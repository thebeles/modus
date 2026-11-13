import { Injectable } from '@nestjs/common';
import { Prisma, Visibility } from '@prisma/client';
import { AppError, invalid, notify, Tx } from './common';

export function eligibleStaff(visibility: Visibility): Prisma.UserWhereInput {
  return { active: true, role: { in: ['HANDLER', 'MANAGER'] },
    ...(visibility === 'NORMAL_INTERNAL' ? {} : { permissions: { has: 'SENSITIVE_CASE_HANDLER' } }) };
}

export function queueStaff(queueId: string): Prisma.UserWhereInput {
  return { OR: [{ queues: { some: { queueId } } }, { coordinates: { some: { id: queueId } } }] };
}

function availableStaff(visibility: Visibility, now: Date): Prisma.UserWhereInput {
  return { ...eligibleStaff(visibility), AND: [{ OR: [{ absentUntil: null }, { absentUntil: { lte: now } }] }] };
}

export async function notifyRoutingPending(tx: Tx, appeal: {
  id: string; visibility: Visibility; departmentId: string | null; authorId: string | null; isSynthetic: boolean;
}) {
  const queue = { visibility: appeal.visibility };
  const recipients = await tx.user.findMany({
    where: {
      ...eligibleStaff(appeal.visibility),
      id: { not: appeal.authorId ?? undefined },
      ...(appeal.authorId === null ? { demo: appeal.isSynthetic } : {}),
      permissions: appeal.visibility === 'NORMAL_INTERNAL' ? { has: 'ROUTING_COORDINATOR' } :
        { hasEvery: ['ROUTING_COORDINATOR', 'SENSITIVE_CASE_HANDLER'] },
      OR: [
        { coordinates: { some: queue } },
        { queues: { some: { queue } } },
        ...(appeal.visibility === 'NORMAL_INTERNAL' && appeal.departmentId ? [{ departmentId: appeal.departmentId }] : []),
      ],
    },
    select: { id: true },
  });
  await notify(tx, `routing-pending:${appeal.id}`, recipients.map(user => user.id), 'ROUTING_PENDING');
}

@Injectable()
export class Routing {
  async find(tx: Tx, input: { categoryId?: string | null; departmentId?: string | null; processId?: string | null; visibility: Visibility; authorId?: string | null; demo?: boolean }) {
    const category = input.categoryId ? await tx.category.findUnique({ where: { id: input.categoryId } }) : null;
    if (input.categoryId && !category) throw invalid('Выбранная категория недоступна.');
    const visibility = category?.sensitive ? 'SPECIAL' : input.visibility;
    const now = new Date();
    const available = availableStaff(visibility, now);
    const responsible = (queueId: string, userId: string) => userId !== input.authorId && tx.user.findFirst({
      where: { id: userId, ...available, ...queueStaff(queueId) }, select: { id: true, departmentId: true },
    });
    const result = (queue: { id: string; coordinatorId: string }, assigneeId: string | null, reason: string) =>
      ({ queueId: queue.id, assigneeId, coordinatorId: queue.coordinatorId, visibility, reason });
    const fallback = async (reason: string) => {
      const queue = await tx.workQueue.findFirst({
        where: { visibility, fallback: true, coordinatorId: input.authorId ? { not: input.authorId } : undefined,
          coordinator: { ...available, demo: input.demo } }, orderBy: { id: 'asc' },
      });
      if (queue) return result(queue, null, reason);
      if (input.authorId) {
        const ownQueue = await tx.workQueue.findFirst({
          where: { visibility, fallback: true, coordinatorId: input.authorId,
            coordinator: eligibleStaff(visibility),
            members: { some: { userId: { not: input.authorId }, user: available } } },
          orderBy: { id: 'asc' },
        });
        if (ownQueue) {
          const assignee = await tx.user.findFirst({ where: { id: { not: input.authorId }, ...available, ...queueStaff(ownQueue.id) },
            orderBy: { id: 'asc' }, select: { id: true } });
          if (assignee) return result(ownQueue, assignee.id, reason);
        }
      }
      return { queueId: null, assigneeId: null, coordinatorId: null, visibility, reason };
    };
    if (visibility !== 'NORMAL_INTERNAL') return fallback('SPECIAL_ROUTE');
    if (!category) return fallback('NO_RULE');
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
    const primaryId = first.assigneeId ?? first.queue.coordinatorId;
    if (await responsible(first.queueId, primaryId)) return result(first.queue, first.assigneeId, 'MATCH');
    if (first.deputyId && first.deputyId !== primaryId && await responsible(first.queueId, first.deputyId)) {
      return result(first.queue, first.deputyId, 'DEPUTY');
    }
    const primary = await tx.user.findUnique({ where: { id: primaryId }, select: { departmentId: true } });
    const departmentId = primary?.departmentId ?? input.departmentId;
    if (departmentId) {
      const managers = await tx.user.findMany({ where: { ...available, role: 'MANAGER', departmentId, ...queueStaff(first.queueId),
        id: { notIn: [primaryId, ...(input.authorId ? [input.authorId] : [])] } }, select: { id: true }, take: 2 });
      if (managers.length === 1) return result(first.queue, managers[0].id, 'DEPARTMENT_MANAGER');
    }
    return fallback('ASSIGNEE_UNAVAILABLE');
  }

  async route(tx: Tx, input: Parameters<Routing['find']>[1]) {
    const route = await this.find(tx, input);
    if (route.queueId === null) throw new AppError('ROUTING_UNAVAILABLE', 'Нет доступной очереди. Обратитесь к администратору.', 503);
    return route;
  }
}
