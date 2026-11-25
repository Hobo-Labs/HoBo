/**
 * Pluggable billing provider + durable invoice store.
 * Events → BillingAggregator → BillingProvider.charge / export.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TenantId } from "@hobo/core";
import type { JsonObject, StringBag } from "../json.js";

import type { Invoice } from "./billing-aggregator.js";

export type BillingChargeStatus =
	| "recorded"
	| "pending"
	| "paid"
	| "failed"
	| "skipped";

export interface BillingChargeResult {
	readonly status: BillingChargeStatus;
	readonly externalId?: string;
	readonly message?: string;
	readonly raw?: JsonObject;
}

export interface BillingProvider {
	readonly providerId: string;
	/** Submit a closed invoice for collection / ledger. */
	charge(invoice: Invoice): Promise<BillingChargeResult>;
	/** Optional customer upsert. */
	ensureCustomer?(input: {
		readonly tenantId: TenantId;
		readonly email?: string;
		readonly name?: string;
	}): Promise<{ readonly customerId: string }>;
}

/** Durable JSONL invoice ledger under a data directory. */
export interface InvoiceLedger {
	append(invoice: Invoice): void;
	list(tenantId?: TenantId): readonly Invoice[];
	get(invoiceId: string): Invoice | null;
	path: string;
}

export function createFileInvoiceLedger(dataDir: string): InvoiceLedger {
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, "invoices.jsonl");
	const cache: Invoice[] = [];
	if (existsSync(path)) {
		const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				// SAFETY: assertion required at this I/O or test boundary.
				cache.push(JSON.parse(line) as Invoice);
			} catch {
				// skip corrupt lines
			}
		}
	}
	return {
		path,
		append(invoice) {
			cache.push(invoice);
			writeFileSync(
				path,
				`${cache.map((i) => JSON.stringify(i)).join("\n")}\n`,
				"utf8",
			);
		},
		list(tenantId) {
			return tenantId
				? cache.filter((i) => i.tenantId === tenantId)
				: [...cache];
		},
		get(invoiceId) {
			return cache.find((i) => i.invoiceId === invoiceId) ?? null;
		},
	};
}

/**
 * Ledger-only provider: records invoices durably without calling a PSP.
 * Always succeeds with status "recorded".
 */
export function createLedgerBillingProvider(options?: {
	readonly ledger?: InvoiceLedger;
	readonly dataDir?: string;
}): BillingProvider & { readonly ledger: InvoiceLedger } {
	const ledger =
		options?.ledger ??
		createFileInvoiceLedger(options?.dataDir ?? join(".hobo", "billing"));
	return {
		providerId: "ledger",
		ledger,
		async charge(invoice) {
			ledger.append(invoice);
			return {
				status: "recorded",
				externalId: invoice.invoiceId,
				message: "invoice recorded on durable ledger",
			};
		},
		async ensureCustomer(input) {
			return { customerId: `cust_${input.tenantId}` };
		},
	};
}

/**
 * Stripe-shaped billing provider using the PaymentIntents / Invoice Items API
 * via REST (no SDK). Requires secret key; test mode keys work.
 */
export function createStripeBillingProvider(options: {
	readonly secretKey: string;
	readonly apiBase?: string;
	readonly fetchImpl?: typeof fetch;
	readonly ledger?: InvoiceLedger;
	readonly currency?: string;
}): BillingProvider {
	const base = (options.apiBase ?? "https://api.stripe.com/v1").replace(
		/\/$/,
		"",
	);
	const fetchImpl = options.fetchImpl ?? fetch;
	const ledger = options.ledger;

	async function stripeForm(
		path: string,
		fields: Record<string, string>,
	): Promise<{ ok: boolean; status: number; body: JsonObject }> {
		const body = new URLSearchParams(fields).toString();
		const res = await fetchImpl(`${base}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${options.secretKey}`,
				"content-type": "application/x-www-form-urlencoded",
				// Idempotency for charge path is set by caller via fields; also allow header.
				...(fields["metadata[invoice_id]"]
					? { "Idempotency-Key": fields["metadata[invoice_id]"] }
					: undefined),
			},
			body,
		});
		// SAFETY: assertion required at this I/O or test boundary.
		const json = (await res.json().catch(() => ({}))) as JsonObject;
		return { ok: res.ok, status: res.status, body: json };
	}

	return {
		providerId: "stripe",
		async ensureCustomer(input) {
			const res = await stripeForm("/customers", {
				"metadata[tenant_id]": input.tenantId,
				...(input.email ? { email: input.email } : undefined),
				...(input.name ? { name: input.name } : undefined),
			});
			if (!res.ok) {
				throw new Error(
					`stripe ensureCustomer failed (${res.status}): ${JSON.stringify(res.body).slice(0, 200)}`,
				);
			}
			return { customerId: String(res.body.id) };
		},
		async charge(invoice) {
			ledger?.append(invoice);
			// Create a PaymentIntent for the invoice total (amount in minor units).
			const customer = await this.ensureCustomer?.({
				tenantId: invoice.tenantId,
			});
			const fields: StringBag = {
				amount: String(Math.max(0, Math.floor(invoice.total))),
				currency: (invoice.currency || options.currency || "usd").toLowerCase(),
				"metadata[invoice_id]": invoice.invoiceId,
				"metadata[tenant_id]": invoice.tenantId,
				"metadata[period_start]": invoice.periodStart,
				"metadata[period_end]": invoice.periodEnd,
				description: `HoBo invoice ${invoice.invoiceId}`,
			};
			if (customer?.customerId) {
				fields.customer = customer.customerId;
			}
			// Amount is always minor currency units (cents). Idempotency-Key = invoiceId.
			const res = await stripeForm("/payment_intents", {
				...fields,
				confirm: "false",
			});
			if (!res.ok) {
				return {
					status: "failed",
					message: `stripe charge failed (${res.status})`,
					raw: res.body,
				};
			}
			return {
				status: "pending",
				externalId: String(res.body.id),
				message: "payment_intent created",
				raw: res.body,
			};
		},
	};
}

/** Export invoice as Stripe-like line items JSON for external systems. */
export function exportInvoiceStripeLines(invoice: Invoice) {
	return {
		currency: invoice.currency.toLowerCase(),
		customer_metadata: { tenant_id: invoice.tenantId },
		lines: invoice.lines.map((line) => ({
			amount: line.amount,
			currency: line.currency.toLowerCase(),
			description: `${line.eventType} x ${line.quantity}`,
			metadata: {
				event_type: line.eventType,
				quantity: String(line.quantity),
				unit_price: String(line.unitPrice),
				period_start: line.periodStart,
				period_end: line.periodEnd,
			},
		})),
	};
}
