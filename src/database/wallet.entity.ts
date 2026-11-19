import { EntitySchema } from '@mikro-orm/core';

export class WalletRow {
  id!: string;
  currency!: string;
  balance!: string;
}
export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow, tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    currency: { type: 'string', length: 3 },
    balance: { type: 'string', columnType: 'numeric(18,2)' },
  },
});
