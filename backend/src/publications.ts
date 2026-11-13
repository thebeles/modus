import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { JsonBody, QueryFields } from './openapi';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { AuthRequest } from './auth';
import { Cases } from './cases';
import { atomic, audit, bodyText, checked, Database, expectedVersion, forbidden, id, invalid, invalidState, missing, notify, pagination, parse, title, Tx } from './common';
import { Policy, Principal } from './policy';

const content = { title: true, id: true, problem: true, change: true, method: true, result: true, limitations: true, publishedAt: true, isSynthetic: true } as const;

const publishedContent = { ...content, improvement: { select: { verification: { select: { outcome: true } } } } } as const;
function publishedView({ improvement, ...row }: Prisma.PublicationGetPayload<{ select: typeof publishedContent }>) {
  return { ...row, verificationOutcome: improvement.verification?.outcome ?? null };
}

const editorialInput = z.strictObject({
  title, problem: bodyText, change: bodyText, method: bodyText, result: bodyText, limitations: bodyText,
  audience: z.enum(['DEPARTMENT', 'INTERNAL']).default('DEPARTMENT'),
});
type EditorialContent = z.output<typeof editorialInput>;

function publicationContent(departmentId: string | null, { audience, ...text }: EditorialContent) {
  if (audience === 'DEPARTMENT' && !departmentId) throw invalidState('Для этой инициативы не определено подразделение.');
  return { ...text, audienceId: audience === 'DEPARTMENT' ? departmentId : null };
}

async function saveRevision(tx: Tx, publicationId: string, actorId: string, action: string) {
  const row = await tx.publication.findUniqueOrThrow({ where: { id: publicationId } });
  const snapshot: Prisma.InputJsonObject = { ...row, publishedAt: row.publishedAt?.toISOString() ?? null };
  await tx.publicationRevision.create({ data: { publicationId, version: row.version, actorId, action, snapshot } });
}

const publicationListInput = z.strictObject({ ...pagination, q: z.string().trim().max(150).optional() });
const editorialTransitionInput = z.strictObject({ expectedVersion, reason: bodyText.optional() });

@Injectable()
export class Publications {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy, @Inject(Cases) private readonly cases: Cases) {}

  async list(user: Principal, raw: unknown) {
    const { page, limit, q } = parse(publicationListInput, raw);
    const where = { ...this.policy.publications(user), ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}) };
    const [items, total] = await this.db.$transaction([
      this.db.publication.findMany({ where, select: publishedContent, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.db.publication.count({ where }),
    ]);
    return { items: items.map(publishedView), total, page, limit };
  }

  async detail(user: Principal, item: string) {
    const row = await this.db.publication.findFirst({ where: { id: item, ...this.policy.publications(user) }, select: publishedContent });
    if (!row) throw missing();
    return publishedView(row);
  }

  async revisions(user: Principal, item: string, raw: unknown) {
    const { page, limit } = parse(z.strictObject(pagination), raw);
    return this.db.$transaction(async tx => {
      const row = await tx.publication.findUnique({ where: { id: item } });
      if (!row) throw missing();
      const record = await this.cases.improvement(tx, user, row.improvementId);
      const departmentManager = user.role === 'MANAGER' && !!user.departmentId && user.departmentId === record.departmentId;
      const reviewer = !!user.departmentId && user.departmentId === record.departmentId && this.policy.has(user, 'PUBLICATION_APPROVER');
      if (record.visibility !== 'NORMAL_INTERNAL' || !(record.ownerId === user.id || departmentManager || reviewer)) throw missing();
      const [items, total] = await Promise.all([
        tx.publicationRevision.findMany({ where: { publicationId: item }, orderBy: { version: 'desc' }, skip: (page - 1) * limit, take: limit }),
        tx.publicationRevision.count({ where: { publicationId: item } }),
      ]);
      return { items, total, page, limit };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async draft(user: Principal, raw: unknown) {
    const { improvementId, ...data } = parse(editorialInput.extend({ improvementId: id }), raw);
    return atomic(this.db, async tx => {
      const record = await this.cases.improvement(tx, user, improvementId);
      if (record.ownerId !== user.id && (user.role !== 'MANAGER' || record.departmentId !== user.departmentId)) throw forbidden();
      if (record.visibility !== 'NORMAL_INTERNAL' || record.status !== 'COMPLETED' || !await tx.verification.findUnique({ where: { improvementId } })) throw invalidState();
      const row = await tx.publication.create({ data: { ...publicationContent(record.departmentId, data), improvementId,
        authorId: user.id, isSynthetic: record.isSynthetic } });
      await saveRevision(tx, row.id, user.id, 'CREATED');
      await audit(tx, 'publication', row.id, 'CREATED', user.id);
      return { id: row.id };
    });
  }

  async edit(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, ...data } = parse(editorialInput.extend({ expectedVersion }), raw);
    return atomic(this.db, async tx => {
      const row = await tx.publication.findUnique({ where: { id: item } });
      if (!row) throw missing();
      const record = await this.cases.improvement(tx, user, row.improvementId);
      if (row.authorId !== user.id || (record.ownerId !== user.id &&
        (user.role !== 'MANAGER' || !user.departmentId || user.departmentId !== record.departmentId))) throw forbidden();
      if (!['DRAFT', 'APPROVED'].includes(row.state)) throw invalidState();
      await checked(tx.publication.updateMany({ where: { id: item, version },
        data: { ...publicationContent(record.departmentId, data), state: 'DRAFT', approvedBy: null, reviewNote: null, version: { increment: 1 } } }));
      await saveRevision(tx, item, user.id, 'EDITED');
      await audit(tx, 'publication', item, 'EDITED', user.id, false, { previousState: row.state });
      return { id: item };
    });
  }

  async transition(user: Principal, item: string, operation: 'approve' | 'publish' | 'unpublish' | 'request-changes', raw: unknown) {
    const { expectedVersion: version, reason } = parse(editorialTransitionInput, raw);
    if (!this.policy.has(user, 'PUBLICATION_APPROVER')) throw forbidden();
    const transitions = { approve: ['DRAFT', 'APPROVED'], publish: ['APPROVED', 'PUBLISHED'], unpublish: ['PUBLISHED', 'RETRACTED'] } as const;
    return atomic(this.db, async tx => {
      const row = await tx.publication.findUnique({ where: { id: item } });
      if (!row) throw missing();
      const record = await this.cases.improvement(tx, user, row.improvementId);
      if (!user.departmentId || user.departmentId !== record.departmentId || user.id === row.authorId) throw forbidden();
      if (operation === 'request-changes') {
        if (!reason) throw invalid('Опишите необходимые правки.');
        if (!['DRAFT', 'APPROVED'].includes(row.state)) throw invalidState();
        await checked(tx.publication.updateMany({ where: { id: item, version },
          data: { state: 'DRAFT', reviewNote: reason, approvedBy: null, version: { increment: 1 } } }));
        await saveRevision(tx, item, user.id, 'CHANGES_REQUESTED');
        const event = await audit(tx, 'publication', item, 'CHANGES_REQUESTED', user.id, false, { reason });
        await notify(tx, event.id, [row.authorId], 'PUBLICATION_CHANGES_REQUESTED', `/improvements/${record.id}`);
        return { id: item, state: 'DRAFT' };
      }
      const [previous, state] = transitions[operation];
      if (row.state !== previous || row.reviewNote) throw invalidState();
      await checked(tx.publication.updateMany({ where: { id: item, version }, data: { state, version: { increment: 1 },
        ...(operation === 'approve' ? { approvedBy: user.id } : {}), ...(operation === 'publish' ? { publishedAt: new Date() } : {}) } }));
      await saveRevision(tx, item, user.id, state);
      const event = await audit(tx, 'publication', item, state, user.id);
      if (state === 'PUBLISHED') await notify(tx, event.id, [row.authorId, record.ownerId], state, `/changes/${item}`);
      return { id: item, state };
    });
  }
}

@Controller('publications')
export class PublicationsController {
  constructor(@Inject(Publications) private readonly service: Publications) {}
  @Get() @QueryFields(publicationListInput) list(@Req() req: AuthRequest, @Query() q: unknown) { return this.service.list(req.user, q); }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.detail(req.user, item); }
  @Get(':id/revisions') @QueryFields(z.strictObject(pagination)) revisions(@Req() req: AuthRequest, @Param('id') item: string, @Query() q: unknown) { return this.service.revisions(req.user, item, q); }
  @Post('drafts') @JsonBody(editorialInput.extend({ improvementId: id })) draft(@Req() req: AuthRequest, @Body() raw: unknown) { return this.service.draft(req.user, raw); }
  @Patch(':id') @JsonBody(editorialInput.extend({ expectedVersion })) edit(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.edit(req.user, item, raw);
  }
  @Post(':id/:operation') @JsonBody(editorialTransitionInput) transition(@Req() req: AuthRequest, @Param('id') item: string, @Param('operation') operation: string, @Body() raw: unknown) {
    return this.service.transition(req.user, item, parse(z.enum(['approve', 'publish', 'unpublish', 'request-changes']), operation), raw);
  }
}
