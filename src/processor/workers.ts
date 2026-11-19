import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { Message } from '@aws-sdk/client-sqs';
import { DomainError } from '../domain/errors';
import { hash,messageSchema } from './contracts';
import { OutboxMessage } from './events';
import { ProcessorService } from './service';
import { SqsBroker } from './sqs';
import { log,metrics } from './observability';
export class Consumer {
  constructor(readonly service:ProcessorService,readonly broker:SqsBroker,private readonly afterCommit?:()=>Promise<void>) {}
  async handle(message:Message) {
    if(!message.ReceiptHandle) return;
    const receipt=message.ReceiptHandle;
    let acceptedEnvelope:ReturnType<typeof messageSchema.parse>|undefined;
    const heartbeat=setInterval(()=>{void this.broker.visibility(receipt,30).catch(()=>log('visibility_extension_failed'));},10000);
    try {
      const envelope=messageSchema.parse(JSON.parse(message.Body??''));
      acceptedEnvelope=envelope;
      const {idempotencyKey,...business}=envelope.data;
      await this.service.submit(idempotencyKey,business,{correlationId:envelope.messageId,causationId:envelope.messageId},
        {messageId:envelope.messageId,consumerName:'wager-transactions-v1',payloadHash:hash(envelope.data)});
      // Fault injection belongs to test fixtures; ack is always after durable commit.
      await this.afterCommit?.();
      await this.broker.ack(receipt);
    } catch(error) {
      const permanent=error instanceof SyntaxError||error instanceof ZodError||error instanceof DomainError&&error.status<500;
      const count=Number(message.Attributes?.ApproximateReceiveCount??'1');
      if(permanent || count>=5) {
        if(!permanent && acceptedEnvelope) {
          const {idempotencyKey,...business}=acceptedEnvelope.data;
          // If PostgreSQL is still unavailable, this fails without ack; SQS redrive remains the safety net.
          await this.service.submit(idempotencyKey,business,{correlationId:acceptedEnvelope.messageId,causationId:acceptedEnvelope.messageId},
            {messageId:acceptedEnvelope.messageId,consumerName:'wager-transactions-v1',payloadHash:hash(acceptedEnvelope.data)},'INFRASTRUCTURE_RETRY_EXHAUSTED');
        }
        await this.broker.deadLetter(message);metrics.dlq.inc();log('message_dlq',{messageId:message.MessageId??'unknown'});
      }
      else {metrics.retries.inc({worker:'consumer'});await this.broker.visibility(receipt,Math.min(300,2**count));log('message_retry',{messageId:message.MessageId??'unknown'});}
    } finally {clearInterval(heartbeat);}
  }
  async tick() {for(const message of await this.broker.receive()) await this.handle(message);}
}
interface OutboxRow {id:string;aggregate_id:string;event_type:string;payload:Record<string,unknown>;occurred_at:Date;attempts:number}
export class Publisher {
  constructor(readonly service:ProcessorService,readonly broker:SqsBroker,private readonly afterSend?:()=>Promise<void>) {}
  async tick():Promise<number> {
    const token=randomUUID();
    const rows=await this.service.orm.em.fork().transactional(async em=>em.execute<OutboxRow[]>(`
      with due as (select id from outbox_messages where published_at is null and next_attempt_at<=now()
        and (lease_until is null or lease_until<now()) order by occurred_at limit 10 for update skip locked)
      update outbox_messages o set lease_token=?,lease_until=now()+interval '60 seconds'
      from due where o.id=due.id returning o.*`,[token]));
    // Small claimed batch published in parallel: network requests never hold SQL locks.
    await Promise.all(rows.map(async row=>{
      try {
        await this.broker.publish(row.id,row.aggregate_id,row.payload);
        await this.afterSend?.();
        await this.service.orm.em.fork().execute(`update outbox_messages set published_at=now(),lease_until=null,lease_token=null
          where id=? and lease_token=? and published_at is null`,[row.id,token]);
      } catch {
        const item=OutboxMessage.rehydrate({id:row.id,aggregateId:row.aggregate_id,eventType:row.event_type,payload:row.payload,
          occurredAt:new Date(row.occurred_at),attempts:row.attempts});
        item.scheduleRetry(new Date()); metrics.retries.inc({worker:'outbox'});
        await this.service.orm.em.fork().execute('update outbox_messages set attempts=?,next_attempt_at=?,lease_token=null,lease_until=null where id=? and lease_token=?',
          [item.attempts,item.nextAttemptAt!,row.id,token]);
        log('outbox_retry',{correlationId:row.id,walletId:row.aggregate_id});
      }
    }));
    const [lag]=await this.service.orm.em.fork().execute<{seconds:string}[]>(
      'select coalesce(extract(epoch from now()-min(occurred_at)),0)::text seconds from outbox_messages where published_at is null');
    metrics.lag.set(Math.max(0,Number(lag?.seconds??0)));
    return rows.length;
  }
}
export class WorkerRunner {
  private stopping=false; private tasks:Promise<void>[]=[];
  constructor(readonly service:ProcessorService,readonly broker:SqsBroker) {}
  start() {
    const consumer=new Consumer(this.service,this.broker); const publisher=new Publisher(this.service,this.broker);
    const loop=async(name:string,tick:()=>Promise<unknown>,delay:number)=>{
      while(!this.stopping) {
        try {await tick();} catch {log('worker_transient_failure',{code:name});metrics.retries.inc({worker:name});}
        if(!this.stopping) await Bun.sleep(delay);
      }
    };
    this.tasks=[loop('consumer',()=>consumer.tick(),250),loop('publisher',()=>publisher.tick(),500),
      loop('reference',()=>this.service.retryPending(),1000)];
  }
  async stop() {this.stopping=true;await Promise.all(this.tasks);}
}
