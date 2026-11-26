import { bench, describe } from "vitest";

import { evaluateAlertRouting, replayAlertEvents } from "../src/alertmanager-routing.ts";

const NOW = "2026-06-26T06:45:00.000Z";

const policy = {
	groupBy: ["sloName"],
	dedupWindow: "5m",
	routes: [{ id: "slo-pages", matcher: { kind: "slo" }, receiverId: "pagerduty" }],
};

const receivers = {
	pagerduty: {
		send: (delivery: { groupKey: string }) => ({
			ok: true,
			receiverId: "pagerduty",
			providerMessageId: `pagerduty:${delivery.groupKey}`,
		}),
	},
};

const stormSignals = Array.from({ length: 100 }, (_, index) => ({
	id: `checkout-${index}`,
	kind: "slo",
	type: "slo.BudgetBurned",
	status: "firing",
	startsAt: NOW,
	labels: { sloName: "checkout-api", severity: "page", window: "fast-burn" },
	metric: { burnRate: 20 + index, remainingBudgetRatio: 0.1 },
}));

const stormEvents = evaluateAlertRouting({ now: NOW, signals: stormSignals, policy, receivers }).events;

// Numbers are advisory; the gate only requires that declared benches EXECUTE.
describe("alert routing hot path", () => {
	bench("evaluateAlertRouting over a 100-signal storm", () => {
		evaluateAlertRouting({ now: NOW, signals: stormSignals, policy, receivers });
	});

	bench("replayAlertEvents over the storm's event log", () => {
		replayAlertEvents(stormEvents);
	});
});
