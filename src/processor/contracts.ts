import { z } from 'zod';
import { createHash } from 'node:crypto';
export const uuid = z.uuid().transform(v => v.toLowerCase());
const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
export const keySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
export const moneySchema = z.strictObject({ amount: z.string().max(19), currency: z.enum(['BRL','USD','EUR']) });
export const openSchema = z.strictObject({ playerId: uuid, initialBalance: moneySchema });
export const transactionSchema = z.strictObject({
  providerId: identifier.max(100), externalTransactionId: identifier, playerId: uuid, walletId: uuid,
  roundId: identifier, gameId: identifier, kind: z.enum(['BET','WIN','LOSS','REFUND','ROLLBACK']),
  money: moneySchema, referenceExternalTransactionId: identifier.optional(),
}).superRefine((v, ctx) => {
  if (['REFUND','ROLLBACK'].includes(v.kind) && !v.referenceExternalTransactionId)
    ctx.addIssue({ code: 'custom', message: 'referenceExternalTransactionId obrigatório' });
  if (['BET','LOSS'].includes(v.kind) && v.referenceExternalTransactionId)
    ctx.addIssue({ code: 'custom', message: 'Referência não permitida para BET/LOSS' });
});
export type TransactionInput = z.infer<typeof transactionSchema>;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export const messageSchema = z.strictObject({ messageId: identifier, type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(), data: z.object({ idempotencyKey: keySchema }).catchall(z.unknown()) });
