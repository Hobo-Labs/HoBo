import { strict as assert } from "node:assert";

import {
	createMockBoundaryHarness,
	runDenyCeilingBypassSimulation,
	runFailClosedSimulation,
	runGovernedDeploySimulation,
	validateBoundaryCoverage,
} from "../services/reference-architecture.ts";

const harness = createMockBoundaryHarness();
assert.deepEqual(harness.networkCalls, []);
const governed = await runGovernedDeploySimulation(harness);
assert.equal(governed.gatekeeper.deployable, true);
assert.equal(governed.gatekeeper.status, "deployable");
assert.equal(governed.policyDecision.effect, "require-approval");
assert.deepEqual(governed.obligationGate.reasons, []);
assert.equal(governed.conformanceReplay.matchesRecordedDecision, true);
console.log(
	`governed deploy status=${governed.gatekeeper.status} policy=${governed.policyDecision.effect} replayMatches=${governed.conformanceReplay.matchesRecordedDecision}`,
);

const coverage = validateBoundaryCoverage(governed.boundaryDecisions);
assert.deepEqual(coverage, { ok: true, missing: [], extra: [] });
assert.deepEqual(harness.networkCalls, []);
console.log(
	`boundary coverage ok=${coverage.ok} missing=${coverage.missing.length} extra=${coverage.extra.length} liveCalls=${harness.networkCalls.length}`,
);

const denyCeiling = await runDenyCeilingBypassSimulation(
	createMockBoundaryHarness(),
);
assert.equal(denyCeiling.gatekeeper.deployable, false);
assert.equal(denyCeiling.gatekeeper.status, "blocked");
assert.equal(denyCeiling.denyCeiling.ok, false);
assert.match(
	denyCeiling.gatekeeper.failures
		.map((failure: { reason: string }) => failure.reason)
		.join("\n"),
	/mandatory deny-ceiling forbids disabling contracts/,
);
console.log(
	`deny-ceiling bypass status=${denyCeiling.gatekeeper.status} bypassFlagged=${!denyCeiling.denyCeiling.ok}`,
);

const failClosed = await runFailClosedSimulation(
	createMockBoundaryHarness({ policyProviderMode: "unavailable" }),
);
assert.equal(failClosed.gatekeeper.deployable, false);
assert.equal(failClosed.failClosedDecision.effect, "deny");
assert.equal(failClosed.failClosedDecision.failClosed, true);
assert.match(failClosed.failClosedDecision.reason, /policy evaluator unavailable/);
assert.equal(
	failClosed.boundaryDecisions["Gatekeeper to Policy Engine"].status,
	"mocked_provider_unavailable",
);
console.log(
	`policy outage effect=${failClosed.failClosedDecision.effect} failClosed=${failClosed.failClosedDecision.failClosed} boundary=${failClosed.boundaryDecisions["Gatekeeper to Policy Engine"].status}`,
);

console.log(
	"EPIC HELD: governance gates are mandatory, evidence replays, and uncertainty denies",
);
