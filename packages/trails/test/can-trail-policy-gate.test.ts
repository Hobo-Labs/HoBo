// The can-trail policy gate is a conjunction and it fails closed.
//
// Three signals can deny a trail: `policyAllows: false`, `residencyConflict:
// true`, and a `policyVerdict` computed over the custody path. A supplied
// verdict used to *supersede* the two booleans, so a passing verdict erased an
// explicit denial, and a verdict that was not the record it claimed to be
// threw a `TypeError` out of a gate. Only the stricter direction — a negative
// verdict overriding permissive booleans — was tested, which is why the
// lenient one went unnoticed.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type CanTrailPolicyVerdict,
	type CanTrailResult,
	evaluateCanTrail,
} from "../src/can-trail.js";
import { defineTrail } from "../src/definition.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function dataTrail() {
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
				},
			},
		],
	});
}

const POLICY_FINDING = {
	code: "CUSTODY_PROTECTION_DOWNGRADE",
	point: "snap",
	detail: "rollback-snapshot snap lacks encryptedAtRest",
};
const RESIDENCY_FINDING = {
	code: "CUSTODY_RESIDENCY_CONFLICT",
	point: "runner",
	detail: "relay runner in us-east-1: residency-conflict",
};

const PASSING: CanTrailPolicyVerdict = {
	ok: true,
	findings: [],
	custodyDigest: DIGEST,
};

/**
 * A verdict as it arrives from outside the type system: evidence that crossed
 * a process boundary as JSON. `JSON.parse` is the honest way to get a value
 * the compiler believes and the runtime does not.
 */
function verdictFromJson(text: string): CanTrailPolicyVerdict {
	return JSON.parse(text);
}

function codes(result: CanTrailResult): string[] {
	return result.reasons.map((reason) => reason.code);
}

function messageOf(result: CanTrailResult, code: string): string {
	return result.reasons.find((reason) => reason.code === code)?.message ?? "";
}

describe("can-trail combines its policy signals instead of letting one supersede", () => {
	test("a passing verdict does not erase an explicit policy denial", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: false,
			policyVerdict: PASSING,
		});
		assert.equal(result.ok, false);
		assert.deepEqual(codes(result), ["policy-denied"]);
		assert.equal(
			messageOf(result, "policy-denied"),
			"policy pack denies this trail",
		);
		assert.equal(result.summary, "can-trail:blocked (policy-denied)");
	});

	test("a passing verdict does not erase an explicit residency conflict", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			residencyConflict: true,
			policyVerdict: PASSING,
		});
		assert.equal(result.ok, false);
		assert.deepEqual(codes(result), ["residency-conflict"]);
		assert.equal(
			messageOf(result, "residency-conflict"),
			"residency obligation conflicts with trail targets",
		);
	});

	test("a passing verdict with both booleans denying reports both denials", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: false,
			residencyConflict: true,
			policyVerdict: PASSING,
		});
		assert.equal(result.ok, false);
		assert.deepEqual(codes(result).sort(), [
			"policy-denied",
			"residency-conflict",
		]);
	});

	test("the trail passes only when every supplied signal allows it", () => {
		for (const policyAllows of [undefined, true]) {
			for (const residencyConflict of [undefined, false]) {
				for (const policyVerdict of [undefined, PASSING]) {
					const result = evaluateCanTrail({
						trail: dataTrail(),
						policyAllows,
						residencyConflict,
						policyVerdict,
					});
					assert.equal(result.ok, true);
					assert.deepEqual(codes(result), []);
				}
			}
		}
	});

	// Every combination of the three signals, judged against an oracle that is
	// nothing more than the rule stated twice: a code is present exactly when
	// some signal raises it.
	const VERDICTS: readonly Readonly<{
		name: string;
		verdict: CanTrailPolicyVerdict | undefined;
		policy: boolean;
		residency: boolean;
	}>[] = [
		{ name: "absent", verdict: undefined, policy: false, residency: false },
		{ name: "passing", verdict: PASSING, policy: false, residency: false },
		{
			name: "policy finding",
			verdict: { ok: false, findings: [POLICY_FINDING], custodyDigest: DIGEST },
			policy: true,
			residency: false,
		},
		{
			name: "residency finding",
			verdict: {
				ok: false,
				findings: [RESIDENCY_FINDING],
				custodyDigest: DIGEST,
			},
			policy: false,
			residency: true,
		},
		{
			name: "both findings",
			verdict: {
				ok: false,
				findings: [RESIDENCY_FINDING, POLICY_FINDING],
				custodyDigest: DIGEST,
			},
			policy: true,
			residency: true,
		},
		{
			name: "negative without findings",
			verdict: { ok: false, findings: [], custodyDigest: DIGEST },
			policy: true,
			residency: false,
		},
		{
			name: "ok yet carrying a finding",
			verdict: { ok: true, findings: [POLICY_FINDING], custodyDigest: DIGEST },
			policy: true,
			residency: false,
		},
		{
			name: "malformed",
			verdict: verdictFromJson('{"ok":true}'),
			policy: true,
			residency: false,
		},
	];

	for (const policyAllows of [undefined, true, false]) {
		for (const residencyConflict of [undefined, false, true]) {
			for (const entry of VERDICTS) {
				test(`policyAllows=${policyAllows} residencyConflict=${residencyConflict} verdict=${entry.name}`, () => {
					const result = evaluateCanTrail({
						trail: dataTrail(),
						policyAllows,
						residencyConflict,
						policyVerdict: entry.verdict,
					});
					const expected: string[] = [];
					if (policyAllows === false || entry.policy) {
						expected.push("policy-denied");
					}
					if (residencyConflict === true || entry.residency) {
						expected.push("residency-conflict");
					}
					assert.deepEqual(codes(result).sort(), expected);
					assert.equal(result.ok, expected.length === 0);
				});
			}
		}
	}

	test("each code is reported once, with every cause in its message", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: false,
			residencyConflict: true,
			policyVerdict: {
				ok: false,
				findings: [RESIDENCY_FINDING, POLICY_FINDING],
				custodyDigest: DIGEST,
			},
		});
		assert.deepEqual(codes(result), ["residency-conflict", "policy-denied"]);
		assert.equal(
			messageOf(result, "policy-denied"),
			`policy pack denies this trail; ${POLICY_FINDING.detail}`,
		);
		assert.equal(
			messageOf(result, "residency-conflict"),
			`residency obligation conflicts with trail targets; ${RESIDENCY_FINDING.detail}`,
		);
	});

	test("reasons keep the order each input style already had", () => {
		assert.deepEqual(
			codes(
				evaluateCanTrail({
					trail: dataTrail(),
					policyAllows: false,
					conflictingTrail: true,
					residencyConflict: true,
				}),
			),
			["policy-denied", "conflicting-trail", "residency-conflict"],
		);
		assert.deepEqual(
			codes(
				evaluateCanTrail({
					trail: dataTrail(),
					conflictingTrail: true,
					policyVerdict: {
						ok: false,
						findings: [POLICY_FINDING, RESIDENCY_FINDING],
						custodyDigest: DIGEST,
					},
				}),
			),
			["residency-conflict", "policy-denied", "conflicting-trail"],
		);
	});

	test("a negative verdict with no findings keeps its message", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyVerdict: { ok: false, findings: [], custodyDigest: DIGEST },
		});
		assert.deepEqual(codes(result), ["policy-denied"]);
		assert.equal(
			messageOf(result, "policy-denied"),
			"policy verdict over the custody path is negative",
		);
	});
});

describe("a malformed policy verdict blocks the trail; it never throws and never passes", () => {
	const finding = JSON.stringify(POLICY_FINDING);
	const MALFORMED: readonly (readonly [string, string])[] = [
		["null", "null"],
		["a string", '"ok"'],
		["a number", "1"],
		["a boolean", "true"],
		["a list", "[]"],
		["an empty record", "{}"],
		["no findings list", `{"ok":true,"custodyDigest":"${DIGEST}"}`],
		[
			"findings null",
			`{"ok":true,"findings":null,"custodyDigest":"${DIGEST}"}`,
		],
		[
			"findings a string",
			`{"ok":false,"findings":"none","custodyDigest":"${DIGEST}"}`,
		],
		[
			"findings a record",
			`{"ok":false,"findings":{},"custodyDigest":"${DIGEST}"}`,
		],
		["no ok", `{"findings":[],"custodyDigest":"${DIGEST}"}`],
		["ok a string", `{"ok":"true","findings":[],"custodyDigest":"${DIGEST}"}`],
		["ok a number", `{"ok":1,"findings":[],"custodyDigest":"${DIGEST}"}`],
		["ok null", `{"ok":null,"findings":[],"custodyDigest":"${DIGEST}"}`],
		["no custody digest", '{"ok":true,"findings":[]}'],
		["an empty custody digest", '{"ok":true,"findings":[],"custodyDigest":""}'],
		[
			"a custody digest that is not a sha256 digest",
			'{"ok":true,"findings":[],"custodyDigest":"sha256:abc"}',
		],
		[
			"a custody digest that is a number",
			'{"ok":true,"findings":[],"custodyDigest":7}',
		],
		[
			"a null finding",
			`{"ok":false,"findings":[null],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a string finding",
			`{"ok":false,"findings":["denied"],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a finding with no code",
			`{"ok":false,"findings":[{"point":"p","detail":"d"}],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a finding with an empty code",
			`{"ok":false,"findings":[{"code":"","point":"p","detail":"d"}],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a finding whose code is a number",
			`{"ok":false,"findings":[{"code":3,"point":"p","detail":"d"}],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a finding with no custody point",
			`{"ok":false,"findings":[{"code":"X","detail":"d"}],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"a finding with no detail",
			`{"ok":false,"findings":[{"code":"X","point":"p"}],"custodyDigest":"${DIGEST}"}`,
		],
		[
			"one malformed finding after a well-formed one",
			`{"ok":false,"findings":[${finding},{}],"custodyDigest":"${DIGEST}"}`,
		],
	];

	test.each(MALFORMED)("%s", (_name, text) => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: true,
			residencyConflict: false,
			policyVerdict: verdictFromJson(text),
		});
		assert.equal(result.ok, false);
		assert.deepEqual(codes(result), ["policy-denied"]);
		assert.match(
			messageOf(result, "policy-denied"),
			/^policy verdict is malformed: /u,
		);
		assert.equal(result.summary, "can-trail:blocked (policy-denied)");
	});

	test("a malformed verdict does not hide the other denials", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyAllows: false,
			residencyConflict: true,
			conflictingTrail: true,
			policyVerdict: verdictFromJson("null"),
		});
		assert.equal(result.ok, false);
		assert.deepEqual(codes(result).sort(), [
			"conflicting-trail",
			"policy-denied",
			"residency-conflict",
		]);
		assert.match(
			messageOf(result, "policy-denied"),
			/^policy pack denies this trail; policy verdict is malformed: /u,
		);
	});

	test("the reason names the defect without echoing the verdict's content", () => {
		const result = evaluateCanTrail({
			trail: dataTrail(),
			policyVerdict: verdictFromJson(
				'{"ok":true,"findings":[],"custodyDigest":"postgres://app:hunter2@db/prod"}',
			),
		});
		assert.equal(result.ok, false);
		assert.doesNotMatch(messageOf(result, "policy-denied"), /hunter2/u);
		assert.match(messageOf(result, "policy-denied"), /custodyDigest/u);
	});
});
