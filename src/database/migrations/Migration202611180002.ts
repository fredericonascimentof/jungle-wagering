import { Migration } from '@mikro-orm/migrations';
export class Migration202611180002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE financial_wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL CHECK(currency IN ('BRL','USD','EUR')),
        balance numeric(18,2) NOT NULL CHECK(balance >= 0 AND balance <> 'NaN'::numeric),
        version integer NOT NULL CHECK(version >= 1), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(player_id,currency), UNIQUE(id,currency)
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY, provider_id varchar(100) NOT NULL, external_transaction_id varchar(160) NOT NULL,
        idempotency_key varchar(256) NOT NULL UNIQUE, payload_hash char(64) NOT NULL,
        wallet_id uuid NOT NULL REFERENCES financial_wallets(id), player_id uuid NOT NULL,
        round_id varchar(160) NOT NULL, game_id varchar(160) NOT NULL,
        kind text NOT NULL CHECK(kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(18,2) NOT NULL CHECK(amount >= 0 AND amount <> 'NaN'::numeric), currency varchar(3) NOT NULL,
        reference_external_transaction_id varchar(160), reference_transaction_id uuid REFERENCES wager_transactions(id),
        status text NOT NULL CHECK(status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code text, response jsonb, business_payload jsonb NOT NULL,
        attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        UNIQUE(provider_id,external_transaction_id), UNIQUE(id,wallet_id),
        CHECK(kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CHECK((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CHECK((status = 'PROCESSED') = (processed_at IS NOT NULL))
      );
      CREATE INDEX transactions_reference_due ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE UNIQUE INDEX reversal_once_per_kind ON wager_transactions(reference_transaction_id,kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE TABLE wallet_ledger_entries (
        sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id uuid NOT NULL UNIQUE,
        wallet_id uuid NOT NULL, transaction_id uuid NOT NULL,
        direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
        amount numeric(18,2) NOT NULL CHECK(amount > 0 AND amount <> 'NaN'::numeric), currency varchar(3) NOT NULL,
        balance_before numeric(18,2) NOT NULL CHECK(balance_before >= 0 AND balance_before <> 'NaN'::numeric),
        balance_after numeric(18,2) NOT NULL CHECK(balance_after >= 0 AND balance_after <> 'NaN'::numeric),
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(wallet_id,transaction_id),
        FOREIGN KEY(wallet_id,currency) REFERENCES financial_wallets(id,currency),
        FOREIGN KEY(transaction_id,wallet_id) REFERENCES wager_transactions(id,wallet_id),
        CHECK(balance_after = balance_before + CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_cursor ON wallet_ledger_entries(wallet_id,sequence);
      CREATE TRIGGER financial_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL, message_id varchar(160) NOT NULL, payload_hash char(64) NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
        transaction_id uuid REFERENCES wager_transactions(id), PRIMARY KEY(consumer_name,message_id)
      );
      CREATE TABLE outbox_messages (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
        lease_until timestamptz, lease_token uuid
      );
      CREATE INDEX outbox_due ON outbox_messages(next_attempt_at) WHERE published_at IS NULL;
      CREATE FUNCTION protect_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') OR
          (to_jsonb(OLD) - ARRAY['status','failure_code','response','attempts','next_attempt_at','processed_at','reference_transaction_id']) <>
          (to_jsonb(NEW) - ARRAY['status','failure_code','response','attempts','next_attempt_at','processed_at','reference_transaction_id']) THEN
          RAISE EXCEPTION 'transaction is immutable or terminal' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$;
      CREATE TRIGGER transaction_transition BEFORE UPDATE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION protect_transaction();
      CREATE TRIGGER transaction_no_delete BEFORE DELETE OR TRUNCATE ON wager_transactions FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
      CREATE FUNCTION check_financial_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE wid uuid; stored numeric; expected numeric; ver integer; changes integer; broken bigint;
      BEGIN
        IF TG_TABLE_NAME = 'financial_wallets' THEN wid := NEW.id; ELSE wid := NEW.wallet_id; END IF;
        SELECT balance,version INTO stored,ver FROM financial_wallets WHERE id=wid FOR UPDATE;
        SELECT coalesce(sum(CASE WHEN e.direction='CREDIT' THEN e.amount ELSE -e.amount END),0),
               count(*) FILTER(WHERE t.kind <> 'OPENING') INTO expected,changes
          FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id=e.transaction_id WHERE e.wallet_id=wid;
        SELECT count(*) INTO broken FROM (
          SELECT balance_after, sum(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END) OVER(ORDER BY sequence) running
          FROM wallet_ledger_entries WHERE wallet_id=wid) chain WHERE balance_after<>running;
        IF stored<>expected OR ver<>changes+1 OR broken<>0 THEN
          RAISE EXCEPTION 'wallet ledger invariant violated' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER wallet_ledger_consistency AFTER INSERT OR UPDATE ON financial_wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financial_wallet();
      CREATE CONSTRAINT TRIGGER ledger_wallet_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financial_wallet();
      CREATE FUNCTION check_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE tid uuid; tx wager_transactions; entry wallet_ledger_entries; n integer;
      BEGIN
        IF TG_TABLE_NAME='wager_transactions' THEN tid := NEW.id; ELSE tid := NEW.transaction_id; END IF;
        SELECT * INTO tx FROM wager_transactions WHERE id=tid;
        SELECT count(*) INTO n FROM wallet_ledger_entries WHERE transaction_id=tid;
        IF tx.status='PROCESSED' AND tx.kind<>'LOSS' THEN
          SELECT * INTO entry FROM wallet_ledger_entries WHERE transaction_id=tid;
          IF n<>1 OR entry.amount<>tx.amount OR entry.currency<>tx.currency THEN
            RAISE EXCEPTION 'processed transaction requires matching ledger' USING ERRCODE='23514';
          END IF;
        ELSIF n<>0 THEN RAISE EXCEPTION 'non financial transaction cannot have ledger' USING ERRCODE='23514';
        END IF;
        RETURN NULL;
      END; $$;
      CREATE CONSTRAINT TRIGGER transaction_ledger_consistency AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
      CREATE CONSTRAINT TRIGGER ledger_transaction_consistency AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_ledger();
    `);
  }
  override async down(): Promise<void> {
    // Explicit operator action only. Never invoked automatically by the application/tests.
    this.addSql(`DROP TABLE outbox_messages,inbox_messages,wallet_ledger_entries,wager_transactions,financial_wallets CASCADE;
      DROP FUNCTION check_transaction_ledger(),check_financial_wallet(),protect_transaction();`);
  }
}
