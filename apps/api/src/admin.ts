import { Body, Controller, Get, Inject, Injectable, Param, Patch, Post, Req } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { z } from 'zod';
import { permissions, priorities, roles, visibilities } from '../../../packages/contracts/domain';
import { AuthRequest } from './auth';
import { atomic, audit, checked, Database, dateTime, expectedVersion, forbidden, id, invalid, missing, parse, shortText, Tx } from './common';
import { Principal, principalSelect } from './policy';
import { Routing } from './routing';

const name = shortText;
const userInput = z.strictObject({ name, email: z.email().max(254), password: z.string().min(12).max(72),
  role: z.enum(roles), departmentId: id.nullable().optional(), permissions: z.array(z.enum(permissions)).max(8).default([]), active: z.boolean().default(true) });
const ruleInput = z.strictObject({ name, categoryId: id, departmentId: id.nullable().optional(), processId: id.nullable().optional(),
  queueId: id, assigneeId: id.nullable().optional(), rank: z.number().int().min(0).max(1000).default(100), active: z.boolean().default(true),
  effectiveFrom: dateTime.nullable().optional(), effectiveTo: dateTime.nullable().optional() });
const resources = ['users', 'organization-units', 'categories', 'processes', 'work-queues', 'routing-rules', 'sla-policies', 'audit', 'outbox-failures'] as const;
type Resource = typeof resources[number];

@Injectable()
export class Admin {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Routing) private readonly routing: Routing) {}

  private check(user: Principal) { if (user.role !== 'ADMIN') throw forbidden(); }

  async list(user: Principal, resource: Resource) {
    this.check(user);
    switch (resource) {
      case 'users': return this.db.user.findMany({ take: 200, orderBy: { name: 'asc' }, select: { ...principalSelect, active: true } });
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
            result = await tx.user.update({ where: { id: item }, data, select: { id: true } });
            await tx.session.deleteMany({ where: { userId: item } });
          } else {
            if (user.demo && !data.email.endsWith('@demo.local')) throw invalid('В деморежиме используйте адрес @demo.local.');
            if (!passwordHash) throw invalid('Задайте пароль.');
            result = await tx.user.create({ data: { ...data, passwordHash, demo: user.demo }, select: { id: true } });
          }
          break;
        }
        case 'organization-units': {
          const data = parse(z.strictObject({ name, parentId: id.nullable().optional() }), raw);
          await this.tree(tx, data.parentId, item, resource);
          result = item ? await tx.organizationUnit.update({ where: { id: item }, data }) : await tx.organizationUnit.create({ data });
          break;
        }
        case 'categories': {
          const data = parse(z.strictObject({ name, parentId: id.nullable().optional(), sensitive: z.boolean().default(false) }), raw);
          await this.tree(tx, data.parentId, item, resource);
          result = item ? await tx.category.update({ where: { id: item }, data }) : await tx.category.create({ data });
          break;
        }
        case 'processes': {
          const data = parse(z.strictObject({ name }), raw);
          result = item ? await tx.businessProcess.update({ where: { id: item }, data }) : await tx.businessProcess.create({ data });
          break;
        }
        case 'work-queues': {
          const { memberIds, ...data } = parse(z.strictObject({ name, visibility: z.enum(visibilities), fallback: z.boolean().default(false), coordinatorId: id, memberIds: z.array(id).max(100).default([]) }), raw);
          const members = [...new Set([data.coordinatorId, ...memberIds])];
          const valid = await tx.user.count({ where: { id: { in: members }, active: true, role: { in: ['HANDLER', 'MANAGER'] },
            ...(data.visibility === 'NORMAL_INTERNAL' ? {} : { permissions: { has: 'SENSITIVE_CASE_HANDLER' } }) } });
          if (valid !== members.length) throw invalid('Участникам нужны действующие полномочия для этой очереди.');
          if (item) {
            const existing = await tx.workQueue.findUnique({ where: { id: item } });
            if (!existing) throw missing();
            if (existing.fallback && !data.fallback) throw invalid('Резервная очередь должна оставаться активной.');
            if (existing.visibility !== data.visibility) throw invalid('Класс доступа существующей очереди изменить нельзя.');
            result = await tx.workQueue.update({ where: { id: item }, data });
            await tx.queueMember.deleteMany({ where: { queueId: item } });
          } else result = await tx.workQueue.create({ data });
          await tx.queueMember.createMany({ data: members.map(userId => ({ queueId: result.id, userId })) });
          break;
        }
        case 'routing-rules': {
          const data = parse(ruleInput, raw);
          if (data.effectiveFrom && data.effectiveTo && data.effectiveFrom >= data.effectiveTo) throw invalid('Проверьте даты действия правила.');
          const queue = await tx.workQueue.findUnique({ where: { id: data.queueId } });
          if (!queue || queue.visibility !== 'NORMAL_INTERNAL') throw invalid('Для обычного правила выберите обычную очередь.');
          if (data.assigneeId && !await tx.queueMember.findUnique({ where: { userId_queueId: { queueId: data.queueId, userId: data.assigneeId } } }) &&
            queue.coordinatorId !== data.assigneeId) throw invalid('Назначенный сотрудник должен состоять в очереди.');
          result = item ? await tx.routingRule.update({ where: { id: item }, data }) : await tx.routingRule.create({ data });
          break;
        }
        case 'sla-policies': {
          const { expectedVersion: version, ...data } = parse(z.strictObject({ expectedVersion: expectedVersion.optional(), priority: z.enum(priorities),
            firstResponseHours: z.number().int().min(1).max(240), nextActionHours: z.number().int().min(1).max(480), active: z.boolean().default(true) }), raw);
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
    const input = parse(z.strictObject({ categoryId: id.optional(), departmentId: id.optional(), processId: id.optional(),
      visibility: z.enum(visibilities).default('NORMAL_INTERNAL') }), raw);
    return this.db.$transaction(tx => this.routing.route(tx, input));
  }
}

@Controller('admin')
export class AdminController {
  constructor(@Inject(Admin) private readonly admin: Admin) {}
  @Post('routing-rules/preview') preview(@Req() req: AuthRequest, @Body() raw: unknown) { return this.admin.preview(req.user, raw); }
  @Get(':resource') list(@Req() req: AuthRequest, @Param('resource') resource: string) { return this.admin.list(req.user, parse(z.enum(resources), resource)); }
  @Post(':resource') create(@Req() req: AuthRequest, @Param('resource') resource: string, @Body() raw: unknown) {
    return this.admin.write(req.user, parse(z.enum(resources), resource), raw);
  }
  @Patch(':resource/:id') edit(@Req() req: AuthRequest, @Param('resource') resource: string, @Param('id') item: string, @Body() raw: unknown) {
    return this.admin.write(req.user, parse(z.enum(resources), resource), raw, item);
  }
}
