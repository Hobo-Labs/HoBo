import type { JsonValue } from "../src/json.js";

export function sloFixture() {
	return {
		schema: "hobo.slo/v1",
		apiVersion: "openslo/v1",
		kind: "SLO",
		metadata: {
			name: "availability",
			labels: { service: "checkout", team: "shop" },
		},
		spec: {
			service: "checkout",
			indicator: {
				ratioMetric: {
					counter: true,
					good: { telemetry: { query: "requests_success", unit: "requests" } },
					total: { telemetry: { query: "requests_total", unit: "requests" } },
				},
			},
			timeWindow: { duration: "30d", isRolling: true },
			budgetingMethod: "Occurrences",
			objectives: [{ displayName: "availability", target: 0.99 }],
			burnRateThresholds: [
				{
					name: "fast",
					threshold: 14.4,
					lookbackWindow: "1h",
					samplingInterval: "5m",
				},
			],
		},
	} satisfies JsonValue;
}
