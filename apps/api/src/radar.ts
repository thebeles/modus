import { Body, Controller, Delete, Get, Inject, Injectable, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { z } from 'zod';
import { relations } from '../../../packages/contracts/domain';
import { Appeals, appealListInput } from './appeals';
import { AuthRequest } from './auth';
import { atomic, audit, bodyText, checked, Database, expectedVersion, forbidden, id, invalid, invalidState, missing, pagination, parse } from './common';
import { Policy, Principal } from './policy';

@Injectable()
export class Radar {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy, @Inject(Appeals) private readonly appeals: Appeals) {}

  private linksWhere(user: Principal): Prisma.AppealLinkWhereInput {
    const allowed = { AND: [this.policy.staffAppeals(user), { visibility: 'NORMAL_INTERNAL' as const }] };
    return { from: allowed, to: allowed };
  }

  async links(user: Principal, raw: unknown) {
    if (!this.policy.isStaff(user)) throw forbidden();
    const { page, limit, state } = parse(z.strictObject({ ...pagination, state: z.enum(['SUGGESTED', 'CONFIRMED', 'REJECTED']).optional() }), raw);
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
    const input = parse(z.strictObject({ fromId: id, toId: id, relation: z.enum(relations), explanation: bodyText }), raw);
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
    const { expectedVersion: version, sameIssue, reason } = parse(z.strictObject({ expectedVersion, sameIssue: z.boolean().optional(), reason: bodyText.optional() }), raw);
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

  async overview(user: Principal, raw: unknown) {
    if (!this.policy.isStaff(user)) throw forbidden();
    const filters = parse(appealListInput, raw);
    const where: Prisma.AppealWhereInput = { AND: [this.appeals.where(user, filters, true), { visibility: 'NORMAL_INTERNAL' }] };
    const now = new Date();
    const live: Prisma.AppealWhereInput = { status: { notIn: ['CLOSED', 'WITHDRAWN', 'WAITING_AUTHOR'] } };
    const overdueWhere: Prisma.AppealWhereInput = { AND: [where, live, { dueAt: { lt: now }, slaVersion: { not: null } }] };
    const staleWhere: Prisma.AppealWhereInput = { AND: [where, live, { OR: [{ updatedAt: { lt: new Date(now.getTime() - 3 * 86400000) } }, { queue: { coordinator: { active: false } }, assigneeId: null }] }] };
    const improvementWhere: Prisma.ImprovementWhereInput = { AND: [this.policy.improvements(user), { visibility: 'NORMAL_INTERNAL',
      ...(filters.from || filters.to ? { createdAt: { gte: filters.from, lt: filters.to } } : {}),
      processId: filters.processId, departmentId: filters.departmentId }] };
    const implementedWhere: Prisma.ImprovementWhereInput = { AND: [improvementWhere, { status: { in: ['IMPLEMENTED', 'VERIFYING', 'COMPLETED'] } }] };
    const linkWhere: Prisma.AppealLinkWhereInput = { AND: [this.linksWhere(user), { from: where, to: where }, { state: { not: 'REJECTED' } }] };
    const totals = await this.db.$transaction(async tx => {
      const [total, closed, documented, response, overdue, stale, waiting, types, statuses, processGroups, categoryGroups, improved, verified, verifiedSuccess, outcomeGroups, topics] = await Promise.all([
        tx.appeal.count({ where }), tx.appeal.count({ where: { AND: [where, { status: 'CLOSED' }] } }),
        tx.appeal.count({ where: { AND: [where, { status: 'CLOSED', resolutionType: { not: null }, resolutionText: { not: null } }] } }),
        tx.appeal.findMany({ where: { AND: [where, { firstHumanResponseAt: { not: null } }] }, select: { createdAt: true, firstHumanResponseAt: true } }),
        tx.appeal.count({ where: overdueWhere }), tx.appeal.count({ where: staleWhere }),
        tx.appeal.count({ where: { AND: [where, { status: 'WAITING_AUTHOR' }] } }),
        tx.appeal.groupBy({ by: ['type'], where, _count: { _all: true } }),
        tx.appeal.groupBy({ by: ['status'], where, _count: { _all: true } }),
        tx.appeal.groupBy({ by: ['processId'], where, _count: { _all: true } }),
        tx.appeal.groupBy({ by: ['categoryId'], where, _count: { _all: true } }),
        tx.improvement.count({ where: implementedWhere }),
        tx.improvement.count({ where: { AND: [implementedWhere, { verification: { isNot: null } }] } }),
        tx.improvement.count({ where: { AND: [implementedWhere, { verification: { outcome: 'VERIFIED' } }] } }),
        tx.verification.groupBy({ by: ['outcome'], where: { improvement: implementedWhere }, _count: { _all: true } }),
        tx.appealLink.count({ where: linkWhere }),
      ]);
      const min = Math.max(2, Number(process.env.RADAR_MIN_GROUP || 2) || 2);
      const processes = processGroups.filter(row => row._count._all >= min);
      const categories = categoryGroups.filter(row => row._count._all >= min);
      const [processNames, categoryNames, attention, improvements, topicItems] = await Promise.all([
        tx.businessProcess.findMany({ where: { id: { in: processes.flatMap(row => row.processId ? [row.processId] : []) } } }),
        tx.category.findMany({ where: { id: { in: categories.flatMap(row => row.categoryId ? [row.categoryId] : []) } } }),
        tx.appeal.findMany({ where: { OR: [overdueWhere, staleWhere] }, take: 8, orderBy: { dueAt: 'asc' }, select: { id: true, number: true, title: true, status: true, dueAt: true } }),
        tx.improvement.findMany({ where: improvementWhere, take: 12, orderBy: { updatedAt: 'desc' },
          select: { id: true, number: true, title: true, status: true, isSynthetic: true, owner: { select: { name: true } }, verification: { select: { outcome: true } } } }),
        tx.appealLink.findMany({ where: linkWhere, take: 12, orderBy: { createdAt: 'desc' }, include: {
          from: { select: { id: true, number: true, title: true } }, to: { select: { id: true, number: true, title: true } },
        } }),
      ]);
      return { total, closed, documented, firstResponse: {
        count: response.length, hours: response.length ? response.reduce((sum, row) => sum + (row.firstHumanResponseAt!.getTime() - row.createdAt.getTime()) / 3600000, 0) / response.length : null,
      }, overdue, stale, waiting, types: types.map(row => ({ key: row.type, count: row._count._all })),
        statuses: statuses.map(row => ({ key: row.status, count: row._count._all })),
        processes: processes.map(row => ({ id: row.processId, name: processNames.find(value => value.id === row.processId)?.name ?? 'Процесс не указан', count: row._count._all })),
        categories: categories.map(row => ({ id: row.categoryId, name: categoryNames.find(value => value.id === row.categoryId)?.name ?? 'Категория не указана', count: row._count._all })),
        improved, verified, verifiedSuccess, outcomes: outcomeGroups.map(row => ({ key: row.outcome, count: row._count._all })),
        topics, topicItems, attention, improvements, minGroup: min };
    }, { isolationLevel: 'RepeatableRead' });
    return totals;
  }

  async export(user: Principal, raw: unknown) {
    if (!this.policy.has(user, 'EXPORT_DATA')) throw forbidden();
    const filters = parse(appealListInput, raw);
    const rows = await this.db.appeal.findMany({ where: { AND: [this.appeals.where(user, filters, true), { visibility: 'NORMAL_INTERNAL' }] },
      select: { number: true, type: true, status: true, priority: true, createdAt: true }, orderBy: { number: 'asc' }, take: 1000 });
    await this.db.$transaction(tx => audit(tx, 'analytics', 'appeals', 'EXPORT', user.id, false, { count: rows.length }));
    return '\uFEFF' + ['Номер,Тип,Статус,Приоритет,Создано (UTC)', ...rows.map(row =>
      [row.number, row.type, row.status, row.priority, row.createdAt.toISOString()].join(','))].join('\r\n');
  }
}

@Controller()
export class RadarController {
  constructor(@Inject(Radar) private readonly radar: Radar, @Inject(Appeals) private readonly appeals: Appeals) {}
  @Get(['radar/overview', 'radar/topics', 'radar/processes', 'radar/attention', 'radar/improvements', 'radar/outcomes', 'analytics/appeals', 'analytics/sla', 'analytics/improvement-outcomes'])
  overview(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.overview(req.user, q); }
  @Get('search') search(@Req() req: AuthRequest, @Query() q: unknown) { return this.appeals.list(req.user, q); }
  @Get('analytics/export') async export(@Req() req: AuthRequest, @Query() q: unknown, @Res() res: Response) {
    const csv = await this.radar.export(req.user, q);
    res.setHeader('Content-Disposition', 'attachment; filename="appeals.csv"');
    res.type('text/csv').send(csv);
  }
  @Get('object-links') links(@Req() req: AuthRequest, @Query() q: unknown) { return this.radar.links(req.user, q); }
  @Get('object-links/similar/:id') similar(@Req() req: AuthRequest, @Param('id') item: string) { return this.radar.similarities(req.user, item); }
  @Post('object-links/suggest-or-create') create(@Req() req: AuthRequest, @Body() raw: unknown) { return this.radar.createLink(req.user, raw); }
  @Post('object-links/:id/confirm') confirm(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, true); }
  @Post('object-links/:id/reject') reject(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, false); }
  @Delete('object-links/:id') remove(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) { return this.radar.decideLink(req.user, item, raw, false); }
}
