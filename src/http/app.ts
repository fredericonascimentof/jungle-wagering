import 'reflect-metadata';
import { Body, Catch, Controller, Get, Headers, Inject, Module, Param, Post, Put, UseGuards,
  type ArgumentsHost, type ExceptionFilter, HttpException, HttpCode } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { ZodError } from 'zod';
import { WageringService } from '../application/wagering.service';
import { DomainError } from '../domain/errors';
import { EvaluationAuthGuard } from './evaluation-auth.guard';

@Catch()
class ApiErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<{ status(n: number): { json(body: unknown): void } }>();
    if (error instanceof DomainError) { res.status(error.status).json({ code: error.code, message: error.message }); return; }
    if (error instanceof ZodError) { res.status(400).json({ code: 'INVALID_REQUEST', issues: error.issues }); return; }
    if (error instanceof HttpException) { res.status(error.getStatus()).json(error.getResponse()); return; }
    console.error('Unhandled request failure', error);
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Falha interna.' });
  }
}

@Controller('wallets')
@UseGuards(EvaluationAuthGuard)
class WalletController {
  constructor(@Inject(WageringService) private readonly service: WageringService) {}
  @Put(':id') @HttpCode(200)
  create(@Param('id') id: string, @Body() body: unknown) { return this.service.createWallet(id, body); }
  @Get(':id')
  get(@Param('id') id: string) { return this.service.getWallet(id); }
  @Post(':id/operations') @HttpCode(200)
  execute(@Param('id') id: string, @Headers('idempotency-key') key: unknown, @Body() body: unknown) {
    return this.service.execute(id, key, body);
  }
  @Get(':id/reconciliation')
  reconcile(@Param('id') id: string) { return this.service.reconcile(id); }
}

export async function createApp(orm: MikroORM) {
  @Module({ controllers: [WalletController], providers: [EvaluationAuthGuard,
    { provide: WageringService, useValue: new WageringService(orm) }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.useGlobalFilters(new ApiErrorFilter());
  return app;
}
