import { Injectable } from '@nestjs/common';
import { Visibility } from '@prisma/client';
import { AppError, Tx } from './common';

@Injectable()
export class Routing {
  async route(tx: Tx, input: { categoryId?: string | null; departmentId?: string | null; processId?: string | null; visibility: Visibility }) {
    const category = input.categoryId ? await tx.category.findUnique({ where: { id: input.categoryId } }) : null;
    const visibility = category?.sensitive ? 'SPECIAL' : input.visibility;
    const fallback = await tx.workQueue.findFirst({
      where: { visibility, fallback: true, coordinator: { active: true, role: { in: ['HANDLER', 'MANAGER'] }, ...(visibility === 'NORMAL_INTERNAL' ? {} : { permissions: { has: 'SENSITIVE_CASE_HANDLER' } }) } },
    });
    if (!fallback) throw new AppError('ROUTING_UNAVAILABLE', 'Нет доступной очереди. Обратитесь к администратору.', 503);
    const defaults = { queueId: fallback.id, assigneeId: null, coordinatorId: fallback.coordinatorId, visibility };
    if (visibility !== 'NORMAL_INTERNAL') return { ...defaults, reason: 'SPECIAL_ROUTE' };
    if (!category) return { ...defaults, reason: 'NO_RULE' };
    const now = new Date();
    const rules = await tx.routingRule.findMany({
      where: { active: true, categoryId: category.id, queue: { visibility, coordinator: { active: true, role: { in: ['HANDLER', 'MANAGER'] } } },
        AND: [
          { OR: [{ departmentId: null }, { departmentId: input.departmentId ?? null }] },
          { OR: [{ processId: null }, { processId: input.processId ?? null }] },
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
        ] },
      include: { assignee: true, queue: true },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }], take: 2,
    });
    const [first, second] = rules;
    if (!first || first.rank === second?.rank) return { ...defaults, reason: first ? 'RULE_CONFLICT' : 'NO_RULE' };
    if (first.assigneeId && (!first.assignee?.active || !['HANDLER', 'MANAGER'].includes(first.assignee.role))) {
      return { ...defaults, reason: 'ASSIGNEE_UNAVAILABLE' };
    }
    return { queueId: first.queueId, assigneeId: first.assigneeId, coordinatorId: first.queue.coordinatorId, visibility, reason: 'MATCH' };
  }
}
