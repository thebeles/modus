import { Body, Controller, Delete, Get, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest } from './auth';
import { atomic, audit, bodyText, Database, digest, forbidden, id, invalid, missing, pagination, parse, throttle, title } from './common';
import { JsonBody, QueryFields } from './openapi';
import { Policy, Principal } from './policy';
import { departmentScope } from './proposals';

const categories = ['DELIVERY', 'QUALITY', 'SERVICE', 'PAYMENT', 'OTHER'] as const;
const category = z.enum(categories);
const csvInput = z.strictObject({ csv: z.string().min(1).max(64000) });
const linkInput = z.strictObject({ target: z.enum(['appeal', 'improvement']), targetId: id });
const listInput = z.strictObject({ ...pagination, category: category.optional(), appealId: id.optional(), improvementId: id.optional() })
  .refine(input => !input.appealId || !input.improvementId);
const reference = { id: true, number: true, title: true };
const rules = [
  ['DELIVERY', /достав|курьер|опозда|задерж|срок|deliver|shipping|delay/iu],
  ['QUALITY', /брак|сломан|дефект|повреж|качеств|defect|broken|quality/iu],
  ['SERVICE', /груб|поддерж|оператор|сервис|обслуж|support|service/iu],
  ['PAYMENT', /оплат|возврат|деньги|сч[её]т|цен[аы]|payment|refund|invoice/iu],
] as const;

export const normalizeReview = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const categorizeReview = (text: string) => rules.find(([, pattern]) => pattern.test(text))?.[0] ?? 'OTHER';

export function parseReviewCsv(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let state: 'plain' | 'quoted' | 'closed' = 'plain';
  const pushField = () => { row.push(value); value = ''; state = 'plain'; };
  const pushRow = () => {
    pushField();
    if (row.some(field => field.trim()) || row.length > 1) rows.push(row);
    if (rows.length > 501) throw invalid('CSV должен содержать не более 500 отзывов.');
    row = [];
  };
  csv = csv.replace(/^\uFEFF/, '');
  for (let pos = 0; pos < csv.length; pos++) {
    const char = csv[pos];
    if (state === 'quoted') {
      if (char !== '"') value += char;
      else if (csv[pos + 1] === '"') { value += '"'; pos++; }
      else state = 'closed';
    } else if (char === ',') pushField();
    else if (char === '\r' || char === '\n') {
      if (char === '\r' && csv[pos + 1] === '\n') pos++;
      pushRow();
    } else if (char === '"' && state === 'plain' && !value) state = 'quoted';
    else if (state === 'closed' || char === '"') throw invalid('Проверьте кавычки в CSV.');
    else value += char;
  }
  if (state === 'quoted') throw invalid('В CSV осталась незакрытая кавычка.');
  if (value || row.length || state === 'closed') pushRow();
  const [headers, ...data] = rows;
  const expected = ['date', 'title', 'body'];
  if (!headers || headers.length !== expected.length || !expected.every(name => headers.includes(name)) || !data.length) {
    throw invalid('Добавьте заголовки date, title, body и хотя бы один отзыв.');
  }
  const schema = z.strictObject({ date: z.iso.date(), title, body: bodyText });
  return data.map((fields, index) => {
    if (fields.length !== headers.length) throw invalid('Неверное число полей в записи ' + (index + 2) + '.');
    const result = schema.safeParse(Object.fromEntries(headers.map((name, i) => [name, fields[i].trim()])));
    if (!result.success) throw invalid('Проверьте дату, заголовок и текст записи ' + (index + 2) + '.');
    const item = result.data;
    const normalized = normalizeReview(item.title + ' ' + item.body);
    if (!normalized) throw invalid('Добавьте текст в запись ' + (index + 2) + '.');
    return { title: item.title, body: item.body, occurredAt: new Date(item.date),
      fingerprint: digest(JSON.stringify([item.date, normalizeReview(item.title), normalizeReview(item.body)])),
      category: categorizeReview(normalized) };
  });
}

@Injectable()
export class Reviews {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy) {}

  private scope(user: Principal, write = false) {
    if (!this.policy.isStaff(user) || (write && !this.policy.has(user, 'PROBLEM_OWNER'))) throw forbidden();
    return departmentScope(user);
  }

  private async checkTarget(tx: Prisma.TransactionClient, user: Principal, input: z.output<typeof linkInput>) {
    const base = { id: input.targetId, ...this.scope(user), visibility: 'NORMAL_INTERNAL' as const };
    const count = input.target === 'appeal'
      ? await tx.appeal.count({ where: { AND: [base, this.policy.staffAppeals(user)] } })
      : await tx.improvement.count({ where: { AND: [base, this.policy.improvements(user)] } });
    if (!count) throw missing();
  }

  async import(user: Principal, raw: unknown) {
    const scope = this.scope(user, true);
    const { csv } = parse(csvInput, raw);
    if (Buffer.byteLength(csv) > 64000) throw invalid('Максимальный размер CSV — 64 КБ.');
    await throttle(this.db, 'review-import:' + user.id, 15, 3600);
    const data = parseReviewCsv(csv);
    return atomic(this.db, async tx => {
      const { count } = await tx.customerReview.createMany({ data: data.map(row => ({ ...row, ...scope })), skipDuplicates: true });
      await audit(tx, 'customer-reviews', scope.departmentId, 'CSV_IMPORTED', user.id, false, { inserted: count, duplicates: data.length - count });
      return { inserted: count, duplicates: data.length - count };
    });
  }

  async list(user: Principal, raw: unknown) {
    const scope = this.scope(user);
    const { page, limit, category, appealId, improvementId } = parse(listInput, raw);
    return this.db.$transaction(async tx => {
      if (appealId) await this.checkTarget(tx, user, { target: 'appeal', targetId: appealId });
      if (improvementId) await this.checkTarget(tx, user, { target: 'improvement', targetId: improvementId });
      const where = { ...scope, category, ...(appealId ? { appeals: { some: { appealId } } } : {}),
        ...(improvementId ? { improvements: { some: { improvementId } } } : {}) };
      const [items, total, groups] = await Promise.all([
        tx.customerReview.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit,
          select: { id: true, title: true, body: true, occurredAt: true, category: true,
            appeals: { where: { appeal: this.policy.staffAppeals(user) }, select: { appeal: { select: reference } } },
            improvements: { where: { improvement: this.policy.improvements(user) }, select: { improvement: { select: reference } } },
          } }),
        tx.customerReview.count({ where }),
        tx.customerReview.groupBy({ by: ['category'], where: scope, _count: { _all: true } }),
      ]);
      return { items, total, page, limit, groups: groups.map(group => ({ category: group.category, count: group._count._all })) };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async targets(user: Principal, raw: unknown) {
    const scope = this.scope(user, true);
    const { target, q, page, limit } = parse(z.strictObject({ ...pagination, target: linkInput.shape.target,
      q: z.string().trim().max(150).optional() }), raw);
    const base = { ...scope, visibility: 'NORMAL_INTERNAL' as const, ...(q ? { OR: [
      { number: { contains: q, mode: 'insensitive' as const } },
      { title: { contains: q, mode: 'insensitive' as const } },
    ] } : {}) };
    const options = { select: reference, orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
      skip: (page - 1) * limit, take: limit };
    const [items, total] = target === 'appeal' ? await this.db.$transaction([
      this.db.appeal.findMany({ ...options, where: { AND: [base, this.policy.staffAppeals(user)] } }),
      this.db.appeal.count({ where: { AND: [base, this.policy.staffAppeals(user)] } }),
    ], { isolationLevel: 'RepeatableRead' }) : await this.db.$transaction([
      this.db.improvement.findMany({ ...options, where: { AND: [base, this.policy.improvements(user)] } }),
      this.db.improvement.count({ where: { AND: [base, this.policy.improvements(user)] } }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items, total, page, limit };
  }

  async similar(user: Principal, item: string) {
    const scope = this.scope(user);
    const review = await this.db.customerReview.findFirst({ where: { id: item, ...scope } });
    if (!review) throw missing();
    return this.db.$queryRaw<{ id: string; title: string; category: string; score: number }[]> `
      SELECT id, title, category, similarity(title || ' ' || left(body, 1000), ${review.title + ' ' + review.body.slice(0, 1000)}) AS score
      FROM "CustomerReview" WHERE "departmentId" = ${scope.departmentId} AND "isSynthetic" = ${scope.isSynthetic}
        AND id <> ${item} AND (title || ' ' || left(body, 1000)) % ${review.title + ' ' + review.body.slice(0, 1000)}
      ORDER BY score DESC, id ASC LIMIT 10`;
  }

  async link(user: Principal, reviewId: string, raw: unknown, attach: boolean) {
    const scope = this.scope(user, true);
    const input = parse(linkInput, raw);
    return atomic(this.db, async tx => {
      if (!await tx.customerReview.count({ where: { id: reviewId, ...scope } })) throw missing();
      await this.checkTarget(tx, user, input);
      const action = attach ? 'SOURCE_LINKED' : 'SOURCE_UNLINKED';
      let count: number;
      if (input.target === 'appeal') {
        const data = { reviewId, appealId: input.targetId };
        ({ count } = attach ? await tx.customerReviewAppeal.createMany({ data, skipDuplicates: true }) : await tx.customerReviewAppeal.deleteMany({ where: data }));
      } else {
        const data = { reviewId, improvementId: input.targetId };
        ({ count } = attach ? await tx.customerReviewImprovement.createMany({ data, skipDuplicates: true }) : await tx.customerReviewImprovement.deleteMany({ where: data }));
      }
      if (count) {
        await audit(tx, 'customer-review', reviewId, action, user.id, false, input);
        await audit(tx, input.target, input.targetId, action, user.id, false, { reviewId });
      }
      return { ok: true };
    });
  }
}

@ApiTags('Клиентские отзывы')
@Controller('customer-reviews')
export class ReviewsController {
  constructor(@Inject(Reviews) private readonly service: Reviews) {}
  @Get() @QueryFields(listInput) list(@Req() req: AuthRequest, @Query() raw: unknown) { return this.service.list(req.user, raw); }
  @Post('import') @JsonBody(csvInput) import(@Req() req: AuthRequest, @Body() raw: unknown) { return this.service.import(req.user, raw); }
  @Get('targets') targets(@Req() req: AuthRequest, @Query() raw: unknown) { return this.service.targets(req.user, raw); }
  @Get(':id/similar') similar(@Req() req: AuthRequest, @Param('id') item: string) { return this.service.similar(req.user, parse(id, item)); }
  @Post(':id/links') @JsonBody(linkInput) link(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.link(req.user, parse(id, item), raw, true);
  }
  @Delete(':id/links') @JsonBody(linkInput) unlink(@Req() req: AuthRequest, @Param('id') item: string, @Body() raw: unknown) {
    return this.service.link(req.user, parse(id, item), raw, false);
  }
}
