import 'dotenv/config';
import 'reflect-metadata';
import { ArgumentsHost, CallHandler, Catch, Controller, ExceptionFilter, ExecutionContext, Get, HttpException, Inject,
  Injectable, Module, NestInterceptor } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { map } from 'rxjs';
import { Admin, AdminController } from './admin';
import { Ai, AiController, Groq } from './ai';
import { Appeals, AppealsController } from './appeals';
import { AuthController, AuthService, Public, SessionGuard } from './auth';
import { Cases, CasesController } from './cases';
import { AppError, Database } from './common';
import { FileController, Files, LocalStorage } from './files';
import { NotificationsController } from './notifications';
import { Policy } from './policy';
import { Publications, PublicationsController } from './publications';
import { Radar, RadarController } from './radar';
import { Routing } from './routing';

@Controller('health')
class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Public() @Get('live') live() { return { status: 'ok' }; }
  @Public() @Get('ready') async ready() {
    try { await this.db.$queryRaw`SELECT 1`; } catch { throw new AppError('NOT_READY', 'База данных недоступна.', 503); }
    return { status: 'ok' };
  }
}

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = response.getHeader('x-request-id');
    if (response.headersSent) return response.end();
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Произошла ошибка сервера. Повторите позже.';
    let details: unknown;
    if (error instanceof AppError) {
      status = error.getStatus();
      ({ code, message, details } = error);
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003', 'P2025'].includes(error.code)) {
      status = error.code === 'P2025' ? 404 : 409;
      code = error.code === 'P2025' ? 'NOT_FOUND' : 'DATA_CONFLICT';
      message = error.code === 'P2025' ? 'Запись не найдена.' : 'Проверьте связанные записи и уникальность значений.';
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 404 ? 'NOT_FOUND' : 'REQUEST_ERROR';
      message = status === 404 ? 'Страница не найдена.' : status === 413 ? 'Превышен размер запроса.' : 'Проверьте параметры запроса.';
    } else {
      console.error('Unhandled request failure', requestId, error instanceof Error ? error.name : typeof error);
    }
    response.status(status).json({ requestId, error: { code, message, details } });
  }
}

@Injectable()
class ResponseEnvelope implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(map(data => ({ data, requestId: response.getHeader('x-request-id') })));
  }
}

@Module({
  controllers: [HealthController, AuthController, AppealsController, CasesController, RadarController,
    PublicationsController, AdminController, NotificationsController, FileController, AiController],
  providers: [Database, Policy, Routing, AuthService, Appeals, Cases, Radar, Publications, Admin, Files, LocalStorage, Ai, Groq,
    { provide: APP_GUARD, useClass: SessionGuard }],
})
export class AppModule {}

export async function createApp() {
  if (!process.env.DATABASE_URL || !process.env.WEB_ORIGIN) throw new Error('DATABASE_URL and WEB_ORIGIN are required');
  if (process.env.NODE_ENV === 'production' && !process.env.WEB_ORIGIN.startsWith('https://')) throw new Error('Production requires HTTPS');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  app.use(helmet({ contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false }));
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('x-request-id', randomUUID());
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.enableCors({ origin: process.env.WEB_ORIGIN, credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new Errors());
  app.useGlobalInterceptors(new ResponseEnvelope());
  if (process.env.NODE_ENV !== 'production') {
    const options = new DocumentBuilder().setTitle('Модус · Контур').setDescription('API обращений и улучшений. Изменяющие запросы требуют Origin и CSRF-токен.').setVersion('1.0').addCookieAuth('kontur_session').build();
    const doc = SwaggerModule.createDocument(app, options);
    SwaggerModule.setup('api/v1/docs', app, doc, { jsonDocumentUrl: 'api/v1/openapi.json' });
  }
  return app;
}

async function main() {
  const app = await createApp();
  await app.listen(Number(process.env.PORT || 4000), '0.0.0.0');
}

if (require.main === module) void main().catch(() => { console.error('API startup failed'); process.exitCode = 1; });
