import { Body, Controller, Get, Headers, Inject, Injectable, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { anonymousStaffMessage } from './anonymous';
import { JsonBody, QueryFields } from './openapi';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Appeal, Prisma, ReviewRequestKind } from '@prisma/client';
import { z } from 'zod';
import { appealStatuses, appealTypes, priorities, resolutions, visibilities } from './contracts';
import { AuthRequest } from './auth';
import { AppError, assertVersion, atomic, audit, bodyText, checked, Database, dateTime, digest, expectedVersion, forbidden, id, invalid, invalidState, notify, pagination, parse, throttle, title, Tx } from './common';
import { attachmentSummary, claimAttachments } from './files';
import { Policy, Principal, principalSelect } from './policy';
import { eligibleStaff, queueStaff, Routing } from './routing';
import { Intake } from './intake';
import { activeAppeal, appealTransitions, businessDeadline, clarificationKey } from './workflow';

export const appealListInput = z.strictObject({
  ...pagination, q: z.string().trim().max(150).optional(), status: z.enum(appealStatuses).optional(),
  type: z.enum(appealTypes).optional(), priority: z.enum(priorities).optional(), categoryId: id.optional(),
  departmentId: id.optional(), processId: id.optional(), assigneeId: id.optional(),
  tab: z.enum(['mine', 'new', 'waiting', 'in-progress', 'review-result', 'unassigned', 'risk', 'overdue', 'stale', 'urgent', 'attention-mine', 'all']).optional(),
  own: z.enum(['true', 'false']).optional(), normalOnly: z.enum(['true']).optional(), sort: z.enum(['recent', 'oldest', 'due']).default('recent'),
  from: dateTime.optional(), to: dateTime.optional(), dueFrom: dateTime.optional(), dueTo: dateTime.optional(),
  metric: z.enum(['closed', 'documented', 'responded']).optional(),
  origin: z.enum(['LIVE', 'DEMO', 'ORIGINAL']).optional(),
  evidence: z.enum(['OBSERVED', 'DEMO_FIXTURE', 'UNKNOWN']).default('OBSERVED'),
}).refine(({ from, to }) => !from || !to || from < to, { path: ['to'], message: 'Конец периода должен быть позже начала.' })
  .refine(({ dueFrom, dueTo }) => !dueFrom || !dueTo || dueFrom < dueTo, { path: ['dueTo'], message: 'Конец интервала должен быть позже начала.' });
const createInput = z.strictObject({
  type: z.enum(appealTypes).optional(), title: title.optional(), description: bodyText,
  proposedSolution: bodyText.optional(), categoryId: id.optional(), processId: id.optional(),
  visibility: z.enum(visibilities).default('NORMAL_INTERNAL'), attachmentIds: z.array(id).max(5).default([]),
});
const editInput = z.strictObject({
  expectedVersion, title: title.optional(), description: bodyText.optional(), proposedSolution: bodyText.nullable().optional(),
  categoryId: id.nullable().optional(), processId: id.nullable().optional(), priority: z.enum(priorities).optional(),
});
const mutationInput = z.strictObject({
  expectedVersion, action: z.enum(['REVIEW', 'IN_PROGRESS', 'RESUME', 'CLARIFICATION', 'AUTHOR_RESPONSE', 'RESOLVE', 'WITHDRAW', 'REVIEW_REQUEST', 'REVIEW_DECISION', 'ASSIGN', 'COMMENT']),
  text: bodyText.optional(), internal: z.boolean().default(false), resolutionType: z.enum(resolutions).optional(),
  relatedId: id.optional(), assigneeId: id.nullable().optional(), approve: z.boolean().optional(),
});
type Mutation = z.output<typeof mutationInput>;
const resultInput = z.strictObject({ expectedVersion, confirm: z.boolean(), reason: bodyText.optional() });
const deadlineInput = z.strictObject({ expectedVersion, dueAt: dateTime.nullable(), reason: bodyText });
const active: Prisma.AppealWhereInput = { status: { in: ['NEW', 'REVIEW', 'IN_PROGRESS'] } };

export function appealMetrics(evidence: z.output<typeof appealListInput>['evidence']) {
  const origins = evidence === 'OBSERVED' ? ['USER_ACTION', 'IMPORTED'] as const : [evidence];
  const closed = { status: 'CLOSED', resolutionOrigin: { in: [...origins] } } satisfies Prisma.AppealWhereInput;
  return {
    closed,
    documented: { ...closed, resolutionType: { not: null }, resolutionText: { not: null } },
    responded: { firstResponseSeconds: { not: null }, firstResponseOrigin: { in: [...origins] } },
  } satisfies Record<string, Prisma.AppealWhereInput>;
}
export function appealStaleHours() {
  const hours = Number(process.env.APPEAL_STALE_HOURS ?? 72);
  return Number.isFinite(hours) && hours >= 1 && hours <= 720 ? hours : 72;
}

export function appealQueueFilters(user: Principal, now: Date) {
  const staleHours = appealStaleHours();
  const liveOwner = (visibility: Appeal['visibility']): Prisma.AppealWhereInput => ({
    visibility, OR: [
      { assignee: eligibleStaff(visibility) },
      { assigneeId: null, queue: { coordinator: eligibleStaff(visibility) } },
    ],
  });
  const mine: Prisma.AppealWhereInput = { AND: [active, { OR: [{ authorId: null }, { authorId: { not: user.id } }] }, { OR: [
      { assigneeId: user.id }, { assigneeId: null, queue: { coordinatorId: user.id } },
    ] }] };
  const overdue: Prisma.AppealWhereInput = { OR: [
    { controlDueAt: { lt: now } },
    { status: { in: ['NEW', 'REVIEW', 'IN_PROGRESS', 'WAITING_AUTHOR'] }, resolutionDueAt: { lt: now } },
  ] };
  const urgent: Prisma.AppealWhereInput = { OR: [overdue, { AND: [active, { priority: 'HIGH' }] }] };
  return {
    all: {},
    mine,
    urgent,
    'attention-mine': { OR: [
      { AND: [mine, { priority: { not: 'HIGH' } }, { OR: [{ controlDueAt: null }, { controlDueAt: { gte: now } }] }] },
      { authorId: user.id, status: 'WAITING_AUTHOR', OR: [{ controlDueAt: null }, { controlDueAt: { gte: now } }] },
    ] },
    new: { AND: [active, { OR: [{ status: 'NEW' }, { assigneeId: null }] }] },
    waiting: { status: 'WAITING_AUTHOR' },
    'in-progress': { status: 'IN_PROGRESS' },
    'review-result': { status: 'IMPLEMENTED' },
    unassigned: { queueId: null, status: { in: ['NEW', 'REVIEW', 'IN_PROGRESS', 'WAITING_AUTHOR'] } },
    risk: { controlDueAt: { gte: now, lte: new Date(now.getTime() + 86400000) } },
    overdue,
    stale: { AND: [active, { OR: [
      { lastMeaningfulActionAt: { lt: new Date(now.getTime() - staleHours * 3600000) } },
      { NOT: { OR: visibilities.map(liveOwner) } },
    ] }] },
  } satisfies Record<string, Prisma.AppealWhereInput>;
}

const summary = {
  id: true, number: true, title: true, type: true, status: true, priority: true, visibility: true,
  authorId: true, assigneeId: true, departmentId: true, categoryId: true, processId: true,
  category: { select: { name: true } }, process: { select: { name: true } }, department: { select: { name: true } },
  createdAt: true, updatedAt: true, lastMeaningfulActionAt: true, controlDueAt: true, dueAt: true, firstResponseDueAt: true, firstHumanResponseAt: true,
  resolutionDueAt: true,
  closedAt: true, isSynthetic: true, seedOrigin: true, version: true,
} satisfies Prisma.AppealSelect;

const rerouteInput = z.strictObject({ expectedVersion, text: bodyText,
      categoryId: id.nullable().optional(), processId: id.nullable().optional() });
const resolutionTargetsInput = z.strictObject({
  ...pagination, q: z.string().trim().max(150).optional(),
  type: z.enum(['LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED']),
});

@Injectable()
export class Appeals {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy,
    @Inject(Routing) private readonly routing: Routing, @Inject(Intake) private readonly intake: Intake) {}

  where(user: Principal, filters: z.output<typeof appealListInput>, staff = false, now = new Date(), includeAuthorTasks = false): Prisma.AppealWhereInput {
    const { status, type, priority, categoryId, departmentId, processId, assigneeId, q, own, normalOnly, tab, from, to, dueFrom, dueTo, metric, origin, evidence } = filters;
    const tabs = appealQueueFilters(user, now);
    return { AND: [
      staff ? includeAuthorTasks && tab === 'attention-mine'
        ? { OR: [this.policy.staffAppeals(user), { authorId: user.id, status: 'WAITING_AUTHOR' }] }
        : this.policy.staffAppeals(user) : this.policy.appeals(user),
      { status, type, priority, categoryId, departmentId, processId, assigneeId, ...(from || to ? { createdAt: { gte: from, lt: to } } : {}) },
      own === 'true' ? { authorId: user.id } : {},
      normalOnly === 'true' ? { visibility: 'NORMAL_INTERNAL' } : {},
      tab ? tabs[tab] : {},
      dueFrom || dueTo ? { controlDueAt: { gte: dueFrom, lt: dueTo } } : {},
      metric ? appealMetrics(evidence)[metric] : {},
      origin === 'ORIGINAL' ? { seedOrigin: 'ORIGINAL_DOCX' } : origin ? { isSynthetic: origin === 'DEMO' } : {},
      q ? { OR: ['title', 'description', 'number'].map(field => ({ [field]: { contains: q, mode: 'insensitive' } })) } : {},
    ] };
  }

  async list(user: Principal, input: unknown, staff = false) {
    if (staff && !this.policy.canReadOperations(user)) throw forbidden();
    const filters = parse(appealListInput, input);
    const { page, limit, sort } = filters;
    if (staff && filters.tab === 'unassigned') {
      if (!this.policy.has(user, 'ROUTING_COORDINATOR') || !user.departmentId) return { items: [], total: 0, page, limit };
      const where = { ...appealQueueFilters(user, new Date()).unassigned, visibility: 'NORMAL_INTERNAL' as const,
        departmentId: user.departmentId, isSynthetic: user.demo, routingRetryAt: { not: null } };
      const [items, total] = await this.db.$transaction([
        this.db.appeal.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
          select: { id: true, number: true, status: true, createdAt: true, isSynthetic: true, visibility: true, department: { select: { name: true } } } }),
        this.db.appeal.count({ where }),
      ]);
      return { items: items.map(item => ({ ...item, title: 'Ожидает маршрутизации', routingOnly: true, nextActionKind: 'ROUTING' })), total, page, limit };
    }
    const where = this.where(user, filters, staff, new Date(), true);
    const orderBy: Prisma.AppealOrderByWithRelationInput = filters.tab === 'urgent' || sort === 'due' ? { controlDueAt: { sort: 'asc', nulls: 'last' } } :
      { createdAt: sort === 'oldest' ? 'asc' : 'desc' };
    const select = { ...summary, nextActions: staff ? {
      orderBy: { revision: 'desc' as const }, take: 1, select: { kind: true },
    } : false } satisfies Prisma.AppealSelect;
    const attention = staff && (filters.tab === 'urgent' || filters.tab === 'attention-mine');
    const [items, total] = await this.db.$transaction(async tx => {
      const items = await tx.appeal.findMany({ where, orderBy: [orderBy, ...(filters.tab === 'urgent' ? [{ priority: 'desc' as const }] : []), { id: 'asc' }], skip: (page - 1) * limit, take: limit, select });
      const total = await tx.appeal.count({ where });
      if (!attention || !items.length) return [items, total] as const;
      const ids = items.map(item => item.id);
      const [delegated, pending] = await Promise.all([
        tx.appeal.findMany({ where: { AND: [{ id: { in: ids } }, this.policy.staffAppeals(user, true)] }, select: { id: true, resumeState: true } }),
        tx.reviewRequest.findMany({ where: { appealId: { in: ids }, decidedAt: null }, select: { appealId: true, kind: true } }),
      ]);
      const handling = new Map(delegated.map(row => [row.id, row]));
      const reviews = new Map(pending.map(row => [row.appealId, row.kind]));
      return [items.map(row => {
        const delegation = handling.get(row.id);
        const actions = this.actions(user, { ...row, resumeState: delegation?.resumeState ?? null }, !!delegation, reviews.get(row.id));
        const work = [
          'REVIEW_DECISION', 'AUTHOR_RESPONSE', ...(row.assigneeId === null ? ['ASSIGN'] : []),
          ...(row.status === 'IN_PROGRESS' ? ['RESOLVE', 'REVIEW'] : ['REVIEW', 'IN_PROGRESS', 'RESOLVE']), 'RESUME',
        ];
        return { ...row, recommendedAction: work.find(action => actions.includes(action)) ?? null };
      }), total] as const;
    }, { isolationLevel: 'RepeatableRead' });
    return { items: items.map(({ nextActions, ...row }) => ({
      ...row,
      ...(row.authorId === user.id && row.visibility !== 'NORMAL_INTERNAL' ? { assigneeId: null } : {}),
      ...(staff ? { nextActionKind: nextActions?.[0]?.kind ?? null } : {}),
    })), total, page, limit };
  }

  async assignees(user: Principal) {
    if (!this.policy.canReadOperations(user)) throw forbidden();
    return this.db.user.findMany({ where: { assigned: { some: this.policy.staffAppeals(user) } },
      select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  async resolutionTargets(user: Principal, item: string, input: unknown) {
    const { q, page, limit, type } = parse(resolutionTargetsInput, input);
    return this.db.$transaction(async tx => {
      const source = await this.policy.appeal(tx, user, item);
      if (!await this.policy.handles(tx, user, item)) throw forbidden();
      const where: Prisma.AppealWhereInput = {
        AND: [this.policy.staffAppeals(user), { id: { not: item } },
          q ? { OR: [{ title: { contains: q, mode: 'insensitive' } }, { number: { contains: q, mode: 'insensitive' } }] } : {}],
      };
      if (type === 'TRANSFERRED') {
        const owner: Prisma.UserWhereInput = {
          ...eligibleStaff(source.visibility),
          OR: [
            ...(source.authorId ? [{ id: source.authorId }] : []),
            ...(source.assigneeId ? [{ id: source.assigneeId }] : []),
            ...(source.queueId ? queueStaff(source.queueId).OR ?? [] : []),
            ...(source.visibility === 'NORMAL_INTERNAL' && source.departmentId ? [{ role: 'MANAGER' as const, departmentId: source.departmentId }] : []),
          ],
        };
        Object.assign(where, {
          status: { in: ['NEW', 'REVIEW', 'IN_PROGRESS', 'WAITING_AUTHOR'] }, visibility: source.visibility,
          queueId: source.visibility === 'NORMAL_INTERNAL' ? { not: null } : source.queueId,
          OR: [
            { OR: [{ authorId: null }, { NOT: { authorId: { equals: tx.appeal.fields.assigneeId } } }], assignee: owner },
            { assigneeId: null, queue: { coordinator: owner } },
          ],
        } satisfies Prisma.AppealWhereInput);
      }
      const [items, total] = await Promise.all([
        tx.appeal.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
          select: { id: true, number: true, title: true } }),
        tx.appeal.count({ where }),
      ]);
      return { items, total, page, limit };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private actions(user: Principal, record: Pick<Appeal, 'authorId' | 'status' | 'visibility' | 'resumeState'>, staff: boolean, pending?: ReviewRequestKind) {
    if (record.status === 'IMPLEMENTED') return record.authorId === user.id ? ['CONFIRM_RESULT', 'RETURN_RESULT'] : [];
    if (record.authorId === user.id) {
      return [
        ...(activeAppeal(record.status) ? ['COMMENT', ...(!pending ? ['WITHDRAW'] : [])] : []),
        ...(record.status === 'NEW' ? ['EDIT'] : []),
        ...(record.status === 'WAITING_AUTHOR' ? ['AUTHOR_RESPONSE'] : []),
        ...(!activeAppeal(record.status) && !pending ? ['REVIEW_REQUEST'] : []),
      ];
    }
    if (!staff) return [];
    const actions: string[] = [];
    if (activeAppeal(record.status)) {
      actions.push('EDIT', 'COMMENT');
      if (pending === 'WITHDRAWAL' && this.policy.has(user, 'SENSITIVE_CASE_HANDLER')) actions.push('REVIEW_DECISION');
      if (this.policy.has(user, 'ROUTING_COORDINATOR')) actions.push('ASSIGN', 'REROUTE');
      actions.push('SET_RESOLUTION_DEADLINE');
      if (record.visibility === 'NORMAL_INTERNAL' && this.policy.has(user, 'PROBLEM_OWNER')) actions.push('CREATE_PROBLEM');
      if (record.visibility === 'NORMAL_INTERNAL' && this.policy.has(user, 'IMPROVEMENT_OWNER')) actions.push('CREATE_IMPROVEMENT');
      for (const step of appealTransitions[record.status]) {
        if (step === 'WITHDRAWN' || (step === 'CLOSED' && pending === 'WITHDRAWAL')) continue;
        if (record.status === 'WAITING_AUTHOR') {
          if (user.role === 'MANAGER' && step === record.resumeState) actions.push('RESUME');
          if (user.role === 'MANAGER' && step === 'CLOSED') actions.push('RESOLVE');
          continue;
        }
        actions.push(({ CLOSED: 'RESOLVE', WAITING_AUTHOR: 'CLARIFICATION' } as Record<string, string>)[step] ?? step);
      }
    } else if ((pending === 'RECONSIDERATION' &&
      (record.visibility === 'NORMAL_INTERNAL' ? user.role === 'MANAGER' : this.policy.has(user, 'SENSITIVE_CASE_HANDLER'))) ||
      (pending === 'WITHDRAWAL' && this.policy.has(user, 'SENSITIVE_CASE_HANDLER'))) actions.push('REVIEW_DECISION');
    return actions;
  }

  async detail(user: Principal, appealId: string) {
    return this.db.$transaction(async tx => {
      const record = await tx.appeal.findFirst({
        where: { AND: [{ id: appealId }, this.policy.appeals(user)] },
        select: { ...summary, description: true, proposedSolution: true, resolutionType: true, resolutionText: true, resolutionOrigin: true, waitingSince: true,
          resumeState: true, queueId: true, routingRetryAt: true, closedAt: true, withdrawnAt: true,
          sharedTitle: true, author: { select: { name: true } }, resolutionVersion: true, resolutionConfirmedAt: true,
          assignee: { select: { name: true } }, queue: { select: { name: true } },
          nextActions: { orderBy: { revision: 'desc' }, take: 30 } },
      });
      if (!record) throw new AppError('NOT_FOUND', 'Обращение не найдено или недоступно.', 404);
      const staff = await this.policy.handles(tx, user, appealId);
      const internal = record.authorId !== user.id && this.policy.isStaff(user);
      const hideAssignment = !internal && record.visibility !== 'NORMAL_INTERNAL';
      const [comments, events, attachments, reviews, problems, improvements, links, publications, periods, elapsed] = await Promise.all([
        tx.comment.findMany({ where: { appealId, ...(internal ? {} : { internal: false }) }, orderBy: { createdAt: 'asc' },
          select: { id: true, internal: true, kind: true, body: true, createdAt: true, author: { select: { name: true } } } }),
        tx.auditEvent.findMany({ where: { entity: 'appeal', entityId: appealId, ...(internal ? {} : { authorVisible: true }) },
          orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, action: true, createdAt: true, ...(internal ? { details: true } : {}) } }),
        tx.attachment.findMany({ where: { appealId }, select: attachmentSummary }),
        tx.reviewRequest.findMany({ where: { appealId }, orderBy: { createdAt: 'desc' }, select: { id: true, reason: true, kind: true, decision: true, approved: true, decidedAt: true, createdAt: true } }),
        tx.problem.findMany({ where: { AND: [{ appeals: { some: { appealId } } }, this.policy.problems(user)] }, select: { id: true, title: true, number: true } }),
        tx.improvement.findMany({ where: { AND: [{ appeals: { some: { appealId } } }, this.policy.improvements(user)] }, select: { id: true, title: true, number: true } }),
        tx.appealLink.findMany({ where: { state: { not: 'REJECTED' }, AND: [
          { OR: [{ fromId: appealId }, { toId: appealId }] },
          { from: this.policy.staffAppeals(user), to: this.policy.staffAppeals(user) },
        ] }, include: { from: { select: { id: true, number: true, title: true } }, to: { select: { id: true, number: true, title: true } } } }),
        record.visibility === 'NORMAL_INTERNAL' ? tx.publication.findMany({ where: { AND: [this.policy.publications(user), { improvement: { OR: [
          { appeals: { some: { appealId } } }, { problem: { appeals: { some: { appealId } } } },
        ] } }] }, select: { id: true, title: true, result: true }, orderBy: { publishedAt: 'desc' }, take: 10 }) : [],
        tx.appealWorkPeriod.findMany({ where: { appealId }, select: { phase: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'desc' }, take: 30 }),
        tx.$queryRaw<{ phase: string; seconds: number }[]>`
          SELECT phase, SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE("endedAt", ${new Date()}) - "startedAt"))))::float8 AS seconds
          FROM "AppealWorkPeriod" WHERE "appealId" = ${appealId} GROUP BY phase`,
      ]);
      const allowedActions = this.actions(user, record, staff, reviews.find(review => !review.decidedAt)?.kind);
      if (staff && record.visibility === 'NORMAL_INTERNAL' && record.authorId && record.departmentId &&
        record.status !== 'WITHDRAWN' && this.policy.has(user, 'ROUTING_COORDINATOR')) allowedActions.push('SHARE_TOPIC');
      const authorImprovements = record.authorId === user.id && record.visibility === 'NORMAL_INTERNAL' ?
        await tx.improvement.findMany({
          where: { visibility: 'NORMAL_INTERNAL', OR: [
            { appeals: { some: { appealId } } }, { problem: { appeals: { some: { appealId } } } },
          ] },
          select: { number: true, status: true }, orderBy: { number: 'asc' }, take: 20,
        }) : [];
      const nextActionHistory = record.nextActions.map(({ kind, state, assignedAt, dueAt, reason, ownerId, queueId }) => ({
        kind, state, assignedAt, dueAt, reason: !internal && kind === 'ROUTING' ? 'ROUTING_UNAVAILABLE' : reason,
        ...(internal ? { ownerId, queueId } : {}),
      }));
      return { ...record, sharedTitle: internal ? record.sharedTitle : undefined,
        routingPending: record.routingRetryAt !== null, routingRetryAt: undefined,
        nextActions: undefined, nextAction: nextActionHistory[0] ?? null, nextActionHistory,
        assignee: hideAssignment ? null : record.assignee, queue: hideAssignment ? null : record.queue,
        assigneeId: hideAssignment ? null : record.assigneeId,
        queueId: internal ? record.queueId : undefined, resumeState: undefined, comments, events, attachments, reviews,
        timing: { periods, activeSeconds: elapsed.find(row => row.phase === 'ACTIVE')?.seconds ?? 0,
          waitingSeconds: elapsed.find(row => row.phase === 'WAITING_AUTHOR')?.seconds ?? 0 },
        problems, improvements, authorImprovements, publications, links: internal ? links : [], allowedActions };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async create(user: Principal, input: unknown, key?: string) {
    if (user.role === 'ADMIN' || user.role === 'DIRECTOR') throw forbidden();
    const data = parse(createInput, input);
    const dedupKey = parse(z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/), key);
    const requestHash = digest(JSON.stringify(data));
    const identity = { userId: user.id, route: 'appeals', key: dedupKey };
    const replay = (existing: { requestHash: string; resourceId: string }) => {
      if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_REPLAY', 'Ключ уже использован для другого обращения.', 409);
      return { id: existing.resourceId, replayed: true };
    };
    const prior = await this.db.idempotencyKey.findUnique({ where: { userId_route_key: identity } });
    if (prior) return replay(prior);
    await throttle(this.db, `appeal:${user.id}`, 35, 3600);
    const suggested = await this.intake.classify(this.db, data.description, !data.type && data.visibility === 'NORMAL_INTERNAL' && !data.categoryId);
    return atomic(this.db, async tx => {
      const existing = await tx.idempotencyKey.findUnique({ where: { userId_route_key: identity } });
      if (existing) return replay(existing);
      const category = suggested.categoryId && await tx.category.findFirst({
        where: { id: suggested.categoryId, sensitive: false }, select: { id: true },
      });
      const record = await this.intake.register(tx, {
        authorId: user.id, departmentId: user.departmentId, isSynthetic: user.demo,
        type: data.type ?? suggested.type, title: data.title ?? suggested.title,
        descriptionOriginal: data.description, description: data.description, proposedSolution: data.proposedSolution,
        priority: data.type ? 'MEDIUM' : suggested.priority,
        categoryId: data.categoryId ?? (data.type || data.visibility !== 'NORMAL_INTERNAL' ? null : category ? category.id : null),
        processId: data.processId, visibility: data.visibility,
      });
      await claimAttachments(tx, user.id, data.attachmentIds, { appealId: record.id });
      if (record.visibility === 'NORMAL_INTERNAL' && record.departmentId && (record.processId || record.categoryId)) {
        const matches: Prisma.AppealWhereInput[] = [];
        if (record.processId) matches.push({ processId: record.processId });
        if (record.categoryId) matches.push({ categoryId: record.categoryId });
        const previous = await tx.appeal.findMany({ where: { visibility: 'NORMAL_INTERNAL', departmentId: record.departmentId,
          OR: matches, improvements: { some: { improvement: { visibility: 'NORMAL_INTERNAL', implementedAt: { lt: record.createdAt } } } },
        }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true } });
        if (previous.length) await tx.appealLink.createMany({ data: previous.map(source => {
          const [fromId, toId] = [record.id, source.id].sort();
          return { fromId, toId, relation: 'POSSIBLE_RECURRENCE', proposedBy: 'SYSTEM_RULE',
            explanation: 'Новое обращение поступило после внедрения. Совпадает категория или процесс исходного обращения.' };
        }), skipDuplicates: true });
      }
      await tx.idempotencyKey.create({ data: { ...identity, requestHash, resourceId: record.id } });
      return { id: record.id, number: record.number, replayed: false };
    }).catch(async error => {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existing = await this.db.idempotencyKey.findUnique({ where: { userId_route_key: identity } });
      if (!existing) throw error;
      return replay(existing);
    });
  }

  async edit(user: Principal, appealId: string, input: unknown) {
    const { expectedVersion: version, ...updates } = parse(editInput, input);
    await atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      assertVersion(record.version, version);
      const staff = await this.policy.handles(tx, user, appealId);
      if (!this.actions(user, record, staff).includes('EDIT')) throw forbidden();
      if (staff && updates.description !== undefined) throw forbidden();
      if (!staff && updates.priority !== undefined) throw forbidden();
      if (updates.categoryId && (await tx.category.findUnique({ where: { id: updates.categoryId } }))?.sensitive && record.visibility !== 'SPECIAL') {
        throw invalid('Выберите специальную очередь при подаче обращения этой категории.');
      }
      if (updates.priority && updates.priority !== record.priority) {
        const sla = await tx.slaPolicy.findFirst({ where: { priority: updates.priority, active: true } });
        await checked(tx.appeal.updateMany({ where: { id: appealId, version }, data: { ...updates, version: { increment: 1 },
          dueAt: sla ? businessDeadline(new Date(), sla.nextActionHours) : null,
          firstResponseDueAt: record.firstHumanResponseAt ? record.firstResponseDueAt : sla ? businessDeadline(record.createdAt, sla.firstResponseHours) : null,
          slaVersion: sla?.version ?? null } }));
      } else await checked(tx.appeal.updateMany({ where: { id: appealId, version }, data: { ...updates, version: { increment: 1 } } }));
      await audit(tx, 'appeal', appealId, 'UPDATED', user.id, true, { fields: Object.keys(updates), ...(updates.description ? { previousDescription: record.description } : {}) });
    });
    return this.detail(user, appealId);
  }

  private async resolution(tx: Tx, user: Principal, record: Appeal, input: Mutation) {
    if (!input.resolutionType || !input.text) throw invalid('Укажите тип и обоснование решения.');
    if (input.resolutionType === 'REJECTED' && user.role !== 'MANAGER') throw forbidden();
    if (record.status === 'WAITING_AUTHOR' && input.resolutionType !== 'INSUFFICIENT_INFO') throw invalidState('Возобновите обращение перед обычным закрытием.');
    if (input.resolutionType === 'INSUFFICIENT_INFO') {
      if (record.status !== 'WAITING_AUTHOR' || !record.waitingSince || Date.now() - record.waitingSince.getTime() < 72 * 3600000) {
        throw invalidState('Дождитесь истечения трёх суток после запроса уточнения.');
      }
      const key = clarificationKey(record.id, record.waitingSince);
      const reminder = record.authorId === null
        ? await tx.auditEvent.findUnique({ where: { id: key } })
        : await tx.notification.findUnique({ where: { key } });
      if (!reminder) throw invalidState('Сначала должно быть отправлено напоминание автору.');
    }
    if (input.resolutionType === 'ACCEPTED_FOR_IMPROVEMENT') {
      const linked = await tx.improvement.findFirst({ where: { AND: [{ id: input.relatedId ?? '', appeals: { some: { appealId: record.id } } }, this.policy.improvements(user)] } });
      if (!linked) throw invalid('Укажите связанное доступное улучшение.');
    }
    if (['LINKED_TO_EXISTING_CASE', 'ALREADY_ADDRESSED', 'TRANSFERRED'].includes(input.resolutionType)) {
      const other = input.relatedId && await tx.appeal.findFirst({ where: { AND: [{ id: input.relatedId }, this.policy.staffAppeals(user)] } });
      if (!other || other.id === record.id) throw invalid('Укажите другое доступное обращение с ответственным.');
      if (input.resolutionType === 'TRANSFERRED') {
        if (!activeAppeal(other.status) || record.visibility !== other.visibility ||
          (record.visibility !== 'NORMAL_INTERNAL' && record.queueId !== other.queueId)) {
          throw invalid('Передача возможна в активное обращение с совместимым классом доступа.');
        }
        if (!other.queueId) throw invalid('Целевое обращение ожидает назначения.');
        const queue = await tx.workQueue.findUniqueOrThrow({ where: { id: other.queueId } });
        const owner = await tx.user.findFirst({ where: { id: other.assigneeId ?? queue.coordinatorId,
          ...eligibleStaff(other.visibility), ...queueStaff(other.queueId) }, select: principalSelect });
        if (!owner || owner.id === other.authorId) throw invalid('У целевого обращения нет действующего ответственного.');
        const sourceReadable = await tx.appeal.count({ where: { AND: [{ id: record.id }, this.policy.appeals(owner)] } });
        if (!sourceReadable) throw invalid('Ответственному за целевое обращение нужен доступ к исходному сигналу.');
        const transfer = await audit(tx, 'appeal', other.id, 'TRANSFER_RECEIVED', user.id, false, { ownerId: owner.id });
        await notify(tx, transfer.id, [owner.id], 'TRANSFER_RECEIVED', `/appeals/${other.id}`);
      }
      const [fromId, toId] = [record.id, other.id].sort();
      const relation = 'RELATED_CONTEXT';
      const explanation = record.authorId === null ? 'Решение зафиксировано в защищённой переписке.' : input.text;
      await tx.appealLink.upsert({ where: { fromId_toId_relation: { fromId, toId, relation } },
        create: { fromId, toId, relation, explanation, state: 'CONFIRMED', confirmedBy: user.id },
        update: { state: 'CONFIRMED', explanation, confirmedBy: user.id, version: { increment: 1 } } });
    }
  }

  async mutate(user: Principal, appealId: string, raw: unknown, action?: Mutation['action']) {
    const input = parse(mutationInput, action && raw && typeof raw === 'object' ? { ...raw, action } : raw);
    await atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      assertVersion(record.version, input.expectedVersion);
      const staff = await this.policy.handles(tx, user, appealId);
      const pending = await tx.reviewRequest.findFirst({ where: { appealId, decidedAt: null }, orderBy: { createdAt: 'desc' } });
      if (!this.actions(user, record, staff, pending?.kind).includes(input.action)) throw invalidState();
      const now = new Date();
      const data: Prisma.AppealUncheckedUpdateManyInput = { version: { increment: 1 } };
      let event: string = input.action;
      let visible = true;
      let comment = false;
      const queue = record.queueId ? await tx.workQueue.findUniqueOrThrow({ where: { id: record.queueId } }) : null;
      let recipients: (string | null | undefined)[] = [staff ? record.authorId : record.assigneeId ?? queue?.coordinatorId];
      switch (input.action) {
        case 'COMMENT':
          if (!input.text || (input.internal && !staff)) throw forbidden();
          visible = !input.internal;
          event = visible ? 'COMMENT' : 'INTERNAL_NOTE';
          if (!visible) recipients = [];
          comment = true;
          break;
        case 'CLARIFICATION':
          if (!input.text) throw invalid('Напишите конкретный вопрос автору.');
          Object.assign(data, { status: 'WAITING_AUTHOR', waitingSince: now, resumeState: record.status });
          comment = true;
          break;
        case 'AUTHOR_RESPONSE':
        case 'RESUME':
          if (!input.text || !record.resumeState) throw invalid('Укажите ответ или обоснование.');
          Object.assign(data, { status: record.resumeState, waitingSince: null, resumeState: null });
          comment = input.action === 'AUTHOR_RESPONSE';
          break;
        case 'REVIEW':
        case 'IN_PROGRESS':
          if (record.status === 'IN_PROGRESS' && !input.text) throw invalid('Укажите причину возврата на рассмотрение.');
          data.status = input.action;
          if (!record.assigneeId) data.assigneeId = user.id;
          break;
        case 'RESOLVE': {
          if (pending?.kind === 'WITHDRAWAL') throw invalidState('Сначала рассмотрите запрос на отзыв.');
          await this.resolution(tx, user, record, input);
          const reviewable = !!record.authorId && input.resolutionType === 'RESOLVED';
          Object.assign(data, { status: reviewable ? 'IMPLEMENTED' : 'CLOSED', resolutionType: input.resolutionType,
            resolutionText: record.authorId === null ? 'Решение доступно в защищённой переписке.' : input.text, resolutionOrigin: 'USER_ACTION',
            resolutionBy: user.id, closedAt: reviewable ? null : now, waitingSince: null, resumeState: null,
            resolutionConfirmedAt: null, ...(reviewable ? { resolutionVersion: { increment: 1 } } : {}) });
          event = reviewable ? 'RESULT_SUBMITTED' : 'RESOLVED_EVENT';
          break;
        }
        case 'WITHDRAW':
          if (!input.text) throw invalid('Укажите причину отзыва.');
          if (record.visibility !== 'NORMAL_INTERNAL') {
            await tx.reviewRequest.create({ data: { appealId, authorId: user.id, reason: input.text, kind: 'WITHDRAWAL' } });
            event = 'WITHDRAWAL_REQUEST';
          } else {
            Object.assign(data, { status: 'WITHDRAWN', withdrawnAt: now, waitingSince: null, resumeState: null });
            event = 'WITHDRAWN';
          }
          break;
        case 'REVIEW_REQUEST':
          if (!input.text) throw invalid('Объясните, что нужно пересмотреть.');
          await tx.reviewRequest.create({ data: { appealId, authorId: user.id, reason: input.text } });
          break;
        case 'REVIEW_DECISION': {
          if (!pending || !input.text || input.approve === undefined) throw invalid('Укажите решение по запросу и причину.');
          const withdrawal = pending.kind === 'WITHDRAWAL';
          if (withdrawal && !this.policy.has(user, 'SENSITIVE_CASE_HANDLER')) throw forbidden();
          if (input.approve && withdrawal !== activeAppeal(record.status)) throw invalidState('Состояние обращения изменилось. Отклоните запрос с обоснованием.');
          await tx.reviewRequest.update({ where: { id: pending.id }, data: { decision: input.text, approved: input.approve, decidedBy: user.id, decidedAt: now } });
          if (input.approve && withdrawal) {
            Object.assign(data, { status: 'WITHDRAWN', withdrawnAt: now, waitingSince: null, resumeState: null });
          } else if (input.approve) {
            Object.assign(data, { status: 'REVIEW', closedAt: null, withdrawnAt: null, resolutionType: null, resolutionText: null,
              resolutionBy: null, resolutionOrigin: null, resolutionConfirmedAt: null });
          }
          break;
        }
        case 'ASSIGN': {
          if (!record.queueId || !queue) throw invalidState('Обращение ожидает маршрутизации.');
          if (!input.text || input.assigneeId === undefined) throw invalid('Укажите ответственного и причину назначения.');
          if (input.assigneeId) {
            const target = await tx.user.findFirst({ where: { id: input.assigneeId, ...eligibleStaff(record.visibility), ...queueStaff(record.queueId) } });
            if (!target || target.id === record.authorId) throw invalid('Пользователь не состоит в нужной очереди.');
          }
          if (!input.assigneeId && queue.coordinatorId === record.authorId) throw invalid('Выберите обработчика, который не является автором.');
          data.assigneeId = input.assigneeId;
          recipients = [record.authorId, input.assigneeId ?? queue.coordinatorId];
          event = 'ASSIGNED';
          break;
        }
      }
      if (data.status === 'WITHDRAWN' && !record.queueId) data.routingRetryAt = null;
      if (comment || data.status) data.lastMeaningfulActionAt = now;
      if (staff && visible && input.text && (comment || input.action === 'RESOLVE') && (!record.firstHumanResponseAt || record.firstResponseOrigin === 'DEMO_FIXTURE' || record.firstResponseOrigin === 'UNKNOWN')) {
        data.firstHumanResponseAt = now;
        data.firstResponseOrigin = 'USER_ACTION';
      }
      if (data.status && ['REVIEW', 'IN_PROGRESS'].includes(String(data.status))) {
        const sla = await tx.slaPolicy.findFirst({ where: { priority: record.priority, active: true } });
        data.dueAt = sla ? businessDeadline(now, sla.nextActionHours) : null;
        data.slaVersion = sla?.version ?? null;
      }
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: input.expectedVersion }, data }));
      if (record.authorId === null && input.action === 'RESOLVE' && input.text) {
        await anonymousStaffMessage(tx, appealId, input.text, 'RESOLUTION');
      }
      if (comment && input.text) {
        if (record.authorId === null && visible) await anonymousStaffMessage(tx, appealId, input.text);
        else await tx.comment.create({ data: { appealId, authorId: user.id, body: input.text, internal: !visible, kind: event, origin: 'USER_ACTION' } });
      }
      const entry = await audit(tx, 'appeal', appealId, event, user.id, visible, { previous: record.status,
        next: typeof data.status === 'string' ? data.status : record.status,
        ...(input.text && !comment && !(record.authorId === null && input.action === 'RESOLVE') ? { reason: input.text } : {}) });
      await notify(tx, entry.id, recipients, event, `/appeals/${appealId}`);
    });
    return this.detail(user, appealId);
  }

  async reviewResult(user: Principal, appealId: string, raw: unknown) {
    const input = parse(resultInput, raw);
    if (!input.confirm && !input.reason) throw invalid('Объясните, что нужно доработать.');
    await atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      if (record.authorId !== user.id || record.resolutionBy === user.id) throw forbidden();
      assertVersion(record.resolutionVersion, input.expectedVersion);
      const previous = await tx.appealResolutionReview.findUnique({ where: { appealId_version: { appealId, version: input.expectedVersion } } });
      if (previous) {
        if (previous.confirmed === input.confirm && previous.reason === (input.reason ?? null)) return;
        throw invalidState('Эта версия результата уже проверена.');
      }
      if (record.status !== 'IMPLEMENTED' || !record.resolutionText?.trim()) throw invalidState();
      const now = new Date();
      const status = input.confirm ? 'CLOSED' : 'IN_PROGRESS';
      const sla = !input.confirm ? await tx.slaPolicy.findFirst({ where: { priority: record.priority, active: true } }) : null;
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: record.version }, data: {
        status, version: { increment: 1 }, lastMeaningfulActionAt: now, closedAt: input.confirm ? now : null,
        resolutionConfirmedAt: input.confirm ? now : null,
        ...(!input.confirm ? { resolutionType: null, resolutionText: null, resolutionOrigin: null,
          dueAt: sla ? businessDeadline(now, sla.nextActionHours) : null, slaVersion: sla?.version ?? null } : {}),
      } }));
      await tx.appealResolutionReview.create({ data: { appealId, version: input.expectedVersion, authorId: user.id,
        confirmed: input.confirm, reason: input.reason, snapshot: record.resolutionText } });
      if (input.reason) await tx.comment.create({ data: { appealId, authorId: user.id, body: input.reason,
        internal: false, kind: input.confirm ? 'RESULT_CONFIRMED' : 'RESULT_REWORK', origin: 'USER_ACTION' } });
      const kind = input.confirm ? 'RESULT_CONFIRMED' : 'RESULT_REWORK';
      const event = await audit(tx, 'appeal', appealId, kind, user.id, true, { next: status, version: input.expectedVersion });
      const queue = record.queueId ? await tx.workQueue.findUnique({ where: { id: record.queueId }, select: { coordinatorId: true } }) : null;
      await notify(tx, event.id, [record.assigneeId ?? queue?.coordinatorId], kind, '/appeals/' + appealId);
    });
    return this.detail(user, appealId);
  }

  async setDeadline(user: Principal, appealId: string, raw: unknown) {
    const input = parse(deadlineInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      if (!await this.policy.handles(tx, user, appealId)) throw forbidden();
      assertVersion(record.version, input.expectedVersion);
      if (!activeAppeal(record.status)) throw invalidState();
      if ((record.resolutionDueAt?.getTime() ?? null) === (input.dueAt?.getTime() ?? null)) return;
      if (input.dueAt && input.dueAt <= new Date()) throw invalid('Срок должен быть в будущем.');
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: record.version }, data: {
        resolutionDueAt: input.dueAt, version: { increment: 1 },
      } }));
      const event = await audit(tx, 'appeal', appealId, 'RESOLUTION_DEADLINE_CHANGED', user.id, true, {
        previousDueAt: record.resolutionDueAt?.toISOString() ?? null, dueAt: input.dueAt?.toISOString() ?? null, reason: input.reason,
      });
      await notify(tx, event.id, [record.authorId], 'RESOLUTION_DEADLINE_CHANGED', '/appeals/' + appealId);
    });
    return this.detail(user, appealId);
  }

  async reroute(user: Principal, appealId: string, raw: unknown) {
    const input = parse(rerouteInput, raw);
    return atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      if (!this.policy.has(user, 'ROUTING_COORDINATOR') || !await this.policy.handles(tx, user, appealId)) throw forbidden();
      if (!activeAppeal(record.status)) throw invalidState();
      const categoryId = input.categoryId === undefined ? record.categoryId : input.categoryId;
      const processId = input.processId === undefined ? record.processId : input.processId;
      const route = await this.routing.route(tx, { categoryId, processId, visibility: record.visibility,
        authorId: record.authorId, departmentId: record.departmentId, demo: record.authorId === null ? record.isSynthetic : undefined });
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: input.expectedVersion }, data: {
        categoryId, processId, visibility: route.visibility, queueId: route.queueId, assigneeId: route.assigneeId,
        routingReason: null, routingRetryAt: null,
        ...(route.visibility !== 'NORMAL_INTERNAL' ? { sharedTitle: null } : {}),
        version: { increment: 1 },
      } }));
      const entry = await audit(tx, 'appeal', appealId, 'REROUTED', user.id, true, { reason: input.text, rule: route.reason,
        previousQueueId: record.queueId, queueId: route.queueId, previousAssigneeId: record.assigneeId, assigneeId: route.assigneeId });
      await notify(tx, entry.id, [record.authorId, route.assigneeId ?? route.coordinatorId], 'REROUTED', `/appeals/${appealId}`);
      return { id: appealId, readable: !!await tx.appeal.count({ where: { AND: [{ id: appealId }, this.policy.appeals(user)] } }) };
    });
  }

  async dictionaries(user: Principal, appealId?: string) {
    let people: { id: string; name: string }[] = [];
    if (appealId && await this.policy.handles(this.db, user, appealId)) {
      const record = await this.policy.appeal(this.db, user, appealId);
      if (record.queueId) people = await this.db.user.findMany({
        where: { id: { not: record.authorId ?? undefined }, ...eligibleStaff(record.visibility), ...queueStaff(record.queueId) },
        select: { id: true, name: true }, orderBy: { name: 'asc' },
      });
    }
    const [categories, processes, departments] = await Promise.all([
      this.db.category.findMany({ select: { id: true, name: true, sensitive: true }, orderBy: { name: 'asc' } }),
      this.db.businessProcess.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.db.organizationUnit.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ]);
    return { categories, processes, departments, people };
  }
}

@ApiTags('Обращения')
@Controller()
export class AppealsController {
  constructor(@Inject(Appeals) private readonly service: Appeals) {}
  @Get('catalog') catalog(@Req() req: AuthRequest, @Query('appealId') appealId?: string) { return this.service.dictionaries(req.user, appealId); }
  @Get('appeals') @QueryFields(appealListInput) list(@Req() req: AuthRequest, @Query() query: unknown) { return this.service.list(req.user, query); }
  @Get('work-queue/assignees') assignees(@Req() req: AuthRequest) { return this.service.assignees(req.user); }
  @Get('work-queue') @QueryFields(appealListInput) queue(@Req() req: AuthRequest, @Query() query: unknown) { return this.service.list(req.user, query, true); }
  @Post('appeals') @JsonBody(createInput, { description: 'Предлагаю добавить поле для ожидаемого срока.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(@Req() req: AuthRequest, @Body() input: unknown, @Headers('idempotency-key') key?: string) { return this.service.create(req.user, input, key); }
  @Get('appeals/:id') detail(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.detail(req.user, item); }
  @Get('appeals/:id/resolution-targets') @QueryFields(resolutionTargetsInput)
  resolutionTargets(@Req() req: AuthRequest, @Param('id') item: string, @Query() query: unknown) { return this.service.resolutionTargets(req.user, item, query); }
  @Patch('appeals/:id') @JsonBody(editInput) edit(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.edit(req.user, item, input); }
  @Post('appeals/:id/transition') @JsonBody(mutationInput) mutate(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.mutate(req.user, item, input); }
  @Post('appeals/:id/reroute') @JsonBody(rerouteInput) reroute(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.reroute(req.user, item, input); }
  @Post('appeals/:id/result-review') @JsonBody(resultInput) result(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.reviewResult(req.user, item, input); }
  @Post('appeals/:id/resolution-deadline') @JsonBody(deadlineInput) deadline(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.setDeadline(req.user, item, input); }
  @Post('appeals/:id/:operation') @JsonBody(mutationInput.omit({ action: true })) operation(@Req() req: AuthRequest, @Param('id') item: string, @Param('operation') operation: string, @Body() input: unknown) {
    const actions: Record<string, Mutation['action']> = {
      assign: 'ASSIGN', 'request-clarification': 'CLARIFICATION', 'respond-clarification': 'AUTHOR_RESPONSE',
      resolve: 'RESOLVE', withdraw: 'WITHDRAW', 'review-request': 'REVIEW_REQUEST', 'review-decision': 'REVIEW_DECISION', comments: 'COMMENT',
    };
    if (!Object.hasOwn(actions, operation)) throw new AppError('NOT_FOUND', 'Действие не найдено.', 404);
    return this.service.mutate(req.user, item, input, actions[operation]);
  }
  @Get('appeals/:id/comments') async comments(@Req() req: AuthRequest, @Param('id') item: string) { return (await this.service.detail(req.user, item)).comments; }
  @Get('appeals/:id/events') async events(@Req() req: AuthRequest, @Param('id') item: string) { return (await this.service.detail(req.user, item)).events; }
  @Get('appeals/:id/related') async related(@Req() req: AuthRequest, @Param('id') item: string) {
    const { links, problems, improvements, publications } = await this.service.detail(req.user, item);
    return { links, problems, improvements, publications };
  }
}
