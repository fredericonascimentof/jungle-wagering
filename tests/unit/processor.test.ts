import {expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {Money,Wallet,WagerTransaction,WalletLedgerEntry,type Kind} from '../../src/processor/domain';
import {hash} from '../../src/processor/contracts';
import {OutboxMessage,InboxMessage,WagerTransactionProcessed} from '../../src/processor/events';
const m=(amount:string,currency='BRL')=>Money.from({amount,currency});
function transaction(kind:Kind,amount='10',reference?:string) {
  return WagerTransaction.create({id:randomUUID(),providerId:'p',externalTransactionId:'e',idempotencyKey:'k',payloadHash:'h',
    walletId:'w',playerId:'p',roundId:'r',gameId:'g',kind,money:m(amount),createdAt:new Date(),
    ...(reference?{referenceExternalTransactionId:reference}:{})});
}
test('Money signed arithmetic is internal; input remains nonnegative and exact',()=>{
  expect(m('0.1').add(m('0.2')).toString()).toBe('0.30');
  expect(m('1').subtract(m('2')).toJSON()).toEqual({amount:'-1.00',currency:'BRL'});
  expect(m('1').negate().isNegative()).toBe(true);
  expect(Money.zero('BRL').isZero()).toBe(true);
  expect(m('1').isLessThan(m('2'))).toBe(true);
  expect(m('1').equals(m('1.00'))).toBe(true);
  expect(()=>m('-1')).toThrow();expect(()=>m('1.001')).toThrow();
  expect(()=>m('1').add(m('1','USD'))).toThrow();
});
test.each(['NaN','Infinity','1e2','',' 1','01','99999999999999999'])('Money rejects %s',value=>expect(()=>m(value)).toThrow());
test('Wallet starts at version one, changes version only with balance, and prevents negative reversal',()=>{
  const w=Wallet.open({id:'w',playerId:'p',initialBalance:m('100')});
  expect(w.version).toBe(1);w.credit(m('0'));expect(w.version).toBe(1);
  w.debit(m('80'));expect(w.version).toBe(2);expect(w.balance.toString()).toBe('20.00');
  expect(()=>w.debit(m('80'),'REVERSAL_INSUFFICIENT_FUNDS')).toThrow();expect(w.version).toBe(2);
});
test('BET WIN LOSS REFUND ROLLBACK domain directions and reference validation',()=>{
  const bet=transaction('BET');bet.markProcessed(undefined,new Date());
  expect(bet.delta().toString()).toBe('-10.00');
  expect(transaction('WIN').delta().toString()).toBe('10.00');
  expect(transaction('LOSS','0').delta().isZero()).toBe(true);
  expect(()=>transaction('LOSS').delta()).toThrow();
  expect(()=>transaction('REFUND')).toThrow();
  expect(transaction('REFUND','10','e').delta(bet).toString()).toBe('10.00');
  expect(()=>transaction('REFUND','9','e').delta(bet)).toThrow();
  const win=transaction('WIN');win.markProcessed(undefined,new Date());
  expect(transaction('ROLLBACK','10','e').delta(win).toString()).toBe('-10.00');
  expect(()=>transaction('REFUND','10','e').delta(win)).toThrow();
});
test.each(['PROCESSED','REJECTED','FAILED'] as const)('terminal %s cannot transition',status=>{
  const tx=transaction('BET');
  if(status==='PROCESSED')tx.markProcessed(undefined,new Date());else if(status==='REJECTED')tx.reject('X');else tx.fail('X');
  expect(()=>tx.markPendingReference()).toThrow();expect(()=>tx.reject('Y')).toThrow();
});
test('Ledger validates arithmetic and is frozen',()=>{
  const e=WalletLedgerEntry.create({walletId:'w',transactionId:'t',delta:m('10').negate(),before:m('100'),after:m('90')});
  expect(e.isBalanced()).toBe(true);expect(Object.isFrozen(e)).toBe(true);
  expect(()=>WalletLedgerEntry.create({walletId:'w',transactionId:'t',delta:m('10'),before:m('100'),after:m('90')})).toThrow();
});
test('canonical payload hashes ignore key order but detect intent changes',()=>{
  expect(hash({b:2,a:{d:'4',c:'3'}})).toBe(hash({a:{c:'3',d:'4'},b:2}));
  expect(hash({amount:'10.00'})).not.toBe(hash({amount:'11.00'}));
});
test('Inbox and Outbox transitions preserve event identity and retry schedule',()=>{
  const inbox=InboxMessage.receive({messageId:'m',consumerName:'c',payloadHash:'h'});expect(inbox.isProcessed()).toBe(false);
  inbox.markProcessed(new Date());expect(inbox.isProcessed()).toBe(true);
  const event=WagerTransactionProcessed.from('w',{transactionId:'t'},{correlationId:'c'});
  const outbox=OutboxMessage.enqueue(event);const now=new Date();outbox.scheduleRetry(now);
  expect(outbox.attempts).toBe(1);expect(outbox.isDue(now)).toBe(false);expect(outbox.payload.eventId).toBe(outbox.id);
  outbox.markPublished(new Date());expect(outbox.isPending()).toBe(false);
});
