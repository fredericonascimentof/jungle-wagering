import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { connectDatabase } from '../../src/database/orm';
import { createApp } from '../../src/http/app';
import type { OperationResult } from '../../src/application/contracts';

let orm: MikroORM;
let secondOrm: MikroORM;
let apps: INestApplication[] = [];
let urls: string[] = [];

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL deve apontar para um banco com sufixo _test. Teste não é simulado nem ignorado.');
  }
  orm = await connectDatabase(url);
  await orm.migrator.up();
  secondOrm = await connectDatabase(url);
  apps = [await createApp(orm), await createApp(secondOrm)];
  for (const app of apps) { await app.listen(0, '127.0.0.1'); urls.push(await app.getUrl()); }
});
afterAll(async () => {
  await Promise.all(apps.map(app => app.close()));
  if (orm) await orm.close(true);
  if (secondOrm) await secondOrm.close(true);
});

async function request(path: string, method = 'GET', body?: unknown, key?: string, instance = 0) {
  return fetch(`${urls[instance]}${path}`, {
    method, headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function wallet(balance = '100.00') {
  const id = randomUUID();
  expect((await request(`/wallets/${id}`, 'PUT', { currency: 'BRL' })).status).toBe(200);
  if (balance !== '0') expect((await op(id, { type: 'DEPOSIT', amount: balance, currency: 'BRL' })).status).toBe(200);
  return id;
}
function op(id: string, body: unknown, key = randomUUID(), instance = 0) {
  return request(`/wallets/${id}/operations`, 'POST', body, key, instance);
}
async function assertBalance(id: string, expected: string) {
  const state = await (await request(`/wallets/${id}`)).json() as { balance: string };
  expect(state.balance).toBe(expected);
  const report = await (await request(`/wallets/${id}/reconciliation`)).json() as { consistent: boolean };
  expect(report.consistent).toBe(true);
}

describe('PostgreSQL real + HTTP em duas instâncias independentes', () => {
  test('bloquear uma carteira não impede operar outra', async () => {
    const lockedId = await wallet(); const freeId = await wallet('0');
    await assertBalance(freeId, '0.00');
    const em = orm.em.fork();
    await em.begin();
    try {
      await em.execute('select id from wallets where id = ? for update', [lockedId]);
      const response = await op(freeId, { type: 'DEPOSIT', amount: '1', currency: 'BRL' }, randomUUID(), 1);
      expect(response.status).toBe(200);
      await assertBalance(freeId, '1.00');
    } finally { await em.rollback(); }
  });

  test('replay preserva resposta original mesmo depois de outras operações', async () => {
    const id = await wallet('0'); const key = randomUUID();
    const body = { type: 'DEPOSIT', amount: '10', currency: 'BRL' };
    const original = await (await op(id, body, key)).json();
    await op(id, { ...body, amount: '5' });
    expect(await (await op(id, body, key, 1)).json()).toEqual(original);
    await assertBalance(id, '15.00');
  });

  test('40 apostas concorrentes: apenas 10 cabem no saldo, sem saldo negativo', async () => {
    const id = await wallet();
    const responses = await Promise.all(Array.from({ length: 40 }, (_, n) => op(id,
      { type: 'PLACE', wagerId: randomUUID(), amount: '10', currency: 'BRL' }, randomUUID(), n % 2)));
    expect(responses.filter(r => r.status === 200)).toHaveLength(10);
    expect(responses.filter(r => r.status === 409)).toHaveLength(30);
    await assertBalance(id, '0.00');
    const [count] = await orm.em.fork().execute<{ n: number }[]>('select count(*)::int n from ledger where wallet_id = ?', [id]);
    expect(count?.n).toBe(11);
  });

  test('30 duplicatas concorrentes produzem exatamente um débito e a mesma resposta', async () => {
    const id = await wallet(); const key = randomUUID();
    const body = { type: 'PLACE', wagerId: randomUUID(), amount: '10.00', currency: 'BRL' };
    const responses = await Promise.all(Array.from({ length: 30 }, (_, n) => op(id, body, key, n % 2)));
    expect(responses.every(r => r.status === 200)).toBe(true);
    const payloads = await Promise.all(responses.map(r => r.json()));
    for (const payload of payloads) expect(payload).toEqual(payloads[0]);
    await assertBalance(id, '90.00');
    expect((await op(id, { ...body, amount: '11' }, key)).status).toBe(409);
    expect(await (await op(id, { ...body, amount: '10' }, key)).json()).toEqual(payloads[0]);
  });

  test('liquidação e cancelamento em corrida: apenas um encerramento', async () => {
    const id = await wallet(); const wagerId = randomUUID();
    await op(id, { type: 'PLACE', wagerId, amount: '10', currency: 'BRL' });
    const key = randomUUID();
    const settle = { type: 'SETTLE', wagerId, amount: '25', currency: 'BRL' };
    const results = await Promise.all([op(id, settle, key), op(id, { type: 'CANCEL', wagerId }, randomUUID(), 1)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const settled = results[0]?.status === 200;
    await assertBalance(id, settled ? '115.00' : '100.00');
    if (settled) expect((await op(id, settle, key)).status).toBe(200);
  });

  test('perda, cancelamento, carteira alheia e rollback de aposta duplicada', async () => {
    const id = await wallet(); const other = await wallet(); const wagerId = randomUUID();
    const placed = { type: 'PLACE', wagerId, amount: '10', currency: 'BRL' };
    expect((await op(id, placed)).status).toBe(200);
    expect((await op(other, { type: 'CANCEL', wagerId })).status).toBe(404);
    expect((await op(id, placed)).status).toBe(409);
    expect((await op(other, placed)).status).toBe(409);
    await assertBalance(other, '100.00');
    await assertBalance(id, '90.00');
    expect((await op(id, { type: 'SETTLE', wagerId, amount: '0', currency: 'BRL' })).status).toBe(200);
    expect((await op(id, { type: 'CANCEL', wagerId })).status).toBe(409);
    const cancelledId = randomUUID();
    await op(id, { ...placed, wagerId: cancelledId });
    expect((await op(id, { type: 'CANCEL', wagerId: cancelledId })).status).toBe(200);
    await assertBalance(id, '90.00');
  });

  test('validação HTTP, moeda, zero, limites e idempotência persistente em outra conexão', async () => {
    const id = await wallet('0');
    expect((await request(`/wallets/${id}`, 'PUT', { currency: 'USD' })).status).toBe(409);
    expect((await op(id, { type: 'DEPOSIT', amount: 1, currency: 'BRL' })).status).toBe(400);
    expect((await op(id, { type: 'DEPOSIT', amount: '-1', currency: 'BRL' })).status).toBe(422);
    expect((await op(id, { type: 'DEPOSIT', amount: '1', currency: 'USD' })).status).toBe(422);
    expect((await op(id, { type: 'DEPOSIT', amount: '0', currency: 'BRL' })).status).toBe(422);
    expect((await request(`/wallets/${id}/operations`, 'POST', { type: 'DEPOSIT', amount: '1', currency: 'BRL' })).status).toBe(400);
    const key = randomUUID(); const deposit = { type: 'DEPOSIT', amount: '9999999999999999.99', currency: 'BRL' };
    const first = await (await op(id, deposit, key)).json() as OperationResult;
    expect(await (await op(id, deposit, key, 1)).json()).toEqual(first);
    expect((await op(id, { ...deposit, amount: '0.01' })).status).toBe(422);
    await assertBalance(id, deposit.amount);
  });

  test('constraints e histórico append-only resistem a SQL direto', async () => {
    const id = await wallet();
    const sql = (query: string) => orm.em.fork().execute(query, [id]);
    await expect(sql('update wallets set balance = -1 where id = ?')).rejects.toThrow();
    await expect(sql("update wallets set balance = 'NaN' where id = ?")).rejects.toThrow();
    await expect(sql('update ledger set delta = 123 where wallet_id = ?')).rejects.toThrow();
    await expect(sql('delete from ledger where wallet_id = ?')).rejects.toThrow();
    await expect(sql('delete from operations where wallet_id = ?')).rejects.toThrow();
    await expect(orm.em.fork().execute('truncate ledger')).rejects.toThrow();
    await assertBalance(id, '100.00');
  });

  test('reconciliação identifica saldo adulterado sem corrigir silenciosamente', async () => {
    const id = await wallet();
    // Transaction is rolled back deliberately; no persistent tampering is left behind.
    await orm.em.fork().transactional(async em => {
      await em.execute('update wallets set balance = 99 where id = ?', [id]);
      const [row] = await em.execute<{ mismatch: boolean }[]>(`select balance <> (select sum(delta) from ledger where wallet_id = ?) mismatch from wallets where id = ?`, [id, id]);
      expect(row?.mismatch).toBe(true);
      throw new Error('rollback-test');
    }).catch(error => { expect((error as Error).message).toBe('rollback-test'); });
    // Committed inconsistency needed to exercise actual reconciliation endpoint; restore in finally.
    await orm.em.fork().execute('update wallets set balance = 99 where id = ?', [id]);
    try {
      const report = await (await request(`/wallets/${id}/reconciliation`)).json() as { consistent: boolean };
      expect(report.consistent).toBe(false);
    } finally { await orm.em.fork().execute('update wallets set balance = 100 where id = ?', [id]); }
    await assertBalance(id, '100.00');
  });
});
