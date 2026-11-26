/**
 * Runnable example for alertmanager-routing-contract. The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-281: alert routing groups related SLO burns into one delivery, silences
 * suppress paging with a replayable explanation, inhibition mutes dependents while the
 * root cause fires, and receiver failure schedules a durable retry. Fixed clock.
 */
import { strict as assert } from "node:assert";

import {
	ALERT_ROUTING_CONTRACT_VERSION,
	evaluateAlertRouting,
	replayAlertEvents,
} from "../src/alertmanager-routing.ts";
import { type JsonObject } from "../src/json.js";


const NOW = "2026-06-26T06:45:00.000Z";

const basePolicy = () => ({
	groupBy: ["sloName"],
	dedupWindow: "5m",
	routes: [
		{ id: "slo-pages", matcher: { kind: "slo" }, receiverId: "pagerduty" },
		{ id: "health-pages", matcher: { kind: "health" }, receiverId: "pagerduty" },
	],
});

const sloBurn = (id: string, overrides: JsonObject = {}) => ({
	id,
	kind: "slo",
	type: "slo.BudgetBurned",
	status: "firing",
	startsAt: NOW,
	labels: {
		sloName: "checkout-api",
		severity: "page",
		// SAFETY: `window: (overrides.window as string) ?? "fast-burn",` is required at this I/O or test boundary.
		window: (overrides.window as string) ?? "fast-burn",
	},
	// SAFETY: `metric: { burnRate: (overrides.burnRate as number) ?? 10, remainingBudgetRatio: ` is required at this I/O or test boundary.
	metric: { burnRate: (overrides.burnRate as number) ?? 10, remainingBudgetRatio: 0.1 },
});

const recordingReceiver = (receiverId: string) => ({
	send: (delivery: { groupKey: string }) => ({
		ok: true,
		receiverId,
		providerMessageId: `${receiverId}:${delivery.groupKey}`,
	}),
});

// 1) Two related SLO burns group into ONE receiver notification.
const grouped = evaluateAlertRouting({
	now: NOW,
	signals: [
		sloBurn("checkout-fast", { burnRate: 16.2 }),
		sloBurn("checkout-slow", { burnRate: 2.5, window: "slow-burn" }),
	],
	policy: basePolicy(),
	receivers: { pagerduty: recordingReceiver("pagerduty") },
});
assert.equal(grouped.schemaVersion, ALERT_ROUTING_CONTRACT_VERSION);
assert.equal(grouped.deliveries.length, 1);
assert.equal(grouped.deliveries[0].alertFingerprints.length, 2);
const groupEvent = grouped.events.find((event: { type: string }) => event.type === "alert.Grouped");
assert.equal(groupEvent.data.groupKey, "sloName=checkout-api");
console.log(`schema: ${grouped.schemaVersion}`);
console.log(
	`grouping: deliveries=${grouped.deliveries.length} alerts=${grouped.deliveries[0].alertFingerprints.length} groupKey=${groupEvent.data.groupKey}`,
);
console.log(`events: ${grouped.events.map((event: { type: string }) => event.type).join(" -> ")}`);

// 2) An active silence suppresses paging; replay explains WHY no page fired.
const silenced = evaluateAlertRouting({
	now: NOW,
	signals: [sloBurn("checkout-fast", { burnRate: 16.2 })],
	policy: {
		...basePolicy(),
		silences: [
			{
				id: "silence-maintenance",
				matcher: { sloName: "checkout-api" },
				startsAt: "2026-06-26T06:00:00.000Z",
				endsAt: "2026-06-26T07:00:00.000Z",
			},
		],
	},
	receivers: { pagerduty: recordingReceiver("pagerduty") },
});
assert.equal(silenced.deliveries.length, 0);
const silencedExplanation = replayAlertEvents(silenced.events).explanations[
	silenced.events[0].data.fingerprint
];
assert.equal(silencedExplanation.status, "silenced");
assert.equal(silencedExplanation.reason, "silence-maintenance");
console.log(
	`silence: deliveries=${silenced.deliveries.length} replay status=${silencedExplanation.status} reason=${silencedExplanation.reason}`,
);

// 3) Inhibition: a critical root cause mutes the dependent warning in the same tenant.
const inhibited = evaluateAlertRouting({
	now: NOW,
	signals: [
		{
			id: "gateway-down",
			kind: "health",
			type: "health.Degraded",
			status: "firing",
			startsAt: NOW,
			labels: { service: "gateway", severity: "critical", tenant: "tenant-a" },
			metric: {},
		},
		{
			id: "checkout-burn",
			kind: "slo",
			type: "health.Degraded",
			status: "firing",
			startsAt: NOW,
			labels: { service: "checkout-api", severity: "warning", tenant: "tenant-a" },
			metric: {},
		},
	],
	policy: {
		...basePolicy(),
		groupBy: ["tenant"],
		inhibitions: [
			{
				id: "root-cause-critical-suppresses-warning",
				sourceMatcher: { severity: "critical" },
				targetMatcher: { severity: "warning" },
				equal: ["tenant"],
			},
		],
	},
	receivers: { pagerduty: recordingReceiver("pagerduty") },
});
assert.deepEqual(
	inhibited.deliveries.map((delivery: { alertFingerprints: string[] }) => delivery.alertFingerprints.length),
	[1],
);
// SAFETY: `const inhibitedEntry = Object.values(replayAlertEvents(inhibited.events).explana` is required at this I/O or test boundary.
const inhibitedEntry = Object.values(replayAlertEvents(inhibited.events).explanations).find(
	(entry: { status: string }) => entry.status === "inhibited",
) as { status: string; reason: string };
assert.equal(inhibitedEntry.reason, "root-cause-critical-suppresses-warning");
console.log(
	`inhibition: delivered=${inhibited.deliveries[0].alertFingerprints.length} muted reason=${inhibitedEntry.reason}`,
);

// 4) Receiver failure keeps the alert and schedules a durable retry.
const failed = evaluateAlertRouting({
	now: NOW,
	signals: [sloBurn("checkout-fast", { burnRate: 16.2 })],
	policy: basePolicy(),
	receivers: {
		pagerduty: { send: () => ({ ok: false, receiverId: "pagerduty", retryAfter: "30s", error: "provider-down" }) },
	},
});
assert.equal(failed.deliveries.length, 0);
assert.equal(failed.pendingDeliveries.length, 1);
const routedEvent = failed.events.find((event: { type: string }) => event.type === "alert.Routed");
assert.equal(routedEvent.data.status, "retry-scheduled");
assert.equal(replayAlertEvents(failed.events).pendingDeliveries.length, 1);
console.log(
	`receiver failure: pending=${failed.pendingDeliveries.length} routed status=${routedEvent.data.status}`,
);

console.log("CONTRACT HELD: group, silence, inhibit, and retry — all replayable from events");
