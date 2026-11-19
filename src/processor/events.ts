import { randomUUID } from 'node:crypto';
export interface EventContext { correlationId: string; causationId?: string }
export interface EventProps<T> extends EventContext { eventId: string; aggregateId: string; occurredAt: Date; data: T }
export abstract class IntegrationEvent<T extends Record<string, unknown>> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  protected constructor(readonly props: EventProps<T>) { Object.freeze(props.data); }
  toJSON() {
    return { eventId: this.props.eventId, eventType: this.eventType, version: this.version,
      aggregateId: this.props.aggregateId, correlationId: this.props.correlationId,
      ...(this.props.causationId ? { causationId: this.props.causationId } : {}),
      occurredAt: this.props.occurredAt.toISOString(), data: this.props.data };
  }
}
type Data = Record<string, unknown>;
function props(aggregateId: string, data: Data, ctx: EventContext): EventProps<Data> {
  return { eventId: randomUUID(), aggregateId, data, occurredAt: new Date(), ...ctx };
}
export class WagerTransactionProcessed extends IntegrationEvent<Data> {
  readonly eventType = 'WagerTransactionProcessed'; readonly version = 1;
  static from(id: string, data: Data, ctx: EventContext) { return new WagerTransactionProcessed(props(id, data, ctx)); }
}
export class WagerTransactionRejected extends IntegrationEvent<Data> {
  readonly eventType = 'WagerTransactionRejected'; readonly version = 1;
  static from(id: string, data: Data, ctx: EventContext) { return new WagerTransactionRejected(props(id, data, ctx)); }
}
export class WagerTransactionFailed extends IntegrationEvent<Data> {
  readonly eventType = 'WagerTransactionFailed'; readonly version = 1;
  static from(id: string, data: Data, ctx: EventContext) { return new WagerTransactionFailed(props(id, data, ctx)); }
}
export class WagerTransactionPendingReference extends IntegrationEvent<Data> {
  readonly eventType = 'WagerTransactionPendingReference'; readonly version = 1;
  static from(id: string, data: Data, ctx: EventContext) { return new WagerTransactionPendingReference(props(id, data, ctx)); }
}
export class WalletBalanceChanged extends IntegrationEvent<Data> {
  readonly eventType = 'WalletBalanceChanged'; readonly version = 1;
  static from(id: string, data: Data, ctx: EventContext) { return new WalletBalanceChanged(props(id, data, ctx)); }
}
export class InboxMessage {
  private constructor(readonly messageId: string, readonly consumerName: string, readonly payloadHash: string,
    readonly receivedAt: Date, private processed?: Date) {}
  static receive(p: { messageId: string; consumerName: string; payloadHash: string }) { return new InboxMessage(p.messageId, p.consumerName, p.payloadHash, new Date()); }
  static rehydrate(p: { messageId: string; consumerName: string; payloadHash: string; receivedAt: Date; processedAt?: Date }) {
    return new InboxMessage(p.messageId, p.consumerName, p.payloadHash, p.receivedAt, p.processedAt);
  }
  get processedAt() { return this.processed; }
  isProcessed() { return this.processed !== undefined; }
  markProcessed(at: Date) { if (!this.processed) this.processed = at; }
}
export class OutboxMessage {
  private constructor(readonly id: string, readonly aggregateId: string, readonly eventType: string,
    readonly payload: Readonly<Data>, readonly occurredAt: Date, private count = 0, private next?: Date, private published?: Date) {}
  static enqueue(event: IntegrationEvent<Data>) {
    const body = event.toJSON();
    return new OutboxMessage(body.eventId, body.aggregateId, body.eventType, Object.freeze(body), new Date(body.occurredAt));
  }
  static rehydrate(p: { id: string; aggregateId: string; eventType: string; payload: Data; occurredAt: Date; attempts: number; nextAttemptAt?: Date; publishedAt?: Date }) {
    return new OutboxMessage(p.id, p.aggregateId, p.eventType, Object.freeze(p.payload), p.occurredAt, p.attempts, p.nextAttemptAt, p.publishedAt);
  }
  get attempts() { return this.count; } get nextAttemptAt() { return this.next; } get publishedAt() { return this.published; }
  isPending() { return !this.published; } isDue(now: Date) { return this.isPending() && (!this.next || this.next <= now); }
  markPublished(at: Date) { this.published = at; }
  scheduleRetry(now: Date) { this.count++; this.next = new Date(now.getTime() + Math.min(300, 2 ** Math.min(this.count, 9)) * 1000); }
}
