import {beforeAll,afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import type {MikroORM} from '@mikro-orm/postgresql';
import {SendMessageCommand,ReceiveMessageCommand,DeleteMessageCommand} from '@aws-sdk/client-sqs';
import {connectDatabase} from '../../src/database/orm';
import {ProcessorService} from '../../src/processor/service';
import {SqsBroker} from '../../src/processor/sqs';
import {Consumer,Publisher} from '../../src/processor/workers';
let orm:MikroORM;let service:ProcessorService;let broker:SqsBroker;
const prefix=`test-${randomUUID().slice(0,8)}-`;
const fixtureChildren:ReturnType<typeof Bun.spawn>[]=[];
beforeAll(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Real container PostgreSQL _test URL required');
  orm=await connectDatabase(url);await orm.migrator.up();service=new ProcessorService(orm);
  broker=new SqsBroker(prefix);await broker.initialize();await broker.ready();
});
afterAll(async()=>{for(const child of fixtureChildren)if(child.exitCode===null)child.kill();if(broker)broker.close();if(orm)await orm.close(true);});
async function open(){return service.open({playerId:randomUUID(),initialBalance:{amount:'100',currency:'BRL'}});}
function body(w:{id:string;playerId:string}) {
  const external=randomUUID();return {providerId:'provider-a',externalTransactionId:external,idempotencyKey:`provider-a:${external}`,
    walletId:w.id,playerId:w.playerId,roundId:'round',gameId:'game',kind:'BET',money:{amount:'10.00',currency:'BRL'}};
}
async function send(data:unknown,messageId=randomUUID()) {
  await broker.client.send(new SendMessageCommand({QueueUrl:broker.inputUrl,MessageBody:JSON.stringify({messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data}),
    MessageGroupId:randomUUID(),MessageDeduplicationId:randomUUID()}));return messageId;
}
async function child(mode:string) {
  const p=Bun.spawn([process.execPath,'tests/fixtures/queue-worker.ts',mode],{env:{...process.env,SQS_QUEUE_PREFIX:prefix},stdout:'pipe',stderr:'pipe'});fixtureChildren.push(p);
  const [exit,stdout,stderr]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);return {exit,stdout,stderr};
}
async function drainOutbox() {
  const publisher=new Publisher(service,broker);
  for(let i=0;i<200;i++) {
    const n=await publisher.tick();if(n===0)return;
  }
  throw new Error('Outbox did not drain');
}
test('real SQS redelivery + durable inbox: one effect, ack after commit',async()=>{
  const w=await open();const data=body(w),messageId=randomUUID();
  await send(data,messageId);await new Consumer(service,broker).tick();
  await send(data,messageId);await new Consumer(service,broker).tick();
  const report=await service.reconcile(w.id);expect(report.consistent).toBe(true);expect(report.storedBalance.amount).toBe('90.00');
  const [r]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from inbox_messages where message_id=?',[messageId]);expect(r?.n).toBe(1);
});
test('process dies after commit before ack; restarted worker safely redelivers',async()=>{
  const w=await open();const data=body(w);await send(data);
  const crashed=await child('consumer-crash');expect(crashed.exit).toBe(86);
  const receipt=crashed.stdout.split('RECEIPT:')[1]?.trim().split('\n')[0];expect(receipt).toBeDefined();
  expect((await service.reconcile(w.id)).storedBalance.amount).toBe('90.00');
  await broker.visibility(receipt!,0); // accelerate visibility expiry, preserving real redelivery
  const restarted=await child('once');expect(restarted.exit).toBe(0);
  const report=await service.reconcile(w.id);expect(report.consistent).toBe(true);expect(report.storedBalance.amount).toBe('90.00');
});
test('two concurrent publishers claim disjoint events and publish committed envelopes',async()=>{
  await drainOutbox();
  const w=await open();const data=body(w);const {idempotencyKey,...input}=data;await service.submit(idempotencyKey,input);
  class TrackedBroker extends SqsBroker {
    readonly sent:string[]=[];
    override async publish(id:string,aggregateId:string,payload:unknown) {this.sent.push(id);await super.publish(id,aggregateId,payload);}
  }
  const a=new TrackedBroker(prefix),b=new TrackedBroker(prefix);await Promise.all([a.initialize(),b.initialize()]);
  try {
    await Promise.all([new Publisher(service,a).tick(),new Publisher(service,b).tick()]);
    expect(a.sent.length+b.sent.length).toBe(4);expect(new Set([...a.sent,...b.sent]).size).toBe(4);
    const [r]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from outbox_messages where aggregate_id=? and published_at is not null',[w.id]);expect(r?.n).toBe(4);
    expect((await service.reconcile(w.id)).consistent).toBe(true);
  } finally {a.close();b.close();}
});
test('publisher dies after send: lease expires, new publisher resumes without lost event',async()=>{
  await drainOutbox();const w=await open();
  const crashed=await child('publisher-crash');expect(crashed.exit).toBe(87);
  await orm.em.fork().execute('update outbox_messages set lease_until=now() where aggregate_id=? and published_at is null',[w.id]);
  await new Publisher(service,broker).tick();
  const [r]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from outbox_messages where aggregate_id=? and published_at is null',[w.id]);expect(r?.n).toBe(0);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});
test('invalid message goes to actual DLQ, not an infinite retry loop',async()=>{
  await broker.client.send(new SendMessageCommand({QueueUrl:broker.inputUrl,MessageBody:'{invalid-json',MessageGroupId:'invalid',MessageDeduplicationId:randomUUID()}));
  await new Consumer(service,broker).tick();
  const dlq=await broker.client.send(new ReceiveMessageCommand({QueueUrl:broker.dlqUrl,WaitTimeSeconds:2}));
  expect(dlq.Messages?.[0]?.Body).toBe('{invalid-json');
  if(dlq.Messages?.[0]?.ReceiptHandle)await broker.client.send(new DeleteMessageCommand({QueueUrl:broker.dlqUrl,ReceiptHandle:dlq.Messages[0].ReceiptHandle}));
});
test('transient DB failure keeps message for retry; recovery processes it',async()=>{
  const w=await open();await send(body(w));
  const [message]=await broker.receive();expect(message).toBeDefined();
  // A real closed PostgreSQL pool fails acquisition; the use case is not mocked.
  const broken=await connectDatabase(process.env.TEST_DATABASE_URL);
  await broken.close(true);
  await new Consumer(new ProcessorService(broken),broker).handle(message!);
  await broker.visibility(message!.ReceiptHandle!,0);
  await new Consumer(service,broker).tick();
  const report=await service.reconcile(w.id);expect(report.consistent).toBe(true);expect(report.storedBalance.amount).toBe('90.00');
});
test('bounded retries persist FAILED and route to DLQ after the fifth receive',async()=>{
  const w=await open();const data=body(w);await send(data);
  let failures=0;
  const flaky=new ProcessorService(orm,{beforeCommit:async()=>{if(++failures<=5)throw new Error('injected infrastructure failure');}});
  const consumer=new Consumer(flaky,broker);
  for(let attempt=1;attempt<=5;attempt++) {
    const [message]=await broker.receive();expect(message).toBeDefined();
    expect(Number(message!.Attributes?.ApproximateReceiveCount)).toBe(attempt);
    await consumer.handle(message!);
    if(attempt<5)await broker.visibility(message!.ReceiptHandle!,0);
  }
  const saved=await service.external(data.providerId,data.externalTransactionId);
  expect(saved.status).toBe('FAILED');expect(saved.failureCode).toBe('INFRASTRUCTURE_RETRY_EXHAUSTED');
  const dlq=await broker.client.send(new ReceiveMessageCommand({QueueUrl:broker.dlqUrl,WaitTimeSeconds:2}));
  expect(dlq.Messages?.[0]?.Body).toContain(data.externalTransactionId);
  const report=await service.reconcile(w.id);expect(report.consistent).toBe(true);expect(report.storedBalance.amount).toBe('100.00');
});
test('SQS outage retains outbox and retry succeeds after broker recovery',async()=>{
  await drainOutbox();const w=await open();const previous=process.env.SQS_ENDPOINT;
  process.env.SQS_ENDPOINT='http://127.0.0.1:1';const offline=new SqsBroker(prefix);
  if(previous===undefined)delete process.env.SQS_ENDPOINT;else process.env.SQS_ENDPOINT=previous;
  try{await new Publisher(service,offline).tick();}finally{offline.close();}
  const pending=await orm.em.fork().execute<{attempts:number;published_at:Date|null}[]>('select attempts,published_at from outbox_messages where aggregate_id=?',[w.id]);
  expect(pending).toHaveLength(2);expect(pending.every(r=>r.attempts===1&&r.published_at===null)).toBe(true);
  await orm.em.fork().execute('update outbox_messages set next_attempt_at=now() where aggregate_id=?',[w.id]);
  await new Publisher(service,broker).tick();
  const [r]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from outbox_messages where aggregate_id=? and published_at is null',[w.id]);expect(r?.n).toBe(0);
  expect((await service.reconcile(w.id)).consistent).toBe(true);
});
