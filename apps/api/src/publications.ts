import { Body, Controller, Get, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { AuthRequest } from './auth';
import { Cases } from './cases';
import { atomic, audit, bodyText, checked, Database, expectedVersion, forbidden, id, invalidState, missing, notify, pagination, parse, title } from './common';
import { Policy, Principal } from './policy';

const content = { title: true, id: true, problem: true, change: true, method: true, result: true, limitations: true, publishedAt: true, isSynthetic: true } as const;

@Injectable()
export class Publications {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy, @Inject(Cases) private readonly cases: Cases) {}

  async list(user: Principal, raw: unknown) {
    const { page, limit, q } = parse(z.strictObject({ ...pagination, q: z.string().trim().max(150).optional() }), raw);
    const where = { ...this.policy.publications(user), ...(q ? { title: { contains: q, mode: 'insensitive' as const } } : {}) };
    const [items, total] = await this.db.$transaction([
      this.db.publication.findMany({ where, select: content, orderBy: { publishedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.db.publication.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async detail(user: Principal, item: string) {
    const row = await this.db.publication.findFirst({ where: { id: item, ...this.policy.publications(user) }, select: content });
    if (!row) throw missing();
    return row;
  }

  async draft(user: Principal, raw: unknown) {
    const { improvementId, ...data } = parse(z.strictObject({ improvementId: id, title, problem: bodyText, change: bodyText,
      method: bodyText, result: bodyText, limitations: bodyText, audience: z.enum(['DEPARTMENT', 'INTERNAL']).default('DEPARTMENT') }), raw);
    return atomic(this.db, async tx => {
      const record = await this.cases.improvement(tx, user, improvementId);
      if (record.ownerId !== user.id && (user.role !== 'MANAGER' || record.departmentId !== user.departmentId)) throw forbidden();
      if (record.visibility !== 'NORMAL_INTERNAL' || record.status !== 'COMPLETED' || !await tx.verification.findUnique({ where: { improvementId } })) throw invalidState();
      const { audience, ...approvedContent } = data;
      if (audience === 'DEPARTMENT' && !record.departmentId) throw invalidState('Для этой инициативы не определено подразделение.');
      const row = await tx.publication.create({ data: { ...approvedContent, improvementId, authorId: user.id, isSynthetic: record.isSynthetic,
        audienceId: audience === 'DEPARTMENT' ? record.departmentId : null } });
      await audit(tx, 'publication', row.id, 'CREATED', user.id);
      return { id: row.id };
    });
  }

  async transition(user: Principal, item: string, operation: 'approve' | 'publish' | 'unpublish', raw: unknown) {
    const { expectedVersion: version } = parse(z.strictObject({ expectedVersion }), raw);
    if (!this.policy.has(user, 'PUBLICATION_APPROVER')) throw forbidden();
    const transitions = { approve: ['DRAFT', 'APPROVED'], publish: ['APPROVED', 'PUBLISHED'], unpublish: ['PUBLISHED', 'RETRACTED'] } as const;
    return atomic(this.db, async tx => {
      const row = await tx.publication.findUnique({ where: { id: item } });
      if (!row) throw missing();
      const record = await this.cases.improvement(tx, user, row.improvementId);
      if (!user.departmentId || user.departmentId !== record.departmentId || user.id === row.authorId) throw forbidden();
      const [previous, state] = transitions[operation];
      if (row.state !== previous) throw invalidState();
      await checked(tx.publication.updateMany({ where: { id: item, version }, data: { state, version: { increment: 1 },
        ...(operation === 'approve' ? { approvedBy: user.id } : {}), ...(operation === 'publish' ? { publishedAt: new Date() } : {}) } }));
      const event = await audit(tx, 'publication', item, state, user.id);
      if (state === 'PUBLISHED') await notify(tx, event.id, [row.authorId, record.ownerId], state, `/changes/${item}`);
      return { id: item, state };
    });
  }
}

@Controller('publications')
export class PublicationsController {
  constructor(@Inject(Publications) private readonly service: Publications) {}
  @Get() list(@Req() req: AuthRequest, @Query() q: unknown) { return this.service.list(req.user, q); }
  @Get(':id') detail(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.detail(req.user, item); }
  @Post('drafts') draft(@Req() req: AuthRequest, @Body() raw: unknown) { return this.service.draft(req.user, raw); }
  @Post(':id/:operation') transition(@Req() req: AuthRequest, @Param('id') item: string, @Param('operation') operation: string, @Body() raw: unknown) {
    return this.service.transition(req.user, item, parse(z.enum(['approve', 'publish', 'unpublish']), operation), raw);
  }
}
