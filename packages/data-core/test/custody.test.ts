// The policy verdict is computed over every place data rests or passes. These
// tests are the "compliant at both ends, non-compliant in the middle" cases.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type CustodyPolicy,
	custodyPathDigest,
	evaluateCustodyPath,
	parseCustodyPath,
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

function path(extra: object[] = []) {
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
	extra: object[],
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
