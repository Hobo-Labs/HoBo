// The mandatory offline lane for the anonymous/claimable dimension.
//
// Two things are being proved here: an honest reference product passes every
// check, and each specific dishonesty the suites exist to catch is actually
// caught. A suite that only ever sees a passing adapter proves nothing.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/json.js";

import {
	ANONYMOUS_CONFORMANCE_SCHEMA,
	ANONYMOUS_SUITE_DESCRIPTORS,
	BINDING_CHECKS,
	BINDING_CONFORMANCE_SUITE,
	BOOTSTRAP_CHECKS,
	BOOTSTRAP_CONFORMANCE_SUITE,
	CLAIM_CHECKS,
	CLAIM_CONFORMANCE_SUITE,
	createAnonymousSuiteRegistry,
	MIGRATION_CHECKS,
	MIGRATION_CONFORMANCE_SUITE,
	runAnonymousConformance,
	runAnonymousSuite,
	UnsupportedCheckError,
} from "../src/suites/anonymous/index.js";
import {
	mutate,
	REFERENCE_ANONYMOUS_PORTS,
	referenceBindingExecutor,
	referenceBootstrapExecutor,
	referenceClaimExecutor,
	referenceMigrationExecutor,
} from "../src/suites/anonymous/reference-adapter.js";

describe("anonymous conformance — the honest reference product", () => {
	it("passes every check in all four dimensions", async () => {
		const reports = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS, {
			subjectId: "reference.claimable-postgres",
		});

		expect(reports).toHaveLength(4);
		for (const report of reports) {
			expect(report.schema).toBe(ANONYMOUS_CONFORMANCE_SCHEMA);
			expect(report.subjectId).toBe("reference.claimable-postgres");
			expect(
				Object.entries(report.checks).filter(
					([, outcome]) => outcome !== "pass",
				),
			).toEqual([]);
			expect(report.ok).toBe(true);
		}
	});

	it("is deterministic across repeated runs", async () => {
		const first = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS);
		const second = await runAnonymousConformance(REFERENCE_ANONYMOUS_PORTS);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
	});

	it("registers all four suites and the checks they can decide", () => {
		const registry = createAnonymousSuiteRegistry();
		expect(registry.list().map((suite) => suite.suiteId)).toEqual([
			"hobo.anonymous.binding/v1",
			"hobo.anonymous.bootstrap/v1",
			"hobo.anonymous.claim/v1",
			"hobo.anonymous.migration/v1",
		]);
		expect(registry.get("hobo.anonymous.claim/v1")?.dimension).toBe("claim");
		expect(registry.checks()).toContain(CLAIM_CHECKS.independentVerification);
		expect(registry.checks()).toHaveLength(
			ANONYMOUS_SUITE_DESCRIPTORS.flatMap((suite) => suite.checks).length,
		);
	});

	it("refuses to register the same suite twice", () => {
		const registry = createAnonymousSuiteRegistry();
		const descriptor = ANONYMOUS_SUITE_DESCRIPTORS.at(0);
		if (descriptor === undefined) throw new Error("no suites are registered");
		expect(() => registry.register(descriptor)).toThrow(/already registered/u);
	});
});

describe("bootstrap conformance catches a dishonest bootstrap", () => {
	it("fails when the effect runs before consent is recorded", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome) =>
				outcome.consentRecordedAtMs === undefined
					? outcome
					: { ...outcome, consentRecordedAtMs: 1_700_000_001_000 },
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.consentBeforeEffect]).toBe("fail");
		expect(report.ok).toBe(false);
	});

	it("fails when withheld consent still provisions", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome, request) =>
				request.consent === "withheld"
					? { caseId: request.caseId, effectAttempted: true }
					: outcome,
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.consentBeforeEffect]).toBe("fail");
	});

	it("fails when the lease expiry is a locally invented timer", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome) =>
				outcome.leaseExpiry === undefined
					? outcome
					: {
							...outcome,
							leaseExpiry: {
								source: "local-timer",
								expiresAtMs: 1_700_003_600_000,
							},
						},
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.providerReportedExpiry]).toBe("fail");
	});

	it("fails when proof-of-work runs past its declared ceiling", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome) =>
				outcome.proofOfWork === undefined
					? outcome
					: {
							...outcome,
							proofOfWork: {
								iterations: 99_999,
								ceiling: 4096,
								completed: true,
							},
						},
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.proofOfWorkBounded]).toBe("fail");
	});

	it("fails when a resource outside the allowlist is provisioned anyway", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome, request) =>
				request.requestedResourceKind === "gpu-cluster"
					? {
							caseId: request.caseId,
							effectAttempted: true,
							observedClass: request.advertisedClass,
						}
					: outcome,
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.resourceAllowlistFailClosed]).toBe(
			"fail",
		);
	});

	it("fails when the advertised class is not the class performed", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			mutate(referenceBootstrapExecutor, (outcome) =>
				outcome.observedClass === undefined
					? outcome
					: { ...outcome, observedClass: "sponsor" },
			),
		);
		expect(report.checks[BOOTSTRAP_CHECKS.advertisedClassHolds]).toBe("fail");
	});
});

describe("claim conformance catches a claim that never moved authority", () => {
	it("fails when a provider callback alone completes the item", async () => {
		const report = await runAnonymousSuite(
			CLAIM_CONFORMANCE_SUITE,
			mutate(referenceClaimExecutor, (outcome, request) =>
				request.step === "observe-provider-callback"
					? { ...outcome, itemStatus: "completed", independentlyVerified: true }
					: outcome,
			),
		);
		expect(report.checks[CLAIM_CHECKS.callbackIsNotOwnership]).toBe("fail");
	});

	it("fails when independent verification never happens", async () => {
		const report = await runAnonymousSuite(
			CLAIM_CONFORMANCE_SUITE,
			mutate(referenceClaimExecutor, (outcome, request) =>
				request.step === "verify-ownership"
					? { ...outcome, independentlyVerified: false }
					: outcome,
			),
		);
		expect(report.checks[CLAIM_CHECKS.independentVerification]).toBe("fail");
	});

	it("fails when the item completes with rotation still outstanding", async () => {
		const report = await runAnonymousSuite(
			CLAIM_CONFORMANCE_SUITE,
			mutate(referenceClaimExecutor, (outcome, request) =>
				request.step === "verify-ownership"
					? { ...outcome, itemStatus: "completed" }
					: outcome,
			),
		);
		expect(report.checks[CLAIM_CHECKS.obligationsGateCompletion]).toBe("fail");
	});

	it("fails when bootstrap authority is still retained after revocation", async () => {
		const report = await runAnonymousSuite(
			CLAIM_CONFORMANCE_SUITE,
			mutate(referenceClaimExecutor, (outcome, request) =>
				request.step === "complete-post-claim-actions"
					? { ...outcome, creatorAuthorityAfterClaim: "retained" }
					: outcome,
			),
		);
		expect(report.checks[CLAIM_CHECKS.obligationsGateCompletion]).toBe("fail");
	});

	it("fails when a pre-claim credential still authenticates", async () => {
		const report = await runAnonymousSuite(
			CLAIM_CONFORMANCE_SUITE,
			mutate(referenceClaimExecutor, (outcome, request) =>
				request.step === "replay-pre-claim-credential"
					? { ...outcome, preClaimCredentialAccepted: true }
					: outcome,
			),
		);
		expect(report.checks[CLAIM_CHECKS.preClaimCredentialRevoked]).toBe("fail");
	});
});

describe("binding conformance catches a leaky or fake-portable binding", () => {
	it("fails when the produced binding cannot survive its own parse boundary", async () => {
		// The binding round-trip check was the one declared check in this module
		// with no dishonesty case: it only ever saw the honest reference adapter,
		// so nothing proved it catches anything. A binding whose id the boundary
		// refuses is the cheapest way to be caught by it.
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome) =>
				outcome.binding === undefined
					? outcome
					: {
							...outcome,
							binding: {
								// SAFETY: assertion to `tcome.binding as JsonObject),` is required at this boundary.
								...(outcome.binding as JsonObject),
								id: "",
							},
						},
			),
		);
		expect(report.checks[BINDING_CHECKS.roundTrip]).toBe("fail");
		expect(report.ok).toBe(false);
	});

	it("fails when a credential is inlined into the endpoint host", async () => {
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome) => {
				// SAFETY: assertion to `tcome.binding as JsonObject; ` is required at this boundary.
				const binding = outcome.binding as JsonObject;
				return {
					...outcome,
					binding: {
						...binding,
						endpoints: [
							{
								protocol: "postgresql",
								addressRef: {
									host: "user:hunter2@db.conformance.example",
									port: 5432,
									tls: true,
								},
								role: "primary",
							},
						],
					},
				};
			}),
		);
		expect(report.checks[BINDING_CHECKS.endpointsNonSecret]).toBe("fail");
	});

	it("fails when the credential is a plaintext connection string", async () => {
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome) => {
				// SAFETY: assertion to `tcome.binding as JsonObject; ` is required at this boundary.
				const binding = outcome.binding as JsonObject;
				return {
					...outcome,
					binding: {
						...binding,
						credentialRef:
							"postgresql://app:hunter2@db.conformance.example/app",
					},
				};
			}),
		);
		expect(report.checks[BINDING_CHECKS.credentialsAreRefs]).toBe("fail");
	});

	it("fails when rotation quietly moves the resource", async () => {
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome, request) => {
				if (request.step !== "rotate") return outcome;
				// SAFETY: assertion to `tcome.binding as JsonObject; ` is required at this boundary.
				const binding = outcome.binding as JsonObject;
				return {
					...outcome,
					binding: {
						...binding,
						resourceRef: "resource:conformance/replacement",
					},
				};
			}),
		);
		expect(report.checks[BINDING_CHECKS.rotationPreservesIdentity]).toBe(
			"fail",
		);
	});

	it("fails when rotation leaves the credential unchanged", async () => {
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome, request) => {
				if (request.step !== "rotate") return outcome;
				return { ...outcome, binding: outcome.previousBinding };
			}),
		);
		expect(report.checks[BINDING_CHECKS.rotationPreservesIdentity]).toBe(
			"fail",
		);
	});

	it("fails when an expired binding is still accepted", async () => {
		const report = await runAnonymousSuite(
			BINDING_CONFORMANCE_SUITE,
			mutate(referenceBindingExecutor, (outcome, request) =>
				request.step === "use-expired"
					? {
							...outcome,
							expiredUse: { declared: "refuse", observed: "accepted" },
						}
					: outcome,
			),
		);
		expect(report.checks[BINDING_CHECKS.expiryBehavesAsDeclared]).toBe("fail");
	});
});

describe("migration conformance catches an export with no exit", () => {
	it("fails when export produces no integrity digest", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			mutate(referenceMigrationExecutor, (outcome) => {
				const { exportDigest: _dropped, ...rest } = outcome;
				return rest;
			}),
		);
		expect(report.checks[MIGRATION_CHECKS.exportIntegrityDigest]).toBe("fail");
	});

	it("fails when the import is verified against the source itself", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			mutate(referenceMigrationExecutor, (outcome, request) =>
				request.step === "import"
					? { ...outcome, destinationRef: request.sourceRef }
					: outcome,
			),
		);
		expect(
			report.checks[MIGRATION_CHECKS.importVerifiedAtDistinctDestination],
		).toBe("fail");
	});

	it("fails when the imported bytes do not match the export digest", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			mutate(referenceMigrationExecutor, (outcome, request) =>
				request.step === "import"
					? { ...outcome, importedDigest: `sha256:${"0".repeat(64)}` }
					: outcome,
			),
		);
		expect(
			report.checks[MIGRATION_CHECKS.importVerifiedAtDistinctDestination],
		).toBe("fail");
	});

	it("fails when cutover commits against an unverified destination", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			mutate(referenceMigrationExecutor, (outcome, request) =>
				request.step === "failed-import"
					? { ...outcome, cutoverCommitted: true }
					: outcome,
			),
		);
		expect(report.checks[MIGRATION_CHECKS.cutoverAfterVerification]).toBe(
			"fail",
		);
	});

	it("fails when a failed import takes the source with it", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			mutate(referenceMigrationExecutor, (outcome, request) =>
				request.step === "failed-import"
					? { ...outcome, sourceIntact: false }
					: outcome,
			),
		);
		expect(report.checks[MIGRATION_CHECKS.sourceSurvivesFailedImport]).toBe(
			"fail",
		);
	});
});

describe("the harness never turns an absent answer into a pass", () => {
	it("reports unknown for a case the executor cannot exercise", async () => {
		const report = await runAnonymousSuite(
			MIGRATION_CONFORMANCE_SUITE,
			(request) => {
				if (request.step === "export") {
					throw new UnsupportedCheckError("this provider has no export API");
				}
				return referenceMigrationExecutor(request);
			},
		);
		expect(report.checks[MIGRATION_CHECKS.exportIntegrityDigest]).toBe(
			"unknown",
		);
		expect(report.ok).toBe(false);
	});

	it("reports unknown for a case that was filtered out of the run", async () => {
		const report = await runAnonymousSuite(
			BOOTSTRAP_CONFORMANCE_SUITE,
			referenceBootstrapExecutor,
			{ caseIds: ["bootstrap/advertised-class-holds"] },
		);
		expect(report.checks[BOOTSTRAP_CHECKS.advertisedClassHolds]).toBe("pass");
		expect(report.checks[BOOTSTRAP_CHECKS.providerReportedExpiry]).toBe(
			"unknown",
		);
		expect(report.ok).toBe(false);
	});

	it("fails rather than crashes when an executor throws", async () => {
		const report = await runAnonymousSuite(CLAIM_CONFORMANCE_SUITE, () => {
			throw new Error("provider API returned 503");
		});
		expect(
			Object.values(report.checks).every((outcome) => outcome === "fail"),
		).toBe(true);
		expect(report.cases[0]?.failureCode).toBe("executor.threw");
	});

	it("fails when an executor answers with a shape that does not parse", async () => {
		const report = await runAnonymousSuite(BINDING_CONFORMANCE_SUITE, () => ({
			caseId: "wrong-case",
		}));
		expect(report.cases[0]?.failureCode).toBe("executor.unparseable-outcome");
		expect(report.ok).toBe(false);
	});
});

describe("the suites cover every check they declare", () => {
	// The binding round-trip check was declared with no dishonesty case: it only
	// ever saw the honest reference adapter, so nothing proved it catches
	// anything. A check nothing can fail is indistinguishable from a check that
	// is not there, which is exactly what this module refuses in a *product* —
	// the same standard has to apply to the suites themselves.
	//
	// This guard reads its own file, so nothing here may spell a check in
	// `NAMESPACE.key` form: a comment doing so would satisfy the guard on the
	// case's behalf. Falsifying it is what caught that.
	it.each([
		["BOOTSTRAP_CHECKS", BOOTSTRAP_CHECKS],
		["CLAIM_CHECKS", CLAIM_CHECKS],
		["BINDING_CHECKS", BINDING_CHECKS],
		["MIGRATION_CHECKS", MIGRATION_CHECKS],
	])("%s has a dishonesty case for every check", (namespace, checks) => {
		const source = readFileSync(
			new URL("./anonymous-conformance.test.ts", import.meta.url),
			"utf8",
		);
		expect(
			Object.keys(checks).filter(
				(key) => !source.includes(`${namespace}.${key}`),
			),
		).toEqual([]);
	});
});
