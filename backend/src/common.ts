import { HttpException, HttpStatus, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';

@Injectable()
export class Database extends PrismaClient implements OnModuleDestroy {
  constructor() { super({ transactionOptions: { maxWait: 5000, timeout: 15000 } }); }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

export class AppError extends HttpException {
  constructor(public readonly code: string, message: string, status = 400, public readonly details?: unknown) {
    super(message, status);
  }
}

export const missing = () => new AppError('NOT_FOUND', 'Запись не найдена или недоступна.', 404);
export const forbidden = () => new AppError('FORBIDDEN', 'У вас нет прав для этого действия.', 403);
export const invalidState = (message = 'Это действие недоступно на текущем этапе.') =>
  new AppError('INVALID_STATE_TRANSITION', message, 409);
export const conflict = () => new AppError('VERSION_CONFLICT', 'Данные изменились. Обновите карточку и повторите действие.', 409);
export const invalid = (message: string) => new AppError('VALIDATION_ERROR', message);
export const unauthenticated = () => new AppError('UNAUTHENTICATED', 'Войдите в систему.', HttpStatus.UNAUTHORIZED);

export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Проверьте заполнение полей.', 422,
      parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return parsed.data;
}

export const title = z.string().trim().min(3, 'Введите не менее 3 символов.').max(180);
export const bodyText = z.string().trim().min(5, 'Введите не менее 5 символов.').max(10000);
export const shortText = z.string().trim().min(1, 'Заполните поле.').max(500);
export const id = z.uuid();
export const expectedVersion = z.number().int().positive();
export const dateTime = z.iso.datetime().transform(value => new Date(value));
export const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export type Tx = Prisma.TransactionClient;

export function assertVersion(current: number, expected: number) {
  if (current !== expected) throw conflict();
}

export async function checked(update: Promise<{ count: number }>) {
  if ((await update).count !== 1) throw conflict();
}

export async function allocate(tx: Tx, prefix: 'A' | 'P' | 'I') {
  const initial = prefix === 'A' ? 21 : 1;
  const [result] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Sequence" ("name", "value") VALUES (${prefix}, ${initial})
    ON CONFLICT ("name") DO UPDATE SET "value" = "Sequence"."value" + 1 RETURNING "value"`;
  return `${prefix}-${String(result.value).padStart(3, '0')}`;
}

export async function atomic<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
      const retryable = error.code === 'P2034' ||
        (error.code === 'P2010' && ['40001', '40P01'].includes(String(error.meta?.code)));
      if (!retryable) throw error;
      if (attempt === 3) throw conflict();
      await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 15));
    }
  }
}

export async function throttle(db: Database, name: string, max: number, seconds: number) {
  const now = new Date();
  const expiry = new Date(now.getTime() + seconds * 1000);
  const [bucket] = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateBucket" ("key", "count", "expiresAt") VALUES (${name}, 1, ${expiry})
    ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "RateBucket"."expiresAt" <= ${now} THEN 1 ELSE "RateBucket"."count" + 1 END,
    "expiresAt" = CASE WHEN "RateBucket"."expiresAt" <= ${now} THEN ${expiry} ELSE "RateBucket"."expiresAt" END RETURNING "count"`;
  if (bucket.count > max) throw new AppError('RATE_LIMITED', 'Слишком много запросов. Повторите позже.', 429);
}

export async function audit(tx: Tx, entity: string, entityId: string, action: string, actorId?: string,
  authorVisible = false, details?: Prisma.InputJsonObject) {
  return tx.auditEvent.create({ data: { entity, entityId, action, actorId, authorVisible, details, origin: actorId ? 'USER_ACTION' : 'SYSTEM' } });
}

export async function notify(tx: Tx, eventId: string, recipients: (string | null | undefined)[], kind: string, href?: string) {
  const ids = [...new Set(recipients.filter((value): value is string => !!value))];
  if (ids.length) await tx.outboxJob.createMany({
    data: ids.map(userId => ({ key: `${eventId}:${userId}`, userId, kind, href })),
    skipDuplicates: true,
  });
}
