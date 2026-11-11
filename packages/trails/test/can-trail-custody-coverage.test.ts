// can-trail and custody coverage. A verdict judges the path it was given; when
// a trail names the migration pattern a step realizes, the verdict's path has
// to name every place that pattern puts data, or the trail is denied. The gate
// stays a conjunction and fails closed.
import assert from "node:assert/strict";
import {
	CUSTODY_ROLES,
	evaluateCustodyPath,
	parseCustodyPath,
	policyVerdictToJson,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import {
	type CanTrailPolicyVerdict,
	type CanTrailResult,
	evaluateCanTrail,
} from "../src/can-trail.js";
import { defineTrail, type TrailDataPattern } from "../src/definition.js";

const NOW = "2026-11-10T00:00:00.000Z";
const LATER = "2026-11-17T00:00:00.000Z";

function trail(pattern?: TrailDataPattern) {
	return defineTrail({
		id: "app.orders.move",
		version: "2026.11.10.1",
		targets: ["silo-b"],
		steps: [
			{
				id: "data-dual",
				kind: "continuous-dual-data",
				data: {
					mode: "cdc-dual",
					transformId: "orders.replicate",
					checksum: `sha256:${"c".repeat(64)}`,
					...(pattern === undefined ? undefined : { pattern }),
				},
			},
		],
	});
}

/** A verdict over a path that names exactly these roles. */
function verdictOver(roles: readonly string[]) {
	return evaluateCustodyPath({
		path: parseCustodyPath({
			points: roles.map((role) => ({
				id: role,
				role,
				region: "eu-west-1",
				protections: [],
				...(role === "source" || role === "target" || role === "event-log"
					? undefined
					: { retainUntil: LATER }),
			})),
		}),
		policy: { classification: "public" },
		now: NOW,
	});
}

function denial(result: CanTrailResult): string {
	return (
		result.reasons.find((reason) => reason.code === "policy-denied")?.message ??
		""
	);
}

describe("can-trail denies a custody path that does not cover the named pattern", () => {
	test("a positive verdict over source and target alone is denied for snapshot-and-tail, naming the roles never judged", () => {
		const verdict = verdictOver(["source", "target"]);
		assert.equal(verdict.ok, true);
		const result = evaluateCanTrail({
			trail: trail("snapshot-and-tail"),
			policyVerdict: verdict,
		});
		assert.equal(result.ok, false);
		assert.match(denial(result), /does not cover snapshot-and-tail/u);
		for (const role of ["relay", "capture-log", "retiring-source"]) {
			assert.match(denial(result), new RegExp(role, "u"));
		}
	});

	test("the same verdict over every role passes, and one role short does not", () => {
		const full = evaluateCanTrail({
			trail: trail("snapshot-and-tail"),
			policyVerdict: verdictOver(CUSTODY_ROLES),
		});
		assert.equal(full.ok, true, denial(full));
		const short = evaluateCanTrail({
			trail: trail("snapshot-and-tail"),
			policyVerdict: verdictOver(
				CUSTODY_ROLES.filter((role) => role !== "retiring-source"),
			),
		});
		assert.equal(short.ok, false);
		assert.match(denial(short), /retiring-source/u);
	});

	test("each pattern asks for its own roles: an in-place step needs the rollback snapshot, not a relay", () => {
		const result = evaluateCanTrail({
			trail: trail("in-place-evolve"),
			policyVerdict: verdictOver(["source", "target", "rollback-snapshot"]),
		});
		assert.equal(result.ok, true, denial(result));
		const missing = evaluateCanTrail({
			trail: trail("in-place-evolve"),
			policyVerdict: verdictOver(["source", "target"]),
		});
		assert.match(denial(missing), /rollback-snapshot/u);
	});

	test("a verdict with no roles member names none, so it covers no named pattern", () => {
		const { roles: _roles, ...legacy } = policyVerdictToJson(
			verdictOver(CUSTODY_ROLES),
		);
		const result = evaluateCanTrail({
			trail: trail("offline-copy"),
			// SAFETY: a verdict as recorded before `roles` existed, arriving as JSON evidence.
			policyVerdict: legacy as CanTrailPolicyVerdict,
		});
		assert.equal(result.ok, false);
		assert.match(denial(result), /does not cover offline-copy/u);
	});

	test("a roles member that is not a list of role names is a malformed verdict: denied, never thrown, never passed", () => {
		for (const roles of ["source", [1, 2], [""], { source: true }, null]) {
			const result = evaluateCanTrail({
				trail: trail(),
				// SAFETY: deliberately not the declared record — evidence that crossed a process boundary.
				policyVerdict: JSON.parse(
					JSON.stringify({
						ok: true,
						findings: [],
						custodyDigest: `sha256:${"a".repeat(64)}`,
						roles,
					}),
				) as CanTrailPolicyVerdict,
			});
			assert.equal(result.ok, false, JSON.stringify(roles));
			assert.match(denial(result), /malformed.*roles/u);
		}
	});

	test("coverage is one more conjunct: it cannot lift a denial, and a trail that names no pattern is judged as before", () => {
		const covered = verdictOver(CUSTODY_ROLES);
		const denied = evaluateCanTrail({
			trail: trail("snapshot-and-tail"),
			policyAllows: false,
			policyVerdict: covered,
		});
		assert.equal(denied.ok, false);
		assert.match(denial(denied), /policy pack denies this trail/u);
		// No pattern named: there is nothing to derive roles from.
		const unnamed = evaluateCanTrail({
			trail: trail(),
			policyVerdict: verdictOver(["source", "target"]),
		});
		assert.equal(unnamed.ok, true, denial(unnamed));
		// No verdict supplied: no path to be incomplete.
		assert.equal(
			evaluateCanTrail({ trail: trail("snapshot-and-tail") }).ok,
			true,
		);
	});
});
