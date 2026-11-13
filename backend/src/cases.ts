import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { JsonBody, QueryFields } from './openapi';
import { Improvement, ImprovementStatus, Prisma, Problem } from '@prisma/client';
import { z } from 'zod';
import { actionStatuses, feedbackChoices, improvementStatuses, outcomes, problemStatuses } from './contracts';
import { AuthRequest } from './auth';
import { allocate, assertVersion, atomic, audit, bodyText, checked, Database, dateTime, expectedVersion, forbidden, id, invalid, invalidState, missing, notify, pagination, parse, shortText, title, Tx } from './common';
import { attachmentSummary, claimAttachments } from './files';
import { Policy, Principal } from './policy';
import { improvementTransitions, problemTransitions } from './workflow';
import { assessEffect } from './effect';

const workStatuses: ImprovementStatus[] = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'DEFERRED', 'IN_PROGRESS'];
const reviewStatuses: ImprovementStatus[] = ['IMPLEMENTED', 'VERIFYING'];
const listInput = z.strictObject({ ...pagination, q: z.string().trim().max(150).optional(), status: z.string().max(30).optional(), processId: id.optional(),
  stage: z.enum(['work', 'review', 'results']).optional(), actionable: z.enum(['true']).optional(), mine: z.enum(['true']).optional(),
});
const problemInput = z.strictObject({ title, symptoms: bodyText, hypothesis: bodyText.optional(), appealId: id.optional(), relatedAppealIds: z.array(id).max(8).default([]), explanation: bodyText.optional() });
const improvementInput = z.strictObject({ title, rationale: bodyText, goal: bodyText, scope: shortText, risks: bodyText.optional(),
  processId: id.optional(), appealId: id.optional(), problemId: id.optional(), ownerId: id.optional() });
const taskInput = z.strictObject({ expectedVersion, title, dueAt: dateTime.nullable().optional(), ownerId: id.optional(), blocking: z.boolean().default(true) });
const planInput = z.strictObject({ expectedVersion, method: z.enum(['QUANTITATIVE', 'QUALITATIVE', 'MIXED']),
  hypothesis: bodyText, criterion: bodyText, metricName: shortText.optional(), unit: shortText.optional(), direction: z.enum(['DECREASE', 'INCREASE', 'TARGET', 'RANGE']).optional(),
  targetValue: z.number().optional(), targetMaximum: z.number().optional(), protocol: bodyText.optional(),
  minimumSampleSize: z.number().int().min(1).max(100000000).optional(), requireSameSource: z.boolean().default(false),
  maxPeriodDifferencePercent: z.number().int().min(0).max(100).optional(),
}).superRefine((plan, ctx) => {
  if (plan.method !== 'QUALITATIVE' && (!plan.metricName || !plan.unit || !plan.direction || plan.targetValue === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['metricName'], message: 'Укажите показатель, единицу, направление и целевое значение.' });
  }
  if (plan.method !== 'QUANTITATIVE' && !plan.protocol) ctx.addIssue({ code: 'custom', path: ['protocol'], message: 'Опишите протокол проверки.' });
  if (plan.direction === 'RANGE' && (plan.targetValue === undefined || plan.targetMaximum === undefined || plan.targetMaximum < plan.targetValue)) {
    ctx.addIssue({ code: 'custom', path: ['targetMaximum'], message: 'Верхняя граница должна быть не ниже нижней.' });
  }
});
const evidenceIds = z.array(id).max(5).transform(ids => [...new Set(ids)]).default([]);
const observationInput = z.strictObject({ expectedVersion, phase: z.enum(['BEFORE', 'AFTER']), value: z.number().optional(), unit: shortText.optional(),
  periodStart: dateTime, periodEnd: dateTime, sampleSize: z.number().int().min(1).max(100000000).optional(), source: bodyText,
  sourceType: z.enum(['SYSTEM_REPORT', 'MANUAL_SAMPLE', 'INTERVIEW', 'OTHER']).default('OTHER'), evidenceIds,
});
const restrictedSources = { visibility: 'NORMAL_INTERNAL' } as const;
const editable = new Set<ImprovementStatus>(['DRAFT', 'DEFERRED', 'APPROVED', 'IN_PROGRESS']);
const decision = new Set<ImprovementStatus>(['APPROVED', 'REJECTED', 'DEFERRED', 'DRAFT']);

const problemEditInput = z.strictObject({ expectedVersion, title: title.optional(),
      symptoms: bodyText.optional(), hypothesis: bodyText.optional(), ownerId: id.optional() });
const problemMutationInput = z.strictObject({ expectedVersion, target: z.enum(problemStatuses).optional(),
      text: bodyText, source: shortText.optional() });
const problemSourceInput = z.strictObject({ expectedVersion, appealId: id, explanation: bodyText });
const improvementSourceInput = problemSourceInput.extend({ operation: z.enum(['ATTACH', 'DETACH']).default('ATTACH') });
const improvementEditInput = z.strictObject({ expectedVersion, title: title.optional(), rationale: bodyText.optional(),
      goal: bodyText.optional(), scope: shortText.optional(), risks: bodyText.optional(), ownerId: id.optional(), processId: id.nullable().optional() });
const improvementTransitionInput = z.strictObject({ expectedVersion, target: z.enum(improvementStatuses), text: bodyText.optional() });
const taskTransitionInput = z.strictObject({ expectedVersion, target: z.enum(actionStatuses), text: bodyText.optional() });
const verificationInput = z.strictObject({ expectedVersion, outcome: z.enum(outcomes), summary: bodyText, limitations: bodyText, evidenceIds });
const requestAmendmentInput = z.strictObject({ expectedVersion, reviewerId: id, reason: bodyText });
const rejectAmendmentInput = z.strictObject({ expectedVersion, reason: bodyText });
const invitationInput = z.strictObject({ expectedVersion });
const feedbackInput = z.strictObject({ expectedVersion, choice: z.enum(feedbackChoices), comment: bodyText.optional() });

@Injectable()
export class Cases {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy) {}

  private requireStaff(user: Principal) {
    if (!this.policy.canReadOperations(user)) throw forbidden();
  }

  async problem(tx: Tx, user: Principal, item: string) {
    if (!this.policy.canReadOperations(user)) throw missing();
    const found = await tx.problem.findFirst({ where: { AND: [{ id: item }, this.policy.problems(user)] } });
    if (!found) throw missing();
    return found;
  }

  async improvement(tx: Tx, user: Principal, item: string) {
    if (!this.policy.canReadOperations(user)) throw missing();
    const found = await tx.improvement.findFirst({ where: { AND: [{ id: item }, this.policy.improvements(user)] } });
    if (!found) throw missing();
    return found;
  }

  private manages(user: Principal, record: Problem | Improvement) {
    return this.policy.isStaff(user) && (record.ownerId === user.id ||
      (record.visibility === 'NORMAL_INTERNAL' && user.role === 'MANAGER' && !!user.departmentId && user.departmentId === record.departmentId));
  }

  private approvalScope(user: Principal, record: Improvement, permission: string) {
    return this.policy.canReview(user, permission, record.departmentId) && user.id !== record.ownerId && record.visibility === 'NORMAL_INTERNAL';
  }

  private steps(user: Principal, record: Improvement) {
    return improvementTransitions[record.status].filter(next => {
      if (record.status === 'UNDER_REVIEW' || next === 'DEFERRED') return this.approvalScope(user, record, 'IMPROVEMENT_APPROVER');
      return this.manages(user, record);
    });
  }

  async list(user: Principal, raw: unknown, kind: 'problem' | 'improvement') {
    this.requireStaff(user);
    const { page, limit, q, status, processId, stage, actionable, mine } = parse(listInput, raw);
    const search = q ? { OR: ['number', 'title'].map(field => ({ [field]: { contains: q, mode: 'insensitive' } })) } : {};
    const options = { orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }], skip: (page - 1) * limit, take: limit };
    const owner = { select: { id: true, name: true } } as const;
    if (kind === 'problem') {
      const where: Prisma.ProblemWhereInput = { AND: [this.policy.problems(user), search,
        { status: status ? parse(z.enum(problemStatuses), status) : undefined },
        ...(actionable || mine ? [{ status: { in: ['CANDIDATE', 'INVESTIGATING', 'CONFIRMED'] } } satisfies Prisma.ProblemWhereInput] : []),
        ...(mine ? [{ OR: [{ ownerId: user.id }, ...(user.role === 'MANAGER' && user.departmentId
          ? [{ departmentId: user.departmentId, visibility: 'NORMAL_INTERNAL' as const }] : [])] }] : []),
      ] };
      const [items, total] = await this.db.$transaction([this.db.problem.findMany({ ...options, where, select: {
        id: true, number: true, title: true, status: true, owner, isSynthetic: true, createdAt: true, updatedAt: true,
      } }), this.db.problem.count({ where })]);
      return { items: items.map(item => ({ ...item, owner: { id: item.owner.id, name: item.owner.name } })), total, page, limit };
    }
    const stages = { work: workStatuses, review: reviewStatuses, results: ['COMPLETED'] as ImprovementStatus[] };
    const availableForVerification: Prisma.ImprovementWhereInput = this.policy.canReview(user, 'RESULT_VERIFIER', user.departmentId)
      ? { status: 'VERIFYING', verification: null, visibility: 'NORMAL_INTERNAL',
        departmentId: user.role === 'DIRECTOR' ? undefined : user.departmentId, ownerId: { not: user.id } }
      : { id: { in: [] } };
    const where: Prisma.ImprovementWhereInput = { AND: [this.policy.improvements(user), search,
      { status: status ? parse(z.enum(improvementStatuses), status) : undefined, processId },
      ...(stage ? [{ status: { in: stages[stage] } }] : []),
      ...(actionable ? [availableForVerification] : []),
    ] };
    const [items, total] = await this.db.$transaction([this.db.improvement.findMany({ ...options, where, select: {
      id: true, number: true, title: true, status: true, owner, isSynthetic: true, createdAt: true, updatedAt: true,
      scope: true, verification: { select: { outcome: true } },
    } }), this.db.improvement.count({ where })]);
    return { items, total, page, limit };
  }

  private history(tx: Tx, entity: string, entityId: string) {
    return tx.auditEvent.findMany({ where: { entity, entityId }, orderBy: { createdAt: 'desc' }, take: 150,
      select: { id: true, action: true, createdAt: true, details: true } });
  }

  async problemDetail(user: Principal, item: string) {
    return this.db.$transaction(async tx => {
      const record = await this.problem(tx, user, item);
      const [owner, findings, sources, improvements, events] = await Promise.all([
        tx.user.findUnique({ where: { id: record.ownerId }, select: { id: true, name: true } }),
        tx.problemFinding.findMany({ where: { problemId: item }, orderBy: { createdAt: 'desc' } }),
        tx.appeal.findMany({ where: { AND: [{ problems: { some: { problemId: item } } }, this.policy.staffAppeals(user)] }, select: { id: true, title: true, number: true } }),
        tx.improvement.findMany({ where: { AND: [{ problemId: item }, this.policy.improvements(user)] }, select: { id: true, title: true, number: true, status: true } }),
        this.history(tx, 'problem', item),
      ]);
      const canEdit = this.manages(user, record) && record.status !== 'CLOSED';
      const people = canEdit ? await tx.user.findMany({ where: { departmentId: record.departmentId, active: true, role: { in: ['HANDLER', 'MANAGER'] },
        permissions: { hasEvery: record.visibility === 'NORMAL_INTERNAL' ? ['PROBLEM_OWNER'] : ['PROBLEM_OWNER', 'SENSITIVE_CASE_HANDLER'] } },
        select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [];
      return { ...record, owner, findings, sources, improvements, events, canEdit, people,
        allowedActions: this.manages(user, record) ? problemTransitions[record.status] : [] };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async createProblem(user: Principal, raw: unknown) {
    if (!this.policy.has(user, 'PROBLEM_OWNER')) throw forbidden();
    const { appealId, relatedAppealIds, explanation, ...data } = parse(problemInput, raw);
    return atomic(this.db, async tx => {
      const source = appealId && await tx.appeal.findFirst({
        where: { AND: [{ id: appealId, ...restrictedSources }, this.policy.staffAppeals(user)] },
      });
      if (appealId && !source) throw missing();
      const extraIds = [...new Set(relatedAppealIds)].filter(item => item !== appealId);
      if (extraIds.length && !source) throw invalid('Укажите основное обращение для группы.');
      const isSynthetic = user.demo || !!(source && source.isSynthetic);
      if (extraIds.length !== await tx.appeal.count({ where: { AND: [
        { id: { in: extraIds }, ...restrictedSources, ...(!isSynthetic ? { isSynthetic: false } : {}) },
        this.policy.staffAppeals(user),
      ] } })) throw missing();
      const record = await tx.problem.create({ data: { ...data, number: await allocate(tx, 'P'), ownerId: user.id,
        departmentId: (source && source.departmentId) || user.departmentId, isSynthetic,
        ...(source ? { appeals: { create: [source.id, ...extraIds].map(appealId => ({
          appealId, explanation: explanation ?? 'Источник наблюдения.',
        })) } } : {}) } });
      await audit(tx, 'problem', record.id, 'CREATED', user.id);
      return { id: record.id };
    });
  }

  async editProblem(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, ownerId, ...data } = parse(problemEditInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.problem(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || record.status === 'CLOSED') throw forbidden();
      if (ownerId && !await tx.user.findFirst({ where: { id: ownerId, active: true, departmentId: record.departmentId,
        role: { in: ['HANDLER', 'MANAGER'] }, permissions: { hasEvery: record.visibility === 'NORMAL_INTERNAL' ?
          ['PROBLEM_OWNER'] : ['PROBLEM_OWNER', 'SENSITIVE_CASE_HANDLER'] } }, select: { id: true } })) {
        throw invalid('Выберите действующего владельца проблемы из её подразделения.');
      }
      await checked(tx.problem.updateMany({ where: { id: item, version }, data: { ...data, ownerId, version: { increment: 1 } } }));
      await audit(tx, 'problem', item, 'UPDATED', user.id, false,
        ownerId && ownerId !== record.ownerId ? { previousOwnerId: record.ownerId, ownerId } : undefined);
    });
    const readable = await this.db.problem.count({ where: { AND: [{ id: item }, this.policy.problems(user)] } });
    return readable ? this.problemDetail(user, item) : { id: item, readable: false };
  }

  async problemMutation(user: Principal, item: string, raw: unknown, finding: boolean) {
    const input = parse(problemMutationInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.problem(tx, user, item);
      assertVersion(record.version, input.expectedVersion);
      if (!this.manages(user, record)) throw forbidden();
      if (finding) {
        if (record.status === 'CLOSED' || !input.source) throw invalid('Укажите источник наблюдения для открытой проблемы.');
        await tx.problemFinding.create({ data: { problemId: item, body: input.text, source: input.source, recordedBy: user.id } });
      } else {
        if (!input.target || !problemTransitions[record.status].includes(input.target)) throw invalidState();
        if (input.target === 'CONFIRMED' && !await tx.problemFinding.count({ where: { problemId: item } })) {
          throw invalidState('Для подтверждения добавьте наблюдение и источник.');
        }
      }
      await checked(tx.problem.updateMany({ where: { id: item, version: record.version }, data: {
        version: { increment: 1 }, ...(finding ? {} : { status: input.target, conclusion: input.text }),
      } }));
      await audit(tx, 'problem', item, finding ? 'FINDING' : input.target!, user.id, false, { reason: input.text });
    });
    return this.problemDetail(user, item);
  }

  async attachProblemSource(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, appealId, explanation } = parse(problemSourceInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.problem(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || record.status === 'CLOSED') throw forbidden();
      const source = await tx.appeal.findFirst({ where: { AND: [{ id: appealId, ...restrictedSources }, this.policy.staffAppeals(user)] } });
      if (!source) throw missing();
      await tx.problemAppeal.upsert({ where: { problemId_appealId: { problemId: item, appealId } },
        create: { problemId: item, appealId, explanation }, update: { explanation } });
      await checked(tx.problem.updateMany({ where: { id: item, version }, data: { version: { increment: 1 }, isSynthetic: record.isSynthetic || source.isSynthetic } }));
      await audit(tx, 'problem', item, 'SOURCE_LINKED', user.id);
    });
    return this.problemDetail(user, item);
  }

  async improvementDetail(user: Principal, item: string) {
    return this.db.$transaction(async tx => {
      const record = await this.improvement(tx, user, item);
      const manager = this.manages(user, record);
      const [owner, actions, approvals, plan, verification, sources, problem, events, feedback, publications, attachments, proposal] = await Promise.all([
        tx.user.findUnique({ where: { id: record.ownerId }, select: { id: true, name: true } }),
        tx.actionItem.findMany({ where: { improvementId: item }, include: { owner: { select: { id: true, name: true } } }, orderBy: { id: 'asc' } }),
        tx.approvalDecision.findMany({ where: { improvementId: item }, orderBy: { createdAt: 'desc' } }),
        tx.measurementPlan.findUnique({ where: { improvementId: item }, include: { observations: { where: { supersededAt: null }, orderBy: { periodStart: 'asc' } } } }),
        tx.verification.findUnique({ where: { improvementId: item } }),
        tx.appeal.findMany({ where: { AND: [{ improvements: { some: { improvementId: item } }, ...restrictedSources }, this.policy.staffAppeals(user)] }, select: { id: true, title: true, number: true } }),
        record.problemId ? tx.problem.findFirst({ where: { AND: [{ id: record.problemId }, this.policy.problems(user)] }, select: { id: true, title: true, number: true } }) : null,
        this.history(tx, 'improvement', item),
        manager ? tx.feedback.findMany({ where: { improvementId: item }, orderBy: { submittedAt: 'desc' } }) : [],
        manager || this.approvalScope(user, record, 'PUBLICATION_APPROVER') ? tx.publication.findMany({ where: { improvementId: item } }) : [],
        tx.attachment.findMany({ where: { improvementId: item, readyAt: { not: null }, purgeAt: null }, select: attachmentSummary }),
        user.departmentId && record.isSynthetic === user.demo ? tx.proposal.findFirst({
          where: { improvementId: item, departmentId: user.departmentId, isSynthetic: user.demo },
          select: { id: true, title: true },
        }) : null,
      ]);
      const people = manager ? await tx.user.findMany({ where: { active: true, departmentId: record.departmentId, role: { in: ['HANDLER', 'MANAGER'] } },
        select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [];
      const byId = new Map(attachments.map(file => [file.id, file]));
      const evidence = (ids: string[]) => ids.flatMap(id => byId.get(id) ?? []);
      const sourceEvents = events.flatMap(event => {
        if (!['SOURCE_ATTACHED', 'SOURCE_DETACHED'].includes(event.action) || !event.details || typeof event.details !== 'object' || Array.isArray(event.details)) return [];
        return typeof event.details.appealId === 'string' ? [event.details.appealId] : [];
      });
      const readableSources = new Set((await tx.appeal.findMany({
        where: { AND: [{ id: { in: sourceEvents }, ...restrictedSources }, this.policy.staffAppeals(user)] }, select: { id: true },
      })).map(row => row.id));
      const safeEvents = events.flatMap(event => {
        if (!['SOURCE_ATTACHED', 'SOURCE_DETACHED'].includes(event.action)) return [event];
        const detail = event.details;
        return detail && typeof detail === 'object' && !Array.isArray(detail) && typeof detail.appealId === 'string' && readableSources.has(detail.appealId) ? [event] : [];
      });
      const [amendments, verificationRevisions, eligibleReviewers] = verification && record.status === 'COMPLETED' ? await Promise.all([
        tx.verificationAmendment.findMany({ where: { improvementId: item }, orderBy: { requestedAt: 'desc' } }),
        tx.verificationRevision.findMany({ where: { improvementId: item }, orderBy: { revision: 'desc' } }),
        manager && record.departmentId ? tx.user.findMany({ where: {
          active: true, id: { notIn: [record.ownerId, user.id] },
          OR: [{ role: 'DIRECTOR', demo: record.isSynthetic }, { departmentId: record.departmentId, role: { in: ['HANDLER', 'MANAGER'] } }],
          permissions: { has: 'RESULT_VERIFIER' },
        }, select: { id: true, name: true }, orderBy: { name: 'asc' } }) : [],
      ]) : [[], [], []];
      const pendingAmendment = amendments.find(row => row.resolvedAt === null);
      return { ...record, problemId: problem?.id ?? null, owner, actions: actions.map(task => ({ ...task, canUpdate: editable.has(record.status) && (manager || task.ownerId === user.id) })),
        approvals, plan: plan && { ...plan, observations: plan.observations.map(row => ({ ...row, evidence: evidence(row.evidenceIds) })) },
        verification: verification && { ...verification, evidence: evidence(verification.evidenceIds) },
        sources, problem, proposal, events: safeEvents, feedback, publications, people,
        canManageSources: manager && !['REJECTED', 'CANCELED'].includes(record.status),
        amendments, verificationRevisions, eligibleReviewers,
        canRequestAmendment: manager && !!eligibleReviewers.length && !pendingAmendment,
        canDecideAmendment: pendingAmendment?.reviewerId === user.id && this.approvalScope(user, record, 'RESULT_VERIFIER'),
        canEdit: manager && editable.has(record.status), canMeasure: manager && ['IN_PROGRESS', 'IMPLEMENTED', 'VERIFYING'].includes(record.status) && !verification,
        canVerify: record.status === 'VERIFYING' && !verification && this.approvalScope(user, record, 'RESULT_VERIFIER'),
        canInvite: manager && !!record.implementedAt, canDraftPublication: manager && record.status === 'COMPLETED' && !!verification,
        canApprovePublication: this.approvalScope(user, record, 'PUBLICATION_APPROVER'), allowedActions: this.steps(user, record) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  private async owner(tx: Tx, ownerId: string, departmentId: string | null, forImprovement = false) {
    const user = await tx.user.findFirst({ where: { id: ownerId, active: true, departmentId, role: { in: ['HANDLER', 'MANAGER'] },
      ...(forImprovement ? { permissions: { has: 'IMPROVEMENT_OWNER' } } : {}) } });
    if (!user) throw invalid('Выберите уполномоченного сотрудника в области инициативы.');
    return user.id;
  }

  async createImprovement(user: Principal, raw: unknown, proposalId?: string) {
    if (!this.policy.has(user, 'IMPROVEMENT_OWNER')) throw forbidden();
    return atomic(this.db, async tx => {
      const proposal = proposalId ? await tx.proposal.findFirst({ where: { id: proposalId,
        departmentId: user.departmentId ?? '', isSynthetic: user.demo } }) : null;
      if (proposalId && !proposal) throw missing();
      if (proposal?.improvementId) {
        const where = { AND: [{ id: proposal.improvementId }, this.policy.improvements(user)] };
        if (!await tx.improvement.count({ where })) throw invalidState('Предложение уже преобразовано в инициативу.');
        return { id: proposal.improvementId };
      }
      const data = proposal ? { ...parse(improvementInput.pick({ goal: true, scope: true }), raw),
        title: proposal.title, rationale: proposal.description } : parse(improvementInput, raw);
      const { appealId, problemId, ownerId, ...input }: z.output<typeof improvementInput> = data;
      const source = appealId && await tx.appeal.findFirst({ where: { AND: [{ id: appealId, ...restrictedSources }, this.policy.staffAppeals(user)] } });
      if (appealId && !source) throw missing();
      const problem = problemId ? await this.problem(tx, user, problemId) : null;
      if (problem && problem.visibility !== 'NORMAL_INTERNAL') throw forbidden();
      const departmentId = (source && source.departmentId) || problem?.departmentId || user.departmentId;
      const targetOwner = ownerId ? await this.owner(tx, ownerId, departmentId, true) : user.id;
      const record = await tx.improvement.create({ data: { ...input, number: await allocate(tx, 'I'), ownerId: targetOwner,
        departmentId, problemId, isSynthetic: user.demo || !!((source && source.isSynthetic) || problem?.isSynthetic),
        ...(source ? { appeals: { create: { appealId: source.id, explanation: 'Основание улучшения.' } } } : {}) } });
      if (proposal) await checked(tx.proposal.updateMany({ where: { id: proposal.id, improvementId: null }, data: { improvementId: record.id } }));
      const event = await audit(tx, 'improvement', record.id, 'CREATED', user.id, false, proposal ? { proposalId: proposal.id } : undefined);
      if (targetOwner !== user.id) await notify(tx, event.id, [targetOwner], 'ASSIGNED', `/improvements/${record.id}`);
      return { id: record.id };
    });
  }

  async changeImprovementSource(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, appealId, explanation, operation } = parse(improvementSourceInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      if (!this.manages(user, record) || ['REJECTED', 'CANCELED'].includes(record.status)) throw forbidden();
      assertVersion(record.version, version);
      const source = await tx.appeal.findFirst({ where: { AND: [{ id: appealId, ...restrictedSources }, this.policy.staffAppeals(user)] } });
      if (!source) throw missing();
      const where = { improvementId: item, appealId };
      if (operation === 'ATTACH') {
        if (source.isSynthetic && !record.isSynthetic) throw invalidState('Демонстрационный источник нельзя добавить к рабочему улучшению.');
        const inserted = await tx.improvementAppeal.createMany({ data: { ...where, explanation }, skipDuplicates: true });
        if (!inserted.count) return;
      } else {
        if (source.resolutionType === 'ACCEPTED_FOR_IMPROVEMENT' && await tx.improvementAppeal.count({ where: { appealId } }) <= 1) {
          throw invalidState('Сначала зафиксируйте другое улучшение для принятого обращения.');
        }
        if (!(await tx.improvementAppeal.deleteMany({ where })).count) throw missing();
      }
      await this.bump(tx, record);
      await audit(tx, 'improvement', item, operation === 'ATTACH' ? 'SOURCE_ATTACHED' : 'SOURCE_DETACHED', user.id, false, { appealId, explanation });
    });
    return this.improvementDetail(user, item);
  }

  private bump(tx: Tx, record: Improvement, data: Prisma.ImprovementUncheckedUpdateManyInput = {}) {
    return checked(tx.improvement.updateMany({ where: { id: record.id, version: record.version }, data: { ...data, version: { increment: 1 } } }));
  }

  async editImprovement(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, ownerId, ...updates } = parse(improvementEditInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || !['DRAFT', 'DEFERRED'].includes(record.status)) throw forbidden();
      const newOwner = ownerId ? await this.owner(tx, ownerId, record.departmentId, true) : undefined;
      await this.bump(tx, record, { ...updates, ownerId: newOwner });
      const event = await audit(tx, 'improvement', item, 'UPDATED', user.id);
      if (newOwner && newOwner !== record.ownerId) await notify(tx, event.id, [newOwner], 'ASSIGNED', `/improvements/${item}`);
    });
    const readable = await this.db.improvement.count({ where: { AND: [{ id: item }, this.policy.improvements(user)] } });
    return readable ? this.improvementDetail(user, item) : { id: item, readable: false };
  }

  async transition(user: Principal, item: string, raw: unknown, fixed?: ImprovementStatus) {
    const input = parse(improvementTransitionInput,
      fixed && raw && typeof raw === 'object' ? { ...raw, target: fixed } : raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, input.expectedVersion);
      const target = input.target;
      if (!improvementTransitions[record.status].includes(target)) throw invalidState();
      if (!this.steps(user, record).includes(target)) throw forbidden();
      const plan = await tx.measurementPlan.findUnique({ where: { improvementId: item } });
      const updates: Prisma.ImprovementUncheckedUpdateManyInput = { status: target };
      if (target === 'UNDER_REVIEW' && (!plan || !await tx.actionItem.count({ where: { improvementId: item, status: { not: 'CANCELED' } } }))) {
        throw invalidState('Перед согласованием добавьте задачи и критерий проверки эффекта.');
      }
      if (target === 'IMPLEMENTED' || target === 'COMPLETED') {
        const pending = await tx.actionItem.count({ where: { improvementId: item, blocking: true, status: { notIn: ['DONE', 'CANCELED'] } } });
        if (pending) throw invalidState('Завершите блокирующие задачи.');
      }
      if (target === 'IMPLEMENTED') {
        if (!input.text) throw invalid('Опишите, что внедрено.');
        updates.implementedAt = new Date();
        updates.implementationNotes = input.text;
      }
      if (target === 'VERIFYING' && (!record.implementedAt || !plan)) throw invalidState('Нужны факт внедрения и план измерения.');
      if (target === 'COMPLETED') {
        if (!await tx.verification.findUnique({ where: { improvementId: item } })) throw invalidState('Сначала независимый проверяющий должен зафиксировать результат.');
        updates.completedAt = new Date();
      }
      if (target === 'IN_PROGRESS' && ['IMPLEMENTED', 'VERIFYING'].includes(record.status)) {
        if (!input.text) throw invalid('Обоснуйте возврат на доработку.');
        const previous = await tx.verification.findUnique({ where: { improvementId: item } });
        if (previous) {
          await audit(tx, 'improvement', item, 'VERIFICATION_SUPERSEDED', user.id, false, { ...previous, verifiedAt: previous.verifiedAt.toISOString() });
          await tx.verification.delete({ where: { improvementId: item } });
        }
        await tx.measurement.updateMany({ where: { improvementId: item, phase: 'AFTER', supersededAt: null }, data: { supersededAt: new Date() } });
        updates.implementedAt = null;
        updates.implementationNotes = null;
      }
      if (decision.has(target) || target === 'CANCELED') {
        if (!input.text) throw invalid('Укажите обоснование решения.');
        await tx.approvalDecision.create({ data: { improvementId: item, status: target, decidedBy: user.id, reason: input.text } });
      }
      await this.bump(tx, record, updates);
      const event = await audit(tx, 'improvement', item, target, user.id, false, { previous: record.status, reason: input.text ?? '' });
      const permission = target === 'UNDER_REVIEW' ? 'IMPROVEMENT_APPROVER' : target === 'VERIFYING' ? 'RESULT_VERIFIER' : null;
      const reviewers = permission ? await tx.user.findMany({ where: {
        active: true, id: { not: record.ownerId }, permissions: { has: permission },
        OR: [{ role: 'DIRECTOR', demo: record.isSynthetic }, { departmentId: record.departmentId, role: { in: ['HANDLER', 'MANAGER'] } }],
      }, select: { id: true } }) : [];
      await notify(tx, event.id, [record.ownerId, ...reviewers.map(person => person.id)], target, `/improvements/${item}`);
    });
    return this.improvementDetail(user, item);
  }

  async saveTask(user: Principal, item: string, raw: unknown, taskId?: string) {
    const { expectedVersion: version, ownerId, ...input } = parse(taskInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || !editable.has(record.status)) throw forbidden();
      const task = taskId ? await tx.actionItem.findFirst({ where: { id: taskId, improvementId: item } }) : null;
      if (taskId && !task) throw missing();
      const owner = ownerId ? await this.owner(tx, ownerId, record.departmentId) : task?.ownerId ?? record.ownerId;
      const data = { ...input, ownerId: owner };
      if (task) await tx.actionItem.update({ where: { id: task.id }, data: { ...data, version: { increment: 1 } } });
      else await tx.actionItem.create({ data: { ...data, improvementId: item } });
      await this.bump(tx, record);
      const event = await audit(tx, 'improvement', item, 'ACTION', user.id);
      await notify(tx, event.id, [owner], 'ACTION', `/improvements/${item}`);
    });
    return this.improvementDetail(user, item);
  }

  async taskTransition(user: Principal, item: string, taskId: string, raw: unknown) {
    const input = parse(taskTransitionInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, input.expectedVersion);
      const task = await tx.actionItem.findFirst({ where: { id: taskId, improvementId: item } });
      if (!task) throw missing();
      if ((!this.manages(user, record) && task.ownerId !== user.id) || !editable.has(record.status)) throw forbidden();
      const allowed: Record<string, string[]> = { TODO: ['IN_PROGRESS', 'BLOCKED', 'DONE', 'CANCELED'], IN_PROGRESS: ['BLOCKED', 'DONE', 'CANCELED'],
        BLOCKED: ['IN_PROGRESS', 'DONE', 'CANCELED'], DONE: ['IN_PROGRESS'], CANCELED: ['TODO'] };
      if (!allowed[task.status].includes(input.target)) throw invalidState();
      if (['DONE', 'BLOCKED', 'CANCELED'].includes(input.target) && !input.text) throw invalid('Укажите результат или причину.');
      if (input.target === 'CANCELED' && !this.manages(user, record)) throw forbidden();
      await tx.actionItem.update({ where: { id: task.id }, data: { status: input.target, result: input.text ?? null, version: { increment: 1 } } });
      await this.bump(tx, record);
      await audit(tx, 'improvement', item, 'ACTION', user.id, false, { taskId, status: input.target, reason: input.text ?? '' });
    });
    return this.improvementDetail(user, item);
  }

  async savePlan(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, ...data } = parse(planInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || !['DRAFT', 'DEFERRED'].includes(record.status)) throw forbidden();
      if (await tx.measurement.count({ where: { improvementId: item } })) throw invalidState('Есть наблюдения по текущему плану.');
      const plan = { ...data, metricName: data.metricName ?? null, unit: data.unit ?? null,
        direction: data.direction ?? null, targetValue: data.targetValue ?? null, targetMaximum: data.direction === 'RANGE' ? data.targetMaximum : null,
        protocol: data.protocol ?? null,
        minimumSampleSize: data.minimumSampleSize ?? null, maxPeriodDifferencePercent: data.maxPeriodDifferencePercent ?? null };
      await tx.measurementPlan.upsert({ where: { improvementId: item }, create: { improvementId: item, ...plan }, update: { ...plan, version: { increment: 1 } } });
      await this.bump(tx, record);
      await audit(tx, 'improvement', item, 'MEASUREMENT_PLAN', user.id);
    });
    return this.improvementDetail(user, item);
  }

  async measure(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, unit, ...data } = parse(observationInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record) || !['IN_PROGRESS', 'IMPLEMENTED', 'VERIFYING'].includes(record.status)) throw forbidden();
      const plan = await tx.measurementPlan.findUnique({ where: { improvementId: item } });
      if (!plan || await tx.verification.findUnique({ where: { improvementId: item } })) throw invalidState();
      if (unit !== undefined && unit !== plan.unit) throw invalid('Единица измерения должна совпадать с утверждённым планом.');
      if (data.periodStart >= data.periodEnd || data.periodEnd > new Date()) throw invalid('Укажите завершившийся период измерения.');
      if (plan.method !== 'QUALITATIVE' && data.value === undefined) throw invalid('Введите измеренное значение.');
      if (data.phase === 'AFTER' && (!record.implementedAt || data.periodStart < record.implementedAt)) {
        throw invalid('Период наблюдения должен начаться после внедрения.');
      }
      if (data.phase === 'BEFORE' && record.implementedAt && data.periodEnd > record.implementedAt) {
        throw invalid('Исходный период должен закончиться до внедрения.');
      }
      await claimAttachments(tx, user.id, data.evidenceIds, { improvementId: item });
      await tx.measurement.create({ data: { ...data, planVersion: plan.version, improvementId: item, recordedBy: user.id, origin: 'USER_ACTION', isSynthetic: record.isSynthetic } });
      await this.bump(tx, record);
      await audit(tx, 'improvement', item, 'MEASUREMENT', user.id);
    });
    return this.improvementDetail(user, item);
  }

  async requestAmendment(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, reviewerId, reason } = parse(requestAmendmentInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record)) throw forbidden();
      if (record.status !== 'COMPLETED' || !await tx.verification.findUnique({ where: { improvementId: item } })) throw invalidState();
      if (await tx.verificationAmendment.count({ where: { improvementId: item, resolvedAt: null } })) throw invalidState('Запрос уже рассматривается.');
      const reviewer = await tx.user.findFirst({ where: { id: reviewerId, active: true } });
      if (!reviewer || reviewer.id === user.id || !this.approvalScope(reviewer, record, 'RESULT_VERIFIER')) throw forbidden();
      await this.bump(tx, record);
      const request = await tx.verificationAmendment.create({ data: { improvementId: item, requestedBy: user.id, reviewerId, reason } });
      const event = await audit(tx, 'improvement', item, 'VERIFICATION_AMENDMENT_REQUESTED', user.id, false, { amendmentId: request.id, reason });
      await notify(tx, event.id, [reviewerId], 'VERIFICATION_AMENDMENT_REQUESTED', `/improvements/${item}`);
    });
    return this.improvementDetail(user, item);
  }

  async rejectAmendment(user: Principal, item: string, amendmentId: string, raw: unknown) {
    const { expectedVersion: version, reason } = parse(rejectAmendmentInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.approvalScope(user, record, 'RESULT_VERIFIER')) throw forbidden();
      const request = await tx.verificationAmendment.findFirst({ where: { id: amendmentId, improvementId: item, reviewerId: user.id, resolvedAt: null } });
      if (!request) throw missing();
      await this.bump(tx, record);
      await tx.verificationAmendment.update({ where: { id: request.id }, data: { resolvedAt: new Date(), approved: false, decision: reason } });
      const event = await audit(tx, 'improvement', item, 'VERIFICATION_AMENDMENT_REJECTED', user.id, false, { reason });
      await notify(tx, event.id, [request.requestedBy], 'VERIFICATION_AMENDMENT_REJECTED', `/improvements/${item}`);
    });
    return this.improvementDetail(user, item);
  }

  async verify(user: Principal, item: string, raw: unknown, amendmentId?: string) {
    const { expectedVersion: version, ...input } = parse(verificationInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.approvalScope(user, record, 'RESULT_VERIFIER')) throw forbidden();
      const previous = await tx.verification.findUnique({ where: { improvementId: item } });
      const amendment = amendmentId ? await tx.verificationAmendment.findFirst({ where: {
        id: amendmentId, improvementId: item, reviewerId: user.id, resolvedAt: null,
      } }) : null;
      if (amendmentId ? !amendment || !previous || record.status !== 'COMPLETED' : record.status !== 'VERIFYING' || previous) throw invalidState();
      const plan = await tx.measurementPlan.findUnique({ where: { improvementId: item } });
      if (!plan) throw invalidState('Сначала задайте план проверки.');
      const observations = await tx.measurement.findMany({
        where: { improvementId: item, supersededAt: null, planVersion: plan.version },
        select: { id: true, phase: true, value: true, sampleSize: true, sourceType: true, periodStart: true, periodEnd: true }, orderBy: [{ periodEnd: 'desc' }, { id: 'asc' }],
      });
      const before = observations.find(row => row.phase === 'BEFORE');
      const afterObservation = observations.find(row => row.phase === 'AFTER');
      const effect = plan.method === 'QUALITATIVE' ? null : assessEffect(plan, before?.value ?? null, afterObservation?.value ?? null);
      const hasBothObservations = !!before && !!afterObservation;
      const sampleSize = plan.minimumSampleSize;
      const sufficientSample = hasBothObservations && (!sampleSize || [before, afterObservation].every(row => (row.sampleSize ?? 0) >= sampleSize));
      const comparableSource = hasBothObservations && (!plan.requireSameSource || (before.sourceType !== 'OTHER' && before.sourceType === afterObservation.sourceType));
      const periodLimit = plan.maxPeriodDifferencePercent;
      const comparablePeriods = hasBothObservations && (() => {
        const base = before.periodEnd.getTime() - before.periodStart.getTime();
        const comparison = afterObservation.periodEnd.getTime() - afterObservation.periodStart.getTime();
        return base > 0 && comparison > 0 && (periodLimit === null || Math.abs(comparison - base) * 100 <= base * periodLimit);
      })();
      if (input.outcome !== 'INCONCLUSIVE') {
        if (!hasBothObservations) throw invalidState('Для вывода об эффекте нужны наблюдения до и после внедрения.');
        if (!sufficientSample) {
          throw invalidState('Выборки меньше минимума, заданного планом. Добавьте наблюдения либо укажите недостаточность данных.');
        }
        if (!comparableSource) {
          throw invalidState('В плане требуется один указанный вид источника до и после внедрения.');
        }
        if (!comparablePeriods) throw invalidState('Длительность периодов различается сильнее, чем допускает план.');
      }
      if (input.outcome === 'VERIFIED' && effect) {
        if (!effect.meetsTarget) throw invalidState('Последнее измерение не достигло целевого значения. Укажите подходящий итог.');
        if (!effect.improved && !effect.maintained) throw invalidState('Достигнутый порог сам по себе не подтверждает улучшение относительно исходного уровня.');
      }
      await claimAttachments(tx, user.id, input.evidenceIds, { improvementId: item });
      const updated = { ...input, planVersion: plan.version, measurementIds: [before?.id, afterObservation?.id].filter((value): value is string => !!value),
        effect: { ...effect, method: plan.method, unit: plan.unit, hypothesis: plan.hypothesis,
          hasBothObservations, sufficientSample, comparableSource, comparablePeriods, evaluatedAsDeterminate: input.outcome !== 'INCONCLUSIVE' },
        verifierId: user.id, origin: 'USER_ACTION' as const, isSynthetic: record.isSynthetic };
      if (previous && amendment) {
        const now = new Date();
        await tx.verificationRevision.create({ data: { improvementId: item, revision: previous.revision, reason: amendment.reason,
          snapshot: { ...previous, verifiedAt: previous.verifiedAt.toISOString() } } });
        await tx.verification.update({ where: { improvementId: item }, data: { ...updated, verifiedAt: now, revision: { increment: 1 } } });
        await tx.verificationAmendment.update({ where: { id: amendment.id }, data: { approved: true, resolvedAt: now, decision: input.summary } });
        const publications = await tx.publication.findMany({ where: { improvementId: item, state: { in: ['DRAFT', 'APPROVED', 'PUBLISHED'] } } });
        for (const publication of publications) {
          const retracted = await tx.publication.update({ where: { id: publication.id }, data: { state: 'RETRACTED', version: { increment: 1 } } });
          await tx.publicationRevision.create({ data: { publicationId: retracted.id, version: retracted.version,
            actorId: user.id, action: 'VERIFICATION_AMENDED', snapshot: { ...retracted, publishedAt: retracted.publishedAt?.toISOString() ?? null } } });
          await audit(tx, 'publication', publication.id, 'VERIFICATION_AMENDED', user.id, false, { previousState: publication.state });
        }
      } else await tx.verification.create({ data: { ...updated, improvementId: item } });
      await this.bump(tx, record);
      const event = await audit(tx, 'improvement', item, amendment ? 'VERIFICATION_AMENDED' : 'VERIFICATION', user.id, false, { outcome: input.outcome });
      await notify(tx, event.id, [record.ownerId], 'VERIFICATION', `/improvements/${item}`);
    });
    return this.improvementDetail(user, item);
  }

  async invite(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version } = parse(invitationInput, raw);
    await atomic(this.db, async tx => {
      const record = await this.improvement(tx, user, item);
      assertVersion(record.version, version);
      if (!this.manages(user, record)) throw forbidden();
      if (!record.implementedAt) throw invalidState('Приглашения доступны после внедрения.');
      const sources = await tx.appeal.findMany({ where: { AND: [this.policy.staffAppeals(user), { ...restrictedSources, OR: [
        { improvements: { some: { improvementId: item } } },
        ...(record.problemId ? [{ problems: { some: { problemId: record.problemId } } }] : []),
      ] }] }, select: { authorId: true }, distinct: ['authorId'] });
      const existing = await tx.feedback.findMany({ where: { improvementId: item }, select: { userId: true } });
      const recipients = sources.flatMap(({ authorId }) => authorId && !existing.some(row => row.userId === authorId) ? [authorId] : []);
      if (!recipients.length) throw invalid('Новых доступных авторов для приглашения нет.');
      await tx.feedback.createMany({ data: recipients.map(userId => ({ userId, improvementId: item })), skipDuplicates: true });
      const invitations = await tx.feedback.findMany({ where: { improvementId: item, userId: { in: recipients } } });
      await this.bump(tx, record);
      const event = await audit(tx, 'improvement', item, 'FEEDBACK_INVITED', user.id);
      for (const invitation of invitations) await notify(tx, event.id, [invitation.userId], 'FEEDBACK_INVITED', `/feedback/${invitation.id}`);
    });
    return this.improvementDetail(user, item);
  }

  async feedback(user: Principal, item: string) {
    const row = await this.db.feedback.findFirst({ where: { id: item, ...this.policy.feedback(user) },
      select: { id: true, choice: true, comment: true, version: true, submittedAt: true } });
    if (!row) throw missing();
    return row;
  }

  async respond(user: Principal, item: string, raw: unknown) {
    const { expectedVersion: version, ...data } = parse(feedbackInput, raw);
    await atomic(this.db, async tx => {
      const invite = await tx.feedback.findFirst({ where: { id: item, ...this.policy.feedback(user) },
        include: { improvement: { select: { ownerId: true } } } });
      if (!invite) throw missing();
      await checked(tx.feedback.updateMany({ where: { id: item, version }, data: { ...data, comment: data.comment ?? null, submittedAt: new Date(), version: { increment: 1 } } }));
      const event = await audit(tx, 'improvement', invite.improvementId, 'FEEDBACK_SUBMITTED', user.id);
      if (['NO', 'PARTLY'].includes(data.choice)) await notify(tx, event.id, [invite.improvement.ownerId], 'FEEDBACK_SUBMITTED', `/improvements/${invite.improvementId}`);
    });
    return this.feedback(user, item);
  }
}

@Controller()
export class CasesController {
  constructor(@Inject(Cases) private readonly cases: Cases) {}

  @Get('problems') @QueryFields(listInput) problems(@Req() req: AuthRequest, @Query() q: unknown) { return this.cases.list(req.user, q, 'problem'); }
  @Post('problems') @JsonBody(problemInput) createProblem(@Req() req: AuthRequest, @Body() data: unknown) { return this.cases.createProblem(req.user, data); }
  @Get('problems/:id') problem(@Req() req: AuthRequest, @Param('id') id: string) { return this.cases.problemDetail(req.user, id); }
  @Patch('problems/:id') @JsonBody(problemEditInput) editProblem(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.editProblem(req.user, id, data); }
  @Post('problems/:id/transition') @JsonBody(problemMutationInput.required({ target: true })) problemTransition(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.problemMutation(req.user, id, data, false); }
  @Post('problems/:id/findings') @JsonBody(problemMutationInput.required({ source: true })) finding(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.problemMutation(req.user, id, data, true); }
  @Post('problems/:id/sources') @JsonBody(problemSourceInput) problemSource(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.attachProblemSource(req.user, id, data); }
  @Get('improvements') @QueryFields(listInput) improvements(@Req() req: AuthRequest, @Query() q: unknown) { return this.cases.list(req.user, q, 'improvement'); }
  @Post('improvements') @JsonBody(improvementInput) create(@Req() req: AuthRequest, @Body() data: unknown) { return this.cases.createImprovement(req.user, data); }
  @Get('improvements/:id') detail(@Req() req: AuthRequest, @Param('id') id: string) { return this.cases.improvementDetail(req.user, id); }
  @Patch('improvements/:id') @JsonBody(improvementEditInput) edit(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.editImprovement(req.user, id, data); }
  @Post('improvements/:id/sources') @JsonBody(improvementSourceInput)
  improvementSource(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.changeImprovementSource(req.user, id, data); }
  @Post('improvements/:id/transition') @JsonBody(improvementTransitionInput) transition(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.transition(req.user, id, data); }
  @Post('improvements/:id/approve') @JsonBody(improvementTransitionInput.omit({ target: true }).required({ text: true })) approve(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.transition(req.user, id, data, 'APPROVED'); }
  @Post('improvements/:id/defer') @JsonBody(improvementTransitionInput.omit({ target: true }).required({ text: true })) defer(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.transition(req.user, id, data, 'DEFERRED'); }
  @Post('improvements/:id/reject') @JsonBody(improvementTransitionInput.omit({ target: true }).required({ text: true })) reject(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.transition(req.user, id, data, 'REJECTED'); }
  @Get('improvements/:id/actions') async actions(@Req() req: AuthRequest, @Param('id') id: string) { return (await this.cases.improvementDetail(req.user, id)).actions; }
  @Post('improvements/:id/actions') @JsonBody(taskInput) task(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.saveTask(req.user, id, data); }
  @Patch('improvements/:id/actions/:taskId') @JsonBody(taskInput) editTask(@Req() req: AuthRequest, @Param('id') id: string, @Param('taskId') taskId: string, @Body() data: unknown) { return this.cases.saveTask(req.user, id, data, taskId); }
  @Post('improvements/:id/actions/:taskId/transition') @JsonBody(taskTransitionInput) taskTransition(@Req() req: AuthRequest, @Param('id') id: string, @Param('taskId') taskId: string, @Body() data: unknown) { return this.cases.taskTransition(req.user, id, taskId, data); }
  @Get('improvements/:id/measurement-plan') async plan(@Req() req: AuthRequest, @Param('id') id: string) { return (await this.cases.improvementDetail(req.user, id)).plan; }
  @Post('improvements/:id/measurement-plan') @JsonBody(planInput) savePlan(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.savePlan(req.user, id, data); }
  @Post('improvements/:id/measurements') @JsonBody(observationInput) measure(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.measure(req.user, id, data); }
  @Post('improvements/:id/verification') @JsonBody(verificationInput) verify(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.verify(req.user, id, data); }
  @Post('improvements/:id/verification-amendments') @JsonBody(requestAmendmentInput)
  requestAmendment(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.requestAmendment(req.user, id, data); }
  @Post('improvements/:id/verification-amendments/:amendmentId/accept') @JsonBody(verificationInput)
  acceptAmendment(@Req() req: AuthRequest, @Param('id') id: string, @Param('amendmentId') amendmentId: string, @Body() data: unknown) {
    return this.cases.verify(req.user, id, data, amendmentId);
  }
  @Post('improvements/:id/verification-amendments/:amendmentId/reject') @JsonBody(rejectAmendmentInput)
  rejectAmendment(@Req() req: AuthRequest, @Param('id') id: string, @Param('amendmentId') amendmentId: string, @Body() data: unknown) {
    return this.cases.rejectAmendment(req.user, id, amendmentId, data);
  }
  @Get('improvements/:id/result') async result(@Req() req: AuthRequest, @Param('id') id: string) {
    const { verification, plan, implementedAt } = await this.cases.improvementDetail(req.user, id);
    return { verification, plan, implementedAt };
  }
  @Post('improvements/:id/feedback-invitations') @JsonBody(invitationInput) invite(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.invite(req.user, id, data); }
  @Get('feedback/:id') feedback(@Req() req: AuthRequest, @Param('id') id: string) { return this.cases.feedback(req.user, id); }
  @Post('feedback/:id/respond') @JsonBody(feedbackInput) respond(@Req() req: AuthRequest, @Param('id') id: string, @Body() data: unknown) { return this.cases.respond(req.user, id, data); }
}
