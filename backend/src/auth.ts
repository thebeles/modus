import { CanActivate, Controller, ExecutionContext, Get, Inject, Injectable, Post, Body, Req, Res, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { compare, hash } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Request, Response } from 'express';
import { z } from 'zod';
import { AppError, Database, digest, forbidden, parse, throttle, unauthenticated } from './common';
import { Principal, principalSelect } from './policy';

export type AuthRequest = Request & { user: Principal; sessionHash: string };
export const Public = () => SetMetadata('public', true);
export const demoMode = () => process.env.NODE_ENV !== 'production' && process.env.DEMO_MODE === 'true';
const secure = () => process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';
const sessionName = 'kontur_session';
const csrfName = 'kontur_csrf';
const lifetime = 8 * 60 * 60 * 1000;
const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const sessionCookie = { httpOnly: true, sameSite: 'strict' as const, path: '/' };
const token = () => randomBytes(32).toString('base64url');

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const changes = writeMethods.has(req.method);
    if (changes && req.header('origin') !== process.env.WEB_ORIGIN) throw forbidden();
    if (this.reflector.getAllAndOverride('public', [context.getHandler(), context.getClass()])) return true;
    const cookie = req.cookies?.[sessionName];
    if (typeof cookie !== 'string' || cookie.length !== 43) throw unauthenticated();
    const session = await this.db.session.findUnique({
      where: { tokenHash: digest(cookie) },
      include: { user: { select: { ...principalSelect, active: true } } },
    });
    if (!session || session.expiresAt <= new Date() || !session.user.active || (session.user.demo && !demoMode())) throw unauthenticated();
    const csrf = req.header('x-csrf-token');
    if (changes && (!csrf || csrf.length !== 43 || digest(csrf) !== session.csrfHash)) throw forbidden();
    const { active: _active, ...user } = session.user;
    req.user = user;
    req.sessionHash = session.tokenHash;
    return true;
  }
}

const loginInput = z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(72) });
const passwordInput = z.strictObject({ current: z.string().min(1).max(72), password: z.string().min(12).max(72) });

@Injectable()
export class AuthService {
  constructor(@Inject(Database) private readonly db: Database) {}

  private issue(userId: string) {
    const session = token();
    const csrf = token();
    return { session, csrf, data: { tokenHash: digest(session), csrfHash: digest(csrf), userId, expiresAt: new Date(Date.now() + lifetime) } };
  }

  cookies(res: Response, issued: { session: string; csrf: string }) {
    const options = { ...sessionCookie, secure: secure(), maxAge: lifetime };
    res.cookie(sessionName, issued.session, options);
    res.cookie(csrfName, issued.csrf, { ...options, httpOnly: false });
  }

  async demo(input: unknown, ip: string, res: Response) {
    if (!demoMode()) throw forbidden();
    const { profile } = parse(z.strictObject({ profile: z.enum(['employee', 'handler', 'manager', 'admin', 'other-employee', 'sensitive-handler']) }), input);
    await throttle(this.db, `demo-login:${ip}`, 120, 300);
    const user = await this.db.user.findFirst({ where: { email: `${profile}@demo.local`, demo: true, active: true }, select: principalSelect });
    if (!user) throw new AppError('INVALID_CREDENTIALS', 'Демонстрационная учётная запись недоступна.', 401);
    const issued = this.issue(user.id);
    await this.db.session.create({ data: issued.data });
    this.cookies(res, issued);
    return { user, demoMode: true };
  }

  async login(input: unknown, ip: string, res: Response) {
    const { email, password } = parse(loginInput, input);
    await throttle(this.db, `login:${ip}`, 20, 300);
    const found = await this.db.user.findUnique({ where: { email: email.toLowerCase() }, select: { ...principalSelect, active: true, passwordHash: true } });
    const matches = await compare(password, found?.passwordHash ?? '$2b$12$X4v0uh3mq/MAM8q5hf8jEuLC5LfuP3zQ0Er8mYZuXg70sdJ8Kg2Wa');
    if (!matches || !found?.active || (found.demo && !demoMode())) {
      throw new AppError('INVALID_CREDENTIALS', 'Неверная почта или пароль.', 401);
    }
    const issued = this.issue(found.id);
    await this.db.session.create({ data: issued.data });
    this.cookies(res, issued);
    const { passwordHash: _hash, active: _active, ...user } = found;
    return { user, demoMode: demoMode() };
  }

  async renew(req: AuthRequest, res: Response) {
    const issued = this.issue(req.user.id);
    await this.db.$transaction(async tx => {
      if (!(await tx.session.deleteMany({ where: { tokenHash: req.sessionHash } })).count) throw unauthenticated();
      await tx.session.create({ data: issued.data });
    });
    this.cookies(res, issued);
    return { user: req.user, demoMode: demoMode() };
  }

  async logout(req: AuthRequest, res: Response) {
    await this.db.session.deleteMany({ where: { tokenHash: req.sessionHash } });
    res.clearCookie(sessionName, { ...sessionCookie, secure: secure() });
    res.clearCookie(csrfName, { ...sessionCookie, secure: secure(), httpOnly: false });
    return { ok: true };
  }

  async change(req: AuthRequest, res: Response, input: unknown) {
    if (req.user.demo) throw forbidden();
    const { current, password } = parse(passwordInput, input);
    if (Buffer.byteLength(password, 'utf8') > 72) throw new AppError('VALIDATION_ERROR', 'Пароль слишком длинный.');
    await throttle(this.db, `password:${req.user.id}`, 5, 300);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.user.id } });
    if (!await compare(current, user.passwordHash)) throw forbidden();
    const passwordHash = await hash(password, 12);
    await this.db.$transaction(async tx => {
      if (!(await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash } })).count) {
        throw unauthenticated();
      }
      await tx.session.deleteMany({ where: { userId: user.id } });
    });
    return this.logout(req, res);
  }
}

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public() @Get('capabilities') capabilities() { return { demoMode: demoMode() }; }
  @Public() @Post('login') login(@Body() input: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(input, req.ip ?? 'unknown', res);
  }
  @Public() @Post('demo') demo(@Body() input: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.demo(input, req.ip ?? 'unknown', res);
  }
  @Get('me') me(@Req() req: AuthRequest) { return { user: req.user, demoMode: demoMode() }; }
  @Post('refresh') refresh(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) { return this.auth.renew(req, res); }
  @Post('logout') logout(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response) { return this.auth.logout(req, res); }
  @Post('change-password') change(@Req() req: AuthRequest, @Res({ passthrough: true }) res: Response, @Body() input: unknown) {
    return this.auth.change(req, res, input);
  }
}
