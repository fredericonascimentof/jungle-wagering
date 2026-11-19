import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletSchema } from './wallet.entity';
import { Migration202611180001 } from './migrations/Migration202611180001';
import { Migration202611180002 } from './migrations/Migration202611180002';
import { FinancialWalletSchema } from '../processor/wallet.schema';

export async function connectDatabase(url = process.env.DATABASE_URL): Promise<MikroORM> {
  if (!url) throw new Error('DATABASE_URL é obrigatória. Copie .env.example para .env.');
  return MikroORM.init({
    clientUrl: url, entities: [WalletSchema, FinancialWalletSchema], extensions: [Migrator],
    migrations: { migrationsList: [Migration202611180001, Migration202611180002], transactional: true, allOrNothing: true },
    pool: { min: 0, max: 12 },
  });
}
