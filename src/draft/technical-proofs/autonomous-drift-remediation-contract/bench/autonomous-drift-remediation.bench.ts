/**
 * Vitest bench for the proof's measurable hot path: the full drift decision
 * (classify -> policy resolve -> action build -> event emission) for the
 * propose path, which allocates the complete event graph without a gateway.
 */
import { bench, describe } from "vitest";

import { handleResourceDrift } from "../src/autonomous-drift-remediation.ts";

const drift = {
	id: "drift-bench-1",
	type: "resource.DriftDetected",
	resourceId: "billing-db",
	environment: "prod",
	occurredAt: "2026-06-27T19:19:00.000Z",
	correlationId: "corr-billing-db",
	desiredSetRef: "set:desired@sha256-good",
	observedRef: "provider:observed@sha256-drifted",
};

describe("autonomous drift remediation", () => {
	bench("propose-path decision with full event graph", async () => {
		await handleResourceDrift({
			drift,
			policies: { "billing-db": { mode: "propose", environment: "prod" } },
			decidedAt: "2026-06-27T19:21:00.000Z",
		});
	});
});
