import { Counter, Gauge, Histogram, Registry } from 'prom-client';
export const registry = new Registry();
export const metrics = {
  transactions: new Counter({ name: 'wager_transactions_total', help: 'Committed transaction states', labelNames: ['status'], registers: [registry] }),
  duplicates: new Counter({ name: 'wager_duplicates_total', help: 'Persistent replays', registers: [registry] }),
  retries: new Counter({ name: 'wager_retries_total', help: 'Retry attempts', labelNames: ['worker'], registers: [registry] }),
  dlq: new Counter({ name: 'wager_dlq_total', help: 'Messages routed to DLQ', registers: [registry] }),
  locks: new Counter({ name: 'wager_lock_conflicts_total', help: 'Lock/serialization conflicts', registers: [registry] }),
  lag: new Gauge({ name: 'wager_outbox_lag_seconds', help: 'Oldest unpublished event age', registers: [registry] }),
  latency: new Histogram({ name: 'wager_processing_seconds', help: 'Use case latency', registers: [registry] }),
  discrepancies: new Counter({ name: 'wager_reconciliation_discrepancies_total', help: 'Reconciliation mismatches', registers: [registry] }),
};
export function log(event: string, ids: { correlationId?: string; messageId?: string; transactionId?: string; walletId?: string; providerId?: string; code?: string } = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, correlationId: ids.correlationId ?? null,
    messageId: ids.messageId ?? null, transactionId: ids.transactionId ?? null, walletId: ids.walletId ?? null,
    providerId: ids.providerId ?? null, ...(ids.code ? { code: ids.code } : {}) }));
}
