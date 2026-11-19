import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
describe('Money e Wallet', () => {
  test('0.10 + 0.20 = 0.30, sem ponto flutuante', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
    expect(brl('9999999999999999.98').add(brl('0.01')).toString()).toBe('9999999999999999.99');
  });
  test.each(['-1', '1e3', 'NaN', 'Infinity', ' 1', '01', '.5', '1.', '0.001', '10000000000000000', ''])('rejeita %s', amount => {
    expect(() => brl(amount)).toThrow();
  });
  test('rejeita number em runtime e moeda desconhecida', () => {
    expect(() => brl(1 as unknown as string)).toThrow();
    expect(() => Money.from({ amount: '1', currency: 'JPY' })).toThrow();
  });
  test('protege moeda, limite, saldo e imutabilidade', () => {
    const original = brl('1');
    expect(() => original.add(Money.from({ amount: '1', currency: 'USD' }))).toThrow();
    expect(() => brl('9999999999999999.99').add(brl('0.01'))).toThrow();
    expect(() => original.subtract(brl('2'))).toThrow();
    expect(original.toJSON()).toEqual({ amount: '1.00', currency: 'BRL' });
    const wallet = new Wallet('unit-wallet', original);
    expect(() => wallet.debit(brl('0'))).toThrow();
    wallet.debit(brl('0.10'));
    expect(wallet.balance.toString()).toBe('0.90');
    expect(original.toString()).toBe('1.00');
  });
});
