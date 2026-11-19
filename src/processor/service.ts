import { randomUUID } from 'node:crypto';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import { z } from 'zod';
import { DomainError } from '../domain/errors';
import { Money, Wallet, WagerTransaction, WalletLedgerEntry, type TransactionState, type Status, type Kind } from './domain';
import { hash, keySchema, openSchema, transactionSchema, uuid, type TransactionInput } from './contracts';
import { InboxMessage, OutboxMessage, WagerTransactionProcessed, WagerTransactionRejected,
  WagerTransactionPendingReference, WagerTransactionFailed, WalletBalanceChanged, type IntegrationEvent, type EventContext } from './events';
import { log, metrics } from './observability';

interface WalletRow { id: string; player_id: string; currency: string; balance: string; version: number; created_at: Date; updated_at: Date }
export interface TxRow {
  id: string; provider_id: string; external_transaction_id: string; idempotency_key: string; payload_hash: string;
  wallet_id: string; player_id: string; round_id: string; game_id: string; kind: Kind; amount: string; currency: string;
  reference_external_transaction_id: string | null; reference_transaction_id: string | null;
  created_at: Date; status: Status; processed_at: Date | null; failure_code: string | null;
  response: Result; business_payload: TransactionInput; attempts: number; next_attempt_at: Date;
}
export interface Result { transactionId: string; status: Status; balance: { amount: string; currency: string }; idempotentReplay: boolean; failureCode?: string }
export interface InboxContext { messageId: string; consumerName: string; payloadHash: string }
function walletFrom(r: WalletRow): Wallet {
  return Wallet.rehydrate({ id:r.id, playerId:r.player_id, balance:Money.rehydrate({amount:r.balance,currency:r.currency}),
    version:r.version, createdAt:new Date(r.created_at), updatedAt:new Date(r.updated_at) });
}
function transactionFrom(r: TxRow): WagerTransaction {
  const state: TransactionState = { id:r.id,providerId:r.provider_id,externalTransactionId:r.external_transaction_id,
    idempotencyKey:r.idempotency_key,payloadHash:r.payload_hash,walletId:r.wallet_id,playerId:r.player_id,
    roundId:r.round_id,gameId:r.game_id,kind:r.kind,money:Money.rehydrate({amount:r.amount,currency:r.currency}),
    createdAt:new Date(r.created_at),status:r.status,
    ...(r.reference_external_transaction_id ? {referenceExternalTransactionId:r.reference_external_transaction_id} : {}),
    ...(r.reference_transaction_id ? {referenceTransactionId:r.reference_transaction_id} : {}),
    ...(r.failure_code ? {failureCode:r.failure_code} : {}), ...(r.processed_at ? {processedAt:new Date(r.processed_at)} : {}) };
  return WagerTransaction.rehydrate(state);
}
export class ProcessorService {
  constructor(readonly orm: MikroORM, private readonly hooks: { beforeCommit?: () => Promise<void> } = {}) {}
  private async emit(em: EntityManager, event: IntegrationEvent<Record<string, unknown>>) {
    const outbox = OutboxMessage.enqueue(event);
    await em.execute(`insert into outbox_messages(id,aggregate_id,event_type,payload,occurred_at) values(?,?,?,?::jsonb,?)`,
      [outbox.id,outbox.aggregateId,outbox.eventType,JSON.stringify(outbox.payload),outbox.occurredAt]);
  }
  private async insertTransaction(em: EntityManager, tx: WagerTransaction, body: unknown) {
    const p=tx.props;
    await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,
      wallet_id,player_id,round_id,game_id,kind,amount,currency,reference_external_transaction_id,status,business_payload)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?::jsonb)`,[p.id,p.providerId,p.externalTransactionId,p.idempotencyKey,
      p.payloadHash,p.walletId,p.playerId,p.roundId,p.gameId,p.kind,p.money.toString(),p.money.currency,
      p.referenceExternalTransactionId ?? null,JSON.stringify(body)]);
  }
  private async ledger(em: EntityManager, entry: WalletLedgerEntry) {
    await em.execute(`insert into wallet_ledger_entries(id,wallet_id,transaction_id,direction,amount,currency,balance_before,balance_after)
      values(?,?,?,?,?,?,?,?)`,[entry.id,entry.walletId,entry.transactionId,entry.direction,entry.money.toString(),
      entry.money.currency,entry.balanceBefore.toString(),entry.balanceAfter.toString()]);
  }
  async open(input: unknown) {
    const body=openSchema.parse(input); const initial=Money.from(body.initialBalance);
    const wallet=Wallet.open({id:randomUUID(),playerId:body.playerId,initialBalance:initial});
    try {
      return await this.orm.em.fork().transactional(async em => {
        await em.execute('insert into financial_wallets(id,player_id,currency,balance,version) values(?,?,?,?,1)',
          [wallet.id,wallet.playerId,wallet.currency,wallet.balance.toString()]);
        if(initial.isPositive()) {
          const id=randomUUID(); const ctx={correlationId:id};
          const tx=WagerTransaction.create({id,providerId:'__internal__',externalTransactionId:id,idempotencyKey:`opening:${id}`,
            payloadHash:hash(body),walletId:wallet.id,playerId:wallet.playerId,roundId:'opening',gameId:'opening',kind:'OPENING',money:initial,createdAt:new Date()});
          await this.insertTransaction(em,tx,body);
          const entry=WalletLedgerEntry.create({walletId:wallet.id,transactionId:id,delta:initial,before:Money.zero(wallet.currency),after:initial});
          await this.ledger(em,entry); tx.markProcessed(undefined,new Date());
          const response:Result={transactionId:id,status:'PROCESSED',balance:initial.toJSON(),idempotentReplay:false};
          await em.execute("update wager_transactions set status='PROCESSED',processed_at=now(),response=?::jsonb where id=?",[JSON.stringify(response),id]);
          await this.emit(em,WagerTransactionProcessed.from(wallet.id,{...response,kind:'OPENING'},ctx));
          await this.emit(em,WalletBalanceChanged.from(wallet.id,this.balanceEvent(wallet,entry),ctx));
        }
        await this.hooks.beforeCommit?.();
        return {id:wallet.id,playerId:wallet.playerId,balance:wallet.balance.toJSON(),version:wallet.version};
      });
    } catch(error) {
      if((error as {code?:string}).code==='23505') throw new DomainError('WALLET_ALREADY_EXISTS','Wallet já existe para player/moeda.',409);
      throw error;
    }
  }
  private balanceEvent(wallet:Wallet,entry:WalletLedgerEntry) {
    return {walletId:wallet.id,transactionId:entry.transactionId,direction:entry.direction,money:entry.money.toJSON(),
      balanceBefore:entry.balanceBefore.toJSON(),balanceAfter:entry.balanceAfter.toJSON(),walletVersion:wallet.version};
  }
  async wallet(idInput:unknown) {
    const id=uuid.parse(idInput); const [r]=await this.orm.em.fork().execute<WalletRow[]>('select * from financial_wallets where id=?',[id]);
    if(!r) throw new DomainError('WALLET_NOT_FOUND','Wallet inexistente.',404);
    return {id:r.id,playerId:r.player_id,balance:{amount:r.balance,currency:r.currency},version:r.version};
  }
  private async lock(em:EntityManager,id:string):Promise<Wallet> {
    const [r]=await em.execute<WalletRow[]>('select * from financial_wallets where id=? for update',[id]);
    if(!r) throw new DomainError('WALLET_NOT_FOUND','Wallet inexistente.',404);
    return walletFrom(r);
  }
  async submit(keyInput:unknown,input:unknown,ctx:EventContext={correlationId:randomUUID()},inbox?:InboxContext,permanentFailureCode?:string):Promise<Result> {
    const key=keySchema.parse(keyInput); const body=transactionSchema.parse(input);
    const money=Money.from(body.money); body.money.amount=money.toString();
    if(body.providerId==='__internal__') throw new DomainError('INVALID_PROVIDER','Provedor reservado.',400);
    const fingerprint=hash(body); const stop=metrics.latency.startTimer();
    try {
      const result=await this.orm.em.fork().transactional(async em => {
        await em.execute("set local lock_timeout='5s'"); await em.execute("set local statement_timeout='10s'");
        if(inbox) {
          const received=InboxMessage.receive(inbox);
          await em.execute(`insert into inbox_messages(consumer_name,message_id,payload_hash) values(?,?,?) on conflict do nothing`,
            [received.consumerName,received.messageId,received.payloadHash]);
          const [saved]=await em.execute<{payload_hash:string}[]>('select payload_hash from inbox_messages where consumer_name=? and message_id=? for update',[inbox.consumerName,inbox.messageId]);
          if(saved?.payload_hash!==inbox.payloadHash) throw new DomainError('INBOX_PAYLOAD_CONFLICT','messageId com conteúdo diferente.',409);
        }
        const wallet=await this.lock(em,body.walletId);
        const existing=await em.execute<TxRow[]>('select * from wager_transactions where idempotency_key=? or (provider_id=? and external_transaction_id=?)',
          [key,body.providerId,body.externalTransactionId]);
        let response:Result;
        if(existing.length) {
          const saved=existing[0]!;
          if(existing.length!==1 || saved.payload_hash!==fingerprint || saved.idempotency_key!==key)
            throw new DomainError('IDEMPOTENCY_CONFLICT','Chave ou ID externo já utilizado com outra intenção.',409);
          response={...saved.response,idempotentReplay:true};
        } else {
          const tx=WagerTransaction.create({ ...body,id:randomUUID(),idempotencyKey:key,payloadHash:fingerprint,money,createdAt:new Date() });
          await this.insertTransaction(em,tx,body);
          if(permanentFailureCode) {
            tx.fail(permanentFailureCode);
            response={transactionId:tx.props.id,status:'FAILED',balance:wallet.balance.toJSON(),idempotentReplay:false,failureCode:permanentFailureCode};
            await em.execute("update wager_transactions set status='FAILED',failure_code=?,response=?::jsonb where id=?",
              [permanentFailureCode,JSON.stringify(response),tx.props.id]);
            await this.emit(em,WagerTransactionFailed.from(wallet.id,{...response},ctx));
          } else response=await this.apply(em,wallet,tx,ctx,0);
        }
        if(inbox) await em.execute('update inbox_messages set processed_at=coalesce(processed_at,now()),transaction_id=? where consumer_name=? and message_id=?',
          [response.transactionId,inbox.consumerName,inbox.messageId]);
        await this.hooks.beforeCommit?.();
        return response;
      });
      if(result.idempotentReplay) metrics.duplicates.inc(); else metrics.transactions.inc({status:result.status});
      log('transaction_committed',{...ctx,transactionId:result.transactionId,walletId:body.walletId,providerId:body.providerId,...(inbox?{messageId:inbox.messageId}:{})});
      return result;
    } catch(error) {
      const code=(error as {code?:string}).code;
      if(code==='23505') throw new DomainError('IDEMPOTENCY_CONFLICT','Chave ou ID externo utilizado concorrentemente.',409);
      if(['55P03','40P01','40001','57014'].includes(code??'')) {
        metrics.locks.inc(); throw new DomainError('TRANSIENT_DATABASE_CONFLICT','Repita com a mesma chave.',503);
      }
      throw error;
    } finally {stop();}
  }
  private async apply(em:EntityManager,wallet:Wallet,tx:WagerTransaction,ctx:EventContext,attempts:number,wasPending=false):Promise<Result> {
    const p=tx.props; const before=wallet.balance; const previous=wasPending?'PENDING_REFERENCE':tx.status; let entry:WalletLedgerEntry|undefined;
    try {
      if(p.playerId!==wallet.playerId) throw new DomainError('PLAYER_MISMATCH','Player não corresponde à wallet.');
      if(p.money.currency!==wallet.currency) throw new DomainError('CURRENCY_MISMATCH','Moeda não corresponde à wallet.');
      let reference:WagerTransaction|undefined;
      if(p.referenceExternalTransactionId) {
        const [row]=await em.execute<TxRow[]>('select * from wager_transactions where provider_id=? and external_transaction_id=?',
          [p.providerId,p.referenceExternalTransactionId]);
        if(!row || ['PENDING','PENDING_REFERENCE'].includes(row.status)) {
          if(attempts>=12 || Date.now()-p.createdAt.getTime()>3600000) tx.reject('REFERENCE_EXPIRED');
          else tx.markPendingReference();
        } else reference=transactionFrom(row);
      }
      if(tx.status!=='PENDING_REFERENCE' && tx.status!=='REJECTED') {
        const delta=tx.delta(reference);
        if(tx.requiresReference() && reference) {
          const prior=await em.execute('select id from wager_transactions where reference_transaction_id=? and kind=? and status=?',
            [reference.props.id,p.kind,'PROCESSED']);
          if(prior.length) throw new DomainError('REFERENCE_ALREADY_REVERSED','Referência já revertida por este tipo.');
        }
        wallet.apply(delta,p.kind==='ROLLBACK'?'REVERSAL_INSUFFICIENT_FUNDS':'INSUFFICIENT_FUNDS');
        if(!delta.isZero()) entry=WalletLedgerEntry.create({walletId:wallet.id,transactionId:p.id,delta,before,after:wallet.balance});
        tx.markProcessed(reference?.props.id,new Date());
      }
    } catch(error) {
      if(!(error instanceof DomainError) || error.status>=500) throw error;
      tx.reject(error.code);
    }
    const response:Result={transactionId:p.id,status:tx.status,balance:wallet.balance.toJSON(),idempotentReplay:false,
      ...(tx.failureCode?{failureCode:tx.failureCode}:{})};
    const next=new Date(Date.now()+Math.min(300,2**Math.min(attempts,9))*1000);
    await em.execute(`update wager_transactions set status=?,failure_code=?,reference_transaction_id=?,processed_at=?,response=?::jsonb,
      attempts=?,next_attempt_at=? where id=?`,[tx.status,tx.failureCode??null,tx.referenceTransactionId??null,tx.processedAt??null,
      JSON.stringify(response),attempts,next,p.id]);
    if(entry) {
      await em.execute('update financial_wallets set balance=?,version=?,updated_at=? where id=?',
        [wallet.balance.toString(),wallet.version,wallet.updatedAt,wallet.id]);
      await this.ledger(em,entry);
      await this.emit(em,WalletBalanceChanged.from(wallet.id,this.balanceEvent(wallet,entry),ctx));
    }
    const data={...response,kind:p.kind,providerId:p.providerId,externalTransactionId:p.externalTransactionId};
    if(tx.status==='PROCESSED') await this.emit(em,WagerTransactionProcessed.from(wallet.id,data,ctx));
    else if(tx.status==='REJECTED') await this.emit(em,WagerTransactionRejected.from(wallet.id,data,ctx));
    else if(previous!=='PENDING_REFERENCE') await this.emit(em,WagerTransactionPendingReference.from(wallet.id,data,ctx));
    return response;
  }
  async retryPending(limit=50):Promise<number> {
    const due=await this.orm.em.fork().execute<{id:string;wallet_id:string}[]>(
      "select id,wallet_id from wager_transactions where status='PENDING_REFERENCE' and next_attempt_at<=now() order by next_attempt_at limit ?",[limit]);
    let count=0;
    for(const candidate of due) {
      const applied=await this.orm.em.fork().transactional(async em => {
        await em.execute("set local lock_timeout='5s'");
        const wallet=await this.lock(em,candidate.wallet_id);
        const [row]=await em.execute<TxRow[]>('select * from wager_transactions where id=? for update',[candidate.id]);
        if(!row || row.status!=='PENDING_REFERENCE' || new Date(row.next_attempt_at)>new Date()) return false;
        const tx=transactionFrom(row);
        tx.resumeReference();
        const result=await this.apply(em,wallet,tx,{correlationId:row.id},row.attempts+1,true);
        await this.hooks.beforeCommit?.(); return result;
      });
      if(applied) {count++;metrics.retries.inc({worker:'reference'});metrics.transactions.inc({status:applied.status});
        log('reference_reprocessed',{transactionId:applied.transactionId,walletId:candidate.wallet_id,correlationId:candidate.id});}
    }
    return count;
  }
  async transaction(id:unknown) {
    const [row]=await this.orm.em.fork().execute<TxRow[]>('select * from wager_transactions where id=?',[uuid.parse(id)]);
    if(!row) throw new DomainError('TRANSACTION_NOT_FOUND','Transação inexistente.',404);
    return {...row.response,providerId:row.provider_id,externalTransactionId:row.external_transaction_id,kind:row.kind};
  }
  async external(provider:string,external:string) {
    const [row]=await this.orm.em.fork().execute<TxRow[]>('select * from wager_transactions where provider_id=? and external_transaction_id=?',[provider,external]);
    if(!row) throw new DomainError('TRANSACTION_NOT_FOUND','Transação inexistente.',404);
    return this.transaction(row.id);
  }
  async ledgerPage(idInput:unknown,cursorInput:unknown,limitInput:unknown) {
    const id=uuid.parse(idInput); await this.wallet(id);
    const limit=z.coerce.number().int().min(1).max(100).parse(limitInput??50);
    let after='0';
    if(cursorInput!==undefined) {
      try {
        const token=z.string().max(512).parse(cursorInput);
        const cursor=z.strictObject({v:z.literal(1),walletId:uuid,after:z.string().regex(/^\d{1,19}$/)}).parse(JSON.parse(Buffer.from(token,'base64url').toString()));
        if(cursor.walletId!==id || BigInt(cursor.after)>9223372036854775807n) throw new Error('cursor');
        after=cursor.after;
      } catch {throw new DomainError('INVALID_CURSOR','Cursor inválido para esta wallet.',400);}
    }
    const rows=await this.orm.em.fork().execute<{sequence:string;id:string;transaction_id:string;direction:string;amount:string;currency:string;balance_before:string;balance_after:string;created_at:Date}[]>(
      'select * from wallet_ledger_entries where wallet_id=? and sequence>?::bigint order by sequence limit ?',[id,after,limit+1]);
    const page=rows.slice(0,limit); const last=page.at(-1);
    return {entries:page.map(r=>({id:r.id,transactionId:r.transaction_id,direction:r.direction,money:{amount:r.amount,currency:r.currency},
      balanceBefore:{amount:r.balance_before,currency:r.currency},balanceAfter:{amount:r.balance_after,currency:r.currency},createdAt:r.created_at})),
      nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,walletId:id,after:last.sequence})).toString('base64url'):null};
  }
  async reconcile(idInput:unknown) {
    const id=uuid.parse(idInput);
    return this.orm.em.fork().transactional(async em=>{
      const wallet=await this.lock(em,id);
      const [row]=await em.execute<{total:string;n:number;broken:number}[]>(`select coalesce(sum(delta),0)::text total,count(*)::int n,
        count(*) filter(where running<>balance_after)::int broken from
        (select balance_after,case when direction='CREDIT' then amount else -amount end delta,
        sum(case when direction='CREDIT' then amount else -amount end) over(order by sequence) running
        from wallet_ledger_entries where wallet_id=?) chain`,[id]);
      const calculated=Money.rehydrate({amount:row?.total??'0',currency:wallet.currency});
      const difference=wallet.balance.subtract(calculated); const consistent=difference.isZero()&&row?.broken===0;
      if(!consistent) {metrics.discrepancies.inc();log('reconciliation_mismatch',{walletId:id,correlationId:randomUUID()});}
      return {walletId:id,storedBalance:wallet.balance.toJSON(),calculatedBalance:calculated.toJSON(),difference:difference.toJSON(),consistent,checkedEntries:row?.n??0};
    });
  }
}
