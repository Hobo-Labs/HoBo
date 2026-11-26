/**
 * What happens after a human claims the temporary account.
 *
 * Cloudflare states that "claiming does not grant the platform permanent access
 * to the account". HoBo takes that literally: the claim is the end of the
 * bootstrap relationship, not the start of a management one. Three things are
 * therefore separate and individually enforced here —
 *
 *  1. ownership is verified independently, against the provider, not inferred
 *     from the fact that we handed someone a URL;
 *  2. every residual bootstrap credential is destroyed, and the account is not
 *     considered clean until the provider agrees the token is gone;
 *  3. continuing HoBo/agent management requires a *new* authorization ceremony
 *     (`creatorAuthorityAfterClaim: "reauthorization-required"`).
 */
import type { SecretRef } from "@hobo/bindings";
import type { TemporaryAccountYardReceipt } from "./temporary-account.js";
import type {
	OneTimeActionVaultPort,
	SecretCustodyPort,
	SensitiveActionRef,
} from "./temporary-account-custody.js";
import { TemporaryAccountError } from "./temporary-account-errors.js";

export type OwnershipObservation = {
	/** True only when the provider reports a non-temporary owner. */
	readonly owned: boolean;
	/** Opaque owner identity. Never an email or account name. */
	readonly ownerRef?: string;
	readonly observedAtMs: number;
	/** Whether the bootstrap API token still authorizes anything. */
	readonly residualTokenActive: boolean;
};

/**
 * Independent verification port.
 *
 * Independent means "asks the provider", not "re-reads our own receipt". An
 * implementation backed by the receipt would make `CLAIM_NOT_VERIFIED`
 * unreachable, which is the failure mode this port exists to prevent.
 */
export type ClaimVerificationPort = {
	verifyOwnership(input: {
		readonly accountId: string;
		readonly nowMs: number;
	}): Promise<OwnershipObservation>;
};

export type ReauthorizationGrant = {
	readonly grantId: string;
	readonly accountId: string;
	/** The principal that re-authorized HoBo, post-claim. */
	readonly principalRef: string;
	readonly scopes: readonly string[];
	readonly issuedAtMs: number;
	readonly expiresAtMs: number;
	readonly ceremony: "post-claim-reauthorization";
};

export type ReauthorizationCeremonyPort = {
	request(input: {
		readonly accountId: string;
		readonly ownerRef: string;
		readonly nowMs: number;
	}): Promise<ReauthorizationGrant | undefined>;
};

export type ClaimCompletion = {
	readonly accountId: string;
	readonly ownershipVerified: true;
	readonly ownerRef: string;
	readonly ownershipVerifiedAtMs: number;
	/** Refs that were destroyed. Present so a receipt can prove revocation. */
	readonly revokedApiTokenRef: SecretRef;
	readonly revokedClaimActionRef: SensitiveActionRef;
	readonly creatorAuthorityAfterClaim: "reauthorization-required";
	readonly managementAuthorized: boolean;
	readonly reauthorizationGrant?: ReauthorizationGrant;
};

export type ClaimCompletedEvent = {
	readonly type: "yard.TemporaryAccountClaimCompleted";
	readonly occurredAtMs: number;
	readonly completion: ClaimCompletion;
};

/**
 * Hand the one-time claim URL to the audience it was minted for.
 *
 * This is the only path from a {@link SensitiveActionRef} back to a URL, it
 * works once, and it is deliberately not called by anything that builds a
 * receipt or an event.
 */
export async function redeemClaimAction(input: {
	readonly receipt: TemporaryAccountYardReceipt;
	readonly actionVault: OneTimeActionVaultPort;
	readonly audienceRef: string;
	readonly nowMs: number;
}): Promise<string> {
	if (input.nowMs >= input.receipt.lease.claimExpiresAtMs) {
		throw new TemporaryAccountError(
			"CLAIM_EXPIRED",
			"the provider-stated claim deadline has passed; provision a new temporary account",
			{ reason: "CLAIM_WINDOW_CLOSED" },
		);
	}
	return input.actionVault.redeem({
		ref: input.receipt.claimActionRef,
		audienceRef: input.audienceRef,
		nowMs: input.nowMs,
	});
}

export type CompleteClaimInput = {
	readonly receipt: TemporaryAccountYardReceipt;
	readonly verification: ClaimVerificationPort;
	readonly custody: SecretCustodyPort;
	readonly actionVault: OneTimeActionVaultPort;
	readonly reauthorization?: ReauthorizationCeremonyPort;
	readonly nowMs: number;
};

export async function completeTemporaryAccountClaim(
	input: CompleteClaimInput,
): Promise<ClaimCompletion> {
	const { receipt, nowMs } = input;

	if (nowMs >= receipt.lease.claimExpiresAtMs) {
		throw new TemporaryAccountError(
			"CLAIM_EXPIRED",
			"the claim deadline recorded from the provider response has passed",
			{ reason: "CLAIM_WINDOW_CLOSED" },
		);
	}

	const observation = await input.verification.verifyOwnership({
		accountId: receipt.accountId,
		nowMs,
	});
	if (!observation.owned || observation.ownerRef === undefined) {
		throw new TemporaryAccountError(
			"CLAIM_NOT_VERIFIED",
			"the provider does not report an owner for this account; the claim is not complete",
			{ reason: "OWNERSHIP_NOT_CONFIRMED" },
		);
	}

	// Residual bootstrap authority is destroyed before anything else is granted.
	await input.custody.destroy(receipt.apiTokenRef);
	await input.actionVault.revoke(receipt.claimActionRef);

	const afterRevocation = await input.verification.verifyOwnership({
		accountId: receipt.accountId,
		nowMs,
	});
	if (afterRevocation.residualTokenActive) {
		throw new TemporaryAccountError(
			"BOOTSTRAP_AUTHORITY_REMAINS",
			"the temporary bootstrap token still authorizes operations after revocation",
			{ reason: "TOKEN_STILL_ACTIVE" },
		);
	}
	if (await input.custody.has(receipt.apiTokenRef)) {
		throw new TemporaryAccountError(
			"BOOTSTRAP_AUTHORITY_REMAINS",
			"the temporary bootstrap token is still present in secret custody after revocation",
			{ reason: "CUSTODY_NOT_CLEARED" },
		);
	}

	const grant = await input.reauthorization?.request({
		accountId: receipt.accountId,
		ownerRef: observation.ownerRef,
		nowMs,
	});

	return {
		accountId: receipt.accountId,
		ownershipVerified: true,
		ownerRef: observation.ownerRef,
		ownershipVerifiedAtMs: observation.observedAtMs,
		revokedApiTokenRef: receipt.apiTokenRef,
		revokedClaimActionRef: receipt.claimActionRef,
		creatorAuthorityAfterClaim: "reauthorization-required",
		managementAuthorized: grant !== undefined,
		...(grant !== undefined ? { reauthorizationGrant: grant } : undefined),
	};
}

/**
 * Gate every post-claim management operation.
 *
 * Without a fresh grant this throws `REAUTHORIZATION_REQUIRED`, which is the
 * whole point of `creatorAuthorityAfterClaim: "reauthorization-required"`:
 * having bootstrapped the account buys no continuing authority over it.
 */
export function assertManagementAuthorized(
	completion: ClaimCompletion,
	nowMs: number,
): ReauthorizationGrant {
	const grant = completion.reauthorizationGrant;
	if (grant === undefined || !completion.managementAuthorized) {
		throw new TemporaryAccountError(
			"REAUTHORIZATION_REQUIRED",
			"continuing management of a claimed account needs a separate post-claim authorization ceremony",
			{ reason: "NO_GRANT" },
		);
	}
	if (nowMs >= grant.expiresAtMs) {
		throw new TemporaryAccountError(
			"REAUTHORIZATION_REQUIRED",
			"the post-claim authorization grant has expired",
			{ reason: "GRANT_EXPIRED" },
		);
	}
	return grant;
}

export function claimCompletedEvent(
	completion: ClaimCompletion,
	occurredAtMs: number,
): ClaimCompletedEvent {
	return {
		type: "yard.TemporaryAccountClaimCompleted",
		occurredAtMs,
		completion,
	};
}
