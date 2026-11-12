import { Injectable } from '@nestjs/common';
import { Prisma, Role, User, Visibility } from '@prisma/client';
import { missing, Tx } from './common';

export type Principal = Pick<User, 'id' | 'email' | 'name' | 'role' | 'departmentId' | 'permissions' | 'demo'>;
export const principalSelect = { id: true, email: true, name: true, role: true, departmentId: true, permissions: true, demo: true } as const;

@Injectable()
export class Policy {
  isStaff(user: Principal) {
    return user.role === Role.HANDLER || user.role === Role.MANAGER;
  }

  has(user: Principal, permission: string) {
    return this.isStaff(user) && user.permissions.includes(permission);
  }

  staffAppeals(user: Principal, delegatedOnly = false): Prisma.AppealWhereInput {
    if (!this.isStaff(user)) return { id: { in: [] } };
    const membership: Prisma.AppealWhereInput[] = [
      { assigneeId: user.id },
      { queue: { coordinatorId: user.id } },
      { queue: { members: { some: { userId: user.id } } } },
    ];
    const normal = [...membership];
    if (!delegatedOnly && user.role === 'MANAGER' && user.departmentId) {
      normal.push({ departmentId: user.departmentId, queueId: { not: null } });
    }
    const access: Prisma.AppealWhereInput[] = [{ visibility: 'NORMAL_INTERNAL', OR: normal }];
    if (this.has(user, 'SENSITIVE_CASE_HANDLER')) {
      access.push({ visibility: { in: ['RESTRICTED', 'SPECIAL'] }, OR: membership });
    }
    return { OR: access };
  }

  appeals(user: Principal): Prisma.AppealWhereInput {
    return { OR: [{ authorId: user.id }, this.staffAppeals(user)] };
  }

  async appeal(tx: Tx, user: Principal, id: string) {
    const item = await tx.appeal.findFirst({ where: { AND: [{ id }, this.appeals(user)] } });
    if (!item) throw missing();
    return item;
  }

  async handles(tx: Tx, user: Principal, id: string) {
    return !!await tx.appeal.findFirst({
      where: { AND: [{ id, authorId: { not: user.id } }, this.staffAppeals(user, true)] }, select: { id: true },
    });
  }

  cases(user: Principal): { OR: Prisma.ImprovementWhereInput[] } {
    if (!this.isStaff(user)) return { OR: [{ id: { in: [] } }] };
    const normal: Prisma.ImprovementWhereInput[] = [{ ownerId: user.id }];
    if (user.role === 'MANAGER' && user.departmentId) normal.push({ departmentId: user.departmentId });
    return { OR: [
      { visibility: Visibility.NORMAL_INTERNAL, OR: normal },
      ...(this.has(user, 'SENSITIVE_CASE_HANDLER') ? [{ visibility: { in: [Visibility.RESTRICTED, Visibility.SPECIAL] }, ownerId: user.id }] : []),
    ] };
  }

  problems(user: Principal): Prisma.ProblemWhereInput {
    return { OR: this.cases(user).OR.map(rule => rule as Prisma.ProblemWhereInput) };
  }

  improvements(user: Principal): Prisma.ImprovementWhereInput {
    const access = this.cases(user);
    if (this.isStaff(user)) access.OR.push({ visibility: 'NORMAL_INTERNAL', actions: { some: { ownerId: user.id } } });
    if (user.departmentId && ['IMPROVEMENT_APPROVER', 'RESULT_VERIFIER', 'PUBLICATION_APPROVER'].some(permission => this.has(user, permission))) {
      access.OR.push({ visibility: 'NORMAL_INTERNAL', departmentId: user.departmentId });
    }
    return access;
  }

  publications(user: Principal): Prisma.PublicationWhereInput {
    return { state: 'PUBLISHED', OR: [{ audienceId: null }, ...(user.departmentId ? [{ audienceId: user.departmentId }] : [])] };
  }

  feedback(user: Principal): Prisma.FeedbackWhereInput {
    const source = { authorId: user.id, visibility: 'NORMAL_INTERNAL' as const };
    return { userId: user.id, improvement: { implementedAt: { not: null }, visibility: 'NORMAL_INTERNAL', OR: [
      { appeals: { some: { appeal: source } } }, { problem: { appeals: { some: { appeal: source } } } },
    ] } };
  }
}
