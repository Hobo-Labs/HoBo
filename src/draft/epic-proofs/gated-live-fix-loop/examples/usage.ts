import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
	replayGatedLiveFixLoop,
	runGatedLiveFixLoop,
} from "../services/gated-live-fix-loop.ts";

const fixture = JSON.parse(
	readFileSync(
		new URL(
			"../simulation/fixtures/gated-live-fix-loop-fixture.json",
			import.meta.url,
		),
		"utf8",
	),
);

assert.equal(fixture.incident.environment, "staging");
assert.equal(fixture.candidate.riskClass, "low");
const staging = runGatedLiveFixLoop(fixture);
assert.equal(staging.status, "rolled-back");
assert.equal(staging.applied, false);
assert.equal(staging.canaryGate.outcome, "regression");
console.log(
	`staging status=${staging.status} applied=${staging.applied} canaryGate=${staging.canaryGate.outcome}`,
);

assert.equal(staging.regressionTests[0].sourceTraceId, "trace-checkout-500");
assert.equal(staging.regressionTests[0].permanent, true);
const stagingEventTypes = staging.events.map(
	(event: { type: string }) => event.type,
);
assert.ok(stagingEventTypes.includes("deployment.CanaryStarted"));
assert.ok(stagingEventTypes.includes("deployment.RolledBack"));
assert.ok(stagingEventTypes.includes("livefix.RegressionTestRetained"));
console.log(
	`regression test source=${staging.regressionTests[0].sourceTraceId} permanent=${staging.regressionTests[0].permanent}`,
);

const stagingReplay = replayGatedLiveFixLoop(staging.events);
assert.equal(stagingReplay.status, "rolled-back");
assert.equal(
	stagingReplay.retainedRegressionTests[0].id,
	"regression:trace-checkout-500",
);
console.log(
	`replay status=${stagingReplay.status} retained=${stagingReplay.retainedRegressionTests[0].id}`,
);

const prodScenario = {
	...fixture,
	incident: { ...fixture.incident, environment: "prod" },
	canaryObservation: {
		snapshot: {
			sloId: "checkout-availability",
			seq: 26,
			status: "available",
			burnRate: 0.3,
			remainingBudgetRatio: 0.85,
		},
		windowSamples: [
			{
				seq: 25,
				status: "available",
				burnRate: 0.4,
				remainingBudgetRatio: 0.84,
			},
			{
				seq: 26,
				status: "available",
				burnRate: 0.3,
				remainingBudgetRatio: 0.85,
			},
		],
		goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
	},
};
const prod = runGatedLiveFixLoop(prodScenario);
assert.equal(prod.status, "needs-approval");
assert.equal(prod.needsApproval, true);
assert.equal(prod.approvalRequest.reason, "production-or-high-risk-live-fix");
assert.ok(
	!prod.events.some(
		(event: { type: string }) => event.type === "deployment.CanaryStarted",
	),
);
assert.equal(prod.regressionTests[0].permanent, true);
const prodReplay = replayGatedLiveFixLoop(prod.events);
assert.equal(prodReplay.needsApproval, true);
assert.equal(prodReplay.policyEffect, "require-approval");
console.log(
	`prod status=${prod.status} approvalReason=${prod.approvalRequest.reason} canaryStarted=false`,
);
console.log(
	`prod replay needsApproval=${prodReplay.needsApproval} policy=${prodReplay.policyEffect}`,
);

console.log(
	"EPIC HELD: canary regressions auto-roll back with permanent regression tests; prod fixes gate on humans",
);
