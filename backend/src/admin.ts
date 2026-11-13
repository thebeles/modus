import { ApiParam } from '@nestjs/swagger';
import { JsonBody, JsonBodyVariants, QueryFields } from './openapi';
import type { Prisma } from '@prisma/client';
import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { permissions, priorities, roles, visibilities } from './contracts';
import { AuthRequest } from './auth';
import { atomic, audit, checked, Database, dateTime, expectedVersion, forbidden, id, invalid, missing, notify, pagination, parse, shortText, Tx } from './common';
import { Principal, principalSelect } from './policy';
import { attachmentScanMode } from './attachment-scan';
import { eligibleStaff, queueStaff, Routing } from './routing';

const name = shortText;
const userInput = z.strictObject({ name, email: z.email().max(254), password: z.string().min(12).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Пароль должен занимать не более 72 байт.'),
  role: z.enum(roles), departmentId: id.nullable().optional(), permissions: z.array(z.enum(permissions)).max(permissions.length).default([]),
  active: z.boolean().default(true), absentUntil: dateTime.nullable().optional() });
const ruleInput = z.strictObject({ name, categoryId: id, departmentId: id.nullable().optional(), processId: id.nullable().optional(),
  queueId: id, assigneeId: id.nullable().optional(), deputyId: id.nullable().optional(),
  rank: z.number().int().min(0).max(1000).default(100), active: z.boolean().default(true),
  effectiveFrom: dateTime.nullable().optional(), effectiveTo: dateTime.nullable().optional() });
const unitInput = z.strictObject({ name, parentId: id.nullable().optional() });
const categoryInput = z.strictObject({ name, parentId: id.nullable().optional(), sensitive: z.boolean().default(false) });
const processInput = z.strictObject({ name });
const queueInput = z.strictObject({ name, visibility: z.enum(visibilities), fallback: z.boolean().default(false), coordinatorId: id, memberIds: z.array(id).max(100).default([]) });
const slaInput = z.strictObject({ expectedVersion: expectedVersion.optional(), priority: z.enum(priorities),
            firstResponseHours: z.number().int().min(1).max(240), nextActionHours: z.number().int().min(1).max(480),
            resolutionHours: z.number().int().min(1).max(1440).nullable().optional(), active: z.boolean().default(true) });
const previewInput = z.strictObject({ categoryId: id.optional(), departmentId: id.optional(), processId: id.optional(),
      visibility: z.enum(visibilities).default('NORMAL_INTERNAL') });
const resources = ['users', 'organization-units', 'categories', 'processes', 'work-queues', 'routing-rules', 'sla-policies', 'audit', 'outbox-failures'] as const;
type Resource = typeof resources[number];

const writableResources = ['users', 'organization-units', 'categories', 'processes', 'work-queues', 'routing-rules', 'sla-policies'] as const;
const userDirectoryInput = z.strictObject({ ...pagination, q: z.string().trim().max(150).optional(), role: z.enum(roles).optional() });
const configInputs = [unitInput, categoryInput, processInput, queueInput, ruleInput, slaInput];

@Injectable()
export class Admin {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Routing) private readonly routing: Routing) {}

  private check(user: Principal) { if (user.role !== 'ADMIN') throw forbidden(); }

  integrations(user: Principal) {
    this.check(user);
    const mode = process.env.ONEC_MODE;
    return { oneC: mode === 'simulator' || mode === 'http' ? mode : null };
  }

  async userDirectory(user: Principal, raw: unknown) {
    this.check(user);
    const { page, limit, q, role } = parse(userDirectoryInput, raw);
    const where: Prisma.UserWhereInput = { role, ...(q ? { OR: [
      { name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } },
    ] } : {}) };
    const [items, total] = await this.db.$transaction([
      this.db.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { ...principalSelect, active: true, department: { select: { name: true } } } }),
      this.db.user.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async workerStatus(user: Principal) {
    this.check(user);
    const pending = { deliveredAt: null, discardedAt: null, deadAt: null };
    const [heartbeat, oldest, pendingCount, deadCount, routingPendingCount, protection] = await this.db.$transaction([
      this.db.workerHeartbeat.findUnique({ where: { id: 'outbox' } }),
      this.db.outboxJob.findFirst({ where: pending, orderBy: { availableAt: 'asc' }, select: { availableAt: true } }),
      this.db.outboxJob.count({ where: pending }),
      this.db.outboxJob.count({ where: { deadAt: { not: null } } }),
      this.db.appeal.count({ where: { routingRetryAt: { not: null } } }),
      this.db.workerHeartbeat.findMany({ where: { id: { in: ['attachment-scan', 'attachment-scan-failure', 'attachment-storage-failure'] } } }),
    ]);
    return { lastCheckAt: heartbeat?.checkedAt ?? null, healthy: !!heartbeat && Date.now() - heartbeat.checkedAt.getTime() < 90000,
      oldestAvailableAt: oldest?.availableAt ?? null, pendingCount, deadCount, routingPendingCount, attachmentProtection: { mode: attachmentScanMode(),
        lastCleanAt: protection.find(row => row.id === 'attachment-scan')?.checkedAt ?? null,
        scanFailureAt: protection.find(row => row.id === 'attachment-scan-failure')?.checkedAt ?? null,
        storageFailureAt: protection.find(row => row.id === 'attachment-storage-failure')?.checkedAt ?? null,
      } };
  }

  async retryNotification(user: Principal, item: string) {
    this.check(user);
    return atomic(this.db, async tx => {
      const row = await tx.outboxJob.findUnique({ where: { id: item }, select: { deadAt: true, attempts: true } });
      if (!row?.deadAt) throw missing();
      await checked(tx.outboxJob.updateMany({ where: { id: item, deadAt: row.deadAt, deliveredAt: null, discardedAt: null },
        data: { attempts: 0, deadAt: null, availableAt: new Date() } }));
      await audit(tx, 'outbox-failures', item, 'RETRY_REQUESTED', user.id, false, { previousAttempts: row.attempts });
      return { id: item };
    });
  }

  async list(user: Principal, resource: Resource) {
    this.check(user);
    switch (resource) {
      case 'users': return this.db.user.findMany({ take: 200, orderBy: { name: 'asc' }, select: { ...principalSelect, active: true, absentUntil: true } });
      case 'organization-units': return this.db.organizationUnit.findMany({ take: 200, orderBy: { name: 'asc' } });
      case 'categories': return this.db.category.findMany({ take: 200, orderBy: { name: 'asc' } });
      case 'processes': return this.db.businessProcess.findMany({ take: 200, orderBy: { name: 'asc' } });
      case 'work-queues': return this.db.workQueue.findMany({ take: 200, orderBy: { name: 'asc' }, include: { members: { select: { userId: true } } } });
      case 'routing-rules': return this.db.routingRule.findMany({ take: 200, orderBy: { rank: 'asc' } });
      case 'sla-policies': return this.db.slaPolicy.findMany({ orderBy: { priority: 'asc' } });
      case 'audit': return this.db.auditEvent.findMany({ take: 100, orderBy: { createdAt: 'desc' }, select: { id: true, entity: true, action: true, createdAt: true } });
      case 'outbox-failures': return this.db.outboxJob.findMany({ where: { deadAt: { not: null } }, take: 100,
        select: { id: true, kind: true, deadAt: true, attempts: true }, orderBy: { deadAt: 'desc' } });
    }
  }

  private async tree(tx: Tx, parentId: string | null | undefined, item: string | undefined, resource: 'organization-units' | 'categories') {
    const visited = new Set(item ? [item] : []);
    while (parentId) {
      if (visited.has(parentId)) throw invalid('Родительская запись образует цикл.');
      visited.add(parentId);
      const query = { where: { id: parentId }, select: { parentId: true } };
      const parent = resource === 'categories' ? await tx.category.findUnique(query) : await tx.organizationUnit.findUnique(query);
      if (!parent) throw missing();
      parentId = parent.parentId;
    }
  }

  private async releaseAssignments(tx: Tx, actor: Principal, scope: Prisma.AppealWhereInput, reason: string) {
    const assignments = await tx.appeal.findMany({ where: { AND: [scope, { assigneeId: { not: null } }] },
      select: { id: true, authorId: true, assigneeId: true, status: true, visibility: true, queueId: true,
        queue: { select: { coordinatorId: true } } } });
    for (const row of assignments) {
      const active = row.status !== 'CLOSED' && row.status !== 'WITHDRAWN';
      const route = active && row.queue?.coordinatorId === row.authorId ?
        await this.routing.route(tx, { visibility: row.visibility, authorId: row.authorId }) : null;
      await tx.appeal.update({ where: { id: row.id }, data: {
        queueId: route?.queueId ?? row.queueId, assigneeId: route?.assigneeId ?? null, version: { increment: 1 },
      } });
      const event = await audit(tx, 'appeal', row.id, 'ASSIGNED', actor.id, true, { reason, previousAssigneeId: row.assigneeId });
      if (active) await notify(tx, event.id, [route?.assigneeId ?? route?.coordinatorId ?? row.queue?.coordinatorId], 'ASSIGNED', `/appeals/${row.id}`);
    }
  }

  private async releaseRules(tx: Tx, actor: Principal, where: Prisma.RoutingRuleWhereInput) {
    const rules = await tx.routingRule.findMany({ where, select: { id: true } });
    if (!rules.length) return;
    await tx.routingRule.updateMany({ where: { id: { in: rules.map(row => row.id) } }, data: { assigneeId: null } });
    for (const rule of rules) await audit(tx, 'routing-rules', rule.id, 'ASSIGNEE_REMOVED', actor.id);
  }

  async write(user: Principal, resource: Resource, raw: unknown, item?: string) {
    this.check(user);
    if (resource === 'audit' || resource === 'outbox-failures') throw forbidden();
    const input = resource === 'users' ? parse(item ? userInput.omit({ password: true }) : userInput, raw) : null;
    const passwordHash = input && 'password' in input && typeof input.password === 'string' ? await hash(input.password, 12) : null;
    return atomic(this.db, async tx => {
      let result: { id: string };
      switch (resource) {
        case 'users': {
          const { password: _password, ...values } = input as z.output<typeof userInput>;
          const data = { ...values, email: values.email.toLowerCase(), permissions: [...new Set(values.permissions)] };
          if (item) {
            const before = await tx.user.findUnique({ where: { id: item } });
            if (!before) throw missing();
            if (before.demo && !user.demo) throw forbidden();
            if (item === user.id && (!data.active || data.role !== 'ADMIN')) throw invalid('Текущая учётная запись должна оставаться администратором.');
            if (before.role !== data.role || !data.active || !data.permissions.includes('SENSITIVE_CASE_HANDLER')) {
              const queues = await tx.workQueue.findMany({ where: { coordinatorId: item } });
              if (queues.some(queue => !data.active || !['HANDLER', 'MANAGER'].includes(data.role) || (queue.visibility !== 'NORMAL_INTERNAL' && !data.permissions.includes('SENSITIVE_CASE_HANDLER')))) {
                throw invalid('Сначала передайте координацию очереди другому сотруднику.');
              }
            }
            const staff = data.active && ['HANDLER', 'MANAGER'].includes(data.role);
            if (!staff) {
              const [problems, improvements, tasks] = await Promise.all([
                tx.problem.count({ where: { ownerId: item, status: { not: 'CLOSED' } } }),
                tx.improvement.count({ where: { ownerId: item, status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELED'] } } }),
                tx.actionItem.count({ where: { ownerId: item, status: { notIn: ['DONE', 'CANCELED'] },
                  improvement: { status: { notIn: ['COMPLETED', 'REJECTED', 'CANCELED'] } } } }),
              ]);
              if (problems || improvements || tasks) throw invalid('Сначала передайте открытые проблемы, улучшения и задачи другому сотруднику.');
            }
            result = await tx.user.update({ where: { id: item }, data, select: { id: true } });
            if (!staff || !data.permissions.includes('SENSITIVE_CASE_HANDLER')) {
              await this.releaseAssignments(tx, user, { assigneeId: item, ...(staff ? { visibility: { not: 'NORMAL_INTERNAL' } } : {}) }, 'ASSIGNEE_ACCESS_REVOKED');
              await tx.queueMember.deleteMany({ where: { userId: item, ...(staff ? { queue: { visibility: { not: 'NORMAL_INTERNAL' } } } : {}) } });
            }
            if (!staff) await this.releaseRules(tx, user, { assigneeId: item });
            await tx.session.deleteMany({ where: { userId: item } });
          } else {
            if (user.demo && !data.email.endsWith('@demo.local')) throw invalid('В деморежиме используйте адрес @demo.local.');
            if (!passwordHash) throw invalid('Задайте пароль.');
            result = await tx.user.create({ data: { ...data, passwordHash, demo: user.demo }, select: { id: true } });
          }
          break;
        }
        case 'organization-units': {
          const data = parse(unitInput, raw);
          await this.tree(tx, data.parentId, item, resource);
          result = item ? await tx.organizationUnit.update({ where: { id: item }, data }) : await tx.organizationUnit.create({ data });
          break;
        }
        case 'categories': {
          const data = parse(categoryInput, raw);
          await this.tree(tx, data.parentId, item, resource);
          result = item ? await tx.category.update({ where: { id: item }, data }) : await tx.category.create({ data });
          break;
        }
        case 'processes': {
          const data = parse(processInput, raw);
          result = item ? await tx.businessProcess.update({ where: { id: item }, data }) : await tx.businessProcess.create({ data });
          break;
        }
        case 'work-queues': {
          const { memberIds, ...data } = parse(queueInput, raw);
          const members = [...new Set([data.coordinatorId, ...memberIds])];
          const valid = await tx.user.count({ where: { id: { in: members }, ...eligibleStaff(data.visibility) } });
          if (valid !== members.length) throw invalid('Участникам нужны действующие полномочия для этой очереди.');
          if (item) {
            const existing = await tx.workQueue.findUnique({ where: { id: item } });
            if (!existing) throw missing();
            if (existing.fallback && !data.fallback) throw invalid('Резервная очередь должна оставаться активной.');
            if (existing.visibility !== data.visibility) throw invalid('Класс доступа существующей очереди изменить нельзя.');
            result = await tx.workQueue.update({ where: { id: item }, data });
            await tx.queueMember.deleteMany({ where: { queueId: item } });
            if (existing.coordinatorId !== data.coordinatorId) {
              const cases = await tx.appeal.findMany({ where: { queueId: item, assigneeId: null, status: { notIn: ['CLOSED', 'WITHDRAWN'] } }, select: { id: true } });
              if (await tx.appeal.count({ where: { queueId: item, authorId: data.coordinatorId, assigneeId: null, status: { notIn: ['CLOSED', 'WITHDRAWN'] } } })) {
                throw invalid('Сначала назначьте обработчика для открытых обращений нового координатора.');
              }
              for (const row of cases) {
                const event = await audit(tx, 'appeal', row.id, 'QUEUE_COORDINATOR_CHANGED', user.id);
                await notify(tx, event.id, [data.coordinatorId], 'ASSIGNED', `/appeals/${row.id}`);
              }
            }
          } else result = await tx.workQueue.create({ data });
          await tx.queueMember.createMany({ data: members.map(userId => ({ queueId: result.id, userId })) });
          if (item) {
            await this.releaseAssignments(tx, user, { queueId: item, assigneeId: { notIn: members } }, 'QUEUE_MEMBERSHIP_REVOKED');
            await this.releaseRules(tx, user, { queueId: item, assigneeId: { notIn: members } });
          }
          break;
        }
        case 'routing-rules': {
          const data = parse(ruleInput, raw);
          if (data.effectiveFrom && data.effectiveTo && data.effectiveFrom >= data.effectiveTo) throw invalid('Проверьте даты действия правила.');
          const queue = await tx.workQueue.findUnique({ where: { id: data.queueId } });
          if (!queue || queue.visibility !== 'NORMAL_INTERNAL') throw invalid('Для обычного правила выберите обычную очередь.');
          if (data.assigneeId && !await tx.user.findFirst({ where: { id: data.assigneeId, ...eligibleStaff(queue.visibility), ...queueStaff(queue.id) }, select: { id: true } })) {
            throw invalid('Назначенный сотрудник должен иметь действующие полномочия в очереди.');
          }
          const existing = item && data.deputyId === undefined ? await tx.routingRule.findUnique({ where: { id: item }, select: { deputyId: true } }) : null;
          const deputyId = data.deputyId === undefined ? existing?.deputyId : data.deputyId;
          if (deputyId && (deputyId === (data.assigneeId ?? queue.coordinatorId) ||
            !await tx.user.findFirst({ where: { id: deputyId, ...eligibleStaff(queue.visibility), ...queueStaff(queue.id) }, select: { id: true } }))) {
            throw invalid('Укажите другого действующего участника очереди в качестве заместителя.');
          }
          result = item ? await tx.routingRule.update({ where: { id: item }, data }) : await tx.routingRule.create({ data });
          break;
        }
        case 'sla-policies': {
          const { expectedVersion: version, ...data } = parse(slaInput, raw);
          if (item) {
            if (!version) throw invalid('Укажите версию политики.');
            await checked(tx.slaPolicy.updateMany({ where: { id: item, version }, data: { ...data, version: { increment: 1 } } }));
            result = { id: item };
          } else result = await tx.slaPolicy.create({ data });
          break;
        }
      }
      await audit(tx, resource, result.id, item ? 'UPDATED' : 'CREATED', user.id);
      return { id: result.id };
    });
  }

  async preview(user: Principal, raw: unknown) {
    this.check(user);
    const input = parse(previewInput, raw);
    return this.db.$transaction(tx => this.routing.route(tx, input));
  }
}

@Controller('admin')
export class AdminController {
  constructor(@Inject(Admin) private readonly admin: Admin) {}
  @Get('integrations') integrations(@Req() req: AuthRequest) { return this.admin.integrations(req.user); }
  @Get('user-directory') @QueryFields(userDirectoryInput)
  directory(@Req() req: AuthRequest, @Query() q: unknown) { return this.admin.userDirectory(req.user, q); }
  @Get('worker-status') workerStatus(@Req() req: AuthRequest) { return this.admin.workerStatus(req.user); }
  @Post('outbox-failures/:id/retry') retry(@Req() req: AuthRequest, @Param('id') item: string) {
    return this.admin.retryNotification(req.user, parse(id, item));
  }
  @Post('routing-rules/preview') @JsonBody(previewInput) preview(@Req() req: AuthRequest, @Body() raw: unknown) { return this.admin.preview(req.user, raw); }
  @Get(':resource') list(@Req() req: AuthRequest, @Param('resource') resource: string) { return this.admin.list(req.user, parse(z.enum(resources), resource)); }
  @Post(':resource') @ApiParam({ name: 'resource', enum: writableResources })
  @JsonBodyVariants([userInput, ...configInputs])
  create(@Req() req: AuthRequest, @Param('resource') resource: string, @Body() raw: unknown) {
    return this.admin.write(req.user, parse(z.enum(resources), resource), raw);
  }
  @Patch(':resource/:id') @ApiParam({ name: 'resource', enum: writableResources })
  @JsonBodyVariants([userInput.omit({ password: true }), ...configInputs])
  edit(@Req() req: AuthRequest, @Param('resource') resource: string, @Param('id') item: string, @Body() raw: unknown) {
    return this.admin.write(req.user, parse(z.enum(resources), resource), raw, item);
  }
}
