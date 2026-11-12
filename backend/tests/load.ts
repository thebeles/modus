import 'dotenv/config';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createApp } from '../src/main';
import { Database } from '../src/common';
import { deadlines, deliver } from '../src/worker';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/^\/modus_[a-z0-9_]*load$/.test(new URL(testUrl).pathname)) {
  throw new Error('TEST_DATABASE_URL must point to a fresh, seeded modus_*load database');
}
const sample = Number(process.env.LOAD_APPEALS ?? 2000);
if (!Number.isInteger(sample) || sample < 500 || sample > 20000) throw new Error('LOAD_APPEALS must be 500–20000');
const maxP95 = Number(process.env.LOAD_P95_MS ?? 1500);
if (!Number.isFinite(maxP95) || maxP95 <= 0) throw new Error('LOAD_P95_MS must be positive');

async function main() {
  process.env.DATABASE_URL = testUrl;
  process.env.DEMO_MODE = 'true';
  process.env.GROQ_AI_ENABLED = 'false';
  const origin = 'http://localhost:5173';
  process.env.WEB_ORIGIN = origin;
  const app = await createApp();
  const db = app.get(Database);
  const workerDb = new Database();
  try {
    const employee = await db.user.findUniqueOrThrow({ where: { email: 'employee@demo.local' } });
    const queue = await db.workQueue.findFirstOrThrow({ where: { fallback: true, visibility: 'NORMAL_INTERNAL' } });
    const marker = 'LOAD-' + randomUUID();
    const overdue = 120;
    const now = new Date();
    for (let offset = 0; offset < sample; offset += 250) {
      await db.appeal.createMany({ data: Array.from({ length: Math.min(250, sample - offset) }, (_, index) => ({
        number: marker + '-' + (offset + index), title: marker, type: 'PROBLEM', description: 'Синтетический нагрузочный сигнал.',
        descriptionOriginal: 'Синтетический нагрузочный сигнал.', authorId: employee.id, departmentId: employee.departmentId,
        queueId: queue.id, isSynthetic: true, slaVersion: 1,
        dueAt: new Date(now.getTime() + (offset + index < overdue ? -86400000 : 86400000)),
      })) });
    }
    await app.listen(0, '127.0.0.1');
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}/api/v1`;
    const login = await fetch(base + '/auth/demo', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: 'manager' }) });
    assert.equal(login.status, 201);
    await login.arrayBuffer();
    const headers = { Cookie: login.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ') };
    const queuePath = '/work-queue?limit=20&q=' + marker;
    const radarPath = '/radar/overview?q=' + marker;
    async function read(path: string) {
      const started = performance.now();
      const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(15000) });
      if (!response.ok) assert.fail(path + ' ' + await response.text());
      const result = await response.json() as { data: { total: number; overdue?: number } };
      assert.equal(result.data.total, sample);
      if (path === radarPath) assert.equal(result.data.overdue, overdue);
      return performance.now() - started;
    }
    await Promise.all([workerDb.$connect(), ...Array.from({ length: 6 }, () => read(queuePath))]);
    await read(radarPath);
    const workerStart = performance.now();
    const worker = (async () => {
      await deadlines(workerDb, now);
      for (let i = 0; i < 12; i++) {
        if (!await db.outboxJob.count({ where: { availableAt: { lte: new Date() }, deliveredAt: null, deadAt: null, discardedAt: null } })) break;
        await deliver(workerDb);
      }
      const rows = await db.appeal.findMany({ where: { title: marker, dueAt: { lt: now } }, select: { id: true } });
      assert.equal(await db.notification.count({ where: { kind: 'SLA_OVERDUE', href: { in: rows.map(row => '/appeals/' + row.id) } } }), overdue);
      return performance.now() - workerStart;
    })();
    const clients = Promise.all(Array.from({ length: 6 }, async () => {
      const timings = [];
      for (let i = 0; i < 5; i++) timings.push([await read(queuePath), await read(radarPath)]);
      return timings;
    }));
    const [clientResult, workerResult] = await Promise.allSettled([clients, worker]);
    if (clientResult.status === 'rejected') throw clientResult.reason;
    if (workerResult.status === 'rejected') throw workerResult.reason;
    const runs = clientResult.value;
    const workerMs = workerResult.value;
    const p95 = (values: number[]) => values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
    const queueP95 = p95(runs.flat().map(pair => pair[0]));
    const radarP95 = p95(runs.flat().map(pair => pair[1]));
    console.info(JSON.stringify({ sample, concurrentClients: 6, requests: 60, queueP95Ms: Math.round(queueP95),
      radarP95Ms: Math.round(radarP95), workerMs: Math.round(workerMs), delivered: overdue }));
    assert.ok(queueP95 <= maxP95 && radarP95 <= maxP95, 'Queue or radar p95 exceeds LOAD_P95_MS');
  } finally {
    await workerDb.$disconnect();
    await app.close();
  }
}

void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
