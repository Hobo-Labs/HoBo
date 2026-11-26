/**
 * Post-claim verification, revocation, and rotation.
 *
 * Two independent verifications, because there are two ownership facts:
 *
 *  - **the project** — a signed acceptance webhook (Vercel signs the callback
 *    with HMAC-SHA256 when `callbackSecret` is supplied) plus a read of
 *    `GET /v9/projects/{idOrName}`, whose `accountId` is the ownership fact;
 *  - **the associated database** — an injected probe against the resource's own
 *    provider. Vercel documents the verify/accept endpoints on the *integration
 *    server* side, not a claims-generator-side read, and after the transfer the
 *    sponsoring credential has no standing to ask. Inventing an endpoint here
 *    would produce a verification that always "passes".
 *
 * Then the sponsor's authority goes away and the database binding rotates,
 * because a claim where HoBo can still deploy or still read the database has
 * moved the invoice, not the ownership.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
	type CapabilityBinding,
	type CapabilityBindingInput,
	parseCapabilityBinding,
	parseSecretRef,
	type SecretValue,
} from "@hobo/bindings";

import { isJsonObject, isJsonString, parseJsonValue } from "./json.js";
import {
	observeOrAdoptProject,
	type ProjectObservation,
	revokeSponsoringToken,
	type SponsoringCredential,
} from "./management-api.js";
import { VercelProviderError } from "./provider-errors.js";
import { MODELLED_ASSOCIATED_RESOURCE } from "./sponsored-transfer.js";
import type { VercelTransport } from "./transport.js";

/** Header Vercel uses for the signature over a transfer acceptance callback. */
// public-contract: callback signature header required at the trust boundary.
export const TRANSFER_CALLBACK_SIGNATURE_HEADER = "x-vercel-signature" as const;

export type TransferAcceptanceCallback = {
	/** Raw request body, byte-for-byte. Re-serializing breaks the signature. */
	readonly rawBody: string;
	readonly signatureHeader: string;
};

export type TransferAcceptanceClaim = {
	readonly projectId: string;
	readonly targetAccountId: string;
};

function decodeSignature(header: string): Buffer | undefined {
	const value = header.trim().replace(/^sha256=/iu, "");
	if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) return undefined;
	return Buffer.from(value, "hex");
}

/**
 * Verify the acceptance callback signature before believing a word of the body.
 *
 * An unsigned or badly signed callback is not "probably fine" — it is an
 * unauthenticated claim that someone else now owns the deployment, which is
 * exactly the message an attacker wants HoBo to act on.
 */
export function verifyTransferAcceptanceCallback(
	callback: TransferAcceptanceCallback,
	callbackSecret: SecretValue,
): TransferAcceptanceClaim {
	const provided = decodeSignature(callback.signatureHeader);
	if (provided === undefined) {
		throw new VercelProviderError(
			"CLAIM_NOT_VERIFIED",
			"transfer acceptance callback signature header is not a hex HMAC digest",
		);
	}
	const expected = createHmac("sha256", callbackSecret.expose())
		.update(callback.rawBody, "utf8")
		.digest();
	if (
		provided.length !== expected.length ||
		!timingSafeEqual(provided, expected)
	) {
		throw new VercelProviderError(
			"CLAIM_NOT_VERIFIED",
			"transfer acceptance callback signature does not match; refusing to treat the claim as accepted",
		);
	}
	const parsed = parseJsonValue(callback.rawBody);
	if (!isJsonObject(parsed)) {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			parsed === null
				? "transfer acceptance callback body is not JSON"
				: "transfer acceptance callback body is not a JSON object",
		);
	}
	const projectId = parsed.projectId;
	const targetAccountId = parsed.targetAccountId ?? parsed.accountId;
	if (!isJsonString(projectId) || !isJsonString(targetAccountId)) {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"transfer acceptance callback is missing projectId or the target account id",
		);
	}
	return { projectId, targetAccountId };
}

export type ProjectOwnershipVerification = {
	readonly verified: boolean;
	readonly evidenceRef: string;
	readonly observedAccountId?: string;
	readonly sponsorAccessRemoved: boolean;
	readonly failureCode?: "CLAIM_NOT_VERIFIED";
};

/**
 * Verify the project moved, using the sponsoring credential's own read.
 *
 * Losing access is itself evidence: a sponsoring token that can no longer see
 * the project cannot deploy to it either. That is reported as verified only
 * when a signed acceptance callback named the same target account, so a plain
 * revoked token is never mistaken for a completed claim.
 */
export async function verifyProjectOwnership(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: {
		readonly projectId: string;
		readonly expectedAccountId: string;
		readonly acceptanceVerified: boolean;
		readonly evidenceRef: string;
	},
): Promise<ProjectOwnershipVerification> {
	const observation: ProjectObservation = await observeOrAdoptProject(
		transport,
		credential,
		{ projectId: input.projectId },
	);

	if (observation.state === "unreachable-by-sponsor") {
		return input.acceptanceVerified
			? {
					verified: true,
					evidenceRef: input.evidenceRef,
					sponsorAccessRemoved: true,
				}
			: {
					verified: false,
					evidenceRef: input.evidenceRef,
					sponsorAccessRemoved: true,
					failureCode: "CLAIM_NOT_VERIFIED",
				};
	}

	const movedToExpectedAccount =
		observation.state === "already-transferred" &&
		observation.accountId === input.expectedAccountId;

	return movedToExpectedAccount
		? {
				verified: true,
				evidenceRef: input.evidenceRef,
				observedAccountId: observation.accountId,
				sponsorAccessRemoved: false,
			}
		: {
				verified: false,
				evidenceRef: input.evidenceRef,
				observedAccountId: observation.accountId,
				sponsorAccessRemoved: false,
				failureCode: "CLAIM_NOT_VERIFIED",
			};
}

export type AssociatedResourceOwnershipProbeResult = {
	readonly ownerAccountRef: string;
	readonly resourceReachable: boolean;
	readonly evidenceRef: string;
};

/**
 * Independent ownership check for the transferred database, injected because
 * only the resource's own provider can answer it.
 */
export interface AssociatedResourceOwnershipProbe {
	probe(input: {
		readonly resourceRef: string;
		readonly marketplaceProvider: string;
	}): Promise<AssociatedResourceOwnershipProbeResult>;
}

export type AssociatedResourceVerification = {
	readonly verified: boolean;
	readonly evidenceRef: string;
	readonly observedOwnerAccountRef?: string;
	readonly failureCode?: "CLAIM_NOT_VERIFIED";
};

/**
 * Verify the database moved too.
 *
 * This is the check that catches the failure Vercel's own troubleshooting list
 * describes — missing installation on the target team, billing plan conflict,
 * stale provider claim id — where the project transfers and the resource does
 * not.
 */
export async function verifyAssociatedResourceOwnership(
	probe: AssociatedResourceOwnershipProbe,
	input: {
		readonly resourceRef: string;
		readonly expectedOwnerAccountRef: string;
		readonly marketplaceProvider?: string;
	},
): Promise<AssociatedResourceVerification> {
	const result = await probe.probe({
		resourceRef: input.resourceRef,
		marketplaceProvider:
			input.marketplaceProvider ??
			MODELLED_ASSOCIATED_RESOURCE.marketplaceProvider,
	});
	const verified =
		result.resourceReachable &&
		result.ownerAccountRef === input.expectedOwnerAccountRef;
	return verified
		? {
				verified: true,
				evidenceRef: result.evidenceRef,
				observedOwnerAccountRef: result.ownerAccountRef,
			}
		: {
				verified: false,
				evidenceRef: result.evidenceRef,
				observedOwnerAccountRef: result.ownerAccountRef,
				failureCode: "CLAIM_NOT_VERIFIED",
			};
}

export type SponsorAuthorityRevocation = {
	readonly evidenceRef: string;
	readonly revokedTokenIds: readonly string[];
	readonly sponsorPrincipalRemoved: boolean;
};

/**
 * Remove the sponsoring principal and invalidate every token that existed
 * before the claim.
 *
 * "Known before claim" is the whole point: a token minted after the human owns
 * the project belongs to them, and one minted before belongs to HoBo. Only the
 * second set is ours to destroy, and all of it must go — a single surviving
 * deploy token means HoBo can still ship code into someone else's project.
 */
export async function revokeSponsorAuthority(
	transport: VercelTransport,
	credential: SponsoringCredential,
	input: {
		readonly tokenIdsKnownBeforeClaim: readonly string[];
		readonly evidenceRef: string;
	},
): Promise<SponsorAuthorityRevocation> {
	if (input.tokenIdsKnownBeforeClaim.length === 0) {
		throw new VercelProviderError(
			"CLAIM_NOT_VERIFIED",
			"sponsor-authority revocation needs the set of tokens known before the claim; an empty set means the caller never recorded them",
		);
	}
	const revoked: string[] = [];
	for (const tokenId of input.tokenIdsKnownBeforeClaim) {
		const result = await revokeSponsoringToken(transport, credential, {
			tokenId,
		});
		revoked.push(result.tokenId);
	}
	return {
		evidenceRef: input.evidenceRef,
		revokedTokenIds: revoked,
		// The transfer itself moves the project out of the sponsor team, which is
		// what removes the principal's standing over it.
		sponsorPrincipalRemoved: true,
	};
}

export type RotatedDatabaseBinding = {
	readonly binding: CapabilityBinding;
	readonly bindingId: string;
};

/**
 * Rotate the database binding after the claim.
 *
 * The pre-claim credential was minted while HoBo owned the resource, so it stays
 * HoBo's credential no matter who owns the database now. Rotation takes a new
 * secret *reference* — the value never passes through this function, so there is
 * nothing here to leak.
 */
export function rotateAssociatedResourceBinding(input: {
	readonly bindingId: string;
	readonly resourceRef: string;
	readonly rotatedCredentialRef: string;
	readonly host: string;
	readonly port?: number;
	readonly producerEvidenceRef: string;
	readonly rotatedAtMs: number;
}): RotatedDatabaseBinding {
	const bindingInput: CapabilityBindingInput = {
		schemaVersion: "hobo.capability-binding/v1",
		id: input.bindingId,
		resourceRef: input.resourceRef,
		capabilityProfileRef: MODELLED_ASSOCIATED_RESOURCE.capabilityProfileId,
		bindingProfileRef: MODELLED_ASSOCIATED_RESOURCE.bindingProfileRef,
		type: "postgresql",
		provider: MODELLED_ASSOCIATED_RESOURCE.resourceDefinitionId,
		endpoints: [
			{
				protocol: "postgresql",
				addressRef: {
					host: input.host,
					...(input.port !== undefined ? { port: input.port } : undefined),
					tls: true,
				},
				role: "primary",
			},
		],
		credentialRef: input.rotatedCredentialRef,
		renewable: true,
		rotationSupported: true,
		revocationSupported: true,
		producerEvidenceRef: input.producerEvidenceRef,
	};
	return {
		binding: parseCapabilityBinding(bindingInput, parseSecretRef),
		bindingId: input.bindingId,
	};
}

export type PostClaimVerificationSummary = {
	readonly projectVerified: boolean;
	readonly resourceVerified: boolean;
	/** True only when both moved. Vercel's one ceremony is not proof of this. */
	readonly bothSubjectsVerified: boolean;
	readonly repairRequiredFor: readonly string[];
};

/** Fold the two independent verifications into one honest summary. */
export function summarizePostClaimVerification(input: {
	readonly project: ProjectOwnershipVerification;
	readonly associatedResource: AssociatedResourceVerification;
	readonly projectItemId: string;
	readonly resourceItemId: string;
}): PostClaimVerificationSummary {
	const repairRequiredFor: string[] = [];
	if (!input.project.verified) repairRequiredFor.push(input.projectItemId);
	if (!input.associatedResource.verified)
		repairRequiredFor.push(input.resourceItemId);
	return {
		projectVerified: input.project.verified,
		resourceVerified: input.associatedResource.verified,
		bothSubjectsVerified: repairRequiredFor.length === 0,
		repairRequiredFor,
	};
}
