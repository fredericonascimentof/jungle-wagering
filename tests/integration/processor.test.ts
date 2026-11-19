import {beforeAll,afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import type {MikroORM} from '@mikro-orm/postgresql';
import {connectDatabase} from '../../src/database/orm';
import {ProcessorService,type Result} from '../../src/processor/service';
import type {TransactionInput} from '../../src/processor/contracts';
import {Migration202611180001} from '../../src/database/migrations/Migration202611180001';
import {Migration202611180002} from '../../src/database/migrations/Migration202611180002';
let orm:MikroORM;let service:ProcessorService;
const children:ReturnType<typeof Bun.spawn>[]=[];const urls:string[]=[];
beforeAll(async()=>{
  const url=process.env.TEST_DATABASE_URL;if(!url||!new URL(url).pathname.endsWith('_test'))throw new Error('Real _test database required');
  orm=await connectDatabase(url);await orm.migrator.up();service=new ProcessorService(orm);
  for(let i=0;i<3;i++) {
    const child=Bun.spawn([process.execPath,'tests/fixtures/server.ts'],{env:{...process.env,TEST_DATABASE_URL:url},stdout:'pipe',stderr:'inherit'});children.push(child);
    const reader=child.stdout.getReader();let text='';
    while(!text.includes('READY:')) {const chunk=await reader.read();if(chunk.done)throw new Error('Child failed');text+=new TextDecoder().decode(chunk.value);}
    urls.push(text.split('READY:')[1]!.trim().split('\n')[0]!);
    void(async()=>{while(!(await reader.read()).done){/* drain structured logs */}})();
  }
},30000);
afterAll(async()=>{for(const child of children)child.kill();await Promise.all(children.map(c=>c.exited));if(orm)await orm.close(true);});
async function open(amount='100') {return service.open({playerId:randomUUID(),initialBalance:{amount,currency:'BRL'}});}
function command(wallet:{id:string;playerId:string},kind:TransactionInput['kind']='BET',amount='10',reference?:string):TransactionInput {
  return {providerId:'provider-a',externalTransactionId:randomUUID(),playerId:wallet.playerId,walletId:wallet.id,
    roundId:'round-1',gameId:'game-1',kind,money:{amount,currency:'BRL'},...(reference?{referenceExternalTransactionId:reference}:{})};
}
async function submit(body:TransactionInput,key=randomUUID(),instance=0) {
  const response=await fetch(`${urls[instance]}/wagering/transactions`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
  return {http:response.status,body:await response.json() as Result};
}
async function consistent(id:string,amount:string) {
  const report=await service.reconcile(id);expect(report.consistent).toBe(true);expect(report.storedBalance.amount).toBe(amount);
}
test('three OS processes, 50 simultaneous duplicate bets: one debit',async()=>{
  expect(new Set(children.map(c=>c.pid)).size).toBe(3);
  const w=await open();const bet=command(w);const key=randomUUID();
  const results=await Promise.all(Array.from({length:50},(_,i)=>submit(bet,key,i%3)));
  expect(results.every(r=>r.http===200)).toBe(true);expect(results.filter(r=>!r.body.idempotentReplay)).toHaveLength(1);
  expect(new Set(results.map(r=>r.body.transactionId)).size).toBe(1);await consistent(w.id,'90.00');
  const [row]=await orm.em.fork().execute<{n:number}[]>("select count(*)::int n from wallet_ledger_entries where wallet_id=? and direction='DEBIT'",[w.id]);expect(row?.n).toBe(1);
  expect((await submit({...bet,money:{amount:'11',currency:'BRL'}},key)).http).toBe(409);
});
test('required 100 vs two bets of 80: processed + persisted rejected + 20 balance',async()=>{
  const w=await open();const a=command(w,'BET','80'),b=command(w,'BET','80');const ka=randomUUID(),kb=randomUUID();
  const results=await Promise.all([submit(a,ka,0),submit(b,kb,2)]);
  expect(results.map(r=>r.http).sort()).toEqual([200,422]);
  const rejected=results.find(r=>r.http===422)!;expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const replay=await submit(rejected===results[0]?a:b,rejected===results[0]?ka:kb,1);expect(replay.body.idempotentReplay).toBe(true);
  await consistent(w.id,'20.00');expect((await service.wallet(w.id)).version).toBe(2);
});
test('initial opening, duplicate wallet conflict, loss no ledger/version and cursor pagination',async()=>{
  const w=await open();await expect(service.open({playerId:w.playerId,initialBalance:{amount:'0',currency:'BRL'}})).rejects.toThrow();
  expect((await submit(command(w,'LOSS','0'))).http).toBe(200);expect((await service.wallet(w.id)).version).toBe(1);
  const one=await service.ledgerPage(w.id,undefined,1);expect(one.entries).toHaveLength(1);expect(one.nextCursor).toBeNull();
  await submit(command(w));const first=await service.ledgerPage(w.id,undefined,1);expect(first.nextCursor).not.toBeNull();
  const second=await service.ledgerPage(w.id,first.nextCursor,1);expect(second.entries).toHaveLength(1);expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
  await consistent(w.id,'90.00');
});
test('refund and rollback exact reference, scope and one reversal per kind',async()=>{
  const w=await open();const bet=command(w);await submit(bet);
  expect((await submit(command(w,'REFUND','9',bet.externalTransactionId))).body.failureCode).toBe('REFERENCE_AMOUNT_MISMATCH');
  expect((await submit({...command(w,'REFUND','10',bet.externalTransactionId),roundId:'wrong'})).body.failureCode).toBe('REFERENCE_MISMATCH');
  const refund=command(w,'REFUND','10',bet.externalTransactionId);expect((await submit(refund)).http).toBe(200);
  expect((await submit(command(w,'REFUND','10',bet.externalTransactionId))).body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  expect((await submit(command(w,'ROLLBACK','10',refund.externalTransactionId))).http).toBe(200);
  await consistent(w.id,'90.00');
});
test('rollback of spent win has distinct failure and remains audited',async()=>{
  const w=await open('0');const win=command(w,'WIN','10');await submit(win);await submit(command(w,'BET','10'));
  const result=await submit(command(w,'ROLLBACK','10',win.externalTransactionId));expect(result.http).toBe(422);
  expect(result.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');await consistent(w.id,'0.00');
});
test('refund before bet is durable, eventually processed, never applied twice',async()=>{
  const w=await open();const bet=command(w);const refund=command(w,'REFUND','10',bet.externalTransactionId);
  const result=await submit(refund);expect(result.http).toBe(202);await consistent(w.id,'100.00');
  await submit(bet);await orm.em.fork().execute('update wager_transactions set next_attempt_at=now() where id=?',[result.body.transactionId]);
  await Promise.all([service.retryPending(),new ProcessorService(orm).retryPending()]);
  expect((await service.transaction(result.body.transactionId)).status).toBe('PROCESSED');await consistent(w.id,'100.00');
});
test('reference limit rejects missing reference with terminal event',async()=>{
  const w=await open();const result=await submit(command(w,'ROLLBACK','10',randomUUID()));
  await orm.em.fork().execute('update wager_transactions set attempts=12,next_attempt_at=now() where id=?',[result.body.transactionId]);
  await service.retryPending();expect((await service.transaction(result.body.transactionId)).failureCode).toBe('REFERENCE_EXPIRED');await consistent(w.id,'100.00');
});
test('inbox financial ledger and outbox all roll back on late failure',async()=>{
  const w=await open();const body=command(w),key=randomUUID(),messageId=randomUUID();
  const faulty=new ProcessorService(orm,{beforeCommit:async()=>{throw new Error('injected-before-commit');}});
  await expect(faulty.submit(key,body,undefined,{messageId,consumerName:'test',payloadHash:'a'.repeat(64)})).rejects.toThrow();
  const [row]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from wager_transactions where idempotency_key=?',[key]);expect(row?.n).toBe(0);
  const [inbox]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from inbox_messages where message_id=?',[messageId]);expect(inbox?.n).toBe(0);
  const [events]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from outbox_messages where aggregate_id=?',[w.id]);expect(events?.n).toBe(2);
  const [entries]=await orm.em.fork().execute<{n:number}[]>('select count(*)::int n from wallet_ledger_entries where wallet_id=?',[w.id]);expect(entries?.n).toBe(1);
  await consistent(w.id,'100.00');
  const one=await service.submit(key,body,undefined,{messageId,consumerName:'test',payloadHash:'a'.repeat(64)});
  const two=await service.submit(key,body,undefined,{messageId,consumerName:'test',payloadHash:'a'.repeat(64)});
  expect(two.idempotentReplay).toBe(true);expect(two.transactionId).toBe(one.transactionId);await consistent(w.id,'90.00');
  await expect(service.submit(key,body,undefined,{messageId,consumerName:'test',payloadHash:'b'.repeat(64)})).rejects.toThrow();
});
test('database enforces balance-ledger consistency and terminal immutability',async()=>{
  const w=await open();const r=await submit(command(w));
  await expect(orm.em.fork().execute('update financial_wallets set balance=12 where id=?',[w.id])).rejects.toThrow();
  await expect(orm.em.fork().execute("update wager_transactions set status='PENDING' where id=?",[r.body.transactionId])).rejects.toThrow();
  await expect(orm.em.fork().execute('delete from wallet_ledger_entries where wallet_id=?',[w.id])).rejects.toThrow();
  await consistent(w.id,'90.00');
});
test('wallets operate concurrently and persisted state survives app replacement',async()=>{
  const wallets=await Promise.all([open(),open(),open()]);
  const results=await Promise.all(wallets.map((w,i)=>submit(command(w),randomUUID(),i)));expect(results.every(r=>r.http===200)).toBe(true);
  const fresh=await connectDatabase(process.env.TEST_DATABASE_URL);
  try {for(const w of wallets)expect((await new ProcessorService(fresh).reconcile(w.id)).consistent).toBe(true);}finally{await fresh.close(true);}
});
test('versioned migrations support up/down/up in an isolated rolled-back schema',async()=>{
  const schema='migration_probe_'+randomUUID().replaceAll('-','');const em=orm.em.fork();await em.begin();
  try {
    await em.execute(`create schema ${schema}`);await em.execute(`set local search_path to ${schema}`);
    for(const [MigrationClass,direction] of [[Migration202611180001,'up'],[Migration202611180002,'up'],
      [Migration202611180002,'down'],[Migration202611180001,'down'],[Migration202611180001,'up'],[Migration202611180002,'up']] as const) {
      const migration=new MigrationClass(orm.em.getDriver(),orm.config);await migration[direction]();
      for(const sql of migration.getQueries())await em.execute(sql.toString());
    }
    const [r]=await em.execute<{exists:boolean}[]>('select to_regclass(?) is not null as exists',[`${schema}.financial_wallets`]);expect(r?.exists).toBe(true);
  } finally {await em.rollback();}
  const [r]=await orm.em.fork().execute<{exists:boolean}[]>('select to_regnamespace(?) is not null as exists',[schema]);expect(r?.exists).toBe(false);
});
