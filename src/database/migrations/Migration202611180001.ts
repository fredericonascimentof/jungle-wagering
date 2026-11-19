import { Migration } from '@mikro-orm/migrations';

export class Migration202611180001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, currency varchar(3) NOT NULL CHECK (currency IN ('BRL','USD','EUR')),
        balance numeric(18,2) NOT NULL DEFAULT 0 CHECK (balance >= 0 AND balance <> 'NaN'::numeric), UNIQUE(id, currency)
      );
      CREATE TABLE wagers (
        id uuid PRIMARY KEY, wallet_id uuid NOT NULL REFERENCES wallets(id),
        stake numeric(18,2) NOT NULL CHECK (stake > 0 AND stake <> 'NaN'::numeric),
        status text NOT NULL CHECK (status IN ('PLACED','SETTLED','CANCELLED')),
        payout numeric(18,2) CHECK (payout >= 0 AND payout <> 'NaN'::numeric),
        CHECK ((status = 'SETTLED' AND payout IS NOT NULL) OR (status <> 'SETTLED' AND payout IS NULL)),
        UNIQUE(id, wallet_id)
      );
      CREATE INDEX wagers_wallet_idx ON wagers(wallet_id);
      CREATE TABLE operations (
        wallet_id uuid NOT NULL REFERENCES wallets(id), key varchar(128) NOT NULL,
        fingerprint char(64) NOT NULL, response jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(wallet_id, key)
      );
      CREATE TABLE ledger (
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        id uuid NOT NULL UNIQUE, wallet_id uuid NOT NULL, currency varchar(3) NOT NULL,
        operation_key varchar(128) NOT NULL, wager_id uuid,
        kind text NOT NULL CHECK(kind IN ('DEPOSIT','PLACE','SETTLE','CANCEL')),
        delta numeric(18,2) NOT NULL CHECK(delta <> 'NaN'::numeric),
        balance_after numeric(18,2) NOT NULL CHECK(balance_after >= 0 AND balance_after <> 'NaN'::numeric),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(wallet_id, operation_key),
        FOREIGN KEY(wallet_id, currency) REFERENCES wallets(id, currency),
        FOREIGN KEY(wallet_id, operation_key) REFERENCES operations(wallet_id, key),
        FOREIGN KEY(wager_id, wallet_id) REFERENCES wagers(id, wallet_id),
        CHECK ((kind = 'DEPOSIT' AND wager_id IS NULL AND delta > 0) OR
               (kind = 'PLACE' AND wager_id IS NOT NULL AND delta < 0) OR
               (kind = 'SETTLE' AND wager_id IS NOT NULL AND delta >= 0) OR
               (kind = 'CANCEL' AND wager_id IS NOT NULL AND delta > 0))
      );
      CREATE INDEX ledger_wallet_sequence_idx ON ledger(wallet_id, sequence);
      CREATE UNIQUE INDEX ledger_one_place ON ledger(wager_id) WHERE kind = 'PLACE';
      CREATE UNIQUE INDEX ledger_one_close ON ledger(wager_id) WHERE kind IN ('SETTLE','CANCEL');
      CREATE FUNCTION reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'financial history is append-only' USING ERRCODE = '23514'; END; $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger
        FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
      CREATE TRIGGER operations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON operations
        FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
    `);
  }
  override async down(): Promise<void> {
    // Explicit migration rollback only; never called by startup or test cleanup.
    this.addSql('DROP TABLE ledger,operations,wagers,wallets CASCADE; DROP FUNCTION reject_history_change();');
  }
}
