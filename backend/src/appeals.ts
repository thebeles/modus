import { Body, Controller, Get, Headers, Inject, Injectable, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import { Appeal, Prisma, ReviewRequestKind } from '@prisma/client';
import { z } from 'zod';
import { appealStatuses, appealTypes, priorities, resolutions, visibilities } from './contracts';
import { AuthRequest } from './auth';
import { AppError, allocate, assertVersion, atomic, audit, bodyText, checked, Database, dateTime, digest, expectedVersion, forbidden, id, invalid, invalidState, notify, pagination, parse, throttle, title, Tx } from './common';
import { attachmentSummary, claimAttachments } from './files';
import { Policy, Principal, principalSelect } from './policy';
import { eligibleStaff, queueStaff, Routing } from './routing';
import { activeAppeal, appealTransitions, businessDeadline, clarificationKey } from './workflow';

export const appealListInput = z.strictObject({
  ...pagination, q: z.string().trim().max(150).optional(), status: z.enum(appealStatuses).optional(),
  type: z.enum(appealTypes).optional(), priority: z.enum(priorities).optional(), categoryId: id.optional(),
  departmentId: id.optional(), processId: id.optional(), assigneeId: id.optional(),
  tab: z.enum(['mine', 'new', 'waiting', 'risk', 'overdue', 'stale', 'all']).optional(),
  own: z.enum(['true', 'false']).optional(), normalOnly: z.enum(['true']).optional(), sort: z.enum(['recent', 'oldest', 'due']).default('recent'),
  from: dateTime.optional(), to: dateTime.optional(),
});
const createInput = z.strictObject({
  type: z.enum(appealTypes), title: title.optional(), description: bodyText,
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
const active: Prisma.AppealWhereInput = { status: { notIn: ['CLOSED', 'WITHDRAWN', 'WAITING_AUTHOR'] } };
export function appealQueueFilters(user: Principal, now: Date) {
  const liveOwner = (visibility: Appeal['visibility']): Prisma.AppealWhereInput => ({
    visibility, OR: [
      { assignee: eligibleStaff(visibility) },
      { assigneeId: null, queue: { coordinator: eligibleStaff(visibility) } },
    ],
  });
  const tabs = {
    all: {},
    mine: { AND: [active, { authorId: { not: user.id }, OR: [
      { assigneeId: user.id }, { assigneeId: null, queue: { coordinatorId: user.id } },
    ] }] },
    new: { AND: [active, { OR: [{ status: 'NEW' }, { assigneeId: null }] }] },
    waiting: { status: 'WAITING_AUTHOR' },
    risk: { controlDueAt: { gte: now, lte: new Date(now.getTime() + 86400000) } },
    overdue: { controlDueAt: { lt: now } },
    stale: { AND: [active, { OR: [
      { lastMeaningfulActionAt: { lt: new Date(now.getTime() - 3 * 86400000) } },
      { NOT: { OR: visibilities.map(liveOwner) } },
    ] }] },
  } satisfies Record<string, Prisma.AppealWhereInput>;
  return tabs;
}

const summary = {
  id: true, number: true, title: true, type: true, status: true, priority: true, visibility: true,
  authorId: true, assigneeId: true, departmentId: true, categoryId: true, processId: true,
  category: { select: { name: true } }, process: { select: { name: true } }, department: { select: { name: true } },
  createdAt: true, updatedAt: true, lastMeaningfulActionAt: true, controlDueAt: true, dueAt: true, firstResponseDueAt: true, firstHumanResponseAt: true,
  closedAt: true, isSynthetic: true, seedOrigin: true, version: true,
} satisfies Prisma.AppealSelect;

@Injectable()
export class Appeals {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy,
    @Inject(Routing) private readonly routing: Routing) {}

  where(user: Principal, filters: z.output<typeof appealListInput>, staff = false, now = new Date()): Prisma.AppealWhereInput {
    const { status, type, priority, categoryId, departmentId, processId, assigneeId, q, own, normalOnly, tab, from, to } = filters;
    const tabs = appealQueueFilters(user, now);
    return { AND: [
      staff ? this.policy.staffAppeals(user) : this.policy.appeals(user),
      { status, type, priority, categoryId, departmentId, processId, assigneeId, ...(from || to ? { createdAt: { gte: from, lt: to } } : {}) },
      own === 'true' ? { authorId: user.id } : {},
      normalOnly === 'true' ? { visibility: 'NORMAL_INTERNAL' } : {},
      tab ? tabs[tab] : {},
      q ? { OR: ['title', 'description', 'number'].map(field => ({ [field]: { contains: q, mode: 'insensitive' } })) } : {},
    ] };
  }

  async list(user: Principal, input: unknown, staff = false) {
    if (staff && !this.policy.isStaff(user)) throw forbidden();
    const filters = parse(appealListInput, input);
    const { page, limit, sort } = filters;
    const where = this.where(user, filters, staff);
    const orderBy: Prisma.AppealOrderByWithRelationInput = sort === 'due' ? { controlDueAt: { sort: 'asc', nulls: 'last' } } :
      { createdAt: sort === 'oldest' ? 'asc' : 'desc' };
    const [items, total] = await this.db.$transaction([
      this.db.appeal.findMany({ where, orderBy: [orderBy, { id: 'asc' }], skip: (page - 1) * limit, take: limit, select: summary }),
      this.db.appeal.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items: items.map(row => row.authorId === user.id && row.visibility !== 'NORMAL_INTERNAL' ? { ...row, assigneeId: null } : row),
      total, page, limit };
  }

  private actions(user: Principal, record: Pick<Appeal, 'authorId' | 'status' | 'visibility' | 'resumeState'>, staff: boolean, pending?: ReviewRequestKind) {
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
    } else if ((pending === 'RECONSIDERATION' && user.role === 'MANAGER') ||
      (pending === 'WITHDRAWAL' && this.policy.has(user, 'SENSITIVE_CASE_HANDLER'))) actions.push('REVIEW_DECISION');
    return actions;
  }

  async detail(user: Principal, appealId: string) {
    return this.db.$transaction(async tx => {
      const record = await tx.appeal.findFirst({
        where: { AND: [{ id: appealId }, this.policy.appeals(user)] },
        select: { ...summary, description: true, proposedSolution: true, resolutionType: true, resolutionText: true, waitingSince: true,
          resumeState: true, queueId: true, closedAt: true, withdrawnAt: true,
          assignee: { select: { name: true } }, queue: { select: { name: true } } },
      });
      if (!record) throw new AppError('NOT_FOUND', 'Обращение не найдено или недоступно.', 404);
      const staff = await this.policy.handles(tx, user, appealId);
      const internal = record.authorId !== user.id && this.policy.isStaff(user);
      const hideAssignment = !internal && record.visibility !== 'NORMAL_INTERNAL';
      const [comments, events, attachments, reviews, problems, improvements, links, publications] = await Promise.all([
        tx.comment.findMany({ where: { appealId, ...(internal ? {} : { internal: false }) }, orderBy: { createdAt: 'asc' },
          select: { id: true, internal: true, kind: true, body: true, createdAt: true, author: { select: { name: true } } } }),
        tx.auditEvent.findMany({ where: { entity: 'appeal', entityId: appealId, ...(internal ? {} : { authorVisible: true }) },
          orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, action: true, createdAt: true, ...(internal ? { details: true } : {}) } }),
        tx.attachment.findMany({ where: { appealId }, select: attachmentSummary }),
        tx.reviewRequest.findMany({ where: { appealId }, orderBy: { createdAt: 'desc' }, select: { id: true, reason: true, kind: true, decision: true, decidedAt: true, createdAt: true } }),
        tx.problem.findMany({ where: { AND: [{ appeals: { some: { appealId } } }, this.policy.problems(user)] }, select: { id: true, title: true, number: true } }),
        tx.improvement.findMany({ where: { AND: [{ appeals: { some: { appealId } } }, this.policy.improvements(user)] }, select: { id: true, title: true, number: true } }),
        tx.appealLink.findMany({ where: { state: { not: 'REJECTED' }, AND: [
          { OR: [{ fromId: appealId }, { toId: appealId }] },
          { from: this.policy.staffAppeals(user), to: this.policy.staffAppeals(user) },
        ] }, include: { from: { select: { id: true, number: true, title: true } }, to: { select: { id: true, number: true, title: true } } } }),
        record.visibility === 'NORMAL_INTERNAL' ? tx.publication.findMany({ where: { AND: [this.policy.publications(user), { improvement: { OR: [
          { appeals: { some: { appealId } } }, { problem: { appeals: { some: { appealId } } } },
        ] } }] }, select: { id: true, title: true, result: true }, orderBy: { publishedAt: 'desc' }, take: 10 }) : [],
      ]);
      const allowedActions = this.actions(user, record, staff, reviews.find(review => !review.decidedAt)?.kind);
      return { ...record, assignee: hideAssignment ? null : record.assignee, queue: hideAssignment ? null : record.queue,
        assigneeId: hideAssignment ? null : record.assigneeId,
        queueId: internal ? record.queueId : undefined, resumeState: undefined, comments, events, attachments, reviews,
        problems, improvements, publications, links: internal ? links : [], allowedActions };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async create(user: Principal, input: unknown, key?: string) {
    if (user.role === 'ADMIN') throw forbidden();
    const data = parse(createInput, input);
    const dedupKey = parse(z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/), key);
    const requestHash = digest(JSON.stringify(data));
    await throttle(this.db, `appeal:${user.id}`, 35, 3600);
    const identity = { userId: user.id, route: 'appeals', key: dedupKey };
    const replay = (existing: { requestHash: string; resourceId: string }) => {
      if (existing.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_REPLAY', 'Ключ уже использован для другого обращения.', 409);
      return { id: existing.resourceId, replayed: true };
    };
    return atomic(this.db, async tx => {
      const existing = await tx.idempotencyKey.findUnique({ where: { userId_route_key: identity } });
      if (existing) return replay(existing);
      const route = await this.routing.route(tx, { ...data, authorId: user.id, departmentId: user.departmentId });
      const sla = await tx.slaPolicy.findFirst({ where: { priority: 'MEDIUM', active: true } });
      const createdAt = new Date();
      const record = await tx.appeal.create({ data: {
        number: await allocate(tx, 'A'), authorId: user.id, departmentId: user.departmentId, isSynthetic: user.demo,
        type: data.type, title: data.title ?? (data.description.slice(0, 85).split('\n')[0].trim() || 'Новое обращение'),
        descriptionOriginal: data.description, description: data.description, proposedSolution: data.proposedSolution,
        categoryId: data.categoryId, processId: data.processId, visibility: route.visibility, assigneeId: route.assigneeId, queueId: route.queueId,
        dueAt: sla ? businessDeadline(createdAt, sla.nextActionHours) : null,
        firstResponseDueAt: sla ? businessDeadline(createdAt, sla.firstResponseHours) : null, slaVersion: sla?.version,
      } });
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
      const event = await audit(tx, 'appeal', record.id, 'CREATED', user.id, true);
      if (route.reason !== 'MATCH') await audit(tx, 'appeal', record.id, route.reason === 'SPECIAL_ROUTE' ? 'ASSIGNED' : 'ROUTING_FALLBACK', user.id, false, { reason: route.reason });
      await notify(tx, event.id, [user.id], 'REGISTRATION_CONFIRMED', `/appeals/${record.id}`);
      await notify(tx, event.id, [route.assigneeId ?? route.coordinatorId], 'CREATED', `/appeals/${record.id}`);
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
      const reminder = await tx.notification.findUnique({ where: { key: clarificationKey(record.id, record.waitingSince) } });
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
      await tx.appealLink.upsert({ where: { fromId_toId_relation: { fromId, toId, relation } },
        create: { fromId, toId, relation, explanation: input.text, state: 'CONFIRMED', confirmedBy: user.id },
        update: { state: 'CONFIRMED', explanation: input.text, confirmedBy: user.id, version: { increment: 1 } } });
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
      const queue = await tx.workQueue.findUniqueOrThrow({ where: { id: record.queueId } });
      let recipients: (string | null)[] = [staff ? record.authorId : record.assigneeId ?? queue.coordinatorId];
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
        case 'RESOLVE':
          if (pending?.kind === 'WITHDRAWAL') throw invalidState('Сначала рассмотрите запрос на отзыв.');
          await this.resolution(tx, user, record, input);
          Object.assign(data, { status: 'CLOSED', resolutionType: input.resolutionType, resolutionText: input.text,
            resolutionBy: user.id, closedAt: now, waitingSince: null, resumeState: null });
          event = 'RESOLVED_EVENT';
          break;
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
          await tx.reviewRequest.update({ where: { id: pending.id }, data: { decision: input.text, decidedAt: now } });
          if (input.approve && withdrawal) {
            Object.assign(data, { status: 'WITHDRAWN', withdrawnAt: now, waitingSince: null, resumeState: null });
          } else if (input.approve) {
            Object.assign(data, { status: 'REVIEW', closedAt: null, withdrawnAt: null, resolutionType: null, resolutionText: null, resolutionBy: null });
          }
          break;
        }
        case 'ASSIGN': {
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
      if (comment || data.status) data.lastMeaningfulActionAt = now;
      if (staff && visible && input.text && (comment || input.action === 'RESOLVE') && !record.firstHumanResponseAt) data.firstHumanResponseAt = now;
      if (data.status && data.status !== 'WAITING_AUTHOR' && data.status !== 'CLOSED' && data.status !== 'WITHDRAWN') {
        const sla = await tx.slaPolicy.findFirst({ where: { priority: record.priority, active: true } });
        data.dueAt = sla ? businessDeadline(now, sla.nextActionHours) : null;
        data.slaVersion = sla?.version ?? null;
      }
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: input.expectedVersion }, data }));
      if (comment && input.text) await tx.comment.create({ data: { appealId, authorId: user.id, body: input.text, internal: !visible, kind: event } });
      const entry = await audit(tx, 'appeal', appealId, event, user.id, visible, { previous: record.status,
        next: typeof data.status === 'string' ? data.status : record.status,
        ...(input.text && !comment ? { reason: input.text } : {}) });
      await notify(tx, entry.id, recipients, event, `/appeals/${appealId}`);
    });
    return this.detail(user, appealId);
  }

  async reroute(user: Principal, appealId: string, raw: unknown) {
    const input = parse(z.strictObject({ expectedVersion, text: bodyText,
      categoryId: id.nullable().optional(), processId: id.nullable().optional() }), raw);
    return atomic(this.db, async tx => {
      const record = await this.policy.appeal(tx, user, appealId);
      if (!this.policy.has(user, 'ROUTING_COORDINATOR') || !await this.policy.handles(tx, user, appealId)) throw forbidden();
      if (!activeAppeal(record.status)) throw invalidState();
      const categoryId = input.categoryId === undefined ? record.categoryId : input.categoryId;
      const processId = input.processId === undefined ? record.processId : input.processId;
      const route = await this.routing.route(tx, { categoryId, processId, visibility: record.visibility,
        authorId: record.authorId, departmentId: record.departmentId });
      await checked(tx.appeal.updateMany({ where: { id: appealId, version: input.expectedVersion }, data: {
        categoryId, processId, visibility: route.visibility, queueId: route.queueId, assigneeId: route.assigneeId,
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
      people = await this.db.user.findMany({
        where: { id: { not: record.authorId }, ...eligibleStaff(record.visibility), ...queueStaff(record.queueId) },
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
  @Get('appeals') list(@Req() req: AuthRequest, @Query() query: unknown) { return this.service.list(req.user, query); }
  @Get('work-queue') queue(@Req() req: AuthRequest, @Query() query: unknown) { return this.service.list(req.user, query, true); }
  @Post('appeals')
  @ApiBody({ schema: { example: { type: 'PROPOSAL', title: 'Обновить шаблон', description: 'Добавить в шаблон поле для ожидаемого срока.' } } })
  create(@Req() req: AuthRequest, @Body() input: unknown, @Headers('idempotency-key') key?: string) { return this.service.create(req.user, input, key); }
  @Get('appeals/:id') detail(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.detail(req.user, item); }
  @Patch('appeals/:id') edit(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.edit(req.user, item, input); }
  @Post('appeals/:id/transition') mutate(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.mutate(req.user, item, input); }
  @Post('appeals/:id/reroute') reroute(@Req() req: AuthRequest, @Param('id') item: string, @Body() input: unknown) { return this.service.reroute(req.user, item, input); }
  @Post('appeals/:id/:operation') operation(@Req() req: AuthRequest, @Param('id') item: string, @Param('operation') operation: string, @Body() input: unknown) {
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
