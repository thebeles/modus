import { Body, Controller, Delete, Get, Inject, Injectable, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthRequest } from './auth';
import { Cases } from './cases';
import { atomic, audit, bodyText, Database, forbidden, id, missing, pagination, parse, throttle, title } from './common';
import { JsonBody, QueryFields } from './openapi';
import { Principal } from './policy';

const createInput = z.strictObject({ title, description: bodyText });
const commentsInput = z.strictObject({ body: bodyText });
const paged = z.strictObject(pagination);
const listInput = paged.extend({ sort: z.enum(['popular', 'recent']).default('popular') });
const author = { select: { name: true } } as const;

export function departmentScope(user: Principal) {
  if (user.role === 'ADMIN' || !user.departmentId) throw forbidden();
  return { departmentId: user.departmentId, isSynthetic: user.demo };
}

@Injectable()
export class Proposals {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Cases) private readonly cases: Cases) {}

  async list(user: Principal, raw: unknown) {
    const where = departmentScope(user);
    const { page, limit, sort } = parse(listInput, raw);
    const [items, total] = await this.db.$transaction([
      this.db.proposal.findMany({ where, skip: (page - 1) * limit, take: limit,
        orderBy: [...(sort === 'popular' ? [{ votes: { _count: 'desc' as const } }] : []), { createdAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, description: true, author, createdAt: true,
          improvement: { select: { number: true, status: true } }, _count: { select: { votes: true, comments: true } },
          votes: { where: { userId: user.id }, select: { userId: true } } } }),
      this.db.proposal.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items: items.map(({ votes, ...item }) => ({ ...item, voted: !!votes.length })), total, page, limit };
  }

  async create(user: Principal, raw: unknown) {
    const scope = departmentScope(user);
    const data = parse(createInput, raw);
    await throttle(this.db, 'proposal:' + user.id, 20, 3600);
    return atomic(this.db, async tx => {
      const record = await tx.proposal.create({ data: { ...scope, ...data, authorId: user.id }, select: { id: true } });
      await audit(tx, 'proposal', record.id, 'CREATED', user.id);
      return record;
    });
  }

  async vote(user: Principal, proposalId: string, enabled: boolean) {
    const where = { id: proposalId, ...departmentScope(user) };
    const vote = { proposalId, userId: user.id };
    return atomic(this.db, async tx => {
      if (!await tx.proposal.count({ where })) throw missing();
      if (enabled) await tx.proposalVote.createMany({ data: vote, skipDuplicates: true });
      else await tx.proposalVote.deleteMany({ where: vote });
      return { voted: enabled };
    });
  }

  async comments(user: Principal, proposalId: string, raw: unknown) {
    const proposal = { id: proposalId, ...departmentScope(user) };
    const { page, limit } = parse(paged, raw);
    return this.db.$transaction(async tx => {
      if (!await tx.proposal.count({ where: proposal })) throw missing();
      const where = { proposalId };
      const [items, total] = await Promise.all([
        tx.proposalComment.findMany({ where, skip: (page - 1) * limit, take: limit,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, body: true, author, createdAt: true } }),
        tx.proposalComment.count({ where }),
      ]);
      return { items, total, page, limit };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async comment(user: Principal, proposalId: string, raw: unknown) {
    const where = { id: proposalId, ...departmentScope(user) };
    const data = parse(commentsInput, raw);
    await throttle(this.db, 'proposal-comment:' + user.id, 60, 3600);
    return atomic(this.db, async tx => {
      if (!await tx.proposal.count({ where })) throw missing();
      return tx.proposalComment.create({ data: { ...data, proposalId, authorId: user.id }, select: { id: true } });
    });
  }

  convert(user: Principal, proposalId: string, raw: unknown) {
    departmentScope(user);
    return this.cases.createImprovement(user, raw, proposalId);
  }
}

@ApiTags('Предложения')
@Controller('proposals')
export class ProposalsController {
  constructor(@Inject(Proposals) private readonly service: Proposals) {}
  @Get() @QueryFields(listInput) list(@Req() req: AuthRequest, @Query() raw: unknown) { return this.service.list(req.user, raw); }
  @Post() @JsonBody(createInput) create(@Req() req: AuthRequest, @Body() raw: unknown) { return this.service.create(req.user, raw); }
  @Put(':id/vote') vote(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.vote(req.user, parse(id, item), true); }
  @Delete(':id/vote') unvote(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.vote(req.user, parse(id, item), false); }
  @Get(':id/comments') @QueryFields(paged) comments(@Req() req: AuthRequest, @Param('id') item: string, @Query() raw: unknown) {
    return this.service.comments(req.user, parse(id, item), raw);
  }
  @Post(':id/comments') @JsonBody(commentsInput) comment(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.comment(req.user, parse(id, item), raw);
  }
  @Post(':id/convert') convert(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.convert(req.user, parse(id, item), raw);
  }
}
