import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	ATTESTATION_PREDICATE_TYPE,
	type AttestationEnvelope,
	type AttestationStatement,
	type AttestationVerdict,
	canonicalJson,
	COVERED_JOBS,
	GATE_JOBS,
	keyIdOf,
	parseAttestors,
	parseJson,
	publicKeyFrom,
	publicKeyText,
	signStatement,
	type TrustedAttestor,
	verifyAttestation,
} from "../ci/attestation.mts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const TREE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);

// Keys are made here, per run; none is stored in the repository.
function attestor(expiresAt = "2026-12-01T00:00:00Z") {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const entry: TrustedAttestor = {
		id: keyIdOf(publicKey),
		publicKey: publicKeyText(publicKey),
		expiresAt,
		note: "made by a test",
	};
	return { privateKey, entry };
}

function statement(
	keyId: string,
	changes: Partial<AttestationStatement> = {},
): AttestationStatement {
	const jobs = changes.jobs ?? [...COVERED_JOBS];
	return {
		predicateType: ATTESTATION_PREDICATE_TYPE,
		tree: TREE,
		baseTree: BASE_TREE,
		head: "c".repeat(40),
		base: "d".repeat(40),
		jobs,
		events: ["pull_request", "merge_group"],
		startedAt: "2026-11-11T11:00:00.000Z",
		finishedAt: "2026-11-11T11:30:00.000Z",
		attestor: keyId,
		environment: {
			node: "v24.0.0",
			platform: "linux-x64",
			dockerEngine: false,
			toolchainDigest: `sha256:${"e".repeat(64)}`,
		},
		results: jobs.map((id) => ({
			id,
			status: "passed" as const,
			commands: 3,
			durationMs: 1000,
			logDigest: `sha256:${"f".repeat(64)}`,
		})),
		...changes,
	};
}

function verify(
	envelope: AttestationEnvelope | string,
	trusted: readonly TrustedAttestor[],
	changes: {
		tree?: string;
		baseTree?: string;
		event?: string;
		nowMs?: number;
	} = {},
): AttestationVerdict {
	return verifyAttestation({
		envelopeText:
			envelope instanceof Object ? JSON.stringify(envelope) : envelope,
		attestorsText: JSON.stringify(trusted),
		tree: changes.tree ?? TREE,
		baseTree: changes.baseTree ?? BASE_TREE,
		event: changes.event ?? "pull_request",
		nowMs: changes.nowMs ?? NOW,
	});
}

function refusal(verdict: AttestationVerdict): string {
	assert.equal(verdict.attested, false);
	return verdict.attested ? "" : verdict.reason;
}

describe("canonical JSON", () => {
	it("is the same bytes whatever order the keys were written in", () => {
		const one = parseJson(
			'{"b":[1,{"y":true,"x":null}],"a":"text","c":{"k":2,"j":1}}',
		);
		const other = parseJson(
			'{"c":{"j":1,"k":2},"a":"text","b":[1,{"x":null,"y":true}]}',
		);
		assert.equal(canonicalJson(one), canonicalJson(other));
		assert.equal(
			canonicalJson(one),
			'{"a":"text","b":[1,{"x":null,"y":true}],"c":{"j":1,"k":2}}',
		);
	});

	it("keeps the order of a list, which is part of what it says", () => {
		assert.notEqual(
			canonicalJson(parseJson("[1,2]")),
			canonicalJson(parseJson("[2,1]")),
		);
	});

	it("sorts by code unit, not by a locale", () => {
		assert.equal(
			canonicalJson(parseJson('{"a":1,"B":2,"_":3}')),
			'{"B":2,"_":3,"a":1}',
		);
	});
});

describe("verifying an attestation", () => {
	const signer = attestor();
	const signed = signStatement(statement(signer.entry.id), signer.privateKey);

	it("accepts a signed statement for this tree, this base and this event", () => {
		for (const event of ["pull_request", "merge_group"]) {
			const verdict = verify(signed, [signer.entry], { event });
			assert.deepEqual(verdict, {
				attested: true,
				jobs: [...COVERED_JOBS],
				attestor: signer.entry.id,
			});
		}
	});

	it("verifies the same after the statement's keys are reordered", () => {
		const reordered = {
			signature: signed.signature,
			statement: Object.fromEntries(Object.entries(signed.statement).reverse()),
		};
		assert.equal(
			verify(JSON.stringify(reordered), [signer.entry]).attested,
			true,
		);
	});

	it("accepts a key written as PEM", () => {
		const pem = publicKeyFrom(signer.entry.publicKey)
			.export({ type: "spki", format: "pem" })
			.toString();
		assert.equal(
			verify(signed, [{ ...signer.entry, publicKey: pem }]).attested,
			true,
		);
	});

	it("refuses a statement changed after it was signed", () => {
		for (const tampered of [
			{ ...signed.statement, jobs: [...signed.statement.jobs].slice(1) },
			{ ...signed.statement, tree: "9".repeat(40) },
			{ ...signed.statement, finishedAt: "2026-11-11T11:31:00.000Z" },
			{
				...signed.statement,
				environment: { ...signed.statement.environment, dockerEngine: true },
			},
			{ ...signed.statement, extra: "added" },
		]) {
			const verdict = verify(
				JSON.stringify({ statement: tampered, signature: signed.signature }),
				[signer.entry],
				{ tree: tampered.tree },
			);
			assert.match(refusal(verdict), /signature does not verify/);
		}
	});

	it("refuses a signature that is not this statement's", () => {
		const other = signStatement(
			statement(signer.entry.id, { head: "1".repeat(40) }),
			signer.privateKey,
		);
		assert.match(
			refusal(
				verify({ statement: signed.statement, signature: other.signature }, [
					signer.entry,
				]),
			),
			/signature does not verify/,
		);
	});

	it("refuses another tree", () => {
		assert.match(
			refusal(verify(signed, [signer.entry], { tree: "9".repeat(40) })),
			/another tree/,
		);
	});

	it("refuses another base tree", () => {
		assert.match(
			refusal(verify(signed, [signer.entry], { baseTree: "9".repeat(40) })),
			/another base/,
		);
	});

	it("refuses an event the run did not cover", () => {
		const prOnly = signStatement(
			statement(signer.entry.id, { events: ["pull_request"] }),
			signer.privateKey,
		);
		assert.equal(verify(prOnly, [signer.entry]).attested, true);
		assert.match(
			refusal(verify(prOnly, [signer.entry], { event: "merge_group" })),
			/does not cover merge_group/,
		);
		assert.match(
			refusal(verify(signed, [signer.entry], { event: "push" })),
			/does not cover push/,
		);
	});

	it("refuses a key that is not on the trusted list", () => {
		const stranger = attestor();
		assert.match(
			refusal(verify(signed, [stranger.entry])),
			/not a trusted attestor at the base commit/,
		);
		assert.match(refusal(verify(signed, [])), /not a trusted attestor/);
	});

	it("refuses a trusted id whose listed key is another key", () => {
		const stranger = attestor();
		assert.match(
			refusal(
				verify(signed, [
					{ ...signer.entry, publicKey: stranger.entry.publicKey },
				]),
			),
			/signature does not verify/,
		);
	});

	it("refuses an expired key, at the moment it expires and after", () => {
		const expiry = Date.parse(signer.entry.expiresAt);
		assert.equal(
			verify(signed, [signer.entry], { nowMs: expiry - 1 }).attested,
			true,
		);
		for (const nowMs of [expiry, expiry + 1])
			assert.match(
				refusal(verify(signed, [signer.entry], { nowMs })),
				/expired/,
			);
	});

	it("refuses a statement and a signature that name different keys", () => {
		const other = attestor();
		assert.match(
			refusal(
				verify(
					{
						statement: signed.statement,
						signature: { ...signed.signature, keyId: other.entry.id },
					},
					[signer.entry, other.entry],
				),
			),
			/different keys/,
		);
	});

	it("refuses a malformed envelope", () => {
		for (const text of [
			"",
			"not json",
			"[]",
			"{}",
			JSON.stringify({ statement: signed.statement }),
			JSON.stringify({ signature: signed.signature }),
			JSON.stringify({
				statement: signed.statement,
				signature: { ...signed.signature, algorithm: "rsa" },
			}),
			JSON.stringify({
				statement: { ...signed.statement, jobs: "pr_gate_validation" },
				signature: signed.signature,
			}),
			JSON.stringify({
				statement: { ...signed.statement, environment: null },
				signature: signed.signature,
			}),
		])
			assert.match(refusal(verify(text, [signer.entry])), /malformed/, text);
	});

	it("refuses another kind or version of statement", () => {
		const other = signStatement(
			statement(signer.entry.id, {
				predicateType: `${ATTESTATION_PREDICATE_TYPE}-next`,
			}),
			signer.privateKey,
		);
		assert.match(
			refusal(verify(other, [signer.entry])),
			/another kind or version/,
		);
	});

	it("refuses a malformed trusted list rather than reading around it", () => {
		const verdict = verifyAttestation({
			envelopeText: JSON.stringify(signed),
			attestorsText: JSON.stringify([signer.entry, { id: "no-key" }]),
			tree: TREE,
			baseTree: BASE_TREE,
			event: "pull_request",
			nowMs: NOW,
		});
		assert.match(
			refusal(verdict),
			/trusted attestor list at the base is malformed/,
		);
	});

	it("never reports a job that is not on the covered list", () => {
		const jobs = ["ci-runner-image", "pr-gate", "secret-scan"];
		const wide = signStatement(
			statement(signer.entry.id, { jobs }),
			signer.privateKey,
		);
		assert.deepEqual(verify(wide, [signer.entry]), {
			attested: true,
			jobs: ["secret-scan"],
			attestor: signer.entry.id,
		});
	});

	it("reports the gate's jobs together or not at all", () => {
		const partial = signStatement(
			statement(signer.entry.id, {
				jobs: ["pr_gate_validation", "workspace_tests", "ci-guard"],
			}),
			signer.privateKey,
		);
		const verdict = verify(partial, [signer.entry]);
		assert.deepEqual(verdict.attested && verdict.jobs, ["ci-guard"]);
		const onlyGate = signStatement(
			statement(signer.entry.id, { jobs: GATE_JOBS.slice(0, 2) }),
			signer.privateKey,
		);
		assert.match(refusal(verify(onlyGate, [signer.entry])), /covers no job/);
	});

	it("refuses a job listed without a passing result", () => {
		const base = statement(signer.entry.id);
		const missing = signStatement(
			{ ...base, results: base.results.slice(1) },
			signer.privateKey,
		);
		assert.match(
			refusal(verify(missing, [signer.entry])),
			/without a passing result/,
		);
		const failed = JSON.stringify({
			statement: {
				...base,
				results: base.results.map((result) => ({
					...result,
					status: "failed",
				})),
			},
			signature: signed.signature,
		});
		assert.match(refusal(verify(failed, [signer.entry])), /malformed/);
	});
});

describe("the trusted attestor list", () => {
	const valid = attestor().entry;

	it("needs an id, a usable ed25519 key, an expiry and a note on every entry", () => {
		assert.deepEqual(parseAttestors(JSON.stringify([valid])), [valid]);
		assert.deepEqual(parseAttestors("[]"), []);
		const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.publicKey.export({ type: "spki", format: "der" })
			.toString("base64");
		for (const broken of [
			{},
			"a string",
			{ ...valid, id: undefined },
			{ ...valid, id: "has a space" },
			{ ...valid, publicKey: undefined },
			{ ...valid, publicKey: "not a key" },
			{ ...valid, publicKey: rsa },
			{ ...valid, expiresAt: undefined },
			{ ...valid, expiresAt: "next week" },
			{ ...valid, note: undefined },
		])
			assert.throws(
				() => parseAttestors(JSON.stringify([broken])),
				JSON.stringify(broken),
			);
		assert.throws(() => parseAttestors(JSON.stringify({ attestors: [valid] })));
		assert.throws(() => parseAttestors(JSON.stringify([valid, valid])));
	});

	it("is well formed in this repository, and no entry is trusted for more than 90 days", () => {
		const text = readFileSync(".hobo/ci-attestors.json", "utf8");
		const entries = parseAttestors(text);
		for (const entry of entries) {
			assert.equal(
				entry.id,
				keyIdOf(publicKeyFrom(entry.publicKey)),
				`${entry.id} must be its key's own id`,
			);
			assert.ok(entry.note.trim().length > 0, `${entry.id} needs a note`);
			assert.ok(
				Date.parse(entry.expiresAt) - Date.now() <= 90 * 24 * 60 * 60 * 1000,
				`${entry.id} expires too far in the future`,
			);
		}
		// Only public keys belong in this file.
		assert.doesNotMatch(text, /PRIVATE KEY/u);
	});
});
