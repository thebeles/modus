import { Injectable } from '@nestjs/common';
import { Prisma, Visibility } from '@prisma/client';
import { AppError, Tx } from './common';

export function eligibleStaff(visibility: Visibility): Prisma.UserWhereInput {
  return { active: true, role: { in: ['HANDLER', 'MANAGER'] },
    ...(visibility === 'NORMAL_INTERNAL' ? {} : { permissions: { has: 'SENSITIVE_CASE_HANDLER' } }) };
}

export function queueStaff(queueId: string): Prisma.UserWhereInput {
  return { OR: [{ queues: { some: { queueId } } }, { coordinates: { some: { id: queueId } } }] };
}

@Injectable()
export class Routing {
  async route(tx: Tx, input: { categoryId?: string | null; departmentId?: string | null; processId?: string | null; visibility: Visibility; authorId?: string }) {
    const category = input.categoryId ? await tx.category.findUnique({ where: { id: input.categoryId } }) : null;
    const visibility = category?.sensitive ? 'SPECIAL' : input.visibility;
    const responsible = async (queue: { id: string; coordinatorId: string }, assigneeId: string | null) => {
      if (assigneeId) {
        if (assigneeId === input.authorId || !await tx.user.findFirst({
          where: { id: assigneeId, ...eligibleStaff(visibility), ...queueStaff(queue.id) }, select: { id: true },
        })) return undefined;
        return assigneeId;
      }
      if (queue.coordinatorId !== input.authorId) return null;
      return (await tx.user.findFirst({
        where: { id: { not: input.authorId }, ...eligibleStaff(visibility), ...queueStaff(queue.id) },
        select: { id: true }, orderBy: { id: 'asc' },
      }))?.id;
    };
    const result = (queue: { id: string; coordinatorId: string }, assigneeId: string | null, reason: string) =>
      ({ queueId: queue.id, assigneeId, coordinatorId: queue.coordinatorId, visibility, reason });
    const fallback = async (reason: string) => {
      const queue = await tx.workQueue.findFirst({
        where: { visibility, fallback: true, coordinatorId: input.authorId ? { not: input.authorId } : undefined,
          coordinator: eligibleStaff(visibility) }, orderBy: { id: 'asc' },
      });
      if (queue) return result(queue, null, reason);
      if (input.authorId) {
        const ownQueue = await tx.workQueue.findFirst({
          where: { visibility, fallback: true, coordinatorId: input.authorId, coordinator: eligibleStaff(visibility),
            members: { some: { userId: { not: input.authorId }, user: eligibleStaff(visibility) } } },
          orderBy: { id: 'asc' },
        });
        if (ownQueue) {
          const assignee = await responsible(ownQueue, null);
          if (assignee) return result(ownQueue, assignee, reason);
        }
      }
      throw new AppError('ROUTING_UNAVAILABLE', 'Нет доступной очереди. Обратитесь к администратору.', 503);
    };
    if (visibility !== 'NORMAL_INTERNAL') return fallback('SPECIAL_ROUTE');
    if (!category) return fallback('NO_RULE');
    const now = new Date();
    const rules = await tx.routingRule.findMany({
      where: { active: true, categoryId: category.id, queue: { visibility, coordinator: eligibleStaff(visibility) },
        AND: [
          { OR: [{ departmentId: null }, { departmentId: input.departmentId ?? null }] },
          { OR: [{ processId: null }, { processId: input.processId ?? null }] },
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: now } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
        ] },
      include: { queue: true },
      orderBy: [{ rank: 'asc' }, { id: 'asc' }], take: 2,
    });
    const [first, second] = rules;
    if (!first || first.rank === second?.rank) return fallback(first ? 'RULE_CONFLICT' : 'NO_RULE');
    const assignee = await responsible(first.queue, first.assigneeId);
    if (assignee === undefined) return fallback('ASSIGNEE_UNAVAILABLE');
    return result(first.queue, assignee, 'MATCH');
  }
}
