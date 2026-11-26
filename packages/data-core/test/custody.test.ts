// The policy verdict is computed over every place data rests or passes. These
// tests are the "compliant at both ends, non-compliant in the middle" cases.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	CUSTODY_ROLES,
	type CustodyMigration,
	type CustodyPolicy,
	custodyPathDigest,
	evaluateCustodyPath,
	type JsonObject,
	MIGRATION_PATTERNS,
	type MigrationPatternId,
	parseCustodyPath,
	policyVerdictToJson,
	requiredCustodyRoles,
	uncoveredCustodyRoles,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";
const LATER = "2026-11-17T00:00:00.000Z";
const FULL = [
	"encryptedAtRest",
	"encryptedInTransit",
	"accessScoped",
	"auditLogged",
];

const EU_PII: CustodyPolicy = {
	classification: "pii",
	residency: { classifications: ["pii"], allowedJurisdictions: ["eu"] },
};

function path(extra: JsonObject[] = []) {
	return parseCustodyPath({
		points: [
			{ id: "source", role: "source", region: "eu-west-1", protections: FULL },
			{
				id: "target",
				role: "target",
				region: "eu-central-1",
				protections: FULL,
			},
			...extra,
		],
	});
}

function codes(
	extra: JsonObject[],
	policy: CustodyPolicy = EU_PII,
	now = NOW,
): string[] {
	return evaluateCustodyPath({ path: path(extra), policy, now }).findings.map(
		(finding) => `${finding.code}@${finding.point}`,
	);
}

describe("evaluateCustodyPath", () => {
	test("EU source and EU target with full protections pass", () => {
		const verdict = evaluateCustodyPath({
			path: path(),
			policy: EU_PII,
			now: NOW,
		});
		assert.equal(verdict.ok, true);
		assert.deepEqual(verdict.findings, []);
		assert.equal(verdict.custodyDigest, custodyPathDigest(path()));
	});

	test("a relay in a denied region fails the plan even though both ends are allowed", () => {
		assert.deepEqual(
			codes([
				{
					id: "runner",
					role: "relay",
					region: "us-east-1",
					protections: FULL,
					retainUntil: LATER,
				},
			]),
			["CUSTODY_RESIDENCY_CONFLICT@runner"],
		);
	});

	test("a staging artifact in an unmapped region is a conflict, never a pass", () => {
		assert.deepEqual(
			codes([
				{
					id: "dump",
					role: "staging-artifact",
					region: "moon-base-1",
					protections: FULL,
					retainUntil: LATER,
				},
			]),
			["CUSTODY_REGION_UNMAPPED@dump"],
		);
	});

	test("a rollback snapshot with weaker protection is a downgrade", () => {
		assert.deepEqual(
			codes([
				{
					id: "snap",
					role: "rollback-snapshot",
					region: "eu-west-1",
					protections: ["encryptedAtRest"],
					retainUntil: LATER,
				},
			]),
			["CUSTODY_PROTECTION_DOWNGRADE@snap"],
		);
	});

	test("a plaintext target is not a legal home for classified data", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					{
						id: "source",
						role: "source",
						region: "eu-west-1",
						protections: FULL,
					},
					{
						id: "analytics",
						role: "target",
						region: "eu-west-1",
						protections: ["accessScoped"],
					},
				],
			}),
			policy: EU_PII,
			now: NOW,
		});
		assert.deepEqual(
			verdict.findings.map((finding) => finding.code),
			["CUSTODY_PROTECTION_DOWNGRADE"],
		);
		assert.match(verdict.findings[0]?.detail ?? "", /encryptedAtRest/u);
	});

	test("secret data additionally needs field-level keys at every point", () => {
		assert.deepEqual(codes([], { classification: "secret" }), [
			"CUSTODY_PROTECTION_DOWNGRADE@source",
			"CUSTODY_PROTECTION_DOWNGRADE@target",
		]);
	});

	test("a bounded copy with no deadline is a finding; a permanent home needs none", () => {
		assert.deepEqual(
			codes([
				{
					id: "log",
					role: "capture-log",
					region: "eu-west-1",
					protections: FULL,
				},
			]),
			["CUSTODY_RETENTION_UNBOUNDED@log"],
		);
	});

	test("the same path fails once a copy outlives its deadline: the verdict is re-evaluated, not cached", () => {
		const extra = [
			{
				id: "old",
				role: "retiring-source",
				region: "eu-west-1",
				protections: FULL,
				retainUntil: LATER,
			},
		];
		assert.deepEqual(codes(extra, EU_PII, NOW), []);
		assert.deepEqual(codes(extra, EU_PII, "2026-12-01T00:00:00.000Z"), [
			"CUSTODY_RETENTION_EXPIRED@old",
		]);
	});

	test("a residency rule scoped to another classification does not apply", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					{
						id: "source",
						role: "source",
						region: "eu-west-1",
						protections: [],
					},
					{
						id: "target",
						role: "target",
						region: "us-east-1",
						protections: [],
					},
				],
			}),
			policy: {
				classification: "public",
				residency: { classifications: ["pii"], allowedJurisdictions: ["eu"] },
			},
			now: NOW,
		});
		assert.equal(verdict.ok, true);
	});

	test("a path with no destination is not a path", () => {
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					{
						id: "source",
						role: "source",
						region: "eu-west-1",
						protections: FULL,
					},
				],
			}),
			policy: EU_PII,
			now: NOW,
		});
		assert.deepEqual(
			verdict.findings.map((finding) => finding.code),
			["CUSTODY_PATH_INCOMPLETE"],
		);
	});

	test("the parser refuses duplicate ids, unknown roles, and unknown protections", () => {
		const point = {
			id: "a",
			role: "source",
			region: "eu-west-1",
			protections: [],
		};
		assert.throws(
			() => parseCustodyPath({ points: [point, point] }),
			/duplicate/u,
		);
		assert.throws(
			() => parseCustodyPath({ points: [{ ...point, role: "warehouse" }] }),
			/role must be one of/u,
		);
		assert.throws(
			() => parseCustodyPath({ points: [{ ...point, protections: ["hope"] }] }),
			/protections entries/u,
		);
		assert.throws(
			() => parseCustodyPath({ points: [{ ...point, retainUntil: "soon" }] }),
			/RFC 3339/u,
		);
	});
});

// `Date.parse` reads an instant with no offset as local time, so the same
// path expired in Tokyo and passed in Los Angeles. Instants are read strictly;
// `instants-timezone.test.ts` runs the same cases under three real zones.
describe("custody instants are strict RFC 3339", () => {
	function relay(retainUntil: string): JsonObject {
		return {
			id: "runner",
			role: "relay",
			region: "eu-west-1",
			protections: FULL,
			retainUntil,
		};
	}

	test("a retention deadline without an offset is malformed", () => {
		for (const retainUntil of [
			"2026-11-10T05:00:00", // local time to Date.parse
			"2026-11-17",
			"2026-11-17T00:00:00+99:99",
			"Tue, 17 Nov 2026 00:00:00 GMT",
		]) {
			assert.throws(
				() => path([relay(retainUntil)]),
				/retainUntil must be an RFC 3339 instant with an explicit offset/u,
				retainUntil,
			);
		}
	});

	test("the injected instant must carry an offset too", () => {
		assert.throws(
			() =>
				evaluateCustodyPath({
					path: path(),
					policy: EU_PII,
					now: "2026-11-10T00:00:00",
				}),
			/now must be an RFC 3339 instant with an explicit offset/u,
		);
	});

	test("one deadline in three spellings is one deadline, compared to the microsecond", () => {
		for (const [retainUntil, expected] of [
			// One microsecond after NOW.
			["2026-11-10T00:00:00.000001Z", []],
			["2026-11-10T09:00:00.000001+09:00", []],
			["2026-11-09T16:00:00.000001-08:00", []],
			// Exactly NOW: a deadline reached is a deadline passed.
			["2026-11-10T09:00:00+09:00", ["CUSTODY_RETENTION_EXPIRED@runner"]],
		] as const) {
			assert.deepEqual(codes([relay(retainUntil)]), expected, retainUntil);
		}
	});
});

// A pattern creates copies beyond its two ends. A path that leaves one out
// was never judged there, so it cannot be `ok` for that pattern.
describe("a custody path must name every role its migration creates", () => {
	const HUB_NO_REVERSE = { realization: "hub", reverseTail: false } as const;

	function point(role: string): JsonObject {
		return {
			id: role,
			role,
			region: "eu-west-1",
			protections: FULL,
			...(role === "source" || role === "target" || role === "event-log"
				? undefined
				: { retainUntil: LATER }),
		};
	}

	function verdictFor(roles: readonly string[], migration?: CustodyMigration) {
		return evaluateCustodyPath({
			path: parseCustodyPath({ points: roles.map((role) => point(role)) }),
			policy: EU_PII,
			now: NOW,
			...(migration === undefined ? undefined : { migration }),
		});
	}

	test("the roles each pattern creates are derived from the catalog", () => {
		const table = {
			"in-place-evolve": ["source", "rollback-snapshot"],
			"rebuild-and-swap": ["target", "event-log", "relay"],
			"offline-copy": ["source", "target", "relay", "retiring-source"],
			"snapshot-and-tail": [
				"source",
				"target",
				"relay",
				"capture-log",
				"retiring-source",
			],
			"log-pivot": ["source", "target", "event-log", "relay", "capture-log"],
			// The log it leaves and the log it moves into: two roles, so a
			// path that names only one of them does not cover the handoff.
			"stream-handoff": ["event-log", "relay", "target-event-log"],
		} satisfies Record<MigrationPatternId, readonly string[]>;
		for (const pattern of MIGRATION_PATTERNS) {
			assert.deepEqual(
				requiredCustodyRoles({ pattern, ...HUB_NO_REVERSE }),
				table[pattern],
				pattern,
			);
		}
	});

	test("a stream-handoff path that names only the log it leaves is incomplete: the destination log is a custody point of its own", () => {
		const handoff = { pattern: "stream-handoff" } as const;
		// The reviewer's path: the source log and the runner, nothing else.
		const leaving = verdictFor(["event-log", "relay"], handoff);
		assert.equal(leaving.ok, false);
		assert.deepEqual(
			leaving.findings.map((finding) => finding.detail),
			[
				"stream-handoff creates a target-event-log (it moves the journal's streams into another log) and the path names none",
			],
		);
		// The same path, judged with no migration named, is positive — and the
		// roles it lists are what a gate reads to refuse the handoff anyway.
		const bare = verdictFor(["event-log", "relay"]);
		assert.equal(bare.ok, true);
		assert.deepEqual(uncoveredCustodyRoles(bare, handoff), [
			"target-event-log",
		]);
		// Two points both called `event-log` do not stand in for it: a verdict
		// lists roles, and a list of roles cannot show two different logs.
		const twice = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					{ ...point("event-log"), id: "log-eu" },
					{ ...point("event-log"), id: "log-us" },
					point("relay"),
				],
			}),
			policy: EU_PII,
			now: NOW,
		});
		assert.deepEqual(uncoveredCustodyRoles(twice, handoff), [
			"target-event-log",
		]);
		// Named, the destination is judged like any other point — here it is
		// outside the residency constraint, and that is now a finding.
		const complete = verdictFor(
			["event-log", "relay", "target-event-log"],
			handoff,
		);
		assert.equal(complete.ok, true, JSON.stringify(complete.findings));
		assert.deepEqual(uncoveredCustodyRoles(complete, handoff), []);
		const abroad = evaluateCustodyPath({
			path: parseCustodyPath({
				points: [
					point("event-log"),
					point("relay"),
					{ ...point("target-event-log"), region: "us-east-1" },
				],
			}),
			policy: EU_PII,
			now: NOW,
			migration: handoff,
		});
		assert.equal(abroad.ok, false);
		assert.deepEqual(
			abroad.findings.map((finding) => `${finding.code}@${finding.role}`),
			["CUSTODY_RESIDENCY_CONFLICT@target-event-log"],
		);
	});

	test("the realization and the reverse tail change what is created", () => {
		// A reverse tail retains the target's change log.
		assert.deepEqual(
			requiredCustodyRoles({
				pattern: "offline-copy",
				realization: "hub",
				reverseTail: true,
			}),
			["source", "target", "relay", "capture-log", "retiring-source"],
		);
		// A native transfer carries no record through the runner, and retains
		// the log itself; it has no reverse tail whatever the caller says.
		assert.deepEqual(
			requiredCustodyRoles({
				pattern: "offline-copy",
				realization: "native",
				reverseTail: true,
			}),
			["source", "target", "capture-log", "retiring-source"],
		);
		// Unstated means the more demanding reading of each.
		assert.deepEqual(requiredCustodyRoles({ pattern: "offline-copy" }), [
			"source",
			"target",
			"relay",
			"capture-log",
			"retiring-source",
		]);
	});

	test("a path of only source and target is not ok for any pattern", () => {
		for (const pattern of MIGRATION_PATTERNS) {
			const verdict = verdictFor(["source", "target"], {
				pattern,
				...HUB_NO_REVERSE,
			});
			assert.equal(verdict.ok, false, pattern);
			assert.ok(
				verdict.findings.every(
					(finding) =>
						finding.code === "CUSTODY_PATH_INCOMPLETE" &&
						finding.point === "path",
				),
				pattern,
			);
		}
		const verdict = verdictFor(["source", "target"], {
			pattern: "snapshot-and-tail",
			...HUB_NO_REVERSE,
		});
		assert.deepEqual(
			verdict.findings.map((finding) => finding.detail),
			[
				"snapshot-and-tail creates a relay (the hub carries every record through the runner) and the path names none",
				"snapshot-and-tail creates a capture-log (a change log is retained for the tail) and the path names none",
				"snapshot-and-tail creates a retiring-source (the old source is kept through the soak window until it is retired) and the path names none",
			],
		);
	});

	test("a path that names every created role passes, and one missing role fails it", () => {
		for (const pattern of MIGRATION_PATTERNS) {
			const migration = { pattern, ...HUB_NO_REVERSE };
			const roles = requiredCustodyRoles(migration);
			assert.equal(verdictFor(roles, migration).ok, true, pattern);
			for (const omitted of roles) {
				const verdict = verdictFor(
					roles.filter((role) => role !== omitted),
					migration,
				);
				assert.equal(verdict.ok, false, `${pattern} without ${omitted}`);
				assert.match(
					verdict.findings.map((finding) => finding.detail).join("\n"),
					new RegExp(`creates a ${omitted} `, "u"),
				);
			}
		}
	});

	test("in-place-evolve needs no target: the store is changed where it stands", () => {
		const migration = {
			pattern: "in-place-evolve",
			...HUB_NO_REVERSE,
		} as const;
		assert.equal(
			verdictFor(["source", "rollback-snapshot"], migration).ok,
			true,
		);
		// With no migration stated the path is judged as a path: two ends.
		assert.deepEqual(
			verdictFor(["source", "rollback-snapshot"]).findings.map(
				(finding) => finding.detail,
			),
			["the path names no target custody point"],
		);
	});

	test("a created role is still judged: an intermediate copy cannot hide behind completeness", () => {
		const migration = {
			pattern: "snapshot-and-tail",
			...HUB_NO_REVERSE,
		} as const;
		const points = requiredCustodyRoles(migration).map((role) =>
			role === "relay" ? { ...point(role), region: "us-east-1" } : point(role),
		);
		const verdict = evaluateCustodyPath({
			path: parseCustodyPath({ points }),
			policy: EU_PII,
			now: NOW,
			migration,
		});
		assert.deepEqual(
			verdict.findings.map((finding) => `${finding.code}@${finding.point}`),
			["CUSTODY_RESIDENCY_CONFLICT@relay"],
		);
	});

	test("a verdict says which roles it judged, so a gate can refuse what it did not", () => {
		const twoEnds = verdictFor(["target", "source"]);
		assert.equal(twoEnds.ok, true);
		assert.deepEqual(twoEnds.roles, ["source", "target"]);
		assert.deepEqual(policyVerdictToJson(twoEnds).roles, ["source", "target"]);
		assert.deepEqual(
			uncoveredCustodyRoles(twoEnds, {
				pattern: "snapshot-and-tail",
				...HUB_NO_REVERSE,
			}),
			["relay", "capture-log", "retiring-source"],
		);
		const full = verdictFor([...CUSTODY_ROLES]);
		assert.deepEqual(full.roles, [...CUSTODY_ROLES]);
		for (const pattern of MIGRATION_PATTERNS) {
			assert.deepEqual(uncoveredCustodyRoles(full, { pattern }), [], pattern);
		}
	});
});
