// The live lane, exercised entirely offline.
//
// The point of this file is that every guard rail is a pure function of an
// injected environment and injected ports, so the lane that must never run in
// CI can still be *tested* in CI. Nothing here touches a provider.

import { describe, expect, it } from "vitest";

import {
	assertSanitized,
	CI_ENV_KEYS,
	CLEANUP_CHECK,
	emitAnonymousTrustEvidence,
	evidenceIsFullyPassing,
	LIVE_ENV_KEYS,
	LiveEvidenceError,
	LiveRunRefusedError,
	liveRunRefusalFor,
	parseLiveRunGrant,
	runLiveAnonymousConformance,
	runLiveConformanceCli,
	standardTrustChecksFrom,
} from "../src/live/index.js";
import type {
	LiveCleanupOutcome,
	LiveConformancePorts,
	LiveResourceHandle,
} from "../src/live/runner.js";
import { runAnonymousConformance } from "../src/suites/anonymous/index.js";
import {
	digestOf,
	PRODUCT_DEFINITION_DIGEST,
	REFERENCE_ANONYMOUS_PORTS,
} from "../src/suites/anonymous/reference-adapter.js";

const PROVIDER_ID = "reference-cloud";
const TESTED_AT_MS = 1_700_000_000_000;

/** A permitted environment. Individual tests remove one gate at a time. */
const PERMITTED_ENV: Readonly<Record<string, string | undefined>> =
	Object.freeze({
		[LIVE_ENV_KEYS.enable]: "1",
		[LIVE_ENV_KEYS.providers]: `other-cloud,${PROVIDER_ID}`,
		[LIVE_ENV_KEYS.credentialRef]: `hobo-secret://tenant-1/live-conformance/${PROVIDER_ID}`,
		[LIVE_ENV_KEYS.providerDocsCheckedAt]: "2026-08-01",
		[LIVE_ENV_KEYS.maximumResources]: "2",
	});

/** A deterministic stand-in for a signing key. No cryptography lives here. */
const TEST_SIGNER = {
	id: "test-signer/v1",
	sign(digest: string): string {
		return `sig:${digestOf(`${digest}:test-key`).slice("sha256:".length, 32)}`;
	},
};

function livePorts(
	overrides: Partial<LiveConformancePorts> = {},
): LiveConformancePorts {
	const destroyed: string[] = [];
	return {
		...REFERENCE_ANONYMOUS_PORTS,
		now: () => TESTED_AT_MS,
		newRunId: () => "abc123",
		provision: (request): LiveResourceHandle => ({
			id: `${request.kind}-${request.sequence}`,
			kind: request.kind,
			runTag: request.runTag,
		}),
		cleanup: (handles): LiveCleanupOutcome => {
			for (const handle of handles) destroyed.push(handle.id);
			return {
				attempted: handles.map((handle) => handle.id),
				destroyed: [...destroyed],
				leaked: [],
				detail: "all tagged resources destroyed",
			};
		},
		signer: TEST_SIGNER,
		...overrides,
	};
}

const LIVE_OPTIONS = {
	providerId: PROVIDER_ID,
	productDefinitionId: "reference.claimable-postgres",
	productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
	adapterVersion: "1.4.2",
	providerClass: "verified-emerging" as const,
	creatorAuthorityAfterClaim: "absent" as const,
	claimActionCount: 1,
	sourceRefs: [
		{
			url: "https://docs.reference-cloud.example/anonymous-projects",
			checkedAt: "2026-08-01",
		},
	],
	resourceKinds: ["database", "object-store"],
};

describe("the live lane refuses by default", () => {
	it("refuses when the lane was never enabled", () => {
		const error = liveRunRefusalFor({ providerId: PROVIDER_ID, env: {} });
		expect(error?.code).toBe("LIVE_LANE_DISABLED");
		expect(error?.remediation).toContain(LIVE_ENV_KEYS.enable);
	});

	it("refuses a provider that is enabled globally but not by name", () => {
		expect(() =>
			parseLiveRunGrant({
				providerId: PROVIDER_ID,
				env: { ...PERMITTED_ENV, [LIVE_ENV_KEYS.providers]: "other-cloud" },
			}),
		).toThrow(LiveRunRefusedError);
		const error = liveRunRefusalFor({
			providerId: PROVIDER_ID,
			env: { ...PERMITTED_ENV, [LIVE_ENV_KEYS.providers]: "other-cloud" },
		});
		expect(error?.code).toBe("LIVE_LANE_PROVIDER_NOT_ENABLED");
	});

	it("refuses when no credential was supplied", () => {
		const error = liveRunRefusalFor({
			providerId: PROVIDER_ID,
			env: { ...PERMITTED_ENV, [LIVE_ENV_KEYS.credentialRef]: undefined },
		});
		expect(error?.code).toBe("LIVE_LANE_CREDENTIAL_MISSING");
	});

	it("refuses a pasted plaintext credential and never echoes it", () => {
		const error = liveRunRefusalFor({
			providerId: PROVIDER_ID,
			env: {
				...PERMITTED_ENV,
				[LIVE_ENV_KEYS.credentialRef]:
					"postgresql://app:hunter2@db.reference-cloud.example/app",
			},
		});
		expect(error?.code).toBe("LIVE_LANE_CREDENTIAL_NOT_A_REFERENCE");
		expect(error?.message).not.toContain("hunter2");
	});

	it("refuses under every recognized CI environment", () => {
		for (const key of CI_ENV_KEYS) {
			const error = liveRunRefusalFor({
				providerId: PROVIDER_ID,
				env: { ...PERMITTED_ENV, [key]: "true" },
			});
			expect(error?.code, `expected refusal under ${key}`).toBe(
				"LIVE_LANE_REFUSED_IN_CI",
			);
		}
	});

	it("refuses without a date a human checked the provider docs", () => {
		const error = liveRunRefusalFor({
			providerId: PROVIDER_ID,
			env: {
				...PERMITTED_ENV,
				[LIVE_ENV_KEYS.providerDocsCheckedAt]: undefined,
			},
		});
		expect(error?.code).toBe("LIVE_LANE_PROVIDER_DOCS_DATE_MISSING");
	});

	it("refuses an unbounded resource budget", () => {
		const error = liveRunRefusalFor({
			providerId: PROVIDER_ID,
			env: { ...PERMITTED_ENV, [LIVE_ENV_KEYS.maximumResources]: "9000" },
		});
		expect(error?.code).toBe("LIVE_LANE_RESOURCE_BUDGET_INVALID");
	});

	it("grants a fully-specified run and redacts the credential locator", () => {
		const grant = parseLiveRunGrant({
			providerId: PROVIDER_ID,
			env: PERMITTED_ENV,
		});
		expect(grant.providerId).toBe(PROVIDER_ID);
		expect(grant.maximumResources).toBe(2);
		expect(grant.providerDocsCheckedAt).toBe("2026-08-01");
		expect(grant.redactedCredentialRef).toBe(
			"hobo-secret://tenant-1/live-conformance/…",
		);
	});
});

describe("a permitted live run", () => {
	it("tags and cleans up every resource it created", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			env: PERMITTED_ENV,
			ports: livePorts(),
		});

		expect(result.runTag).toBe(`hobo-conf-${PROVIDER_ID}-abc123`);
		expect(result.cleanup.destroyed).toEqual(["database-0", "object-store-1"]);
		expect(result.cleanup.leaked).toEqual([]);
		expect(result.artifact.evidence.checks[CLEANUP_CHECK]).toBe("pass");
	});

	it("caps resource creation at the operator's budget", async () => {
		const provisioned: string[] = [];
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			resourceKinds: ["database", "object-store", "site", "queue"],
			env: PERMITTED_ENV,
			ports: livePorts({
				provision: (request) => {
					provisioned.push(request.kind);
					return {
						id: `${request.kind}-${request.sequence}`,
						kind: request.kind,
						runTag: request.runTag,
					};
				},
			}),
		});
		expect(provisioned).toEqual(["database", "object-store"]);
		expect(result.cleanup.attempted).toHaveLength(2);
	});

	it("cleans up what it already created when provisioning dies part-way", async () => {
		const cleaned: string[] = [];
		await expect(
			runLiveAnonymousConformance({
				...LIVE_OPTIONS,
				env: PERMITTED_ENV,
				ports: livePorts({
					provision: (request) => {
						if (request.sequence > 0) {
							throw new Error("provider quota exhausted mid-run");
						}
						return {
							id: `${request.kind}-${request.sequence}`,
							kind: request.kind,
							runTag: request.runTag,
						};
					},
					cleanup: (handles) => {
						for (const handle of handles) cleaned.push(handle.id);
						return {
							attempted: handles.map((handle) => handle.id),
							destroyed: handles.map((handle) => handle.id),
							leaked: [],
							detail: "cleaned up after a failed run",
						};
					},
				}),
			}),
		).rejects.toThrow(/quota exhausted mid-run/u);
		expect(cleaned).toEqual(["database-0"]);
	});

	it("records a failing suite rather than aborting the run", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			env: PERMITTED_ENV,
			ports: livePorts({
				claim: () => {
					throw new Error("provider went away mid-claim");
				},
			}),
		});
		// A provider that breaks during the claim flow is a conformance
		// finding, not a harness crash — and the resources still get cleaned up.
		expect(result.artifact.evidence.checks["claim.verification"]).toBe("fail");
		expect(result.cleanup.leaked).toEqual([]);
		expect(evidenceIsFullyPassing(result.artifact)).toBe(false);
	});

	it("records a failed cleanup as a failed check rather than hiding it", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			env: PERMITTED_ENV,
			ports: livePorts({
				cleanup: () => {
					throw new Error("provider delete API returned 500");
				},
			}),
		});
		expect(result.cleanup.leaked).toEqual(["database-0", "object-store-1"]);
		expect(result.artifact.evidence.checks[CLEANUP_CHECK]).toBe("fail");
		expect(evidenceIsFullyPassing(result.artifact)).toBe(false);
	});

	it("refuses to destroy a resource tagged for a different run", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			resourceKinds: ["database"],
			env: PERMITTED_ENV,
			ports: livePorts({
				provision: (request) => ({
					id: `${request.kind}-${request.sequence}`,
					kind: request.kind,
					runTag: "somebody-elses-run",
				}),
			}),
		});
		expect(result.cleanup.destroyed).toEqual([]);
		expect(result.cleanup.leaked).toEqual(["database-0"]);
		expect(result.cleanup.detail).toContain("another run");
	});

	it("emits signed evidence carrying its full provenance", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			env: PERMITTED_ENV,
			ports: livePorts(),
		});

		expect(result.artifact.provenance).toEqual({
			adapterVersion: "1.4.2",
			productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
			providerDocsCheckedAt: "2026-08-01",
			runTag: `hobo-conf-${PROVIDER_ID}-abc123`,
			signerId: "test-signer/v1",
			suiteIds: [
				"hobo.anonymous.binding/v1",
				"hobo.anonymous.bootstrap/v1",
				"hobo.anonymous.claim/v1",
				"hobo.anonymous.migration/v1",
			],
		});
		expect(result.artifact.evidence.testedAt).toBe(TESTED_AT_MS);
		expect(result.artifact.evidence.expiresAt).toBe(
			TESTED_AT_MS + 30 * 24 * 60 * 60 * 1000,
		);
		expect(result.artifact.signature.startsWith("sig:")).toBe(true);
		expect(evidenceIsFullyPassing(result.artifact)).toBe(true);
	});

	it("translates suite outcomes into the trust vocabulary", async () => {
		const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS);
		expect(standardTrustChecksFrom(reports)).toEqual({
			"bootstrap.official-contract": "pass",
			"claim.documented-contract": "pass",
			"claim.verification": "pass",
			"credential.rotation": "pass",
			"portability.export-profile": "pass",
			"portability.standard-binding": "pass",
			"conformance.suite": "pass",
		});
	});
});

describe("evidence never improves on the run that produced it", () => {
	it("cannot turn a skipped check into a passing artifact", async () => {
		// One case is deliberately left out of the run.
		const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS, {
			caseIds: [
				"bootstrap/advertised-class-holds",
				"bootstrap/consent-recorded-before-effect",
				"bootstrap/withheld-consent-refuses",
				"bootstrap/proof-of-work-bounded",
				"bootstrap/allowlist-refuses-unlisted-kind",
			],
		});

		const artifact = emitAnonymousTrustEvidence({
			providerId: PROVIDER_ID,
			productDefinitionId: "reference.claimable-postgres",
			productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
			adapterVersion: "1.4.2",
			providerClass: "verified-emerging",
			providerDocsCheckedAt: "2026-08-01",
			runTag: "hobo-conf-partial",
			testedAtMs: TESTED_AT_MS,
			reports,
			creatorAuthorityAfterClaim: "absent",
			claimActionCount: 1,
			sourceRefs: LIVE_OPTIONS.sourceRefs,
			signer: TEST_SIGNER,
		});

		expect(artifact.evidence.checks["bootstrap.provider-reported-expiry"]).toBe(
			"unknown",
		);
		expect(artifact.evidence.checks["conformance.suite"]).toBe("unknown");
		expect(evidenceIsFullyPassing(artifact)).toBe(false);
	});

	it("refuses an artifact whose extra checks overwrite a skipped check with a pass", async () => {
		const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS, {
			caseIds: ["bootstrap/advertised-class-holds"],
		});

		expect(() =>
			emitAnonymousTrustEvidence({
				providerId: PROVIDER_ID,
				productDefinitionId: "reference.claimable-postgres",
				productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
				adapterVersion: "1.4.2",
				providerClass: "verified-emerging",
				providerDocsCheckedAt: "2026-08-01",
				runTag: "hobo-conf-liar",
				testedAtMs: TESTED_AT_MS,
				reports,
				creatorAuthorityAfterClaim: "absent",
				claimActionCount: 1,
				sourceRefs: LIVE_OPTIONS.sourceRefs,
				signer: TEST_SIGNER,
				additionalChecks: { "bootstrap.provider-reported-expiry": "pass" },
			}),
		).toThrow(LiveEvidenceError);
	});

	it("refuses to emit an artifact carrying credential-shaped material", () => {
		const poisonedBag = {
			schema: "hobo.conformance.anonymous-trust-evidence/v1",
			provenance: {
				adapterVersion: "1.4.2",
				productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
				providerDocsCheckedAt: "2026-08-01",
				runTag: "hobo-conf-leaky",
				signerId: "test-signer/v1",
				suiteIds: ["hobo.anonymous.bootstrap/v1"],
			},
			evidence: {
				note: "postgresql://app:hunter2@db.reference-cloud.example/app",
			},
			artifactDigest: PRODUCT_DEFINITION_DIGEST,
			signature: "sig:whatever",
		};
		// SAFETY: poisoned fixture is the assertSanitized input at this test boundary.
		const poisoned: Parameters<typeof assertSanitized>[0] =
			poisonedBag as never;

		expect(() => assertSanitized(poisoned)).toThrow(LiveEvidenceError);
	});

	it("keeps the credential locator out of the artifact entirely", async () => {
		const result = await runLiveAnonymousConformance({
			...LIVE_OPTIONS,
			env: PERMITTED_ENV,
			ports: livePorts(),
		});
		const serialized = JSON.stringify(result.artifact);
		expect(serialized).not.toContain("live-conformance");
		expect(serialized).not.toContain("hobo-secret://");
	});
});

describe("the operator command", () => {
	const adapterModule = {
		providerId: PROVIDER_ID,
		productDefinitionId: "reference.claimable-postgres",
		productDefinitionDigest: PRODUCT_DEFINITION_DIGEST,
		adapterVersion: "1.4.2",
		providerClass: "verified-emerging" as const,
		creatorAuthorityAfterClaim: "absent" as const,
		claimActionCount: 1,
		sourceRefs: LIVE_OPTIONS.sourceRefs,
		resourceKinds: ["database"],
		ports: {
			...REFERENCE_ANONYMOUS_PORTS,
			provision: (request: {
				kind: string;
				runTag: string;
				sequence: number;
			}) => ({
				id: `${request.kind}-${request.sequence}`,
				kind: request.kind,
				runTag: request.runTag,
			}),
			cleanup: (handles: readonly LiveResourceHandle[]) => ({
				attempted: handles.map((handle) => handle.id),
				destroyed: handles.map((handle) => handle.id),
				leaked: [],
				detail: "destroyed",
			}),
			signer: TEST_SIGNER,
		},
	};

	function cliOptions(env: Readonly<Record<string, string | undefined>>) {
		const lines: string[] = [];
		return {
			lines,
			options: {
				argv: [
					"--provider",
					PROVIDER_ID,
					"--adapter",
					"./reference-adapter.js",
				],
				env,
				write: (line: string) => lines.push(line),
				loadAdapter: async () => () => adapterModule,
				now: () => TESTED_AT_MS,
				newRunId: () => "abc123",
			},
		};
	}

	it("exits with a refusal and an actionable message when a gate is missing", async () => {
		const { lines, options } = cliOptions({});
		const result = await runLiveConformanceCli(options);
		expect(result.exitCode).toBe(3);
		expect(lines.join("\n")).toContain("LIVE_LANE_DISABLED");
		expect(lines.join("\n")).toContain(LIVE_ENV_KEYS.enable);
	});

	it("runs and prints the artifact when every gate is satisfied", async () => {
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli(options);
		expect(result.exitCode).toBe(0);
		const output = lines.join("\n");
		expect(output).toContain("hobo.conformance.anonymous-trust-evidence/v1");
		expect(output).toContain("destroyed 1, leaked 0");
	});

	it("writes the artifact to a file when asked", async () => {
		const written: Array<[string, string]> = [];
		const { options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			argv: [...options.argv, "--out", "evidence.json"],
			writeArtifact: async (file, contents) => {
				written.push([file, contents]);
			},
		});
		expect(result.exitCode).toBe(0);
		expect(written[0]?.[0]).toBe("evidence.json");
		expect(written[0]?.[1]).toContain("artifactDigest");
	});
	it("prints usage and exits zero for --help and -h alike", async () => {
		// Help is a success, not a usage error. An operator running `--help` in a
		// script must not have it read as a failed run.
		for (const flag of ["--help", "-h"]) {
			const { lines, options } = cliOptions(PERMITTED_ENV);
			const result = await runLiveConformanceCli({ ...options, argv: [flag] });
			expect(result.exitCode).toBe(0);
			expect(lines.join("\n")).toContain("hobo-conformance-live");
		}
	});

	it("checks --help before the required arguments", async () => {
		// So `--help` alone prints help rather than the "both required" error,
		// which is the state an operator is in precisely when they need help.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			argv: ["--help"],
		});
		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).not.toContain("error:");
	});

	it("names both required arguments and exits 2 when either is missing", async () => {
		// Exit 2 for a usage error, distinct from 3 (refused) and 1 (the run
		// failed): a wrapper script needs to tell "you typed it wrong" from
		// "the gate said no" from "the provider broke".
		for (const argv of [
			[],
			["--provider", PROVIDER_ID],
			["--adapter", "./reference-adapter.js"],
		]) {
			const { lines, options } = cliOptions(PERMITTED_ENV);
			const result = await runLiveConformanceCli({ ...options, argv });
			expect(result.exitCode).toBe(2);
			expect(lines.join("\n")).toContain(
				"--provider and --adapter are both required",
			);
		}
	});

	it("lists every required and optional environment key in the usage text", async () => {
		// The usage block is the only place an operator learns which gates exist.
		// A key that stopped being documented would be a gate nobody can satisfy.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		await runLiveConformanceCli({ ...options, argv: ["--help"] });
		const usage = lines.join("\n");
		for (const key of Object.values(LIVE_ENV_KEYS)) {
			expect(usage).toContain(key);
		}
		// And it says what the credential reference must be — a locator, never
		// the secret material itself.
		expect(usage).toContain("hobo-secret://");
	});

	it("accepts a positive integer --freshness-days and ignores anything else", async () => {
		// Silently ignoring a malformed value falls back to the default window
		// rather than running with a NaN one, which would make every freshness
		// comparison false and quietly pass a stale-docs run.
		for (const value of ["30", "0", "-1", "1.5", "abc"]) {
			const { options } = cliOptions(PERMITTED_ENV);
			const result = await runLiveConformanceCli({
				...options,
				argv: [...options.argv, "--freshness-days", value],
			});
			expect(result.exitCode).toBe(0);
		}
	});

	it("tolerates a trailing --freshness-days with no value", async () => {
		const { options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			argv: [...options.argv, "--freshness-days"],
		});
		expect(result.exitCode).toBe(0);
	});

	it("ignores an unrecognised flag rather than failing the run", async () => {
		const { options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			argv: [...options.argv, "--not-a-flag", "value"],
		});
		expect(result.exitCode).toBe(0);
	});

	it("lets a later occurrence of a flag win", async () => {
		// Last-wins is what a shell wrapper that appends a default expects.
		const { options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			argv: ["--provider", "wrong", ...options.argv],
		});
		expect(result.exitCode).toBe(0);
	});

	it("exits 1 with the adapter's message when loading it throws", async () => {
		// Not a refusal (3) and not a usage error (2): a broken adapter module is
		// a failed run, and the operator needs the loader's own message to fix it.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			loadAdapter: async () => {
				throw new TypeError("must default-export a live adapter factory");
			},
		});
		expect(result.exitCode).toBe(1);
		expect(lines.join("\n")).toContain(
			"live conformance run failed: must default-export a live adapter factory",
		);
	});

	it("stringifies a non-Error throw rather than printing [object Object]", async () => {
		// `throw "boom"` from an adapter is not hypothetical, and an error path
		// that itself produced an unreadable message would hide the cause.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			loadAdapter: async () => {
				throw "boom";
			},
		});
		expect(result.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("live conformance run failed: boom");
	});

	it("records a stale providerDocsCheckedAt without refusing the run", async () => {
		// Pinning a gap rather than an intent. The gate parses
		// HOBO_CONFORMANCE_LIVE_PROVIDER_DOCS_CHECKED_AT for *shape* (YYYY-MM-DD)
		// but never for age, and the evidence freshness window applies to the
		// artifact's own expiry (`testedAtMs + freshnessWindowMs`) rather than to
		// how long ago a human actually read the provider's docs. So a date
		// twenty-six years old passes every check and the run exits 0.
		//
		// The date is still carried into the artifact's provenance, so a
		// consumer *could* judge it — but nothing in this lane does, and the
		// usage text ("date a human last read the provider's docs") reads like a
		// gate. Flagged for whoever owns the live-lane trust model rather than
		// changed here: deciding how stale is too stale, and whether staleness
		// should refuse or merely downgrade the evidence, is a policy call.
		const { lines, options } = cliOptions({
			...PERMITTED_ENV,
			[LIVE_ENV_KEYS.providerDocsCheckedAt]: "2000-01-01",
		});
		const result = await runLiveConformanceCli(options);
		expect(result.exitCode).toBe(0);
		// It does reach the artifact, which is what makes the gap recoverable.
		expect(lines.join("\n")).toContain("2000-01-01");
	});

	it("refuses a providerDocsCheckedAt that is not a YYYY-MM-DD date", async () => {
		// The shape *is* gated, and that is the half that works: an operator who
		// exported a free-text note instead of a date is refused rather than
		// having it recorded as provenance nobody can compare.
		for (const value of ["yesterday", "2026-1-1", "", "20260101"]) {
			const { lines, options } = cliOptions({
				...PERMITTED_ENV,
				[LIVE_ENV_KEYS.providerDocsCheckedAt]: value,
			});
			const result = await runLiveConformanceCli(options);
			expect(result.exitCode).toBe(3);
			expect(lines.join("\n")).toContain(LIVE_ENV_KEYS.providerDocsCheckedAt);
		}
	});

	it("exits 1 when resources leaked even though every check passed", async () => {
		// Cleanup is reported separately from conformance precisely so this case
		// is visible: an operator whose resources leaked is being billed, and a
		// green conformance result must not mask that.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli({
			...options,
			loadAdapter: async () => () => ({
				...adapterModule,
				ports: {
					...adapterModule.ports,
					cleanup: (handles: readonly LiveResourceHandle[]) => ({
						attempted: handles.map((handle) => handle.id),
						destroyed: [],
						leaked: handles.map((handle) => handle.id),
						detail: "leaked",
					}),
				},
			}),
		});
		expect(result.exitCode).toBe(1);
		expect(lines.join("\n")).toContain("leaked 1");
	});

	it("prints the artifact to stdout when --out is absent", async () => {
		// The default has to be usable in a pipeline, so the artifact goes to
		// stdout rather than to a file nobody asked for.
		const { lines, options } = cliOptions(PERMITTED_ENV);
		const result = await runLiveConformanceCli(options);
		expect(result.exitCode).toBe(0);
		expect(lines.some((line) => line.trimStart().startsWith("{"))).toBe(true);
	});

	it("writes a trailing newline into the artifact file", async () => {
		// A file without one breaks `cat`-style concatenation and shows as a
		// no-newline-at-end-of-file diff on every commit.
		const written: Array<[string, string]> = [];
		const { options } = cliOptions(PERMITTED_ENV);
		await runLiveConformanceCli({
			...options,
			argv: [...options.argv, "--out", "evidence.json"],
			writeArtifact: async (file, contents) => {
				written.push([file, contents]);
			},
		});
		expect(written[0]?.[1].endsWith("\n")).toBe(true);
	});

	it("says where it wrote the artifact", async () => {
		const { lines, options } = cliOptions(PERMITTED_ENV);
		await runLiveConformanceCli({
			...options,
			argv: [...options.argv, "--out", "evidence.json"],
			writeArtifact: async () => {},
		});
		expect(lines.join("\n")).toContain(
			"wrote evidence artifact to evidence.json",
		);
	});
});
