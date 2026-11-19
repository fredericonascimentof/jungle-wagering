import { DomainError } from './errors';
import { Money } from './money';
import { Wallet } from './wallet';
export type WagerStatus = 'PLACED' | 'SETTLED' | 'CANCELLED';
export class Wager {
  private constructor(public readonly id: string, public readonly walletId: string,
    public readonly stake: Money, private currentStatus: WagerStatus) {}
  get status(): WagerStatus { return this.currentStatus; }
  static place(id: string, wallet: Wallet, stake: Money): Wager {
    wallet.debit(stake);
    return new Wager(id, wallet.id, stake, 'PLACED');
  }
  static restore(id: string, walletId: string, stake: Money, status: WagerStatus): Wager {
    if (stake.isZero()) throw new DomainError('ZERO_STAKE', 'A aposta deve ser positiva.');
    return new Wager(id, walletId, stake, status);
  }
  private assertOpen(wallet: Wallet): void {
    if (wallet.id !== this.walletId) throw new DomainError('WAGER_OWNER_MISMATCH', 'Carteira não pertence à aposta.', 409);
    if (this.currentStatus !== 'PLACED') throw new DomainError('WAGER_CLOSED', 'Aposta já encerrada.', 409);
  }
  settle(wallet: Wallet, payout: Money): Money {
    this.assertOpen(wallet); wallet.credit(payout); this.currentStatus = 'SETTLED'; return payout;
  }
  cancel(wallet: Wallet): Money {
    this.assertOpen(wallet); wallet.credit(this.stake); this.currentStatus = 'CANCELLED'; return this.stake;
  }
}
