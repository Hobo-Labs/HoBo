// The reference anonymous product: one that tells the truth about its own
// ownership story.
//
// This is public surface, not a test fixture. A provider adapter proves it
// conforms by being checked against the same suites this adapter passes, and
// the CLI's own integration path needs a product whose evidence is real rather
// than hand-written.
//
// Every executor is a pure function of its request, so the mandatory lane has
// no clock, no network, and no randomness. Mutation helpers below turn the
// honest adapter into the specific dishonest ones each suite must catch.

import { createHash } from "node:crypto";
import type { JsonObject } from "../../json.js";

import type { BindingProbeRequest } from "./binding.js";
import type { BootstrapAttemptRequest } from "./bootstrap.js";
import type { ClaimStepRequest } from "./claim.js";
import type { MigrationStepRequest } from "./migration.js";

export function digestOf(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export const REFERENCE_EXPORT_DIGEST = digestOf("conformance-export-payload");
export const PRODUCT_DEFINITION_DIGEST = digestOf("product-definition");

export function referenceBootstrapExecutor(
	request: BootstrapAttemptRequest,
): JsonObject {
	if (request.consent === "withheld") {
		return {
			caseId: request.caseId,
			effectAttempted: false,
			refusal: {
				code: "CONSENT_REQUIRED",
				detail: "consent was not captured before the effectful call",
			},
		};
	}
	if (!request.allowedResourceKinds.includes(request.requestedResourceKind)) {
		return {
			caseId: request.caseId,
			effectAttempted: false,
			refusal: {
				code: "RESOURCE_NOT_ALLOWLISTED",
				detail: `${request.requestedResourceKind} is not in the anonymous bootstrap allowlist`,
			},
		};
	}
	return {
		caseId: request.caseId,
		effectAttempted: true,
		consentRecordedAtMs: request.issuedAtMs,
		effectStartedAtMs: request.issuedAtMs + 500,
		observedClass: request.advertisedClass,
		leaseExpiry: {
			source: "provider-response",
			expiresAtMs: request.issuedAtMs + 3_600_000,
		},
		...(request.proofOfWorkCeiling > 0
			? {
					proofOfWork: {
						iterations: Math.floor(request.proofOfWorkCeiling / 4),
						ceiling: request.proofOfWorkCeiling,
						completed: true,
					},
				}
			: undefined),
	};
}

export function referenceClaimExecutor(request: ClaimStepRequest): JsonObject {
	const outstanding = request.requiredPostClaimActions.filter(
		(action) => !request.completedPostClaimActions.includes(action),
	);

	switch (request.step) {
		case "observe-provider-callback":
			return {
				caseId: request.caseId,
				itemStatus: "observed",
				providerReportedClaimed: true,
				independentlyVerified: false,
				creatorAuthorityAfterClaim: "rotatable",
				outstandingPostClaimActions: outstanding,
			};
		case "verify-ownership":
			return {
				caseId: request.caseId,
				itemStatus: outstanding.length > 0 ? "needs-rotation" : "verified",
				providerReportedClaimed: true,
				independentlyVerified: true,
				creatorAuthorityAfterClaim: "rotatable",
				outstandingPostClaimActions: outstanding,
				verificationRef: `verification:${request.subjectRef}`,
			};
		case "complete-post-claim-actions":
			return {
				caseId: request.caseId,
				itemStatus: "completed",
				providerReportedClaimed: true,
				independentlyVerified: true,
				creatorAuthorityAfterClaim: "absent",
				outstandingPostClaimActions: [],
				verificationRef: `verification:${request.subjectRef}`,
				evidenceRef: `evidence:${request.subjectRef}`,
			};
		case "replay-pre-claim-credential":
			return {
				caseId: request.caseId,
				itemStatus: "completed",
				providerReportedClaimed: true,
				independentlyVerified: true,
				creatorAuthorityAfterClaim: "absent",
				outstandingPostClaimActions: [],
				preClaimCredentialAccepted: false,
				verificationRef: `verification:${request.subjectRef}`,
				evidenceRef: `evidence:${request.subjectRef}`,
			};
	}
}

function bindingFor(
	request: BindingProbeRequest,
	credentialGeneration: number,
	expiresAtMs: number,
): JsonObject {
	return {
		schemaVersion: "hobo.capability-binding/v1",
		id: "binding-claimable-1",
		resourceRef: request.resourceRef,
		capabilityProfileRef: request.capabilityProfileRef,
		bindingProfileRef: "binding.postgresql/v1",
		type: "postgresql",
		endpoints: [
			{
				protocol: "postgresql",
				addressRef: { host: "db.conformance.example", port: 5432, tls: true },
				role: "primary",
			},
		],
		credentialRef: `hobo-secret://tenant-1/conformance/claimable-1-v${credentialGeneration}`,
		expiresAtMs,
		renewable: true,
		rotationSupported: true,
		revocationSupported: true,
		producerEvidenceRef: "evidence:conformance/binding/claimable-1",
	};
}

export function referenceBindingExecutor(
	request: BindingProbeRequest,
): JsonObject {
	switch (request.step) {
		case "produce":
			return {
				caseId: request.caseId,
				binding: bindingFor(request, 1, request.nowMs + 3_600_000),
			};
		case "rotate":
			return {
				caseId: request.caseId,
				previousBinding: bindingFor(request, 1, request.nowMs + 3_600_000),
				binding: bindingFor(request, 2, request.nowMs + 7_200_000),
			};
		case "use-expired":
			return {
				caseId: request.caseId,
				binding: bindingFor(request, 1, request.nowMs - 1_000),
				expiredUse: { declared: "refuse", observed: "refused" },
			};
	}
}

export function referenceMigrationExecutor(
	request: MigrationStepRequest,
): JsonObject {
	switch (request.step) {
		case "export":
			return {
				caseId: request.caseId,
				sourceRef: request.sourceRef,
				exportDigest: REFERENCE_EXPORT_DIGEST,
				state: "Exporting",
			};
		case "import":
			return {
				caseId: request.caseId,
				sourceRef: request.sourceRef,
				destinationRef: request.destinationRef,
				exportDigest: REFERENCE_EXPORT_DIGEST,
				importedDigest: REFERENCE_EXPORT_DIGEST,
				verified: true,
				cutoverCommitted: false,
				state: "Verifying",
			};
		case "cutover":
			return {
				caseId: request.caseId,
				sourceRef: request.sourceRef,
				destinationRef: request.destinationRef,
				exportDigest: REFERENCE_EXPORT_DIGEST,
				importedDigest: REFERENCE_EXPORT_DIGEST,
				verified: true,
				cutoverCommitted: true,
				state: "CutoverCommitted",
			};
		case "failed-import":
			return {
				caseId: request.caseId,
				sourceRef: request.sourceRef,
				destinationRef: request.destinationRef,
				exportDigest: REFERENCE_EXPORT_DIGEST,
				verified: false,
				cutoverCommitted: false,
				sourceIntact: true,
				state: "Importing",
			};
	}
}

export const REFERENCE_ANONYMOUS_PORTS = {
	bootstrap: referenceBootstrapExecutor,
	claim: referenceClaimExecutor,
	binding: referenceBindingExecutor,
	migration: referenceMigrationExecutor,
} as const;

/** Rewrite one executor's answer, to build the dishonest adapters under test. */
export function mutate<TRequest>(
	executor: (request: TRequest) => JsonObject,
	patch: (outcome: JsonObject, request: TRequest) => JsonObject,
): (request: TRequest) => JsonObject {
	return (request) => patch(executor(request), request);
}
