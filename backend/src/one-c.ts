import { Body, Controller, Get, Headers, Inject, Injectable, Param, Post, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { OneCRequest, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthRequest, demoMode } from './auth';
import { AppError, atomic, audit, Database, forbidden, id, invalidState, missing, pagination, parse, throttle } from './common';
import { JsonBody, QueryFields } from './openapi';
import { Policy, Principal } from './policy';

const sku = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/);
const createInput = z.strictObject({ sku, quantity: z.number().int().min(1).max(1000000), improvementId: id.optional() });
const products = z.array(z.object({ sku, name: z.string().min(1).max(300), stock: z.number().int().nonnegative() })).max(1000);
const remoteStatus = z.object({ externalId: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,199}$/), status: z.enum(['SUBMITTED', 'PROCESSING', 'COMPLETED', 'REJECTED']) });
type Mode = 'http' | 'simulator';
type Product = z.output<typeof products>[number];
type RemoteStatus = z.output<typeof remoteStatus>;
const unavailable = () => new AppError('ONEC_UNAVAILABLE', 'Сервис 1С временно недоступен. Заявку можно повторить с тем же ключом.', 503);
const requestQuery = z.strictObject({ ...pagination, improvementId: id.optional() });
const paged = z.strictObject(pagination);
const requestSelect = { id: true, sku: true, quantity: true, status: true, externalId: true, improvementId: true,
  createdAt: true, updatedAt: true } as const;
const simulatorProducts = [
  { sku: 'DEMO-001', name: 'Маркировочные этикетки', stock: 420 },
  { sku: 'DEMO-002', name: 'Транспортная коробка', stock: 84 },
  { sku: 'DEMO-003', name: 'Защитная упаковка', stock: 0 },
];
const statusOrder: Record<string, number> = { PENDING: 0, SUBMITTED: 1, PROCESSING: 2, COMPLETED: 3, REJECTED: 3 };

interface OneCAdapter {
  products(): Promise<Product[]>;
  submit(request: OneCRequest): Promise<RemoteStatus>;
  status(request: OneCRequest): Promise<RemoteStatus>;
}

class HttpOneC implements OneCAdapter {
  private async fetch<T extends z.ZodType>(path: string, schema: T, body?: unknown, key?: string): Promise<z.output<T>> {
    try {
      const base = new URL(process.env.ONEC_API_URL ?? '');
      if ((base.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && base.protocol === 'http:')) ||
          base.username || base.password || base.hash || base.search || !process.env.ONEC_API_TOKEN) throw unavailable();
      const url = new URL(path, base.href.replace(/\/?$/, '/'));
      const response = await fetch(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: 'Bearer ' + process.env.ONEC_API_TOKEN, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key! } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      return schema.parse(await response.json());
    } catch { throw unavailable(); }
  }

  products() { return this.fetch('products', products); }

  submit(request: OneCRequest) {
    return this.fetch('requests', remoteStatus, { requestId: request.id, sku: request.sku, quantity: request.quantity }, request.id);
  }

  status(request: OneCRequest) {
    return this.fetch('requests/' + encodeURIComponent(request.externalId!), remoteStatus);
  }
}

class Simulator implements OneCAdapter {
  constructor(private readonly db: Database) {}

  async products() {
    const allocations = await this.db.oneCRequest.groupBy({ by: ['sku'], where: { mode: 'simulator', status: { in: ['SUBMITTED', 'PROCESSING', 'COMPLETED'] } },
      _sum: { quantity: true } });
    return simulatorProducts.map(product => ({ ...product, stock: product.stock - (allocations.find(row => row.sku === product.sku)?._sum.quantity ?? 0) }));
  }

  async submit(request: OneCRequest): Promise<RemoteStatus> {
    return atomic(this.db, async tx => {
      const current = await tx.oneCRequest.findUniqueOrThrow({ where: { id: request.id } });
      const externalId = 'SIM-' + request.id;
      if (current.externalId) return { externalId, status: remoteStatus.shape.status.parse(current.status) };
      const product = simulatorProducts.find(item => item.sku === current.sku);
      const used = await tx.oneCRequest.aggregate({ where: { mode: 'simulator', sku: current.sku, status: { in: ['SUBMITTED', 'PROCESSING', 'COMPLETED'] } },
        _sum: { quantity: true } });
      const status = product && product.stock - (used._sum.quantity ?? 0) >= current.quantity ? 'SUBMITTED' : 'REJECTED';
      await tx.oneCRequest.update({ where: { id: current.id }, data: { externalId, status } });
      return { externalId, status };
    });
  }

  async status(request: OneCRequest): Promise<RemoteStatus> {
    const elapsed = Date.now() - request.createdAt.getTime();
    const status = request.status === 'REJECTED' ? 'REJECTED' : elapsed >= 60000 ? 'COMPLETED' : elapsed >= 10000 ? 'PROCESSING' : 'SUBMITTED';
    return { externalId: request.externalId!, status };
  }
}

@Injectable()
export class OneC {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Policy) private readonly policy: Policy) {}

  capabilities(user: Principal): { mode: Mode | null } {
    const configured = process.env.ONEC_MODE;
    if (this.policy.isStaff(user) && configured === 'simulator' && user.demo && demoMode()) return { mode: configured };
    if (this.policy.has(user, 'ONEC_OPERATOR') && configured === 'http' && !user.demo) return { mode: configured };
    return { mode: null };
  }

  private mode(user: Principal): Mode {
    const { mode } = this.capabilities(user);
    if (mode) return mode;
    if (!user.demo && this.policy.has(user, 'ONEC_OPERATOR')) throw unavailable();
    throw forbidden();
  }

  private adapter(mode: Mode): OneCAdapter {
    return mode === 'simulator' ? new Simulator(this.db) : new HttpOneC();
  }

  private async run<T>(user: Principal, mode: Mode, action: string, requestId: string | undefined, execute: () => Promise<T>) {
    await throttle(this.db, 'one-c:' + user.id, 90, 300);
    const operation = await this.db.oneCOperation.create({ data: { userId: user.id, mode, action, requestId, result: 'STARTED' } });
    try {
      const result = await execute();
      await this.db.oneCOperation.update({ where: { id: operation.id }, data: { result: 'OK' } });
      return result;
    } catch (error) {
      await this.db.oneCOperation.update({ where: { id: operation.id }, data: { result: 'ERROR' } });
      throw error;
    }
  }

  private async ensureImprovement(tx: Prisma.TransactionClient, user: Principal, improvementId: string) {
    if (!await tx.improvement.count({ where: { AND: [{ id: improvementId, visibility: 'NORMAL_INTERNAL', isSynthetic: user.demo },
      this.policy.improvements(user)] } })) throw missing();
  }

  async products(user: Principal) {
    const mode = this.mode(user);
    return this.run(user, mode, 'PRODUCTS', undefined, async () => ({ mode, items: await this.adapter(mode).products() }));
  }

  async list(user: Principal, raw: unknown) {
    const mode = this.mode(user);
    const { page, limit, improvementId } = parse(requestQuery, raw);
    return this.db.$transaction(async tx => {
      if (improvementId) await this.ensureImprovement(tx, user, improvementId);
      const where = { userId: user.id, mode, improvementId };
      const [items, total] = await Promise.all([
        tx.oneCRequest.findMany({ where, select: requestSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
        tx.oneCRequest.count({ where }),
      ]);
      return { items, total, page, limit, mode };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async linked(user: Principal, improvementId: string, raw: unknown) {
    const { page, limit } = parse(paged, raw);
    return this.db.$transaction(async tx => {
      await this.ensureImprovement(tx, user, improvementId);
      const where = { improvementId, mode: user.demo ? 'simulator' : 'http' };
      const [items, total] = await Promise.all([
        tx.oneCRequest.findMany({ where, select: requestSelect, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit, take: limit }),
        tx.oneCRequest.count({ where }),
      ]);
      return { items, total, page, limit };
    }, { isolationLevel: 'RepeatableRead' });
  }

  async journal(user: Principal, raw: unknown) {
    const where = { mode: this.mode(user), userId: user.id };
    const { page, limit } = parse(paged, raw);
    const [items, total] = await this.db.$transaction([
      this.db.oneCOperation.findMany({ where, select: { id: true, action: true, result: true, createdAt: true, requestId: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      this.db.oneCOperation.count({ where }),
    ], { isolationLevel: 'RepeatableRead' });
    return { items, total, page, limit };
  }

  async create(user: Principal, raw: unknown, rawKey?: string) {
    const mode = this.mode(user);
    const data = parse(createInput, raw);
    const key = parse(z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/), rawKey);
    await throttle(this.db, 'one-c-create:' + user.id, 60, 300);
    const where = { userId: user.id, key };
    const request = await atomic(this.db, async tx => {
      if (data.improvementId) await this.ensureImprovement(tx, user, data.improvementId);
      const inserted = await tx.oneCRequest.createMany({ data: { ...where, ...data, mode }, skipDuplicates: true });
      const record = await tx.oneCRequest.findUniqueOrThrow({ where: { userId_key: where } });
      if (record.mode !== mode || record.sku !== data.sku || record.quantity !== data.quantity ||
          record.improvementId !== (data.improvementId ?? null)) throw invalidState('Ключ уже использован для другой заявки.');
      if (inserted.count && data.improvementId) await audit(tx, 'improvement', data.improvementId, 'ONEC_REQUEST_CREATED', user.id, false, { requestId: record.id });
      return record;
    });
    return request.externalId ? this.db.oneCRequest.findUniqueOrThrow({ where: { id: request.id }, select: requestSelect })
      : this.sync(user, mode, request, false);
  }

  async refresh(user: Principal, item: string) {
    const mode = this.mode(user);
    const request = await this.db.oneCRequest.findFirst({ where: { id: item, userId: user.id, mode } });
    if (!request) throw missing();
    if (request.improvementId) await this.ensureImprovement(this.db, user, request.improvementId);
    return this.sync(user, mode, request, !!request.externalId);
  }

  private sync(user: Principal, mode: Mode, request: OneCRequest, check: boolean) {
    return this.run(user, mode, check ? 'STATUS' : 'SUBMIT', request.id, async () => {
      const adapter = this.adapter(mode);
      const remote = check ? await adapter.status(request) : await adapter.submit(request);
      return atomic(this.db, async tx => {
        const current = await tx.oneCRequest.findUniqueOrThrow({ where: { id: request.id }, select: requestSelect });
        if (current.externalId && current.externalId !== remote.externalId) throw unavailable();
        if (current.externalId && statusOrder[current.status] >= statusOrder[remote.status]) return current;
        return tx.oneCRequest.update({ where: { id: request.id }, data: remote, select: requestSelect });
      });
    });
  }
}

@ApiTags('Интеграция 1С')
@Controller('one-c')
export class OneCController {
  constructor(@Inject(OneC) private readonly service: OneC) {}

  @Get('capabilities') capabilities(@Req() req: AuthRequest) { return this.service.capabilities(req.user); }
  @Get('products') products(@Req() req: AuthRequest) { return this.service.products(req.user); }
  @Get('requests') @QueryFields(requestQuery) requests(@Req() req: AuthRequest, @Query() raw: unknown) { return this.service.list(req.user, raw); }
  @Get('improvements/:id/requests') linked(@Req() req: AuthRequest, @Param('id') item: string, @Query() raw: unknown) {
    return this.service.linked(req.user, parse(id, item), raw);
  }

  @Get('journal') @QueryFields(paged) journal(@Req() req: AuthRequest, @Query() raw: unknown) { return this.service.journal(req.user, raw); }
  @Post('requests') @JsonBody(createInput) @ApiHeader({ name: 'Idempotency-Key', required: true }) create(@Req() req: AuthRequest, @Body() raw: unknown, @Headers('idempotency-key') key?: string) {
    return this.service.create(req.user, raw, key);
  }
  @Post('requests/:id/refresh') refresh(@Req() req: AuthRequest, @Param('id') item: string) {
    return this.service.refresh(req.user, parse(id, item));
  }
}
