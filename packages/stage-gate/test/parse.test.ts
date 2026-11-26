/**
 * Parsing and re-serialising a stage-gate record.
 *
 * A stage-gate record is the artifact that says a build passed its gate. It is
 * written by CI, read by whatever decides whether something may ship, and
 * therefore is exactly the kind of document somebody would be tempted to hand-
 * edit. The parser is the only thing standing between an edited file and a
 * release.
 *
 * That makes one group of tests more important than all the others: the
 * **passed-record constraints**. A record claiming `status: "passed"` has to
 * survive checks the other statuses do not — every check passed, a verified
 * signature, a real artifact digest, and the right gate id. A parser that let a
 * `passed` record through with a failed check inside it would launder a red
 * build into a green attestation, and every downstream reader would believe it.
 * Each of those four constraints gets its own test, so weakening one is a
 * failure rather than a silently wider door.
 *
 * The rest of the parser has a subtler property worth pinning: it **accumulates**
 * issues rather than throwing on the first. A CI author fixing a hand-written
 * record one error per run is the experience that design avoids, so the tests
 * check that several problems are reported together.
 *
 * Both naming conventions are accepted throughout — snake_case as written by
 * CI, camelCase as produced by TypeScript callers. Where a field is read, both
 * spellings are tested, because supporting one silently is how half a document
 * ends up ignored.
 */
import { describe, expect, it } from "vitest";
import type { JsonObject, JsonValue } from "../src/json.js";
import {
	parseStageGateRecord,
	serializeStageGateRecord,
} from "../src/parse.js";
import { StageGateParseError } from "../src/types.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function record(overrides: JsonObject = {}) {
	return {
		gate_id: "s0",
		status: "passed",
		repo_commit: "abc123",
		ci_run_url: "https://ci.example.com/run/1",
		started_at: "2026-08-20T10:00:00.000Z",
		finished_at: "2026-08-20T10:05:00.000Z",
		checks: [
			{
				check_id: "typecheck",
				command: ["tsc", "-b"],
				exit_code: 0,
				status: "passed",
				evidence: { log: "clean" },
			},
		],
		artifact: {
			digest_sha256: DIGEST,
			byte_length: 1024,
			media_type: "application/wasm",
		},
		signature: {
			verified: true,
			signer_identity: "ci@hobo.test",
			provenance_tier: "tier-2",
		},
		...overrides,
	};
}

/** The issues a rejected record reported. */
function issuesOf(raw: JsonValue): readonly string[] {
	try {
		parseStageGateRecord(raw);
		expect.unreachable("record should have been rejected");
	} catch (error) {
		if (error instanceof StageGateParseError) return error.issues;
		throw error;
	}
	return [];
}

describe("a well-formed record", () => {
	it("parses", () => {
		expect(parseStageGateRecord(record()).gateId).toBe("s0");
	});

	it("normalises snake_case onto camelCase fields", () => {
		// CI writes snake_case; the rest of the codebase reads camelCase. The
		// parser is where that translation happens exactly once.
		const parsed = parseStageGateRecord(record());
		expect(parsed.repoCommit).toBe("abc123");
		expect(parsed.artifact.digestSha256).toBe(DIGEST);
		expect(parsed.signature.signerIdentity).toBe("ci@hobo.test");
	});

	it("accepts camelCase input just as readily", () => {
		// A TypeScript caller round-tripping a record it built in memory would
		// otherwise be rejected by the parser that produced its own shape.
		const parsed = parseStageGateRecord({
			gateId: "s0",
			status: "skipped",
			repoCommit: "abc",
			ciRunUrl: "",
			startedAt: "2026-08-20T10:00:00.000Z",
			finishedAt: "2026-08-20T10:05:00.000Z",
			checks: [],
			artifact: {
				digestSha256: DIGEST,
				byteLength: 1,
				mediaType: "application/wasm",
			},
			signature: {
				verified: false,
				signerIdentity: "",
				provenanceTier: "",
			},
		});
		expect(parsed.repoCommit).toBe("abc");
	});

	it("defaults an absent conformance digest to empty rather than undefined", () => {
		// Downstream code compares this string. `undefined` would make every
		// comparison a type error waiting to happen at the far end.
		expect(
			parseStageGateRecord(record()).signature.conformanceReportDigest,
		).toBe("");
	});

	it("keeps an explicit conformance digest", () => {
		const parsed = parseStageGateRecord(
			record({
				signature: {
					verified: true,
					signer_identity: "ci",
					provenance_tier: "t",
					conformance_report_digest: DIGEST,
				},
			}),
		);
		expect(parsed.signature.conformanceReportDigest).toBe(DIGEST);
	});
});

describe("the passed-record constraints", () => {
	// These four are the whole point of the parser. A record claiming to have
	// passed must not be able to lie about it; each constraint is what stops one
	// particular lie, so each gets a test of its own.

	it("refuses a passed record containing a failed check", () => {
		// The lie that matters most: a red build laundered into a green
		// attestation. Every reader downstream would believe it.
		const issues = issuesOf(
			record({
				checks: [
					{
						check_id: "tests",
						command: ["vitest"],
						exit_code: 1,
						status: "failed",
					},
				],
			}),
		);
		expect(issues.join()).toContain("requires every check passed");
	});

	it("names the check that was not passed", () => {
		// Without the id, somebody with forty checks has to diff two files to
		// find out which one blocked the gate.
		const issues = issuesOf(
			record({
				checks: [
					{
						check_id: "the-culprit",
						command: ["x"],
						exit_code: 1,
						status: "failed",
					},
				],
			}),
		);
		expect(issues.join()).toContain("the-culprit");
	});

	it("refuses a passed record with a skipped check", () => {
		// Skipped is not passed. Treating it as acceptable would let a gate be
		// cleared by disabling the check that guards it.
		const issues = issuesOf(
			record({
				checks: [
					{
						check_id: "skipme",
						command: ["x"],
						exit_code: 0,
						status: "skipped",
					},
				],
			}),
		);
		expect(issues.join()).toContain("requires every check passed");
	});

	it("refuses a passed record whose signature is unverified", () => {
		// An unverified signature means nobody can say who produced the artifact.
		// A passing gate on an unattributable build is worth nothing.
		const issues = issuesOf(
			record({
				signature: {
					verified: false,
					signer_identity: "ci",
					provenance_tier: "t",
				},
			}),
		);
		expect(issues.join()).toContain("signature.verified === true");
	});

	it("refuses a passed record for a gate other than s0", () => {
		const issues = issuesOf(record({ gate_id: "s3" }));
		expect(issues.join()).toContain('gate_id must be "s0"');
	});

	it("allows a failed record to carry failed checks", () => {
		// The constraints apply to the claim, not the document. A failed record
		// describing what failed is the honest case and must parse.
		const parsed = parseStageGateRecord(
			record({
				status: "failed",
				gate_id: "s3",
				checks: [
					{
						check_id: "tests",
						command: ["vitest"],
						exit_code: 1,
						status: "failed",
					},
				],
				signature: {
					verified: false,
					signer_identity: "",
					provenance_tier: "",
				},
			}),
		);
		expect(parsed.status).toBe("failed");
	});

	it("allows a skipped record the same latitude", () => {
		const parsed = parseStageGateRecord(
			record({ status: "skipped", gate_id: "s2", checks: [] }),
		);
		expect(parsed.status).toBe("skipped");
	});
});

describe("rejecting a malformed record", () => {
	it("refuses something that is not an object at all", () => {
		expect(() => parseStageGateRecord("nope")).toThrow(StageGateParseError);
	});

	it("refuses an array, which is an object but not a record", () => {
		// `typeof [] === "object"`, so an explicit array check is what stops a
		// list of records being parsed as one.
		expect(() => parseStageGateRecord([record()])).toThrow(StageGateParseError);
	});

	it("refuses null", () => {
		expect(() => parseStageGateRecord(null)).toThrow(StageGateParseError);
	});

	it("requires a gate id", () => {
		expect(issuesOf(record({ gate_id: "" })).join()).toContain("gate_id");
	});

	it("requires a known status", () => {
		// An unknown status would skip the passed-record constraints entirely,
		// since those only fire on the literal "passed".
		expect(issuesOf(record({ status: "mostly-fine" })).join()).toContain(
			"passed|failed|skipped",
		);
	});

	it("requires timestamps that look like timestamps", () => {
		expect(issuesOf(record({ started_at: "yesterday" })).join()).toContain(
			"started_at",
		);
	});

	it("refuses a run that finished before it started", () => {
		// Backwards timestamps mean the record was assembled by hand or by a
		// clock nobody should trust for provenance.
		expect(
			issuesOf(
				record({
					started_at: "2026-08-20T10:05:00.000Z",
					finished_at: "2026-08-20T10:00:00.000Z",
				}),
			).join(),
		).toContain("finished_at must be >= started_at");
	});

	it("refuses a run that finished at the instant it started", () => {
		// Pinning the boundary as it is: the comparison is `>=`, so equal
		// timestamps are rejected despite the message saying ">=". Anyone
		// loosening this to allow instantaneous runs should expect this to flip.
		expect(
			issuesOf(
				record({
					started_at: "2026-08-20T10:00:00.000Z",
					finished_at: "2026-08-20T10:00:00.000Z",
				}),
			).join(),
		).toContain("finished_at must be >= started_at");
	});

	it("accepts an empty ci url but not a non-https one", () => {
		// Empty means "ran outside CI". A plaintext URL would make the run's
		// evidence tamperable in transit, which defeats keeping the link at all.
		expect(parseStageGateRecord(record({ ci_run_url: "" })).ciRunUrl).toBe("");
		expect(
			issuesOf(record({ ci_run_url: "http://ci.example.com" })).join(),
		).toContain("must start with https://");
	});

	it("requires checks to be an array", () => {
		expect(issuesOf(record({ checks: {} })).join()).toContain("checks");
	});

	it("reports several problems at once", () => {
		// Accumulating issues is what stops a CI author fixing a hand-written
		// record one error per run.
		const issues = issuesOf(
			record({ gate_id: "", status: "nope", repo_commit: 42 }),
		);
		expect(issues.length).toBeGreaterThanOrEqual(3);
	});

	it("points at the offending index inside checks", () => {
		// With twenty checks, "expected object" without a position is not
		// actionable.
		const issues = issuesOf(
			record({
				checks: [
					{
						check_id: "ok",
						command: ["x"],
						exit_code: 0,
						status: "passed",
					},
					"not-an-object",
				],
			}),
		);
		expect(issues.join()).toContain("checks[1]");
	});
});

describe("check results", () => {
	function checkIssues(check: JsonValue): string {
		return issuesOf(record({ checks: [check] })).join();
	}

	it("requires a check id", () => {
		expect(
			checkIssues({ command: ["x"], exit_code: 0, status: "passed" }),
		).toContain("check_id");
	});

	it("requires the command to be an array", () => {
		// A command recorded as a bare string cannot be replayed — the reader
		// cannot tell where one argument ends and the next begins.
		expect(
			checkIssues({
				check_id: "c",
				command: "vitest run",
				exit_code: 0,
				status: "passed",
			}),
		).toContain("command: expected array");
	});

	it("names the offending element inside a command", () => {
		expect(
			checkIssues({
				check_id: "c",
				command: ["vitest", 7],
				exit_code: 0,
				status: "passed",
			}),
		).toContain("command[1]");
	});

	it("requires an integer exit code", () => {
		// A fractional exit code is not a thing an operating system produces, so
		// its presence means the record was written by something else.
		expect(
			checkIssues({
				check_id: "c",
				command: ["x"],
				exit_code: 0.5,
				status: "passed",
			}),
		).toContain("exit_code");
	});

	it("accepts a non-zero exit code on a failed check", () => {
		// The exit code is evidence, not a constraint. Only the status decides
		// whether the check passed.
		const parsed = parseStageGateRecord(
			record({
				status: "failed",
				gate_id: "s1",
				checks: [
					{
						check_id: "c",
						command: ["x"],
						exit_code: 137,
						status: "failed",
					},
				],
				signature: {
					verified: false,
					signer_identity: "",
					provenance_tier: "",
				},
			}),
		);
		expect(parsed.checks[0]?.exitCode).toBe(137);
	});

	it("defaults absent evidence to an empty map", () => {
		const parsed = parseStageGateRecord(
			record({
				checks: [
					{ check_id: "c", command: ["x"], exit_code: 0, status: "passed" },
				],
			}),
		);
		expect(parsed.checks[0]?.evidence).toEqual({});
	});

	it("requires evidence values to be strings", () => {
		// Evidence is rendered into reports. A nested object would print as
		// "[object Object]" in whatever reads it.
		expect(
			checkIssues({
				check_id: "c",
				command: ["x"],
				exit_code: 0,
				status: "passed",
				evidence: { log: { nested: true } },
			}),
		).toContain("evidence.log");
	});

	it("requires evidence itself to be an object", () => {
		expect(
			checkIssues({
				check_id: "c",
				command: ["x"],
				exit_code: 0,
				status: "passed",
				evidence: "clean",
			}),
		).toContain("evidence: expected object");
	});
});

describe("the artifact", () => {
	function artifactIssues(artifact: JsonValue): string {
		return issuesOf(record({ artifact })).join();
	}

	it("requires a well-formed sha256 digest", () => {
		// The digest is what ties the attestation to a specific build. A
		// truncated or differently-cased one would still look plausible.
		expect(
			artifactIssues({
				digest_sha256: "sha256:abc",
				byte_length: 1,
				media_type: "x",
			}),
		).toContain("digest_sha256");
	});

	it("refuses an uppercase digest", () => {
		// Hex comparison downstream is a string compare. Accepting both cases
		// would make the same artifact hash to two different values.
		expect(
			artifactIssues({
				digest_sha256: `sha256:${"A".repeat(64)}`,
				byte_length: 1,
				media_type: "x",
			}),
		).toContain("digest_sha256");
	});

	it("refuses a digest with no algorithm prefix", () => {
		expect(
			artifactIssues({
				digest_sha256: "a".repeat(64),
				byte_length: 1,
				media_type: "x",
			}),
		).toContain("digest_sha256");
	});

	it("refuses a negative byte length", () => {
		expect(
			artifactIssues({
				digest_sha256: DIGEST,
				byte_length: -1,
				media_type: "x",
			}),
		).toContain("byte_length");
	});

	it("accepts a zero byte length", () => {
		// An empty artifact is a real outcome, distinct from a missing one.
		const parsed = parseStageGateRecord(
			record({
				artifact: {
					digest_sha256: DIGEST,
					byte_length: 0,
					media_type: "application/wasm",
				},
			}),
		);
		expect(parsed.artifact.byteLength).toBe(0);
	});

	it("requires a media type", () => {
		expect(
			artifactIssues({
				digest_sha256: DIGEST,
				byte_length: 1,
				media_type: "",
			}),
		).toContain("media_type");
	});
});

describe("the signature", () => {
	function signatureIssues(signature: JsonValue): string {
		return issuesOf(record({ signature })).join();
	}

	it("requires verified to be a boolean, not a truthy string", () => {
		// `"false"` is truthy. Accepting a string here would let a record spell
		// its way past the passed-record signature constraint.
		expect(
			signatureIssues({
				verified: "true",
				signer_identity: "ci",
				provenance_tier: "t",
			}),
		).toContain("verified: expected boolean");
	});

	it("requires a signer identity field", () => {
		expect(signatureIssues({ verified: true, provenance_tier: "t" })).toContain(
			"signer_identity",
		);
	});

	it("requires a provenance tier field", () => {
		expect(
			signatureIssues({ verified: true, signer_identity: "ci" }),
		).toContain("provenance_tier");
	});

	it("refuses a malformed conformance digest when one is given", () => {
		expect(
			signatureIssues({
				verified: true,
				signer_identity: "ci",
				provenance_tier: "t",
				conformance_report_digest: "not-a-digest",
			}),
		).toContain("conformance_report_digest");
	});

	it("treats an empty conformance digest as absent", () => {
		// Writers emit "" rather than omitting the key. Validating it as a digest
		// would reject every record produced that way.
		const parsed = parseStageGateRecord(
			record({
				signature: {
					verified: true,
					signer_identity: "ci",
					provenance_tier: "t",
					conformance_report_digest: "",
				},
			}),
		);
		expect(parsed.signature.conformanceReportDigest).toBe("");
	});
});

describe("serialising back out", () => {
	it("round-trips a record through parse and serialize", () => {
		// The two halves must agree, or a record this build wrote is one the next
		// build rejects.
		const parsed = parseStageGateRecord(record());
		expect(parseStageGateRecord(serializeStageGateRecord(parsed))).toEqual(
			parsed,
		);
	});

	it("writes snake_case, whatever case it was given", () => {
		// The on-disk format is the contract with CI and with other tools. Echoing
		// back camelCase because that is how it arrived would produce two
		// incompatible file shapes in the same repository.
		const parsed = parseStageGateRecord(record());
		const out = serializeStageGateRecord(parsed);
		expect(Object.keys(out)).toContain("gate_id");
		expect(Object.keys(out)).not.toContain("gateId");
	});

	it("copies the command array rather than sharing it", () => {
		// A serialized record handed to a writer that mutates it would reach back
		// into the parsed record it came from.
		const parsed = parseStageGateRecord(record());
		const out = serializeStageGateRecord(parsed);
		expect(out.checks[0]?.command).toEqual(["tsc", "-b"]);
		expect(out.checks[0]?.command).not.toBe(parsed.checks[0]?.command);
	});

	it("copies the evidence map rather than sharing it", () => {
		const parsed = parseStageGateRecord(record());
		const out = serializeStageGateRecord(parsed);
		expect(out.checks[0]?.evidence).toEqual({ log: "clean" });
		expect(out.checks[0]?.evidence).not.toBe(parsed.checks[0]?.evidence);
	});

	it("writes the conformance digest even when empty", () => {
		// Omitting the key would make two records with the same meaning differ
		// byte for byte, and these files get hashed.
		const out = serializeStageGateRecord(parseStageGateRecord(record()));
		expect(out.signature).toHaveProperty("conformance_report_digest", "");
	});
});
