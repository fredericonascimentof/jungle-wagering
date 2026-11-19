import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors';
const Exact = Decimal.clone({ precision: 40 });
export interface MoneyProps { amount: string; currency: string }
export class Money {
  private constructor(private readonly value: Decimal, readonly currency: string) {}
  static from(p: MoneyProps): Money {
    if (typeof p.amount !== 'string' || !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(p.amount))
      throw new DomainError('INVALID_MONEY', 'Valor decimal inválido.', 400);
    if (!['BRL', 'USD', 'EUR'].includes(p.currency)) throw new DomainError('INVALID_CURRENCY', 'Moeda inválida.', 400);
    return new Money(new Exact(p.amount), p.currency);
  }
  static zero(currency: string): Money { return Money.from({ amount: '0.00', currency }); }
  static rehydrate(p: MoneyProps): Money { return new Money(new Exact(p.amount), p.currency); }
  private same(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH', 'Moedas diferentes.');
  }
  private result(value: Decimal): Money {
    if (value.abs().greaterThan('9999999999999999.99')) throw new DomainError('AMOUNT_OVERFLOW', 'Limite monetário excedido.');
    return new Money(value, this.currency);
  }
  add(other: Money): Money { this.same(other); return this.result(this.value.plus(other.value)); }
  subtract(other: Money): Money { this.same(other); return this.result(this.value.minus(other.value)); }
  negate(): Money { return this.result(this.value.negated()); }
  isZero(): boolean { return this.value.isZero(); }
  isPositive(): boolean { return this.value.isPositive() && !this.isZero(); }
  isNegative(): boolean { return this.value.isNegative() && !this.isZero(); }
  isLessThan(other: Money): boolean { this.same(other); return this.value.lessThan(other.value); }
  equals(other: Money): boolean { this.same(other); return this.value.equals(other.value); }
  toString(): string { return this.value.toFixed(2); }
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
}
export interface WalletState {
  id: string; playerId: string; balance: Money; version: number; createdAt: Date; updatedAt: Date;
}
export class Wallet {
  private constructor(private state: WalletState) {}
  static open(p: { id: string; playerId: string; initialBalance: Money }): Wallet {
    if (p.initialBalance.isNegative()) throw new DomainError('NEGATIVE_BALANCE', 'Saldo inicial negativo.');
    const now = new Date();
    return new Wallet({ id: p.id, playerId: p.playerId, balance: p.initialBalance, version: 1, createdAt: now, updatedAt: now });
  }
  static rehydrate(s: WalletState): Wallet { return new Wallet({ ...s }); }
  get id() { return this.state.id; } get playerId() { return this.state.playerId; }
  get balance() { return this.state.balance; } get currency() { return this.balance.currency; }
  get version() { return this.state.version; } get createdAt() { return this.state.createdAt; }
  get updatedAt() { return this.state.updatedAt; }
  apply(delta: Money, insufficientCode = 'INSUFFICIENT_FUNDS'): void {
    const after = this.balance.add(delta);
    if (after.isNegative()) throw new DomainError(insufficientCode, 'Movimentação produziria saldo negativo.');
    if (!delta.isZero()) this.state = { ...this.state, balance: after, version: this.version + 1, updatedAt: new Date() };
  }
  debit(money: Money, code = 'INSUFFICIENT_FUNDS'): void {
    if (!money.isPositive()) throw new DomainError('INVALID_AMOUNT', 'Débito deve ser positivo.');
    this.apply(money.negate(), code);
  }
  credit(money: Money): void {
    if (money.isNegative()) throw new DomainError('INVALID_AMOUNT', 'Crédito não pode ser negativo.');
    this.apply(money);
  }
}
export type Kind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type Status = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export interface TransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string; payloadHash: string;
  walletId: string; playerId: string; roundId: string; gameId: string; kind: Kind; money: Money;
  referenceExternalTransactionId?: string | undefined; createdAt: Date;
}
export interface TransactionState extends TransactionProps {
  status: Status; referenceTransactionId?: string; failureCode?: string; processedAt?: Date;
}
export class WagerTransaction {
  private constructor(readonly props: Readonly<TransactionProps>, private state: TransactionState) {}
  static create(p: TransactionProps): WagerTransaction {
    if (['REFUND', 'ROLLBACK'].includes(p.kind) && !p.referenceExternalTransactionId)
      throw new DomainError('REFERENCE_REQUIRED', 'Referência obrigatória.', 400);
    return new WagerTransaction(Object.freeze({ ...p }), { ...p, status: 'PENDING' });
  }
  static rehydrate(s: TransactionState): WagerTransaction { return new WagerTransaction(Object.freeze({ ...s }), { ...s }); }
  get status() { return this.state.status; } get failureCode() { return this.state.failureCode; }
  get referenceTransactionId() { return this.state.referenceTransactionId; }
  get processedAt() { return this.state.processedAt; }
  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  private mutable(): void { if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE', 'Estado terminal.', 500); }
  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.mutable(); this.state = { ...this.state, status: 'PROCESSED', processedAt: at,
      ...(referenceTransactionId ? { referenceTransactionId } : {}) };
  }
  markPendingReference(): void { this.mutable(); this.state.status = 'PENDING_REFERENCE'; }
  resumeReference(): void {
    this.mutable();
    if(this.status!=='PENDING_REFERENCE') throw new DomainError('INVALID_TRANSACTION_STATE','Não está aguardando referência.',500);
    this.state.status='PENDING';
  }
  reject(code: string): void { this.mutable(); this.state.status = 'REJECTED'; this.state.failureCode = code; }
  fail(code: string): void { this.mutable(); this.state.status = 'FAILED'; this.state.failureCode = code; }
  requiresReference(): boolean { return ['REFUND', 'ROLLBACK'].includes(this.props.kind); }
  affectsBalance(): boolean { return this.props.kind !== 'LOSS' && !this.props.money.isZero(); }
  matchesPayload(hash: string): boolean { return this.props.payloadHash === hash; }
  delta(reference?: WagerTransaction): Money {
    const p = this.props;
    if (p.kind === 'LOSS') {
      if (!p.money.isZero()) throw new DomainError('LOSS_AMOUNT_MUST_BE_ZERO', 'LOSS exige valor zero.');
      return p.money;
    }
    if (!p.money.isPositive()) throw new DomainError('AMOUNT_MUST_BE_POSITIVE', 'Operação financeira exige valor positivo.');
    if (p.referenceExternalTransactionId) {
      if (!reference || reference.status !== 'PROCESSED') throw new DomainError('REFERENCE_NOT_PROCESSED', 'Referência não processada.');
      const r = reference.props;
      if (p.providerId !== r.providerId || p.walletId !== r.walletId || p.playerId !== r.playerId ||
          p.roundId !== r.roundId || p.money.currency !== r.money.currency)
        throw new DomainError('REFERENCE_MISMATCH', 'Referência pertence a outro contexto.');
      if (p.kind === 'REFUND' && r.kind !== 'BET' || p.kind === 'ROLLBACK' && !['BET', 'WIN', 'REFUND'].includes(r.kind) ||
          p.kind === 'WIN' && r.kind !== 'BET') throw new DomainError('INVALID_REFERENCE_KIND', 'Tipo de referência inválido.');
      if (this.requiresReference() && !p.money.equals(r.money)) throw new DomainError('REFERENCE_AMOUNT_MISMATCH', 'Reversão deve ser integral.');
      if (p.kind === 'ROLLBACK') return r.kind === 'BET' ? p.money : p.money.negate();
    }
    return p.kind === 'BET' ? p.money.negate() : p.money;
  }
}
export class WalletLedgerEntry {
  private constructor(readonly id: string, readonly walletId: string, readonly transactionId: string,
    readonly direction: 'DEBIT' | 'CREDIT', readonly money: Money, readonly balanceBefore: Money,
    readonly balanceAfter: Money, readonly createdAt: Date) { Object.freeze(this); }
  static create(p: { walletId: string; transactionId: string; delta: Money; before: Money; after: Money }): WalletLedgerEntry {
    if (p.delta.isZero() || !p.before.add(p.delta).equals(p.after) || p.after.isNegative())
      throw new DomainError('UNBALANCED_LEDGER', 'Lançamento inválido.', 500);
    return new WalletLedgerEntry(randomUUID(), p.walletId, p.transactionId, p.delta.isNegative() ? 'DEBIT' : 'CREDIT',
      p.delta.isNegative() ? p.delta.negate() : p.delta, p.before, p.after, new Date());
  }
  static rehydrate(p: { id: string; walletId: string; transactionId: string; direction: 'DEBIT' | 'CREDIT'; money: Money; balanceBefore: Money; balanceAfter: Money; createdAt: Date }): WalletLedgerEntry {
    return new WalletLedgerEntry(p.id, p.walletId, p.transactionId, p.direction, p.money, p.balanceBefore, p.balanceAfter, p.createdAt);
  }
  isBalanced(): boolean { return this.balanceBefore.add(this.direction === 'DEBIT' ? this.money.negate() : this.money).equals(this.balanceAfter); }
}
