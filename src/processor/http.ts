import 'reflect-metadata';
import { Body,Catch,Controller,Get,Headers,Inject,Module,Param,Post,Query,Res,UseGuards,HttpException,
  HttpCode,type ArgumentsHost,type ExceptionFilter,type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors';
import { EvaluationAuthGuard } from '../http/evaluation-auth.guard';
import { ProcessorService } from './service';
import { SqsBroker } from './sqs';
import { registry,log } from './observability';
interface Response {status(n:number):Response;json(body:unknown):void;type(type:string):Response;send(body:string):void}
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error:unknown,host:ArgumentsHost) {
    const res=host.switchToHttp().getResponse<Response>();
    if(error instanceof DomainError) {res.status(error.status).json({code:error.code,message:error.message});return;}
    if(error instanceof ZodError) {res.status(400).json({code:'INVALID_PAYLOAD',issues:error.issues});return;}
    if(error instanceof HttpException) {res.status(error.getStatus()).json(error.getResponse());return;}
    const code=(error as {code?:string}).code??'';
    if(/^(08|53|57|ECONN|ETIMEDOUT)/.test(code)||/connection|timeout/i.test((error as Error).message??'')) {
      res.status(503).json({code:'INFRASTRUCTURE_UNAVAILABLE'});return;
    }
    log('request_failed',{code:'INTERNAL_ERROR'});res.status(500).json({code:'INTERNAL_ERROR'});
  }
}
@Controller()
@UseGuards(EvaluationAuthGuard)
class FinancialController {
  constructor(@Inject(ProcessorService) readonly service:ProcessorService) {}
  @Post('wallets') open(@Body() input:unknown) {return this.service.open(input);}
  @Get('wallets/:id') wallet(@Param('id') id:string) {return this.service.wallet(id);}
  @Get('wallets/:id/ledger') ledger(@Param('id') id:string,@Query('cursor') cursor:unknown,@Query('limit') limit:unknown) {return this.service.ledgerPage(id,cursor,limit);}
  @Post('wallets/:id/reconciliation') @HttpCode(200) reconcile(@Param('id') id:string) {return this.service.reconcile(id);}
  @Get('wagering/transactions/:id') transaction(@Param('id') id:string) {return this.service.transaction(id);}
  @Get('providers/:provider/wagering/transactions/:external') external(@Param('provider') provider:string,@Param('external') external:string) {return this.service.external(provider,external);}
  @Post('wagering/transactions')
  async submit(@Headers('idempotency-key') key:unknown,@Body() input:unknown,@Res() res:Response) {
    const result=await this.service.submit(key,input,{correlationId:randomUUID()});
    res.status(result.status==='REJECTED'?422:result.status==='FAILED'?500:result.status==='PENDING_REFERENCE'?202:200).json(result);
  }
}
@Controller()
class OperationsController {
  constructor(@Inject(ProcessorService) readonly service:ProcessorService,@Inject(SqsBroker) readonly broker:SqsBroker) {}
  @Get('health/live') live() {return {status:'alive'};}
  @Get('health/ready') async ready(@Res() res:Response) {
    const checks=await Promise.allSettled([this.service.orm.em.fork().execute('select 1'),this.broker.ready()]);
    const ready=checks.every(r=>r.status==='fulfilled');res.status(ready?200:503).json({status:ready?'ready':'unavailable',
      postgres:checks[0]?.status==='fulfilled',sqs:checks[1]?.status==='fulfilled'});
  }
  @Get('metrics') async metrics(@Res() res:Response) {res.type(registry.contentType).send(await registry.metrics());}
}
export async function createProcessorApp(orm:MikroORM,broker=new SqsBroker()):Promise<INestApplication> {
  @Module({controllers:[FinancialController,OperationsController],providers:[EvaluationAuthGuard,
    {provide:ProcessorService,useValue:new ProcessorService(orm)},{provide:SqsBroker,useValue:broker}]}) class AppModule {}
  const app=await NestFactory.create(AppModule,{logger:false});app.useGlobalFilters(new ErrorFilter());return app;
}
