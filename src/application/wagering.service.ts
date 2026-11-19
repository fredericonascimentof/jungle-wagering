import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletRow } from '../database/wallet.entity';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { Wager } from '../domain/wager';
import { DomainError } from '../domain/errors';
import { commandSchema, createWalletSchema, keySchema, walletIdSchema, type OperationResult } from './contracts';

interface WagerRow { id: string; wallet_id: string; stake: string; status: 'PLACED' | 'SETTLED' | 'CANCELLED' }

export class WageringService {
  constructor(private readonly orm: MikroORM) {}

  async createWallet(idInput: unknown, input: unknown): Promise<{ id: string; currency: string }> {
    const id = walletIdSchema.parse(idInput);
    const { currency } = createWalletSchema.parse(input);
    return this.orm.em.fork().transactional(async em => {
      await em.execute('insert into wallets(id, currency, balance) values (?, ?, 0) on conflict(id) do nothing', [id, currency]);
      const row = await em.findOneOrFail(WalletRow, { id });
      if (row.currency !== currency) throw new DomainError('WALLET_CONFLICT', 'Carteira já existe com outra moeda.', 409);
      return { id, currency };
    });
  }

  async getWallet(idInput: unknown): Promise<{ id: string; balance: string; currency: string }> {
    const id = walletIdSchema.parse(idInput);
    const row = await this.orm.em.fork().findOne(WalletRow, { id });
    if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
    return { id, balance: Money.from({ amount: row.balance, currency: row.currency }).toString(), currency: row.currency };
  }

  async execute(idInput: unknown, keyInput: unknown, input: unknown): Promise<OperationResult> {
    const walletId = walletIdSchema.parse(idInput);
    const key = keySchema.parse(keyInput);
    const command = commandSchema.parse(input);
    const amount = command.type === 'CANCEL' ? null : Money.from(command);
    // Build a stable tuple; JSON object key order and 1/1.00 do not change intent.
    const fingerprint = createHash('sha256').update(JSON.stringify([
      command.type, 'wagerId' in command ? command.wagerId : null, amount?.toString() ?? null, amount?.currency ?? null,
    ])).digest('hex');
    try {
      return await this.orm.em.fork().transactional(async em => {
        await em.execute("set local lock_timeout = '5s'");
        await em.execute("set local statement_timeout = '10s'");
        const row = await em.findOne(WalletRow, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
        const existing = await em.execute<{ fingerprint: string; response: OperationResult }[]>(
          'select fingerprint, response from operations where wallet_id = ? and key = ?', [walletId, key]);
        if (existing[0]) {
          if (existing[0].fingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Chave reutilizada para outra operação.', 409);
          return existing[0].response;
        }
        const wallet = new Wallet(walletId, Money.from({ amount: row.balance, currency: row.currency }));
        let delta: string;
        let wagerStatus: OperationResult['wagerStatus'] = null;
        const wagerId = 'wagerId' in command ? command.wagerId : null;
        if (command.type === 'DEPOSIT') {
          if (!amount || amount.isZero()) throw new DomainError('ZERO_DEPOSIT', 'Depósito deve ser positivo.');
          wallet.credit(amount); delta = amount.toString();
        } else if (command.type === 'PLACE') {
          if (!amount) throw new Error('Missing stake');
          const wager = Wager.place(command.wagerId, wallet, amount);
          delta = `-${amount.toString()}`; wagerStatus = wager.status;
          await em.execute('insert into wagers(id, wallet_id, stake, status) values (?, ?, ?, ?)',
            [command.wagerId, walletId, amount.toString(), wagerStatus]);
        } else {
          const wagers = await em.execute<WagerRow[]>('select * from wagers where id = ? and wallet_id = ?', [command.wagerId, walletId]);
          const stored = wagers[0];
          if (!stored) throw new DomainError('WAGER_NOT_FOUND', 'Aposta não encontrada nesta carteira.', 404);
          const wager = Wager.restore(stored.id, stored.wallet_id,
            Money.from({ amount: stored.stake, currency: row.currency }), stored.status);
          let credit: Money;
          if (command.type === 'CANCEL') credit = wager.cancel(wallet);
          else {
            if (!amount) throw new Error('Missing payout');
            credit = wager.settle(wallet, amount);
          }
          delta = credit.toString(); wagerStatus = wager.status;
          await em.execute('update wagers set status = ?, payout = ? where id = ? and wallet_id = ?',
            [wagerStatus, command.type === 'SETTLE' ? credit.toString() : null, command.wagerId, walletId]);
        }
        row.balance = wallet.balance.toString();
        const result: OperationResult = {
          operationId: randomUUID(), walletId, type: command.type, balance: row.balance,
          currency: row.currency, wagerId, wagerStatus,
        };
        await em.execute('insert into operations(wallet_id, key, fingerprint, response) values (?, ?, ?, ?::jsonb)',
          [walletId, key, fingerprint, JSON.stringify(result)]);
        await em.execute(`insert into ledger(id, wallet_id, currency, operation_key, wager_id, kind, delta, balance_after)
          values (?, ?, ?, ?, ?, ?, ?, ?)`, [result.operationId, walletId, row.currency, key, wagerId, command.type, delta, row.balance]);
        await em.flush();
        return result;
      });
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === '23505') throw new DomainError('DUPLICATE_WAGER', 'Identificador de aposta já utilizado.', 409);
      if (code === '55P03' || code === '40P01' || code === '40001' || code === '57014') {
        throw new DomainError('RETRYABLE_CONFLICT', 'Tente novamente com a mesma chave de idempotência.', 503);
      }
      throw error;
    }
  }

  async reconcile(idInput: unknown): Promise<{
    walletId: string; balance: string; ledgerBalance: string; entries: string; brokenLinks: string; consistent: boolean;
  }> {
    const walletId = walletIdSchema.parse(idInput);
    return this.orm.em.fork().transactional(async em => {
      // Same lock as writers gives a stable wallet + ledger snapshot under READ COMMITTED.
      const row = await em.findOne(WalletRow, { id: walletId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!row) throw new DomainError('WALLET_NOT_FOUND', 'Carteira não encontrada.', 404);
      const [summary] = await em.execute<{ total: string; entries: string; broken: string; matches: boolean }[]>(`
        select coalesce(sum(delta), 0)::text as total, count(*)::text as entries,
          coalesce(sum(delta), 0) = ?::numeric as matches,
          count(*) filter (where expected <> balance_after)::text as broken
        from (select delta, balance_after, sum(delta) over(order by sequence) as expected
              from ledger where wallet_id = ?) chain`, [row.balance, walletId]);
      if (!summary) throw new Error('Missing aggregate');
      return { walletId, balance: row.balance, ledgerBalance: summary.total, entries: summary.entries,
        brokenLinks: summary.broken, consistent: summary.broken === '0' && summary.matches };
    });
  }
}
