import { z } from 'zod';
const money = { amount: z.string().max(20), currency: z.enum(['BRL', 'USD', 'EUR']) };
export const walletIdSchema = z.uuid();
export const createWalletSchema = z.strictObject({ currency: money.currency });
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('DEPOSIT'), ...money }),
  z.strictObject({ type: z.literal('PLACE'), wagerId: z.uuid(), ...money }),
  z.strictObject({ type: z.literal('SETTLE'), wagerId: z.uuid(), ...money }),
  z.strictObject({ type: z.literal('CANCEL'), wagerId: z.uuid() }),
]);
export const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export type Command = z.infer<typeof commandSchema>;
export interface OperationResult {
  operationId: string; walletId: string; type: Command['type'];
  balance: string; currency: string; wagerId: string | null;
  wagerStatus: 'PLACED' | 'SETTLED' | 'CANCELLED' | null;
}
