import { Money } from './money';
import { DomainError } from './errors';

export class Wallet {
  constructor(public readonly id: string, private currentBalance: Money) {}
  get balance(): Money { return this.currentBalance; }
  credit(amount: Money): void { this.currentBalance = this.currentBalance.add(amount); }
  debit(amount: Money): void {
    if (amount.isZero()) throw new DomainError('ZERO_STAKE', 'A aposta deve ser positiva.');
    this.currentBalance = this.currentBalance.subtract(amount);
  }
}
