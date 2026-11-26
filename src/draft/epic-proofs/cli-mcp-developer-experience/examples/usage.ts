/**
 * Runnable example for cli-mcp-developer-experience. The draft-artifact gate EXECUTES this
 * with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Runs the same mocked reference simulation the cucumber steps drive
 * (services/cli-mcp-reference.ts): CLI/MCP command parity, the deterministic
 * local-to-Camp loop, SVID-scoped MCP calls failing closed, and the operator paths.
 */
import { strict as assert } from "node:assert";

import { runCliMcpDeveloperExperienceReference } from "../services/cli-mcp-reference.ts";

const result = await runCliMcpDeveloperExperienceReference();

// 1) CLI and MCP expose the same command surface — parity is checked, not assumed.
assert.equal(result.commandSurface.parity.ok, true);
assert.deepEqual(result.commandSurface.missingRequiredCommands, []);
console.log(
	`command surface parity ok=${result.commandSurface.parity.ok} missing=${result.commandSurface.missingRequiredCommands.length}`,
);

// 2) App developer: deterministic local dev loop, then a mocked Camp deploy.
const app = result.scenarios.appDeveloper;
assert.equal(app.deterministicSnapshot.dev.replayDiff.status, "unchanged");
assert.equal(app.deterministicSnapshot.up.status, "deployed");
assert.deepEqual(app.deterministicSnapshot.cloudSpecificCodeMatches, []);
console.log(
	`app dev loop replayDiff=${app.deterministicSnapshot.dev.replayDiff.status} deploy=${app.deterministicSnapshot.up.status} cloudSpecificMatches=${app.deterministicSnapshot.cloudSpecificCodeMatches.length}`,
);

// 3) MCP: a scoped plan succeeds; an unscoped deploy fails closed.
const mcp = result.scenarios.mcp;
assert.equal(mcp.plan.ok, true);
assert.equal(mcp.deniedDeploy.ok, false);
assert.equal(mcp.deniedDeploy.error.code, "MCP_SCOPE_DENIED");
console.log(
	`mcp plan ok=${mcp.plan.ok}; unscoped deploy denied code=${mcp.deniedDeploy.error.code}`,
);

// 4) Credential broker rejects static keys and denies revoked identities.
const credentials = result.scenarios.credentials;
assert.equal(credentials.staticKey.status, "rejected");
assert.equal(credentials.deniedAfterRevoke.status, "denied");
console.log(
	`credentials staticKey=${credentials.staticKey.status} afterRevoke=${credentials.deniedAfterRevoke.status}`,
);

// 5) Operator paths: read-only GitOps preview, SecOps denial replay, SRE drift, canary.
const scenarios = result.scenarios;
assert.equal(scenarios.gitops.readOnlyPlan, true);
assert.equal(scenarios.secops.decision.effect, "deny");
assert.equal(scenarios.secops.replay.effect, "deny");
assert.equal(scenarios.sre.replay.drift.detected, true);
assert.equal(scenarios.canary.status.state, "promoted");
assert.equal(scenarios.canaryRollback.status.state, "rolled-back");
console.log(
	`operators gitopsReadOnly=${scenarios.gitops.readOnlyPlan} secops=${scenarios.secops.decision.effect}/replay=${scenarios.secops.replay.effect} sreDrift=${scenarios.sre.replay.drift.detected}`,
);
console.log(
	`canary healthy=${scenarios.canary.status.state} regressing=${scenarios.canaryRollback.status.state}`,
);

// 6) The whole run stays mocked — zero live external calls.
assert.equal(result.workspace.mockedOnly, true);
assert.equal(result.workspace.liveExternalCalls, 0);
console.log(
	`workspace mockedOnly=${result.workspace.mockedOnly} liveExternalCalls=${result.workspace.liveExternalCalls}`,
);

console.log(
	"EPIC HELD: CLI/MCP parity, fail-closed scopes, and mocked operator journeys are deterministic",
);
