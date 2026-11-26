import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createBillingAggregator } from "../../src/metering/billing-aggregator.js";
import { createStripeBillingProvider } from "../../src/metering/billing-provider.js";
import { createPactFetch, requirePact } from "../helpers/pact-fetch.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

describe("StripeBillingApi consumer contract", () => {
	it("charges closed invoice through pact mock", async () => {
		const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
		const pact = requirePact(pacts, "StripeBillingApi");
		const fetchImpl = createPactFetch(pact);

		const stripe = createStripeBillingProvider({
			secretKey: "sk_test_pact",
			apiBase: "https://api.stripe.com/v1",
			fetchImpl,
		});
		const billing = createBillingAggregator({ billingProvider: stripe });
		await billing.emit({
			tenantId: parseTenantId("acme"),
			eventType: "tunnel.heartbeat",
			resource: "j1",
			quantity: 10,
			unit: "tick",
			timestamp: "2026-07-15T12:00:00.000Z",
		});
		const { invoice, charge } = await billing.closeAndCharge({
			tenantId: parseTenantId("acme"),
			periodStart: "2026-07-01",
			periodEnd: "2026-07-31",
		});
		expect(invoice.total).toBe(10);
		expect(charge?.status).toBe("pending");
		expect(charge?.externalId).toBe("pi_pact_1");
	});
});
