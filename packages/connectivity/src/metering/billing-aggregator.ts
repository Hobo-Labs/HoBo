import type { MeteringSink, TenantId, UsageEvent } from "@hobo/core";
import { createUsageEvent } from "@hobo/core";

export interface PriceBook {
	/** Price per unit in minor currency units (e.g. USD cents). */
	readonly prices: Readonly<Partial<Record<UsageEvent["eventType"], number>>>;
	readonly currency: string;
}

export interface InvoiceLine {
	readonly tenantId: TenantId;
	readonly eventType: UsageEvent["eventType"];
	readonly quantity: number;
	readonly unitPrice: number;
	readonly amount: number;
	readonly currency: string;
	readonly periodStart: string;
	readonly periodEnd: string;
}

export interface Invoice {
	readonly invoiceId: string;
	readonly tenantId: TenantId;
	readonly currency: string;
	readonly periodStart: string;
	readonly periodEnd: string;
	readonly lines: readonly InvoiceLine[];
	readonly total: number;
	readonly closedAt: string;
}

export interface BillingPeriodBucket {
	readonly tenantId: TenantId;
	readonly eventType: UsageEvent["eventType"];
	quantity: number;
}

export interface BillingAggregator extends MeteringSink {
	readonly priceBook: PriceBook;
	/** Ingested raw events (debug). */
	readonly events: readonly UsageEvent[];
	snapshot(tenantId?: TenantId): readonly BillingPeriodBucket[];
	closePeriod(input: {
		readonly tenantId: TenantId;
		readonly periodStart: string;
		readonly periodEnd: string;
	}): Invoice;
	/**
	 * Close period, then charge via BillingProvider when configured.
	 */
	closeAndCharge(input: {
		readonly tenantId: TenantId;
		readonly periodStart: string;
		readonly periodEnd: string;
	}): Promise<{
		readonly invoice: Invoice;
		readonly charge?: import("./billing-provider.js").BillingChargeResult;
	}>;
	listInvoices(tenantId?: TenantId): readonly Invoice[];
}

const DEFAULT_PRICE_BOOK: PriceBook = {
	currency: "USD",
	prices: {
		"junction.join": 10,
		"junction.leave": 0,
		"tunnel.up": 5,
		"tunnel.heartbeat": 1,
		"tunnel.down": 0,
		"name.resolve": 0,
		"named_endpoint.register": 2,
		"named_endpoint.unregister": 0,
		"dns.record_upsert": 3,
		"dns.record_delete": 1,
		"dns.suggest": 0,
		"dns.dynamic_register": 2,
		"policy.evaluate": 0,
		"overlay.join": 5,
		"overlay.leave": 0,
		"overlay.magicdns": 1,
		"overlay.funnel": 10,
		"billing.invoice_line": 0,
		"billing.period_close": 0,
	},
};

/**
 * Aggregates UsageEvent streams into per-tenant period invoices.
 * Wire as a MeteringSink so every lifecycle path feeds billing.
 */
export function createBillingAggregator(options?: {
	readonly sinkId?: string;
	readonly priceBook?: PriceBook;
	readonly onInvoice?: (invoice: Invoice) => void | Promise<void>;
	readonly billingProvider?: import("./billing-provider.js").BillingProvider;
}): BillingAggregator {
	const events: UsageEvent[] = [];
	const buckets = new Map<string, BillingPeriodBucket>();
	const invoices: Invoice[] = [];
	const priceBook = options?.priceBook ?? DEFAULT_PRICE_BOOK;
	let invoiceSeq = 0;

	function bucketKey(tenantId: string, eventType: string): string {
		return `${tenantId}::${eventType}`;
	}

	const aggregator: BillingAggregator = {
		sinkId: options?.sinkId ?? "billing-aggregator",
		priceBook,
		get events() {
			return events;
		},
		emit(event) {
			if (
				event.eventType === "billing.invoice_line" ||
				event.eventType === "billing.period_close"
			) {
				return;
			}
			events.push(event);
			const k = bucketKey(event.tenantId, event.eventType);
			const existing = buckets.get(k);
			if (existing) {
				existing.quantity += event.quantity;
			} else {
				buckets.set(k, {
					tenantId: event.tenantId,
					eventType: event.eventType,
					quantity: event.quantity,
				});
			}
		},
		snapshot(tenantId) {
			const all = [...buckets.values()];
			return tenantId ? all.filter((b) => b.tenantId === tenantId) : all;
		},
		closePeriod(input) {
			const periodStartMs = Date.parse(input.periodStart);
			const periodEndMs = Date.parse(input.periodEnd);
			const hasWindow =
				Number.isFinite(periodStartMs) && Number.isFinite(periodEndMs);

			// Rebuild buckets for this close from events in the period window when timestamps exist.
			const periodBuckets = new Map<string, BillingPeriodBucket>();
			for (const event of events) {
				if (event.tenantId !== input.tenantId) continue;
				if (
					event.eventType === "billing.invoice_line" ||
					event.eventType === "billing.period_close"
				) {
					continue;
				}
				if (hasWindow) {
					const ts = Date.parse(event.timestamp);
					if (!Number.isFinite(ts)) continue;
					// Inclusive start, exclusive end-of-day if date-only, else inclusive range.
					const endBound =
						input.periodEnd.length <= 10
							? periodEndMs + 24 * 60 * 60 * 1000
							: periodEndMs + 1;
					if (ts < periodStartMs || ts >= endBound) continue;
				}
				const k = bucketKey(event.tenantId, event.eventType);
				const existing = periodBuckets.get(k);
				if (existing) existing.quantity += event.quantity;
				else {
					periodBuckets.set(k, {
						tenantId: event.tenantId,
						eventType: event.eventType,
						quantity: event.quantity,
					});
				}
			}

			const sourceBuckets =
				periodBuckets.size > 0 || hasWindow
					? [...periodBuckets.values()]
					: [...buckets.values()].filter((b) => b.tenantId === input.tenantId);

			const lines: InvoiceLine[] = sourceBuckets
				.map((b) => {
					const unitPrice = priceBook.prices[b.eventType] ?? 0;
					const amount = unitPrice * b.quantity;
					if (!Number.isInteger(amount) || amount < 0) {
						throw new Error(
							`billing: non-integer or negative amount for ${b.eventType} (amounts must be minor currency units)`,
						);
					}
					return {
						tenantId: input.tenantId,
						eventType: b.eventType,
						quantity: b.quantity,
						unitPrice,
						amount,
						currency: priceBook.currency,
						periodStart: input.periodStart,
						periodEnd: input.periodEnd,
					};
				})
				.filter((line) => line.quantity > 0);

			const total = lines.reduce((sum, l) => sum + l.amount, 0);
			invoiceSeq += 1;
			const invoice: Invoice = {
				invoiceId: `inv_${input.tenantId}_${invoiceSeq}`,
				tenantId: input.tenantId,
				currency: priceBook.currency,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				lines,
				total,
				closedAt: new Date().toISOString(),
			};
			invoices.push(invoice);

			// Clear closed tenant buckets so the next period starts clean.
			for (const k of buckets.keys()) {
				if (k.startsWith(`${input.tenantId}::`)) buckets.delete(k);
			}

			void options?.onInvoice?.(invoice);
			return invoice;
		},
		async closeAndCharge(input) {
			const invoice = aggregator.closePeriod(input);
			if (!options?.billingProvider) {
				return { invoice };
			}
			const charge = await options.billingProvider.charge(invoice);
			return { invoice, charge };
		},
		listInvoices(tenantId) {
			return tenantId
				? invoices.filter((i) => i.tenantId === tenantId)
				: [...invoices];
		},
	};

	return aggregator;
}

/** Emit synthetic billing events for audit trails on a bus. */
export function invoiceToUsageEvents(invoice: Invoice): UsageEvent[] {
	const lines = invoice.lines.map((line) =>
		createUsageEvent({
			tenantId: invoice.tenantId,
			eventType: "billing.invoice_line",
			resource: line.eventType,
			quantity: line.amount,
			unit: invoice.currency,
			metadata: {
				invoiceId: invoice.invoiceId,
				qty: line.quantity,
				unitPrice: line.unitPrice,
			},
		}),
	);
	return [
		...lines,
		createUsageEvent({
			tenantId: invoice.tenantId,
			eventType: "billing.period_close",
			resource: invoice.invoiceId,
			quantity: invoice.total,
			unit: invoice.currency,
			metadata: {
				periodStart: invoice.periodStart,
				periodEnd: invoice.periodEnd,
				lineCount: invoice.lines.length,
			},
		}),
	];
}
