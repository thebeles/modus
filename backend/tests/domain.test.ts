import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appealTransitions, businessDeadline, improvementTransitions, problemTransitions } from '../src/workflow';
import { Policy, type Principal } from '../src/policy';
import { Groq, packContext, redact } from '../src/ai';
import { z } from 'zod';
import { fileType } from '../src/files';

test('workflow keeps early closure and terminal improvement changes unavailable', () => {
  assert.deepEqual(appealTransitions.NEW, ['REVIEW', 'WITHDRAWN']);
  assert.deepEqual(appealTransitions.CLOSED, ['REVIEW']);
  assert.deepEqual(problemTransitions.CANDIDATE, ['INVESTIGATING']);
  assert.deepEqual(improvementTransitions.COMPLETED, []);
  assert.deepEqual(improvementTransitions.REJECTED, []);
  assert.deepEqual(improvementTransitions.IMPLEMENTED, ['VERIFYING', 'IN_PROGRESS']);
  assert.ok(!improvementTransitions.IN_PROGRESS.includes('COMPLETED'));
});

test('working hours carry a Friday deadline across the weekend in Almaty', () => {
  assert.equal(businessDeadline(new Date('2026-11-06T12:30:00Z'), 2, 'Asia/Almaty').toISOString(), '2026-11-09T05:30:00.000Z');
  assert.equal(businessDeadline(new Date('2026-11-06T12:59:59Z'), 1, 'Asia/Almaty').toISOString(), '2026-11-09T04:59:59.000Z');
  assert.equal(businessDeadline(new Date('2026-11-07T10:00:00Z'), 1, 'Asia/Almaty').toISOString(), '2026-11-09T05:00:00.000Z');
  assert.equal(businessDeadline(new Date('2026-11-09T04:00:00Z'), 1, 'Asia/Almaty').toISOString(), '2026-11-09T05:00:00.000Z');
});

test('staff policy ties confidential reads to membership and a dedicated permission', () => {
  const p: Principal = { id: 'member', name: 'Имя', role: 'HANDLER', departmentId: 'unit', email: 'test@example.org', permissions: [], demo: false };
  const policy = new Policy();
  assert.ok(!JSON.stringify(policy.staffAppeals(p)).includes('RESTRICTED'));
  assert.match(JSON.stringify(policy.staffAppeals({ ...p, permissions: ['SENSITIVE_CASE_HANDLER'] })), /RESTRICTED.*members/);
  assert.deepEqual(policy.staffAppeals({ ...p, role: 'ADMIN', permissions: ['SENSITIVE_CASE_HANDLER'] }), { id: { in: [] } });
});

test('AI payload minimization redacts email, phone and labeled secrets', () => {
  const input = 'Почта info@example.org, телефон +7 (700) 222-33-44. пароль: TestPass';
  const masked = redact(input);
  assert.ok(!masked.includes('example.org'));
  assert.ok(!masked.includes('222'));
  assert.ok(!masked.includes('TestPass'));
  assert.ok(masked.includes('[секрет]'));
});

test('file validation matches signatures, rejects active types and limits production PDFs', () => {
  assert.equal(fileType('тест.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(fileType('test.png', Buffer.from('script')), null);
  assert.equal(fileType('test.html', Buffer.from('<html>')), null);
  assert.equal(fileType('test.txt', Buffer.from([0, 1, 2])), null);
  assert.equal(fileType('test.pdf', Buffer.from('%PDF-1.7'), true), null);
});

test('AI context remains parseable within the budget and preserves included source IDs', () => {
  const sourceId = 'dba1cb25-73ad-4af0-a2ef-7dc3aacce9a9';
  const packed = packContext({ events: [{ id: sourceId }], text: 'Почта info@example.org. ' + '🧪'.repeat(1000) }, 160);
  assert.equal(packed.truncated, true);
  assert.ok(packed.input.length <= 160);
  const payload = JSON.parse(packed.input);
  assert.equal(payload.events[0].id, sourceId);
  assert.match(payload.text, /\[почта\]/);
  assert.doesNotMatch(packed.input, /example.org/);
});

test('Groq validates the configured mode and retries a transient rate limit', async t => {
  const options = { GROQ_AI_ENABLED: 'true', GROQ_API_KEY: 'test-only', GROQ_MODEL: 'unsupported-example', GROQ_OUTPUT_MODE: 'json_schema' };
  for (const [key, value] of Object.entries(options)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const provider = new Groq();
  assert.equal(provider.available(), false);
  process.env.GROQ_MODEL = 'openai/gpt-oss-20b';
  const request = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.response_format.json_schema.strict, true);
    assert.ok(init.signal);
    if (request.mock.callCount() === 0) return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
  });
  assert.deepEqual(await provider.complete('test', 'test', '{}', z.strictObject({ ok: z.literal(true) })), { ok: true });
  assert.equal(request.mock.callCount(), 2);
});
