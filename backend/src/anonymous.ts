import { Body, Controller, Get, Headers, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { Appeal } from '@prisma/client';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Request } from 'express';
import { z } from 'zod';
import { scanUpload } from './attachment-scan';
import { AuthRequest, demoMode, Public } from './auth';
import { AppError, atomic, bodyText, checked, Database, digest, id, invalid, invalidState, missing, notify, parse, throttle, title, Tx } from './common';
import { JsonBody, QueryFields } from './openapi';
import { Policy } from './policy';
import { classifyAppeal, Intake } from './intake';
import { activeAppeal, businessDeadline } from './workflow';

const attachmentMaxBytes = 64 * 1024;
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const message = z.strictObject({ text: bodyText, attachment: z.string().max(attachmentMaxBytes).optional() });
const submission = message.extend({ title: title.optional(), type: z.enum(['PROBLEM', 'PROPOSAL', 'POSITIVE_FEEDBACK']).optional(),
  proposedSolution: bodyText.optional() });
const cursorInput = z.strictObject({ cursor: id.optional() });
const tokenHeader = ApiHeader({ name: 'X-Appeal-Token', required: true });
const threadSelect = { id: true, side: true, content: true, createdAt: true } as const;

function key() {
  const secret = process.env.ANONYMOUS_DATA_KEY;
  if (!secret || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new AppError('ANONYMOUS_UNAVAILABLE', 'Анонимный канал временно недоступен.', 503);
  }
  return Buffer.from(secret, 'hex');
}

const storedMessage = message.extend({ kind: z.enum(['RESOLUTION', 'REMINDER']).optional(), proposedSolution: bodyText.optional() });

function seal(appealId: string, side: string, data: z.output<typeof storedMessage>) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(Buffer.from(appealId + ':' + side));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
}

function unseal(appealId: string, side: string, data: string) {
  const bytes = Buffer.from(data, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(appealId + ':' + side));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return parse(storedMessage, JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')));
}

export function anonymousStaffMessage(tx: Tx, appealId: string, text: string, kind?: 'RESOLUTION' | 'REMINDER') {
  return tx.anonymousMessage.create({ data: { appealId, side: 'STAFF', content: seal(appealId, 'STAFF', { text, kind }) } });
}

async function validateAttachment(text?: string) {
  if (text === undefined) return;
  const bytes = Buffer.from(text, 'utf8');
  const hasBinaryCharacters = Array.from(text).some(character => {
    const code = character.charCodeAt(0);
    return (code < 32 && ![9, 10, 13].includes(code)) || (character.length === 1 && code >= 0xd800 && code <= 0xdfff);
  });
  if (!bytes.length || bytes.length > attachmentMaxBytes || hasBinaryCharacters) {
    throw invalid('Допустим текстовый файл UTF-8 размером до 64 КиБ.');
  }
  await scanUpload(bytes);
}

@Injectable()
export class AnonymousAppeals {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy,
    @Inject(Intake) private readonly intake: Intake) {}

  private rate(ip: string, action: string, max: number) {
    const pseudonym = createHmac('sha256', key()).update(action + ':' + ip).digest('hex');
    return throttle(this.db, 'anonymous:' + pseudonym, max, 900);
  }

  async create(ip: string, raw: unknown) {
    await this.rate(ip, 'create', 10);
    const { title: subject, type, text, attachment, proposedSolution } = parse(submission, raw);
    await validateAttachment(attachment);
    const token = randomBytes(32).toString('base64url');
    return atomic(this.db, async tx => {
      const isSynthetic = demoMode();
      const appeal = await this.intake.register(tx, {
        title: subject ?? 'Анонимное обращение', type: type ?? classifyAppeal(text, []).type, visibility: 'SPECIAL', isSynthetic,
        description: 'Текст доступен в защищённой переписке.', descriptionOriginal: 'Текст доступен в защищённой переписке.',
        anonymousAccess: { create: { tokenHash: digest(token) } },
      });
      await tx.anonymousMessage.create({ data: { appealId: appeal.id, side: 'AUTHOR',
        content: seal(appeal.id, 'AUTHOR', { text, attachment, proposedSolution }) } });
      return { number: appeal.number, token };
    });
  }

  private async byToken(tx: Tx, token?: string) {
    if (!token || !tokenFormat.test(token)) throw missing();
    const access = await tx.anonymousAccess.findUnique({ where: { tokenHash: digest(token) }, include: { appeal: true } });
    if (!access) throw missing();
    return access.appeal;
  }

  private async thread(tx: Tx, appeal: Appeal, cursor?: string) {
    if (cursor && !await tx.anonymousMessage.findFirst({ where: { id: cursor, appealId: appeal.id }, select: { id: true } })) throw missing();
    const messages = await tx.anonymousMessage.findMany({ where: { appealId: appeal.id }, select: threadSelect,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51 });
    const page = messages.slice(0, 50);
    return { number: appeal.number, title: appeal.title, status: appeal.status, resolutionType: appeal.resolutionType,
      nextCursor: messages.length > 50 ? page.at(-1)?.id : undefined,
      messages: page.reverse().map(({ content, ...item }) => {
        const { attachment, ...body } = unseal(appeal.id, item.side, content);
        return { ...item, ...body, hasAttachment: attachment !== undefined };
      }) };
  }

  async track(ip: string, token: string | undefined, raw: unknown) {
    await this.rate(ip, 'track', 180);
    const { cursor } = parse(cursorInput, raw);
    return this.db.$transaction(async tx => this.thread(tx, await this.byToken(tx, token), cursor), { isolationLevel: 'RepeatableRead' });
  }

  private async staffAppeal(tx: Tx, req: AuthRequest, appealId: string) {
    const appeal = await this.policy.appeal(tx, req.user, appealId);
    if (appeal.authorId !== null || !await this.policy.handles(tx, req.user, appealId)) throw missing();
    return appeal;
  }

  async staffThread(req: AuthRequest, appealId: string, cursor?: string) {
    return this.db.$transaction(async tx => {
      return this.thread(tx, await this.staffAppeal(tx, req, appealId), cursor);
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async attachment(tx: Tx, appealId: string, item: string) {
    const row = await tx.anonymousMessage.findFirst({ where: { id: item, appealId }, select: threadSelect });
    if (!row) throw missing();
    const { attachment } = unseal(appealId, row.side, row.content);
    if (attachment === undefined) throw missing();
    return { attachment };
  }

  async staffAttachment(req: AuthRequest, appealId: string, item: string) {
    return this.db.$transaction(async tx => this.attachment(tx, (await this.staffAppeal(tx, req, appealId)).id, item),
      { isolationLevel: 'RepeatableRead' });
  }

  async authorAttachment(ip: string, token: string | undefined, item: string) {
    await this.rate(ip, 'track', 180);
    return this.db.$transaction(async tx => this.attachment(tx, (await this.byToken(tx, token)).id, item),
      { isolationLevel: 'RepeatableRead' });
  }

  async reply(ip: string, token: string | undefined, raw: unknown) {
    await this.rate(ip, 'reply', 45);
    const data = parse(message, raw);
    await this.byToken(this.db, token);
    await validateAttachment(data.attachment);
    return atomic(this.db, async tx => {
      const appeal = await this.byToken(tx, token);
      if (!activeAppeal(appeal.status)) throw invalidState();
      const resumed = appeal.status === 'WAITING_AUTHOR' ? appeal.resumeState : null;
      const sla = resumed ? await tx.slaPolicy.findFirst({ where: { priority: appeal.priority, active: true } }) : null;
      const now = new Date();
      await checked(tx.appeal.updateMany({ where: { id: appeal.id, version: appeal.version }, data: {
        version: { increment: 1 }, lastMeaningfulActionAt: now,
        ...(resumed ? { status: resumed, waitingSince: null, resumeState: null,
          dueAt: sla ? businessDeadline(now, sla.nextActionHours) : null, slaVersion: sla?.version ?? null } : {}),
      } }));
      await tx.anonymousMessage.create({ data: { appealId: appeal.id, side: 'AUTHOR', content: seal(appeal.id, 'AUTHOR', data) } });
      const kind = resumed ? 'AUTHOR_RESPONSE' : 'COMMENT';
      const event = await tx.auditEvent.create({ data: { entity: 'appeal', entityId: appeal.id, action: kind, authorVisible: true, origin: 'USER_ACTION' } });
      const queue = appeal.queueId ? await tx.workQueue.findUnique({ where: { id: appeal.queueId } }) : null;
      await notify(tx, event.id, [appeal.assigneeId ?? queue?.coordinatorId], kind, '/appeals/' + appeal.id);
      return { ok: true };
    });
  }
}

@ApiTags('Анонимные обращения')
@Controller()
export class AnonymousAppealsController {
  constructor(@Inject(AnonymousAppeals) private readonly service: AnonymousAppeals) {}

  @Public() @Post('anonymous/appeals') @JsonBody(submission) create(@Req() req: Request, @Body() raw: unknown) {
    return this.service.create(req.ip ?? 'unknown', raw);
  }

  @Public() @Post('anonymous/track') @JsonBody(cursorInput) @tokenHeader track(@Req() req: Request, @Headers('x-appeal-token') token: string | undefined, @Body() raw: unknown) {
    return this.service.track(req.ip ?? 'unknown', token, raw);
  }

  @Public() @Post('anonymous/reply') @JsonBody(message) @tokenHeader reply(@Req() req: Request, @Headers('x-appeal-token') token: string | undefined, @Body() raw: unknown) {
    return this.service.reply(req.ip ?? 'unknown', token, raw);
  }

  @Public() @Post('anonymous/attachments/:item') @tokenHeader authorAttachment(@Req() req: Request, @Headers('x-appeal-token') token: string | undefined,
    @Param('item') item: string) {
    return this.service.authorAttachment(req.ip ?? 'unknown', token, parse(id, item));
  }

  @Get('appeals/:id/anonymous-thread/attachments/:item') staffAttachment(@Req() req: AuthRequest,
    @Param('id') appealId: string, @Param('item') item: string) {
    return this.service.staffAttachment(req, parse(id, appealId), parse(id, item));
  }

  @Get('appeals/:id/anonymous-thread') @QueryFields(cursorInput) thread(@Req() req: AuthRequest, @Param('id') appealId: string) {
    const { cursor } = parse(cursorInput, req.query);
    return this.service.staffThread(req, parse(id, appealId), cursor);
  }
}
