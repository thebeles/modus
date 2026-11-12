import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { JsonBody, QueryFields } from './openapi';
import { AuthRequest } from './auth';
import { Database, missing, pagination, parse } from './common';
import { Policy } from './policy';

import { z } from 'zod';

const preferencesInput = z.strictObject({ notifyRegistration: z.boolean() });
const notificationQuery = z.strictObject({ ...pagination, unreadOnly: z.enum(['true']).optional() });

@Controller()
export class NotificationsController {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy) {}
  @Get('notifications') @QueryFields(notificationQuery)
  async list(@Req() req: AuthRequest, @Query() query: unknown) {
    const { page, limit, unreadOnly } = parse(notificationQuery, query);
    const unreadWhere = { userId: req.user.id, readAt: null };
    const where = unreadOnly ? unreadWhere : { userId: req.user.id };
    return this.db.$transaction(async tx => {
      const [items, unread, total] = await Promise.all([
        tx.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit, skip: (page - 1) * limit,
          select: { id: true, kind: true, href: true, readAt: true, createdAt: true } }),
        tx.notification.count({ where: unreadWhere }), tx.notification.count({ where }),
      ]);
      const ids = (kind: string) => items.flatMap(item => item.href?.startsWith('/' + kind + '/') ? [item.href.split('/')[2]] : []);
      const [appeals, improvements, changes, feedback] = await Promise.all([
        tx.appeal.findMany({ where: { AND: [{ id: { in: ids('appeals') } }, this.policy.appeals(req.user)] }, select: { id: true } }),
        tx.improvement.findMany({ where: { AND: [{ id: { in: ids('improvements') } }, this.policy.improvements(req.user)] }, select: { id: true } }),
        tx.publication.findMany({ where: { id: { in: ids('changes') }, ...this.policy.publications(req.user) }, select: { id: true } }),
        tx.feedback.findMany({ where: { id: { in: ids('feedback') }, ...this.policy.feedback(req.user) }, select: { id: true } }),
      ]);
      const accessible = new Set([...appeals.map(a => '/appeals/' + a.id), ...improvements.map(a => '/improvements/' + a.id),
        ...changes.map(a => '/changes/' + a.id), ...feedback.map(a => '/feedback/' + a.id)]);
      return { unread, total, page, limit, items: items.map(item =>
        item.href && !accessible.has(item.href) ? { ...item, kind: 'NOTIFICATION_UNAVAILABLE', href: null } : item) };
    }, { isolationLevel: 'RepeatableRead' });
  }
  @Get('notification-preferences') preferences(@Req() req: AuthRequest) {
    return this.db.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { notifyRegistration: true } });
  }
  @Patch('notification-preferences') @JsonBody(preferencesInput) updatePreferences(@Req() req: AuthRequest, @Body() raw: unknown) {
    const data = parse(preferencesInput, raw);
    return this.db.user.update({ where: { id: req.user.id }, data, select: { notifyRegistration: true } });
  }
  @Post('notifications/read-all') async readAll(@Req() req: AuthRequest) {
    await this.db.notification.updateMany({ where: { userId: req.user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }
  @Post('notifications/:id/read') async read(@Req() req: AuthRequest, @Param('id') item: string) {
    const result = await this.db.notification.updateMany({ where: { id: item, userId: req.user.id }, data: { readAt: new Date() } });
    if (!result.count) throw missing();
    return { ok: true };
  }
}
