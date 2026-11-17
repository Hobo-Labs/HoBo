import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.js";

import type { Invoice } from "../../src/metering/billing-aggregator.js";
import {
	createFileInvoiceLedger,
	createLedgerBillingProvider,
	createStripeBillingProvider,
	exportInvoiceStripeLines,
} from "../../src/metering/billing-provider.js";

const dir = () => mkdtempSync(join(tmpdir(), "hobo-billing-"));

const line = (overrides: JsonObject = {}) => ({
	tenantId: "t1",
	eventType: "request",
	quantity: 10,
	unitPrice: 3,
	amount: 30,
	currency: "USD",
	periodStart: "2026-01-01",
	periodEnd: "2026-02-01",
	...overrides,
});

const invoice = (overrides: JsonObject = {}): Invoice =>
	({
		invoiceId: "inv-1",
		tenantId: "t1",
		currency: "USD",
		periodStart: "2026-01-01",
		periodEnd: "2026-02-01",
		lines: [line()],
		total: 30,
		closedAt: "2026-02-01T00:00:00.000Z",
		...overrides,
	}) as Invoice;

describe("the file invoice ledger", () => {
	it("creates its data directory", () => {
		const path = join(dir(), "nested", "deep");
		expect(() => createFileInvoiceLedger(path)).not.toThrow();
	});

	it("writes one JSON object per line", () => {
		const ledger = createFileInvoiceLedger(dir());
		ledger.append(invoice());
		ledger.append(invoice({ invoiceId: "inv-2" }));
		const lines = readFileSync(ledger.path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(String(lines[1])).invoiceId).toBe("inv-2");
	});

	it("names its file invoices.jsonl inside the directory it was given", () => {
		const path = dir();
		expect(createFileInvoiceLedger(path).path).toBe(
			join(path, "invoices.jsonl"),
		);
	});

	it("reloads what a previous process wrote", () => {
		const path = dir();
		createFileInvoiceLedger(path).append(invoice());
		expect(createFileInvoiceLedger(path).list()).toHaveLength(1);
	});

	it("keeps the good lines when one is corrupt", () => {
		const path = dir();
		writeFileSync(
			join(path, "invoices.jsonl"),
			`${JSON.stringify(invoice())}\n{not json\n${JSON.stringify(invoice({ invoiceId: "inv-3" }))}\n`,
		);
		const ledger = createFileInvoiceLedger(path);
		expect(ledger.list().map((i) => i.invoiceId)).toEqual(["inv-1", "inv-3"]);
	});

	it("ignores blank lines", () => {
		const path = dir();
		writeFileSync(
			join(path, "invoices.jsonl"),
			`\n${JSON.stringify(invoice())}\n\n`,
		);
		expect(createFileInvoiceLedger(path).list()).toHaveLength(1);
	});

	it("starts empty when there is no file yet", () => {
		expect(createFileInvoiceLedger(dir()).list()).toEqual([]);
	});

	it("filters by tenant", () => {
		const ledger = createFileInvoiceLedger(dir());
		ledger.append(invoice());
		ledger.append(invoice({ invoiceId: "inv-2", tenantId: "t2" }));
		expect(ledger.list("t1" as never).map((i) => i.invoiceId)).toEqual([
			"inv-1",
		]);
	});

	it("returns every tenant's invoices when none is named", () => {
		const ledger = createFileInvoiceLedger(dir());
		ledger.append(invoice());
		ledger.append(invoice({ invoiceId: "inv-2", tenantId: "t2" }));
		expect(ledger.list()).toHaveLength(2);
	});

	it("hands out a copy of the list, not its own array", () => {
		const ledger = createFileInvoiceLedger(dir());
		ledger.append(invoice());
		(ledger.list() as Invoice[]).push(invoice({ invoiceId: "inv-x" }));
		expect(ledger.list()).toHaveLength(1);
	});

	it("looks an invoice up by id", () => {
		const ledger = createFileInvoiceLedger(dir());
		ledger.append(invoice());
		expect(ledger.get("inv-1")?.tenantId).toBe("t1");
	});

	it("reports null for an unknown invoice rather than undefined", () => {
		expect(createFileInvoiceLedger(dir()).get("nope")).toBeNull();
	});
});

describe("the ledger-only provider", () => {
	it("identifies itself", () => {
		expect(
			createLedgerBillingProvider({ ledger: memoryLedger() }).providerId,
		).toBe("ledger");
	});

	it("records the invoice and says so", async () => {
		const ledger = memoryLedger();
		const result = await createLedgerBillingProvider({ ledger }).charge(
			invoice(),
		);
		expect(result.status).toBe("recorded");
		expect(ledger.list()).toHaveLength(1);
	});

	it("reports the invoice id as the external reference", async () => {
		const result = await createLedgerBillingProvider({
			ledger: memoryLedger(),
		}).charge(invoice());
		expect(result.externalId).toBe("inv-1");
	});

	it("never reports pending, since nothing is in flight", async () => {
		const result = await createLedgerBillingProvider({
			ledger: memoryLedger(),
		}).charge(invoice());
		expect(result.status).not.toBe("pending");
	});

	it("derives a customer id from the tenant", async () => {
		const provider = createLedgerBillingProvider({ ledger: memoryLedger() });
		expect(
			await provider.ensureCustomer?.({ tenantId: "t1" as never }),
		).toEqual({ customerId: "cust_t1" });
	});

	it("builds its own file ledger under a named data directory", () => {
		const provider = createLedgerBillingProvider({ dataDir: dir() });
		expect(provider.ledger.path).toContain("invoices.jsonl");
	});
});

describe("the Stripe-shaped provider", () => {
	type Call = { url: string; init: RequestInit };

	function stripe(
		script: { ok?: boolean; status?: number; body?: unknown }[] = [],
		options: JsonObject = {},
	) {
		const calls: Call[] = [];
		let n = 0;
		const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
			calls.push({ url: String(url), init });
			const entry = script[n++] ?? { body: { id: `obj_${n}` } };
			const status = entry.status ?? (entry.ok === false ? 402 : 200);
			return {
				ok: status >= 200 && status < 300,
				status,
				json: async () => entry.body ?? { id: `obj_${n}` },
			} as Response;
		}) as typeof fetch;
		return {
			calls,
			fields: (i: number) =>
				Object.fromEntries(new URLSearchParams(String(calls[i]?.init.body))),
			provider: createStripeBillingProvider({
				secretKey: "sk_test_secret",
				fetchImpl,
				...options,
			}),
		};
	}

	it("identifies itself", () => {
		expect(stripe().provider.providerId).toBe("stripe");
	});

	it("addresses the live API by default", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		expect(s.calls[0]?.url).toContain("https://api.stripe.com/v1");
	});

	it("honours an override base without doubling its slash", async () => {
		const s = stripe([], { apiBase: "https://stripe.mock/v1/" });
		await s.provider.charge(invoice());
		expect(s.calls[0]?.url).toBe("https://stripe.mock/v1/customers");
	});

	it("authenticates with the secret key as a bearer token", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		const call = s.calls[0];
		if (call === undefined) throw new Error("expected a request");
		const headers = call.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers.authorization).toBe("Bearer sk_test_secret");
	});

	it("posts form-encoded fields, as the Stripe REST API requires", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		const call = s.calls[0];
		if (call === undefined) throw new Error("expected a request");
		const headers = call.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
	});

	it("records the invoice on the ledger before calling out", async () => {
		const ledger = memoryLedger();
		const s = stripe([], { ledger });
		await s.provider.charge(invoice());
		expect(ledger.list()).toHaveLength(1);
	});

	it("works with no ledger at all", async () => {
		expect((await stripe().provider.charge(invoice())).status).toBe("pending");
	});

	it("upserts the customer before creating the intent", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		expect(s.calls[0]?.url).toContain("/customers");
		expect(s.calls[1]?.url).toContain("/payment_intents");
	});

	it("attaches the resolved customer to the intent", async () => {
		const s = stripe([{ body: { id: "cus_123" } }, { body: { id: "pi_1" } }]);
		await s.provider.charge(invoice());
		expect(s.fields(1).customer).toBe("cus_123");
	});

	it("tags the customer with the tenant it belongs to", async () => {
		const s = stripe();
		await s.provider.ensureCustomer?.({ tenantId: "t1" as never });
		expect(s.fields(0)["metadata[tenant_id]"]).toBe("t1");
	});

	it("sends an email and name only when it has them", async () => {
		const s = stripe();
		await s.provider.ensureCustomer?.({ tenantId: "t1" as never });
		expect(s.fields(0)).not.toHaveProperty("email");
		await s.provider.ensureCustomer?.({
			tenantId: "t1" as never,
			email: "a@example.com",
			name: "Acme",
		});
		expect(s.fields(1).email).toBe("a@example.com");
		expect(s.fields(1).name).toBe("Acme");
	});

	it("throws when the customer upsert fails", async () => {
		const s = stripe([{ status: 401, body: { error: "bad key" } }]);
		await expect(
			s.provider.ensureCustomer?.({ tenantId: "t1" as never }),
		).rejects.toThrow(/stripe ensureCustomer failed \(401\)/u);
	});

	it("bounds the error body it quotes", async () => {
		const s = stripe([{ status: 500, body: { detail: "x".repeat(4000) } }]);
		const error = await s.provider
			.ensureCustomer?.({ tenantId: "t1" })
			.catch((error: Error) => error);
		expect(error instanceof Error ? error.message.length : 0).toBeLessThan(400);
	});

	it("uses the invoice id as the idempotency key", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		const call = s.calls[1];
		if (call === undefined) throw new Error("expected a charge request");
		const headers = call.init.headers;
		if (!headers || headers instanceof Headers || Array.isArray(headers)) {
			throw new Error("expected header object");
		}
		expect(headers["Idempotency-Key"]).toBe("inv-1");
	});

	it("sends the amount in minor units", async () => {
		const s = stripe();
		await s.provider.charge(invoice({ total: 1234 }));
		expect(s.fields(1).amount).toBe("1234");
	});

	it("floors a fractional total rather than letting Stripe reject it", async () => {
		const s = stripe();
		await s.provider.charge(invoice({ total: 10.9 }));
		expect(s.fields(1).amount).toBe("10");
	});

	it("clamps a negative total to zero rather than issuing a refund", async () => {
		const s = stripe();
		await s.provider.charge(invoice({ total: -500 }));
		expect(s.fields(1).amount).toBe("0");
	});

	it("lowercases the currency, as Stripe requires", async () => {
		const s = stripe();
		await s.provider.charge(invoice({ currency: "EUR" }));
		expect(s.fields(1).currency).toBe("eur");
	});

	it("falls back to the provider currency when the invoice names none", async () => {
		const s = stripe([], { currency: "GBP" });
		await s.provider.charge(invoice({ currency: "" }));
		expect(s.fields(1).currency).toBe("gbp");
	});

	it("falls back to usd when nothing names a currency", async () => {
		const s = stripe();
		await s.provider.charge(invoice({ currency: "" }));
		expect(s.fields(1).currency).toBe("usd");
	});

	it("carries the billing period in the intent's metadata", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		expect(s.fields(1)["metadata[period_start]"]).toBe("2026-01-01");
		expect(s.fields(1)["metadata[period_end]"]).toBe("2026-02-01");
	});

	it("creates the intent unconfirmed", async () => {
		const s = stripe();
		await s.provider.charge(invoice());
		expect(s.fields(1).confirm).toBe("false");
	});

	it("reports a created intent as pending, not paid", async () => {
		const s = stripe([{ body: { id: "cus_1" } }, { body: { id: "pi_1" } }]);
		const result = await s.provider.charge(invoice());
		expect(result.status).toBe("pending");
		expect(result.externalId).toBe("pi_1");
	});

	it("returns a failure as data rather than throwing", async () => {
		const s = stripe([
			{ body: { id: "cus_1" } },
			{ status: 402, body: { error: { code: "card_declined" } } },
		]);
		const result = await s.provider.charge(invoice());
		expect(result.status).toBe("failed");
		expect(result.message).toContain("402");
		expect(JSON.stringify(result.raw)).toContain("card_declined");
	});

	it("keeps the raw provider response on success too", async () => {
		const s = stripe([{ body: { id: "cus_1" } }, { body: { id: "pi_1" } }]);
		expect((await s.provider.charge(invoice())).raw).toMatchObject({
			id: "pi_1",
		});
	});

	it("survives a response body that is not JSON", async () => {
		const fetchImpl = (async () =>
			({
				ok: true,
				status: 200,
				json: async () => {
					throw new Error("not json");
				},
			}) as Response) as typeof fetch;
		const provider = createStripeBillingProvider({
			secretKey: "sk",
			fetchImpl,
		});
		await expect(provider.charge(invoice())).resolves.toHaveProperty("status");
	});
});

describe("exportInvoiceStripeLines", () => {
	it("lowercases the invoice currency", () => {
		expect(
			exportInvoiceStripeLines(invoice({ currency: "USD" })).currency,
		).toBe("usd");
	});

	it("carries the tenant as customer metadata", () => {
		expect(
			exportInvoiceStripeLines(invoice()).customer_metadata.tenant_id,
		).toBe("t1");
	});

	it("emits one line per invoice line", () => {
		const exported = exportInvoiceStripeLines(
			invoice({ lines: [line(), line({ eventType: "egress" })] }),
		);
		expect(exported.lines).toHaveLength(2);
	});

	it("describes a line by its event type and quantity", () => {
		expect(exportInvoiceStripeLines(invoice()).lines[0]?.description).toBe(
			"request x 10",
		);
	});

	it("keeps the line amount as-is", () => {
		expect(exportInvoiceStripeLines(invoice()).lines[0]?.amount).toBe(30);
	});

	it("lowercases a per-line currency independently of the invoice", () => {
		const exported = exportInvoiceStripeLines(
			invoice({ lines: [line({ currency: "EUR" })] }),
		);
		expect(exported.lines[0]?.currency).toBe("eur");
	});

	it("carries the unit price and period as metadata strings", () => {
		const metadata = exportInvoiceStripeLines(invoice()).lines[0]?.metadata;
		expect(metadata).toMatchObject({
			event_type: "request",
			quantity: "10",
			unit_price: "3",
			period_start: "2026-01-01",
		});
	});

	it("exports an invoice with no lines rather than refusing it", () => {
		expect(
			exportInvoiceStripeLines(invoice({ lines: [], total: 0 })).lines,
		).toEqual([]);
	});
});

function memoryLedger() {
	const rows: Invoice[] = [];
	return {
		path: ":memory:",
		append: (inv: Invoice) => {
			rows.push(inv);
		},
		list: (tenantId?: string) =>
			tenantId ? rows.filter((r) => r.tenantId === tenantId) : [...rows],
		get: (invoiceId: string) =>
			rows.find((r) => r.invoiceId === invoiceId) ?? null,
	};
}
