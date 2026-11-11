import { Body, Controller, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { JsonBody } from './openapi';
import { AuthRequest } from './auth';
import { Database, missing, parse } from './common';

import { z } from 'zod';

const preferencesInput = z.strictObject({ notifyRegistration: z.boolean() });

@Controller()
export class NotificationsController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get('notifications') async list(@Req() req: AuthRequest) {
    const [items, unread] = await this.db.$transaction([
      this.db.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50,
        select: { id: true, kind: true, href: true, readAt: true, createdAt: true } }),
      this.db.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);
    return { items, unread };
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
