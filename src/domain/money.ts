import Decimal from 'decimal.js';
import { DomainError } from './errors';

// Private clone prevents other modules from changing financial precision globally.
const ExactDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_DOWN });
export interface MoneyProps { amount: string; currency: string }
export class Money {
  private constructor(private readonly value: Decimal, public readonly currency: string) {}

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,15})(\.\d{1,2})?$/.test(amount)) {
      throw new DomainError('INVALID_AMOUNT', 'Use uma string decimal não negativa, até 16 inteiros e 2 casas.');
    }
    if (!['BRL', 'USD', 'EUR'].includes(currency)) {
      throw new DomainError('INVALID_CURRENCY', 'Moeda suportada: BRL, USD ou EUR.');
    }
    return new Money(new ExactDecimal(amount), currency);
  }
  private assertCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH', 'Moedas diferentes.');
  }
  add(other: Money): Money {
    this.assertCurrency(other);
    return Money.from({ amount: this.value.plus(other.value).toFixed(2), currency: this.currency });
  }
  subtract(other: Money): Money {
    this.assertCurrency(other);
    if (this.value.lessThan(other.value)) throw new DomainError('INSUFFICIENT_FUNDS', 'Saldo insuficiente.', 409);
    return Money.from({ amount: this.value.minus(other.value).toFixed(2), currency: this.currency });
  }
  isZero(): boolean { return this.value.isZero(); }
  toString(): string { return this.value.toFixed(2); }
  toJSON(): MoneyProps { return { amount: this.toString(), currency: this.currency }; }
}
