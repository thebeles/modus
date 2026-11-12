import { Body, Controller, Delete, Get, Inject, Injectable, Param, Post, Query, Req, Res } from '@nestjs/common';
import { JsonBody, JsonResponse, QueryFields } from './openapi';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { appealStatuses, appealTypes, outcomes, relations } from './contracts';
import { Appeals, appealListInput, appealMetrics, appealQueueFilters } from './appeals';
import { AuthRequest } from './auth';
import { atomic, audit, bodyText, checked, Database, expectedVersion, forbidden, id, invalid, invalidState, missing, pagination, parse } from './common';
import { Policy, Principal } from './policy';

const linkListInput = z.strictObject({ ...pagination, state: z.enum(['SUGGESTED', 'CONFIRMED', 'REJECTED']).optional() });
const linkInput = z.strictObject({ fromId: id, toId: id, relation: z.enum(relations), explanation: bodyText });
const linkDecisionInput = z.strictObject({ expectedVersion, sameIssue: z.boolean().optional(), reason: bodyText.optional() });

const outcomeInput = appealListInput.safeExtend({ outcome: z.enum(outcomes).optional(), verifiedOnly: z.enum(['true']).optional() });

const groupsResponse = z.array(z.object({ key: z.string(), count: z.number().int() }));
const pageResponse = z.object({ page: z.number().int(), limit: z.number().int(), total: z.number().int() });
const referenceResponse = z.object({ id, number: z.string(), title: z.string() });
const appealAnalyticsResponse = z.object({ total: z.number().int(), closed: z.number().int(), documented: z.number().int(),
  types: groupsResponse, statuses: groupsResponse });
const slaAnalyticsResponse = z.object({ overdue: z.number().int(), stale: z.number().int(), waiting: z.number().int(),
  firstResponse: z.object({ count: z.number().int(), hours: z.number().nullable() }) });
const outcomeResponse = pageResponse.extend({
  items: z.array(referenceResponse.extend({ status: z.string(), verification: z.object({ outcome: z.enum(outcomes) }).nullable() })),
  improved: z.number().int(), verified: z.number().int(), verifiedSuccess: z.number().int(), verifiedDeterminate: z.number().int(), outcomes: groupsResponse,
});
const recurrenceResponse = pageResponse.extend({ items: z.array(z.object({
  id, from: referenceResponse, to: referenceResponse, relation: z.literal('POSSIBLE_RECURRENCE'),
  state: z.enum(['SUGGESTED', 'CONFIRMED']), explanation: z.string(), proposedBy: z.string(), version: z.number().int(),
})) });

@Injectable()
export class Radar {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy, @Inject(Appeals) private readonly appeals: Appeals) {}

  private linksWhere(user: Principal): Prisma.AppealLinkWhereInput {
    const allowed = { AND: [this.policy.staffAppeals(user), { visibility: 'NORMAL_INTERNAL' as const }] };
    return { from: allowed, to: allowed };
  }

  async links(user: Principal, raw: unknown) {
    if (!this.policy.isStaff(user)) throw forbidden();
    const { page, limit, state } = parse(linkListInput, raw);
    const where = { ...this.linksWhere(user), state: state ?? { not: 'REJECTED' as const } };
    const select = { id: true, number: true, title: true };
    const [items, total] = await this.db.$transaction([
      this.db.appealLink.findMany({ where, orderBy: [{ state: 'asc' }, { createdAt: 'desc' }], take: limit, skip: (page - 1) * limit,
        include: { from: { select }, to: { select } } }),
      this.db.appealLink.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async createLink(user: Principal, raw: unknown) {
    if (!this.policy.has(user, 'PROBLEM_OWNER')) throw forbidden();
    const input = parse(linkInput, raw);
    if (input.fromId === input.toId || input.relation === 'CONFIRMED_SAME_ISSUE') throw invalid('Выберите два разных обращения и предложите тип связи.');
    const [fromId, toId] = [input.fromId, input.toId].sort();
    return atomic(this.db, async tx => {
      if (await tx.appeal.count({ where: { AND: [{ id: { in: [fromId, toId] }, visibility: 'NORMAL_INTERNAL' }, this.policy.staffAppeals(user)] } }) !== 2) throw missing();
      const record = await tx.appealLink.upsert({
        where: { fromId_toId_relation: { fromId, toId, relation: input.relation } },
        create: { ...input, fromId, toId }, update: {},
      });
      if (record.state === 'REJECTED') throw invalidState('Это предложение уже отклонено.');
      await audit(tx, 'link', record.id, 'SUGGESTED', user.id);
      return { id: record.id };
    });
  }

  async decideLink(user: Principal, item: string, raw: unknown, confirm: boolean) {
    if (!this.policy.has(user, 'PROBLEM_OWNER')) throw forbidden();
    const { expectedVersion: version, sameIssue, reason } = parse(linkDecisionInput, raw);
    return atomic(this.db, async tx => {
      const link = await tx.appealLink.findFirst({ where: { ...this.linksWhere(user), id: item } });
      if (!link) throw missing();
      if (link.state === 'REJECTED' || (confirm && link.state !== 'SUGGESTED')) throw invalidState();
      if (sameIssue && (!confirm || link.relation !== 'POSSIBLE_DUPLICATE' || !reason)) throw invalid('Обоснуйте, почему это один и тот же случай.');
      const state = confirm ? 'CONFIRMED' : 'REJECTED';
      await checked(tx.appealLink.updateMany({ where: { id: item, version }, data: { state, confirmedBy: user.id,
        ...(sameIssue ? { relation: 'CONFIRMED_SAME_ISSUE' } : {}), version: { increment: 1 } } }));
      await audit(tx, 'link', item, state, user.id, false, { previous: link.state, reason: reason ?? '' });
      return { id: item, state };
    });
  }

  async similarities(user: Principal, item: string) {
    const base = await this.db.appeal.findFirst({ where: { AND: [{ id: item, visibility: 'NORMAL_INTERNAL' }, this.policy.staffAppeals(user)] } });
    if (!base) throw missing();
    const matches: Prisma.AppealWhereInput[] = [];
    if (base.categoryId) matches.push({ categoryId: base.categoryId });
    if (base.processId) matches.push({ processId: base.processId });
    const words = [...new Set((base.title.toLowerCase().match(/[а-яё]{6,}/g) ?? []))].slice(0, 8);
    matches.push(...words.map(word => ({ title: { contains: word, mode: 'insensitive' as const } })));
    const records = await this.db.appeal.findMany({
      where: { AND: [this.policy.staffAppeals(user), { visibility: 'NORMAL_INTERNAL', id: { not: item }, OR: matches,
        linksFrom: { none: { toId: item, state: 'REJECTED' } }, linksTo: { none: { fromId: item, state: 'REJECTED' } } }] },
      orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, number: true, title: true, categoryId: true, processId: true },
    });
    return records.map(row => ({ id: row.id, number: row.number, title: row.title, explanation:
      [row.categoryId && row.categoryId === base.categoryId ? 'Совпадает категория' : '',
        row.processId && row.processId === base.processId ? 'Совпадает процесс' : '',
        words.some(word => row.title.toLowerCase().includes(word)) ? 'Общие слова в заголовке' : ''].filter(Boolean).join('. ') }));
  }

  private analyticsScope(user: Principal, filters: z.output<typeof appealListInput>, now: Date) {
    if (!this.policy.isStaff(user)) throw forbidden();
    const where: Prisma.AppealWhereInput = { AND: [this.appeals.where(user, filters, true, now), { visibility: 'NORMAL_INTERNAL' }] };
    const tabs = appealQueueFilters(user, now);
    const sourceFilters = { ...filters, from: undefined, to: undefined, processId: undefined, departmentId: undefined };
    const filtersBySource = filters.origin === 'ORIGINAL' || filters.categoryId || filters.type || filters.status || filters.priority ||
      filters.assigneeId || filters.q || filters.dueFrom || filters.dueTo || filters.metric || filters.own || (filters.tab && filters.tab !== 'all');
    const sources: Prisma.AppealWhereInput = { AND: [
      this.appeals.where(user, sourceFilters, true, now), { visibility: 'NORMAL_INTERNAL' },
    ] };
    const improvementWhere: Prisma.ImprovementWhereInput = { AND: [this.policy.improvements(user), { visibility: 'NORMAL_INTERNAL',
      ...(filters.origin ? { isSynthetic: filters.origin !== 'LIVE' } : {}),
      ...(filters.from || filters.to ? { createdAt: { gte: filters.from, lt: filters.to } } : {}),
      processId: filters.processId, departmentId: filters.departmentId },
      ...(filtersBySource ? [{ OR: [{ appeals: { some: { appeal: sources } } },
        { problem: { appeals: { some: { appeal: sources } } } }] }] : []),
    ] };
    const evidence = appealMetrics(filters.evidence).responded.firstResponseOrigin;
    const implementedWhere: Prisma.ImprovementWhereInput = { AND: [improvementWhere, { status: { in: ['IMPLEMENTED', 'VERIFYING', 'COMPLETED'] } }] };
    const recurrenceScope: Prisma.AppealLinkWhereInput = {
      OR: [{ from: where }, { to: where }], relation: 'POSSIBLE_RECURRENCE',
    };
    const visibleLinks: Prisma.AppealLinkWhereInput = { ...this.linksWhere(user), state: { not: 'REJECTED' } };
    const linkWhere: Prisma.AppealLinkWhereInput = { AND: [visibleLinks, { OR: [{ from: where, to: where }, recurrenceScope] }] };
    const recurrenceWhere: Prisma.AppealLinkWhereInput = { AND: [visibleLinks, recurrenceScope] };
    const overdueWhere: Prisma.AppealWhereInput = { AND: [where, tabs.overdue] };
    const staleWhere: Prisma.AppealWhereInput = { AND: [where, tabs.stale] };
    return { where, tabs, overdueWhere, staleWhere, improvementWhere, implementedWhere, linkWhere, recurrenceWhere, evidence,
      metrics: appealMetrics(filters.evidence) };
  }

  async appealAnalytics(user: Principal, raw: unknown) {
    const { where, metrics } = this.analyticsScope(user, parse(appealListInput, raw), new Date());
    const [total, closed, documented, types, statuses] = await this.db.$transaction(tx => Promise.all([
      tx.appeal.count({ where }), tx.appeal.count({ where: { AND: [where, metrics.closed] } }),
      tx.appeal.count({ where: { AND: [where, metrics.documented] } }),
      tx.appeal.groupBy({ by: ['type'], orderBy: { type: 'asc' }, where, _count: { _all: true } }),
      tx.appeal.groupBy({ by: ['status'], orderBy: { status: 'asc' }, where, _count: { _all: true } }),
    ]), { isolationLevel: 'RepeatableRead' });
    return { total, closed, documented, types: types.map(row => ({ key: row.type, count: row._count._all })),
      statuses: statuses.map(row => ({ key: row.status, count: row._count._all })) };
  }

  async slaAnalytics(user: Principal, raw: unknown) {
    const now = new Date();
    const { where, overdueWhere, staleWhere, metrics } = this.analyticsScope(user, parse(appealListInput, raw), now);
    const [overdue, stale, waiting, response] = await this.db.$transaction([
      this.db.appeal.count({ where: overdueWhere }), this.db.appeal.count({ where: staleWhere }),
      this.db.appeal.count({ where: { AND: [where, { status: 'WAITING_AUTHOR' }] } }),
      this.db.appeal.aggregate({ where: { AND: [where, metrics.responded] }, _count: { firstResponseSeconds: true }, _avg: { firstResponseSeconds: true } }),
    ], { isolationLevel: 'RepeatableRead' });
    return { overdue, stale, waiting, firstResponse: {
      count: response._count.firstResponseSeconds, hours: response._avg.firstResponseSeconds === null ? null : response._avg.firstResponseSeconds / 3600,
    } };
  }

  async improvementOutcomes(user: Principal, raw: unknown) {
    const { outcome, verifiedOnly, ...filters } = parse(outcomeInput, raw);
    const { page, limit } = filters;
    const { implementedWhere, evidence } = this.analyticsScope(user, filters, new Date());
    const where: Prisma.ImprovementWhereInput = { AND: [implementedWhere,
      outcome || verifiedOnly ? { verification: { outcome, origin: evidence } } : {}] };
    const [items, total, improved, groups] = await this.db.$transaction(tx => Promise.all([
      tx.improvement.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, number: true, status: true, verification: { select: { outcome: true } } } }),
      tx.improvement.count({ where }), tx.improvement.count({ where: implementedWhere }),
      tx.verification.groupBy({ by: ['outcome'], orderBy: { outcome: 'asc' }, where: { improvement: implementedWhere, origin: evidence }, _count: { _all: true } }),
    ]), { isolationLevel: 'RepeatableRead' });
    const count = (outcome: string) => groups.find(row => row.outcome === outcome)?._count._all ?? 0;
    const verified = groups.reduce((sum, row) => sum + row._count._all, 0);
    return { items, total, page, limit, improved, verified, verifiedSuccess: count('VERIFIED'), verifiedDeterminate: verified - count('INCONCLUSIVE'),
      outcomes: groups.map(row => ({ key: row.outcome, count: row._count._all })) };
  }

  async recurrences(user: Principal, raw: unknown) {
    const filters = parse(appealListInput, raw);
    const { page, limit } = filters;
    const { recurrenceWhere: where } = this.analyticsScope(user, filters, new Date());
    const select = { id: true, number: true, title: true };
    const [items, total] = await this.db.$transaction([
      this.db.appealLink.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        include: { from: { select }, to: { select } } }), this.db.appealLink.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items, total, page, limit };
  }

  async overview(user: Principal, raw: unknown) {
    const filters = parse(appealListInput, raw);
    const now = new Date();
    const { where, tabs, overdueWhere, staleWhere, improvementWhere, implementedWhere, linkWhere, recurrenceWhere, evidence, metrics } =
      this.analyticsScope(user, filters, now);
    const activeAttention: Prisma.AppealWhereInput = { status: { notIn: ['CLOSED', 'WITHDRAWN', 'WAITING_AUTHOR'] } };
    const nextDay = new Date(now.getTime() + 86400000);
    const dueSoon = { controlDueAt: { gte: now, lte: nextDay } };
    const repeats = { OR: [{ linksFrom: { some: recurrenceWhere } }, { linksTo: { some: recurrenceWhere } }] };
    const totals = await this.db.$transaction(async tx => {
      const [closed, documented, response, overdue, stale, appealGroups, processGroups, categoryGroups, improved, outcomeGroups, topics, recurrenceCandidates] = await Promise.all([
        tx.appeal.count({ where: { AND: [where, metrics.closed] } }),
        tx.appeal.count({ where: { AND: [where, metrics.documented] } }),
        tx.appeal.aggregate({ where: { AND: [where, metrics.responded] }, _count: { firstResponseSeconds: true }, _avg: { firstResponseSeconds: true } }),
        tx.appeal.count({ where: overdueWhere }), tx.appeal.count({ where: staleWhere }),
        tx.appeal.groupBy({ by: ['type', 'status'], where, _count: { _all: true } }),
        tx.appeal.groupBy({ by: ['processId'], where, _count: { _all: true } }),
        tx.appeal.groupBy({ by: ['categoryId'], where, _count: { _all: true } }),
        tx.improvement.count({ where: implementedWhere }),
        tx.verification.groupBy({ by: ['outcome'], orderBy: { outcome: 'asc' }, where: { improvement: implementedWhere, origin: evidence }, _count: { _all: true } }),
        tx.appealLink.count({ where: linkWhere }),
        tx.appealLink.count({ where: recurrenceWhere }),
      ]);
      const typeCounts = new Map(appealTypes.map(type => [type, 0]));
      const statusCounts = new Map(appealStatuses.map(status => [status, 0]));
      let total = 0;
      for (const row of appealGroups) {
        const count = row._count._all;
        total += count;
        typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + count);
        statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + count);
      }
      const verified = outcomeGroups.reduce((sum, row) => sum + row._count._all, 0);
      const min = Math.max(2, Number(process.env.RADAR_MIN_GROUP || 2) || 2);
      const processes = processGroups.filter(row => row._count._all >= min);
      const categories = categoryGroups.filter(row => row._count._all >= min);
      const [processNames, categoryNames, attention, improvements, topicItems] = await Promise.all([
        tx.businessProcess.findMany({ where: { id: { in: processes.flatMap(row => row.processId ? [row.processId] : []) } } }),
        tx.category.findMany({ where: { id: { in: categories.flatMap(row => row.categoryId ? [row.categoryId] : []) } } }),
        tx.appeal.findMany({ where: { AND: [where, activeAttention, { OR: [tabs.overdue, tabs.stale, dueSoon, { priority: 'HIGH' }, repeats] }] },
          take: 8, orderBy: [{ priority: 'desc' }, { controlDueAt: { sort: 'asc', nulls: 'last' } }, { lastMeaningfulActionAt: 'asc' }, { id: 'asc' }],
          select: { id: true, number: true, title: true, priority: true, status: true, controlDueAt: true,
            _count: { select: { linksFrom: { where: recurrenceWhere }, linksTo: { where: recurrenceWhere } } },
            nextActions: { orderBy: { revision: 'desc' }, take: 1, select: { ownerId: true, queueId: true } },
          } }),
        tx.improvement.findMany({ where: improvementWhere, take: 12, orderBy: { updatedAt: 'desc' },
          select: { id: true, number: true, title: true, status: true, isSynthetic: true, owner: { select: { name: true } }, verification: { select: { outcome: true } } } }),
        tx.appealLink.findMany({ where: linkWhere, take: 12, orderBy: { createdAt: 'desc' }, include: {
          from: { select: { id: true, number: true, title: true } }, to: { select: { id: true, number: true, title: true } },
        } }),
      ]);
      return { total, closed, documented, firstResponse: {
        count: response._count.firstResponseSeconds, hours: response._avg.firstResponseSeconds === null ? null : response._avg.firstResponseSeconds / 3600,
      }, overdue, stale, waiting: statusCounts.get('WAITING_AUTHOR') ?? 0,
        types: [...typeCounts].filter(([, count]) => count > 0).map(([key, count]) => ({ key, count })),
        statuses: [...statusCounts].filter(([, count]) => count > 0).map(([key, count]) => ({ key, count })),
        processes: processes.map(row => ({ id: row.processId, name: processNames.find(value => value.id === row.processId)?.name ?? 'Процесс не указан', count: row._count._all })),
        categories: categories.map(row => ({ id: row.categoryId, name: categoryNames.find(value => value.id === row.categoryId)?.name ?? 'Категория не указана', count: row._count._all })),
        improved, verified,
        verifiedSuccess: outcomeGroups.find(row => row.outcome === 'VERIFIED')?._count._all ?? 0,
        verifiedDeterminate: verified - (outcomeGroups.find(row => row.outcome === 'INCONCLUSIVE')?._count._all ?? 0),
        outcomes: outcomeGroups.map(row => ({ key: row.outcome, count: row._count._all })),
        topics, recurrenceCandidates, topicItems, improvements, minGroup: min,
        attention: attention.map(({ _count, nextActions, ...row }) => ({
          ...row, reasons: [
            ...(row.priority === 'HIGH' ? ['HIGH_PRIORITY'] : []),
            ...(row.controlDueAt && row.controlDueAt <= nextDay ? [row.controlDueAt < now ? 'OVERDUE' : 'DUE_SOON'] : []),
            ...(!nextActions.some(action => action.ownerId || action.queueId) ? ['NO_NEXT_OWNER'] : []),
            ...(_count.linksFrom || _count.linksTo ? ['POSSIBLE_RECURRENCE'] : []),
          ],
        })) };
    }, { isolationLevel: 'RepeatableRead' });
    return totals;
  }

  async export(user: Principal, raw: unknown) {
    if (!this.policy.has(user, 'EXPORT_DATA')) throw forbidden();
    const filters = parse(appealListInput, raw);
    const rows = await this.db.appeal.findMany({ where: { AND: [this.appeals.where(user, filters, true), { visibility: 'NORMAL_INTERNAL' }] },
      select: { number: true, type: true, status: true, priority: true, createdAt: true,
        seedOrigin: true, isSynthetic: true, firstResponseOrigin: true, firstResponseSeconds: true, resolutionOrigin: true,
      }, orderBy: { number: 'asc' }, take: 1000 });
    await this.db.$transaction(tx => audit(tx, 'analytics', 'appeals', 'EXPORT', user.id, false, { count: rows.length }));
    const evidence = appealMetrics(filters.evidence).responded.firstResponseOrigin.in;
    return '\uFEFF' + ['Номер,Тип,Статус,Приоритет,Создано (UTC),Источник карточки,Демо,Источник первого ответа,Секунды первого ответа,Источник решения', ...rows.map(row =>
      [row.number, row.type, row.status, row.priority, row.createdAt.toISOString(), row.seedOrigin, row.isSynthetic,
        row.firstResponseOrigin, row.firstResponseOrigin && evidence.some(origin => origin === row.firstResponseOrigin) ? row.firstResponseSeconds : null,
        row.resolutionOrigin].join(','))].join('\r\n');
  }
}

@Controller()
export class RadarController {
  constructor(@Inject(Radar) private readonly radar: Radar, @Inject(Appeals) private readonly appeals: Appeals) {}
  @Get(['radar/overview', 'radar/topics', 'radar/processes', 'radar/attention', 'radar/improvements', 'radar/outcomes'])
  @QueryFields(appealListInput)
  overview(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.overview(req.user, q); }
  @Get('analytics/appeals') @JsonResponse(appealAnalyticsResponse) @QueryFields(appealListInput) appealAnalytics(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.appealAnalytics(req.user, q); }
  @Get('analytics/sla') @JsonResponse(slaAnalyticsResponse) @QueryFields(appealListInput) slaAnalytics(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.slaAnalytics(req.user, q); }
  @Get('analytics/improvement-outcomes') @JsonResponse(outcomeResponse) @QueryFields(outcomeInput) outcomes(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.improvementOutcomes(req.user, q); }
  @Get('radar/recurrences') @JsonResponse(recurrenceResponse) @QueryFields(appealListInput) recurrences(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.recurrences(req.user, q); }
  @Get('search') @QueryFields(appealListInput) search(@Req() req: AuthRequest, @Query() q: unknown) { return this.appeals.list(req.user, q); }
  @Get('analytics/export') @QueryFields(appealListInput) async export(@Req() req: AuthRequest, @Query() q: unknown, @Res() res: Response) {
    const csv = await this.radar.export(req.user, q);
    res.setHeader('Content-Disposition', 'attachment; filename="appeals.csv"');
    res.type('text/csv').send(csv);
  }
  @Get('object-links') @QueryFields(linkListInput) links(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.links(req.user, q); }
  @Get('object-links/similar/:id') similar(@Req() req: AuthRequest, @Param('id') item: string) { return this.radar.similarities(req.user, item); }
  @Post('object-links/suggest-or-create') @JsonBody(linkInput) create(@Req() req: AuthRequest, @Body() raw: unknown) { return this.radar.createLink(req.user, raw); }
  @Post('object-links/:id/confirm') @JsonBody(linkDecisionInput) confirm(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, true); }
  @Post('object-links/:id/reject') @JsonBody(linkDecisionInput) reject(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, false); }
  @Delete('object-links/:id') @JsonBody(linkDecisionInput) remove(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, false); }
}
