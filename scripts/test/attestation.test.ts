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
	MAX_TRUST_DAYS,
	parseAttestors,
	parseJson,
	publicKeyFrom,
	publicKeyText,
	signStatement,
	type TrustedAttestor,
	utcInstant,
	verifyAttestation,
} from "../ci/attestation.mts";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const TREE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
/** Jobs the workflows run on merge groups as well as pull requests. */
const BOTH_EVENTS = [
	"pr_gate_validation",
	"workspace_tests",
	"release-contract",
];

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
		head: HEAD,
		base: BASE,
		jobs,
		events: ["pull_request", "merge_group"],
		startedAt: "2026-11-11T11:00:00.000Z",
		finishedAt: "2026-11-11T11:30:00.000Z",
		attestor: keyId,
		environment: {
			platform: "linux-x64",
			dockerEngine: true,
			tools: {
				node: "v24.0.0",
				pnpm: "10.0.0",
				turbo: "2.0.0",
				docker: "29.0.0",
			},
		},
		results: jobs.map((id) => ({
			id,
			status: "passed" as const,
			events: BOTH_EVENTS.includes(id)
				? ["pull_request", "merge_group"]
				: ["pull_request"],
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
		head?: string | undefined;
		base?: string | undefined;
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
		head: "head" in changes ? changes.head : HEAD,
		base: "base" in changes ? changes.base : BASE,
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
		assert.deepEqual(verify(signed, [signer.entry]), {
			attested: true,
			jobs: [...COVERED_JOBS],
			attestor: signer.entry.id,
		});
	});

	it("reports for an event only the jobs that ran for it", () => {
		// A merge group has no head commit a local run could have seen.
		assert.deepEqual(
			verify(signed, [signer.entry], { event: "merge_group", head: undefined }),
			{ attested: true, jobs: BOTH_EVENTS, attestor: signer.entry.id },
		);
		// A record made for merge groups alone covers the merge group's jobs,
		// and says nothing about a pull request.
		const groupOnly = signStatement(
			{
				...statement(signer.entry.id, {
					jobs: ["pr_gate_validation", "workspace_tests"],
					events: ["merge_group"],
				}),
				results: ["pr_gate_validation", "workspace_tests"].map((id) => ({
					id,
					status: "passed" as const,
					events: ["merge_group"],
					commands: 1,
					durationMs: 1,
					logDigest: `sha256:${"f".repeat(64)}`,
				})),
			},
			signer.privateKey,
		);
		assert.deepEqual(
			verify(groupOnly, [signer.entry], { event: "merge_group" }),
			{
				attested: true,
				jobs: ["pr_gate_validation", "workspace_tests"],
				attestor: signer.entry.id,
			},
		);
		assert.match(
			refusal(verify(groupOnly, [signer.entry])),
			/does not cover pull_request/,
		);
		// The statement says both events, but a job's own result decides.
		const claimed = signStatement(
			{
				...statement(signer.entry.id, { jobs: ["ci-guard", "artifact-trust"] }),
				results: [
					{
						id: "ci-guard",
						status: "passed" as const,
						events: ["merge_group"],
						commands: 1,
						durationMs: 1,
						logDigest: `sha256:${"f".repeat(64)}`,
					},
					{
						id: "artifact-trust",
						status: "passed" as const,
						events: ["pull_request"],
						commands: 1,
						durationMs: 1,
						logDigest: `sha256:${"f".repeat(64)}`,
					},
				],
			},
			signer.privateKey,
		);
		assert.deepEqual(verify(claimed, [signer.entry]), {
			attested: true,
			jobs: ["artifact-trust"],
			attestor: signer.entry.id,
		});
	});

	it("accepts the secret scan only for the exact commits that were scanned", () => {
		const others = COVERED_JOBS.filter((job) => job !== "secret-scan");
		const jobsFor = (changes: Parameters<typeof verify>[2]) => {
			const verdict = verify(signed, [signer.entry], changes);
			return verdict.attested ? verdict.jobs : [];
		};
		assert.ok(jobsFor({}).includes("secret-scan"));
		// Another history that ends in the same tree: a secret added, then
		// reverted. Same tree, same base tree, other commits.
		for (const changes of [
			{ head: "9".repeat(40) },
			{ base: "9".repeat(40) },
			{ head: undefined },
			{ base: undefined },
			{ head: "not-a-commit" },
			{ head: BASE, base: HEAD },
		])
			assert.deepEqual(jobsFor(changes), others, JSON.stringify(changes));
	});

	it("does not accept a job that needs a container engine from a machine without one", () => {
		const base = statement(signer.entry.id);
		const noEngine = signStatement(
			{
				...base,
				environment: {
					platform: "linux-x64",
					dockerEngine: false,
					tools: { node: "v24.0.0", pnpm: "10.0.0", turbo: "2.0.0" },
				},
			},
			signer.privateKey,
		);
		// The workspace tests go, and the gate's other jobs with them.
		assert.deepEqual(verify(noEngine, [signer.entry]), {
			attested: true,
			jobs: COVERED_JOBS.filter((job) => !GATE_JOBS.includes(job)),
			attestor: signer.entry.id,
		});
	});

	it("refuses an engine version without an engine, and an engine without a version", () => {
		const base = statement(signer.entry.id);
		for (const environment of [
			{
				platform: "linux-x64",
				dockerEngine: false,
				tools: { node: "v24", pnpm: "10", turbo: "2", docker: "29.0.0" },
			},
			{
				platform: "linux-x64",
				dockerEngine: true,
				tools: { node: "v24", pnpm: "10", turbo: "2" },
			},
		])
			assert.match(
				refusal(
					verify(signStatement({ ...base, environment }, signer.privateKey), [
						signer.entry,
					]),
				),
				/malformed.*present exactly when dockerEngine is true/,
			);
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
			{ ...signed.statement, head: "9".repeat(40) },
			{ ...signed.statement, finishedAt: "2026-11-11T11:31:00.000Z" },
			{
				...signed.statement,
				environment: {
					...signed.statement.environment,
					tools: { ...signed.statement.environment.tools, node: "v99.0.0" },
				},
			},
			{
				...signed.statement,
				results: signed.statement.results.map((result) => ({
					...result,
					events: ["pull_request", "merge_group"],
				})),
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
			/trusted attestor list at the base is malformed.*its key's own id/,
		);
	});

	it("refuses a list that trusts any key for more than 90 days", () => {
		const day = 24 * 60 * 60 * 1000;
		const until = (ms: number) => new Date(ms).toISOString();
		const within = {
			...signer.entry,
			expiresAt: until(NOW + MAX_TRUST_DAYS * day),
		};
		assert.equal(verify(signed, [within]).attested, true);
		const beyond = {
			...signer.entry,
			expiresAt: until(NOW + MAX_TRUST_DAYS * day + 1000),
		};
		assert.match(
			refusal(verify(signed, [beyond])),
			/malformed.*more than 90 days/,
		);
		// Another entry's lifetime counts too: the list is trusted whole or not.
		const other = attestor(until(NOW + 400 * day));
		assert.match(
			refusal(verify(signed, [signer.entry, other.entry])),
			/malformed.*more than 90 days/,
		);
	});

	it("refuses a key id that is not the shape of one", () => {
		for (const keyId of [
			"a b",
			"x\n::error::injected",
			"",
			"../../etc",
			"a".repeat(65),
		])
			assert.match(
				refusal(
					verify(
						JSON.stringify({
							statement: { ...signed.statement, attestor: keyId },
							signature: { ...signed.signature, keyId },
						}),
						[signer.entry],
					),
				),
				/malformed/,
				JSON.stringify(keyId),
			);
	});

	it("refuses a statement whose commits or trees are not object ids", () => {
		for (const field of ["tree", "baseTree", "head", "base"])
			assert.match(
				refusal(
					verify(
						JSON.stringify({
							statement: { ...signed.statement, [field]: "main\n::warning::x" },
							signature: signed.signature,
						}),
						[signer.entry],
					),
				),
				/malformed.*not a git object id/,
				field,
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
			JSON.stringify({
				statement: {
					...signed.statement,
					results: signed.statement.results.map(
						({ events: _events, ...result }) => result,
					),
				},
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
			// Strict ISO-8601 UTC, and a day that exists.
			{ ...valid, expiresAt: "2026-12-01" },
			{ ...valid, expiresAt: "2026-12-01 00:00:00Z" },
			{ ...valid, expiresAt: "2026-12-01T00:00:00+01:00" },
			{ ...valid, expiresAt: "2026-12-01T00:00:00" },
			{ ...valid, expiresAt: "2026-02-31T00:00:00Z" },
			{ ...valid, expiresAt: "1764547200000" },
			// The id must be the key's own.
			{ ...valid, id: attestor().entry.id },
			{ ...valid, id: "ed25519-0000000000000000" },
			{ ...valid, note: undefined },
		])
			assert.throws(
				() => parseAttestors(JSON.stringify([broken])),
				JSON.stringify(broken),
			);
		assert.throws(() => parseAttestors(JSON.stringify({ attestors: [valid] })));
		assert.throws(() => parseAttestors(JSON.stringify([valid, valid])));
	});

	it("reads a strict UTC instant and nothing looser", () => {
		assert.equal(utcInstant("2026-12-01T00:00:00Z"), Date.UTC(2026, 11, 1));
		assert.equal(
			utcInstant("2026-12-01T00:00:00.250Z"),
			Date.UTC(2026, 11, 1) + 250,
		);
		for (const text of [
			"2026-12-01",
			"2026-13-01T00:00:00Z",
			"2026-02-30T00:00:00Z",
			" 2026-12-01T00:00:00Z",
			"2026-12-01T00:00:00z",
		])
			assert.equal(utcInstant(text), undefined, text);
	});

	it("refuses an expiry more than 90 days away once it knows the time", () => {
		const day = 24 * 60 * 60 * 1000;
		const far = { ...valid, expiresAt: new Date(NOW + 91 * day).toISOString() };
		// Without a clock only the shape is checked; with one, the lifetime too.
		assert.equal(parseAttestors(JSON.stringify([far])).length, 1);
		assert.throws(
			() => parseAttestors(JSON.stringify([far]), NOW),
			/more than 90 days/,
		);
		assert.equal(
			parseAttestors(JSON.stringify([far]), NOW + 2 * day).length,
			1,
		);
	});

	it("is well formed in this repository, and no entry is trusted for more than 90 days", () => {
		const text = readFileSync(".hobo/ci-attestors.json", "utf8");
		// The same reading the verifier does, with the same clock rule.
		const entries = parseAttestors(text, Date.now());
		for (const entry of entries)
			assert.ok(entry.note.trim().length > 0, `${entry.id} needs a note`);
		// Only public keys belong in this file.
		assert.doesNotMatch(text, /PRIVATE KEY/u);
	});
});
