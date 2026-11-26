/**
 * Runnable example for autonomous-drift-remediation-contract. The draft-artifact
 * gate EXECUTES this with `node --import tsx` and diffs stdout against
 * usage.expected.txt — keep both honest.
 *
 * Proves the drift-remediation decision surface: a heal-mode resource auto-resyncs
 * through the gated canary path, a propose-mode prod resource opens a gated diff
 * without writing, ignore-mode records the drift and does nothing, and replay of
 * the emitted events reproduces the terminal status deterministically.
 */
import { strict as assert } from "node:assert";

import {
	handleResourceDrift,
	replayDriftRemediation,
} from "../src/autonomous-drift-remediation.ts";

function driftSignal(resourceId: string, id: string, environment = "staging") {
	return {
		id,
		type: "resource.DriftDetected",
		resourceId,
		environment,
		occurredAt: "2026-06-27T19:19:00.000Z",
		correlationId: `corr-${resourceId}`,
		desiredSetRef: "set:desired@sha256-good",
		observedRef: "provider:observed@sha256-drifted",
	};
}

function recordingGateway(routeId: string) {
	return {
		state: {
			routeId,
			activeVersion: "desired-set@previous",
			split: { "desired-set@previous": 100, "desired-set@resync": 0 },
		},
		async apply(command: {
			kind: string;
			routeId: string;
			fromVersion: string;
			toVersion: string;
			toWeight: number;
		}) {
			if (command.kind === "gateway.shiftTraffic") {
				this.state = {
					routeId: command.routeId,
					activeVersion:
						command.toWeight === 100 ? command.toVersion : command.fromVersion,
					split: {
						[command.fromVersion]: 100 - command.toWeight,
						[command.toVersion]: command.toWeight,
					},
				};
				return { status: "applied", state: this.state };
			}
			return { status: "applied", state: this.state };
		},
	};
}

// 1) heal mode: auto-resync rides the gated canary and applies.
const healed = await handleResourceDrift({
	drift: driftSignal("api", "drift-api-1"),
	policies: { api: { mode: "heal", environment: "staging", estimatedImpact: "medium" } },
	decidedAt: "2026-06-27T19:20:00.000Z",
	gateway: recordingGateway("api"),
	gateSignal: () => ({ decision: "pass", reason: "healthy" }),
});
assert.equal(healed.status, "applied");
assert.equal(healed.action.kind, "resync");
console.log(`heal: status=${healed.status} class=${healed.classification.failureClass} drift=${healed.events.drift[0].type}`);

// 2) propose mode in prod: gated diff, no write.
const proposed = await handleResourceDrift({
	drift: driftSignal("billing-db", "drift-billing-1", "prod"),
	policies: { "billing-db": { mode: "propose", environment: "prod" } },
	decidedAt: "2026-06-27T19:21:00.000Z",
});
assert.equal(proposed.status, "proposed");
assert.equal(proposed.events.rollout.length, 0);
console.log(`propose: status=${proposed.status} drift=${proposed.events.drift[0].type} crew=${proposed.events.crew.map((e: { type: string }) => e.type).join(",")}`);

// 3) ignore mode: recorded, zero write actions.
const ignored = await handleResourceDrift({
	drift: driftSignal("legacy-cache", "drift-cache-1"),
	policies: { "legacy-cache": { mode: "ignore", reason: "adopted detect-only resource" } },
	decidedAt: "2026-06-27T19:22:00.000Z",
});
assert.equal(ignored.status, "ignored");
assert.equal(ignored.events.crew.length, 0);
console.log(`ignore: status=${ignored.status} drift=${ignored.events.drift[0].type}`);

// 4) Replay of each event log reproduces the terminal status.
for (const [name, result] of [
	["heal", healed],
	["propose", proposed],
	["ignore", ignored],
] as const) {
	const replayed = replayDriftRemediation(result.events);
	assert.equal(replayed.status, result.status);
	console.log(`replay(${name}): status=${replayed.status} resource=${replayed.resourceId}`);
}

console.log("CONTRACT HELD: heal auto-resyncs gated, propose never writes, ignore records, replay agrees");
