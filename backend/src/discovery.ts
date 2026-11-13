import { Body, Controller, Get, Inject, Injectable, Param, Post, Req } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from './auth';
import { atomic, audit, bodyText, checked, Database, expectedVersion, forbidden, id, invalidState, missing, notify, parse, throttle, title } from './common';
import { appealTypes } from './contracts';
import { Intake } from './intake';
import { JsonBody } from './openapi';
import { Policy, Principal } from './policy';
import { Routing } from './routing';
import { businessDeadline } from './workflow';

const draftInput = z.strictObject({ description: bodyText, type: z.enum(appealTypes).optional() });
const shareInput = z.strictObject({ expectedVersion, title: title.nullable() });
const articleInput = z.strictObject({ expectedVersion });
const stopWords = new Set(['проблема', 'проблем', 'работает', 'предлагаю', 'нужно', 'можно', 'сделать', 'почему', 'который', 'после', 'снова']);

function terms(text: string) {
  return [...new Set((text.toLocaleLowerCase('ru').replaceAll('ё', 'е').match(/[\p{L}\p{N}]{4,}/gu) ?? [])
    .filter(word => !stopWords.has(word)).map(word => word.slice(0, 6)))];
}

export function lexicalScore(query: string[], text: string) {
  const words = new Set(terms(text));
  const overlap = query.filter(word => words.has(word)).length;
  return overlap >= 2 ? overlap / Math.sqrt(query.length * words.size) : 0;
}

function rank<T>(query: string[], rows: T[], text: (row: T) => string) {
  return rows.map(row => ({ row, score: lexicalScore(query, text(row)) }))
    .filter(entry => entry.score >= 0.4).sort((a, b) => b.score - a.score).slice(0, 3).map(entry => entry.row);
}

@Injectable()
export class Discovery {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy,
    @Inject(Intake) private readonly intake: Intake, @Inject(Routing) private readonly routing: Routing) {}

  private shared(user: Principal): Prisma.AppealWhereInput {
    return { visibility: 'NORMAL_INTERNAL', sharedTitle: { not: null }, departmentId: user.departmentId ?? '',
      isSynthetic: user.demo, authorId: { not: null }, status: { not: 'WITHDRAWN' } };
  }

  private knowledge(user: Principal): Prisma.PublicationWhereInput {
    return { AND: [this.policy.publications(user), { publishedAt: { not: null }, isSynthetic: user.demo,
      improvement: { visibility: 'NORMAL_INTERNAL', verification: { outcome: 'VERIFIED' } } }] };
  }

  async preview(user: Principal, raw: unknown) {
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR') throw forbidden();
    const { description, type } = parse(draftInput, raw);
    await throttle(this.db, `intake-preview:${user.id}`, 240, 3600);
    const query = terms(description).slice(0, 12);
    const search = (field: string) => query.map(word => ({ [field]: { contains: word, mode: 'insensitive' as const } }));
    const [triage, candidates, articles] = await Promise.all([
      this.intake.classify(this.db, description, !type),
      query.length < 2 ? [] : this.db.appeal.findMany({
        where: { AND: [this.shared(user), { authorId: { not: user.id } }, { OR: search('sharedTitle') }] },
        orderBy: { updatedAt: 'desc' }, take: 100, select: { id: true, sharedTitle: true, status: true,
          subscribers: { where: { userId: user.id }, select: { userId: true } } },
      }),
      query.length < 2 ? [] : this.db.publication.findMany({
        where: { AND: [this.knowledge(user), { OR: [...search('title'), ...search('problem')] }] },
        orderBy: { publishedAt: 'desc' }, take: 100, select: { id: true, title: true, version: true, problem: true, change: true },
      }),
    ]);
    const categoryId = type ? null : triage.categoryId;
    const priority = type ? 'MEDIUM' : triage.priority;
    const [category, route, sla] = await Promise.all([
      categoryId ? this.db.category.findUnique({ where: { id: categoryId }, select: { name: true } }) : null,
      this.routing.find(this.db, { authorId: user.id, departmentId: user.departmentId, categoryId, visibility: 'NORMAL_INTERNAL' }),
      this.db.slaPolicy.findFirst({ where: { active: true, priority } }),
    ]);
    const ownerId = route.assigneeId ?? route.coordinatorId;
    const owner = ownerId ? await this.db.user.findUnique({ where: { id: ownerId }, select: { name: true } }) : null;
    return {
      triage: { title: triage.title, type: type ?? triage.type, category: category?.name ?? null, priority,
        owner: owner?.name ?? null, firstResponseDueAt: sla ? businessDeadline(new Date(), sla.firstResponseHours) : null },
      similar: rank(query, candidates, row => row.sharedTitle!).map(row => ({
        id: row.id, title: row.sharedTitle, status: row.status, joined: !!row.subscribers.length,
      })),
      knowledge: rank(query, articles, row => row.title + ' ' + row.problem).map(({ id, title, version, change }) => ({ id, title, version, change })),
    };
  }

  async share(user: Principal, appealId: string, raw: unknown) {
    const input = parse(shareInput, raw);
    return atomic(this.db, async tx => {
      const row = await this.policy.appeal(tx, user, appealId);
      if (!this.policy.has(user, 'ROUTING_COORDINATOR') || !await this.policy.handles(tx, user, appealId)) throw forbidden();
      if (row.visibility !== 'NORMAL_INTERNAL' || !row.authorId || !row.departmentId || row.status === 'WITHDRAWN') throw invalidState();
      if (row.sharedTitle === input.title && row.version === input.expectedVersion) return { id: row.id };
      await checked(tx.appeal.updateMany({ where: { id: row.id, version: input.expectedVersion }, data: {
        sharedTitle: input.title, version: { increment: 1 },
      } }));
      await audit(tx, 'appeal', row.id, input.title ? 'SHARED_TOPIC_PUBLISHED' : 'SHARED_TOPIC_RETRACTED', user.id, false);
      return { id: row.id };
    });
  }

  async join(user: Principal, appealId: string) {
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR') throw forbidden();
    return atomic(this.db, async tx => {
      const row = await tx.appeal.findFirst({ where: { AND: [this.shared(user), { id: appealId, authorId: { not: user.id } }] },
        select: { id: true, status: true, assigneeId: true, queue: { select: { coordinatorId: true } } } });
      if (!row) throw missing();
      if (await tx.appealSubscription.findUnique({ where: { appealId_userId: { appealId, userId: user.id } } })) return { id: appealId, joined: true };
      if (row.status === 'CLOSED') throw invalidState('Работа по этому обращению завершена.');
      const inserted = await tx.appealSubscription.createMany({ data: { appealId, userId: user.id }, skipDuplicates: true });
      if (inserted.count) {
        const event = await audit(tx, 'appeal', appealId, 'SHARED_TOPIC_JOINED', user.id, false);
        await notify(tx, event.id, [row.assigneeId ?? row.queue?.coordinatorId], 'SHARED_TOPIC_JOINED', '/appeals/' + appealId);
      }
      return { id: appealId, joined: true };
    });
  }

  async joined(user: Principal) {
    const rows = await this.db.appeal.findMany({
      where: { ...this.shared(user), subscribers: { some: { userId: user.id } } },
      select: { id: true, sharedTitle: true, status: true, improvements: { select: { improvement: { select: {
        publications: { where: this.knowledge(user), select: { id: true, title: true, result: true }, take: 2 },
      } } } } }, take: 50, orderBy: { updatedAt: 'desc' },
    });
    return rows.map(row => ({ id: row.id, title: row.sharedTitle, status: row.status,
      results: row.improvements.flatMap(link => link.improvement.publications) }));
  }

  async solved(user: Principal, item: string, raw: unknown) {
    const { expectedVersion } = parse(articleInput, raw);
    return atomic(this.db, async tx => {
      const row = await tx.publication.findFirst({ where: { ...this.knowledge(user), id: item }, select: { id: true, version: true } });
      if (!row) throw missing();
      if (row.version !== expectedVersion) throw invalidState('Публикация обновилась. Откройте актуальную версию.');
      await tx.auditEvent.createMany({ skipDuplicates: true, data: {
        id: `knowledge-solved:${item}:${row.version}:${user.id}`, entity: 'publication', entityId: item,
        action: 'KNOWLEDGE_SOLVED', origin: 'USER_ACTION', actorId: user.id,
      } });
      return { solved: true };
    });
  }
}

@Controller('intake')
export class DiscoveryController {
  constructor(@Inject(Discovery) private readonly service: Discovery) {}
  @Post('preview') @JsonBody(draftInput) preview(@Req() req: AuthRequest, @Body() raw: unknown) { return this.service.preview(req.user, raw); }
  @Get('joined') joined(@Req() req: AuthRequest) { return this.service.joined(req.user); }
  @Post('shared/:id/join') join(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.join(req.user, parse(id, item)); }
  @Post('shared/:id/publish') @JsonBody(shareInput) share(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.share(req.user, parse(id, item), raw);
  }
  @Post('knowledge/:id/solved') @JsonBody(articleInput) solved(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.solved(req.user, parse(id, item), raw);
  }
}
