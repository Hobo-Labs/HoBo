/**
 * Pure in-process policy (rego-lite / tag-acl) and billing aggregator tests.
 * HTTP OPA and Stripe boundaries are covered by PACT consumer tests.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMeteringBus, parseTenantId } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";

import {
	createBillingAggregator,
	invoiceToUsageEvents,
} from "../../src/metering/billing-aggregator.js";
import {
	createFileInvoiceLedger,
	createLedgerBillingProvider,
	exportInvoiceStripeLines,
} from "../../src/metering/billing-provider.js";
import { createInMemoryMeteringSink } from "../../src/metering/sinks.js";
import {
	createOpaPolicyEngine,
	SAMPLE_HOBO_AUTHZ_REGO,
} from "../../src/policy/opa-engine.js";
import {
	evaluateRegoLite,
	HOBO_DEFAULT_POLICY_DOCUMENT,
	parseRegoLiteDocument,
} from "../../src/policy/rego-lite.js";
import { createTagAclPolicyEngine } from "../../src/policy/tag-acl-engine.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

describe("tag ACL policy (pure)", () => {
	it("denies cross-tenant and meters evaluations", async () => {
		const sink = createInMemoryMeteringSink();
		const bus = createMeteringBus([sink]);
		const engine = createTagAclPolicyEngine({ metering: bus });
		const allow = await engine.evaluate({
			subject: {
				identity: "j1",
				tenantId: parseTenantId("acme"),
				tags: ["role:junction", "env:development"],
			},
			action: "junction.join",
			resource: {
				kind: "junction",
				id: "j1",
				tenantId: parseTenantId("acme"),
				tags: ["env:development"],
			},
		});
		expect(allow.effect).toBe("allow");

		const deny = await engine.evaluate({
			subject: {
				identity: "j1",
				tenantId: parseTenantId("acme"),
				tags: ["role:junction", "env:development"],
			},
			action: "name.resolve",
			resource: {
				kind: "endpoint",
				id: "web",
				tenantId: parseTenantId("other"),
				tags: ["env:development"],
			},
		});
		expect(deny.effect).toBe("deny");
		expect(sink.events.some((e) => e.eventType === "policy.evaluate")).toBe(
			true,
		);
	});
});

describe("rego-lite + OPA local fallback (pure)", () => {
	it("evaluates structured allow/deny rules without HTTP", async () => {
		const doc = parseRegoLiteDocument({
			default: "deny",
			rules: [
				{
					effect: "allow",
					when: { sameTenant: true, subjectTagsAny: ["role:junction"] },
					reason: "junction same tenant",
				},
			],
		});
		const allow = evaluateRegoLite(doc, {
			subject: {
				identity: "j1",
				tenantId: parseTenantId("acme"),
				tags: ["role:junction"],
			},
			action: "junction.join",
			resource: {
				kind: "junction",
				id: "j1",
				tenantId: parseTenantId("acme"),
			},
		});
		expect(allow.effect).toBe("allow");

		const engine = createOpaPolicyEngine({
			policyDocument: HOBO_DEFAULT_POLICY_DOCUMENT,
		});
		const deny = await engine.evaluate({
			subject: {
				identity: "x",
				tenantId: parseTenantId("a"),
				tags: [],
			},
			action: "read",
			resource: {
				kind: "x",
				id: "1",
				tenantId: parseTenantId("b"),
			},
		});
		expect(deny.effect).toBe("deny");
		expect(SAMPLE_HOBO_AUTHZ_REGO).toContain("package hobo.authz");
	});

	it("falls back to rego-like tenant isolation when no opaUrl", async () => {
		const engine = createOpaPolicyEngine({});
		const deny = await engine.evaluate({
			subject: {
				identity: "u",
				tenantId: parseTenantId("acme"),
				tags: [],
			},
			action: "read",
			resource: {
				kind: "x",
				id: "1",
				tenantId: parseTenantId("other"),
			},
		});
		expect(deny.effect).toBe("deny");
	});
});

describe("billing aggregator + durable ledger (pure)", () => {
	it("aggregates usage into period invoices", async () => {
		const billing = createBillingAggregator();
		const bus = createMeteringBus([billing]);
		await bus.emit({
			tenantId: parseTenantId("acme"),
			eventType: "tunnel.heartbeat",
			resource: "j1",
			quantity: 3,
			unit: "tick",
			timestamp: "2026-07-15T00:00:00.000Z",
		});
		await bus.emit({
			tenantId: parseTenantId("acme"),
			eventType: "dns.record_upsert",
			resource: "web",
			quantity: 2,
			unit: "count",
			timestamp: "2026-07-15T00:00:00.000Z",
		});
		const invoice = billing.closePeriod({
			tenantId: parseTenantId("acme"),
			periodStart: "2026-07-01",
			periodEnd: "2026-07-31",
		});
		expect(invoice.lines.length).toBeGreaterThan(0);
		expect(invoice.total).toBe(3 * 1 + 2 * 3);
		const events = invoiceToUsageEvents(invoice);
		expect(events.some((e) => e.eventType === "billing.period_close")).toBe(
			true,
		);
		expect(billing.listInvoices("acme")).toHaveLength(1);
	});

	it("records invoices on ledger and exports stripe-shaped lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-bill-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const ledger = createFileInvoiceLedger(dir);
		const provider = createLedgerBillingProvider({ ledger });
		const billing = createBillingAggregator({
			billingProvider: provider,
		});
		await billing.emit({
			tenantId: parseTenantId("acme"),
			eventType: "tunnel.heartbeat",
			resource: "j1",
			quantity: 10,
			unit: "tick",
			timestamp: "2026-07-15T00:00:00.000Z",
		});
		const { invoice, charge } = await billing.closeAndCharge({
			tenantId: parseTenantId("acme"),
			periodStart: "2026-07-01",
			periodEnd: "2026-07-31",
		});
		expect(invoice.total).toBe(10);
		expect(charge?.status).toBe("recorded");
		expect(ledger.list("acme")).toHaveLength(1);
		expect(exportInvoiceStripeLines(invoice).lines[0]?.amount).toBe(10);

		// Period filter: old event excluded from close window.
		const billing2 = createBillingAggregator();
		await billing2.emit({
			tenantId: parseTenantId("acme"),
			eventType: "tunnel.heartbeat",
			resource: "j1",
			quantity: 5,
			unit: "tick",
			timestamp: "2020-01-01T00:00:00.000Z",
		});
		const empty = billing2.closePeriod({
			tenantId: parseTenantId("acme"),
			periodStart: "2026-07-01",
			periodEnd: "2026-07-31",
		});
		expect(empty.total).toBe(0);
	});
});
