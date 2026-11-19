import { expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { Wager } from '../../src/domain/wager';
const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
test('Wager só encerra uma vez e não pode movimentar outra carteira', () => {
  const wallet = new Wallet('a', money('100'));
  const wager = Wager.place('w', wallet, money('10'));
  expect(wallet.balance.toString()).toBe('90.00');
  expect(() => wager.cancel(new Wallet('b', money('100')))).toThrow();
  wager.cancel(wallet);
  expect(wallet.balance.toString()).toBe('100.00');
  expect(wager.status).toBe('CANCELLED');
  expect(() => wager.settle(wallet, money('20'))).toThrow();
  expect(() => wager.cancel(wallet)).toThrow();
});
test('payout zero e moeda errada não corrompem o estado', () => {
  const wallet = new Wallet('a', money('100'));
  const wager = Wager.place('w', wallet, money('10'));
  expect(() => wager.settle(wallet, Money.from({ amount: '10', currency: 'USD' }))).toThrow();
  expect(wager.status).toBe('PLACED');
  wager.settle(wallet, money('0'));
  expect(wager.status).toBe('SETTLED');
  expect(wallet.balance.toString()).toBe('90.00');
  expect(() => Wager.restore('bad', 'a', money('0'), 'PLACED')).toThrow();
});
