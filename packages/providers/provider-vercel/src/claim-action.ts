/**
 * The human claim action, kept where it belongs.
 *
 * `https://vercel.com/claim-deployment?code=…` is bearer authority over the
 * project *and* the database behind it. So it is built once, deposited into the
 * `@hobo/claims` one-time action store, and referenced by handle afterwards.
 * The `@hobo/claims` event guard already rejects a payload containing a claim
 * URL with a code — this module is the reason that guard never has to fire.
 */

import { parseSecretRef, redactSecretRef, SecretValue } from "@hobo/bindings";
import type {
	Instant,
	OneTimeActionRef,
	OneTimeActionStore,
} from "@hobo/claims";

import { VERCEL_CLAIM_DEPLOYMENT_URL } from "./management-api.js";
import { VercelProviderError } from "./provider-errors.js";
import { PROJECT_TRANSFER_CODE_TTL_MS } from "./sponsored-transfer.js";

export type ClaimActionAudience = "human-owner";

// public-contract: audience bound into encrypted ownership actions.
export const CLAIM_ACTION_AUDIENCE: ClaimActionAudience = "human-owner";

export type BuildClaimActionInput = {
	readonly transferCode: SecretValue;
	readonly projectId: string;
	/** Where Vercel sends the human if the code is invalid or expired. */
	readonly returnUrl: string;
};

/**
 * The claim URL as a {@link SecretValue}.
 *
 * Returning a plain string would be the whole leak: the value would be one
 * template literal away from a log line, and `toString`/`toJSON` on the wrapper
 * is what stops that by default.
 */
export function buildClaimAction(input: BuildClaimActionInput): SecretValue {
	let returnUrl: URL;
	try {
		returnUrl = new URL(input.returnUrl);
	} catch {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"claim action returnUrl is not a valid URL",
		);
	}
	if (returnUrl.protocol !== "https:") {
		throw new VercelProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			`claim action returnUrl must use https, got ${returnUrl.protocol.replace(":", "")}`,
		);
	}
	const url = new URL(VERCEL_CLAIM_DEPLOYMENT_URL);
	url.searchParams.set("code", input.transferCode.expose());
	url.searchParams.set("returnUrl", returnUrl.toString());
	const slug = input.projectId.replace(/[^A-Za-z0-9._~-]/gu, "-").slice(0, 96);
	// Its own custody locator: the URL is no less sensitive than the code.
	const ref = parseSecretRef(
		`hobo-token://vercel/claim-action/${slug || "project"}`,
	);
	return new SecretValue(ref, url.toString());
}

export type StoredClaimAction = {
	readonly ref: OneTimeActionRef;
	/** Safe for operator output, receipts, and UI. Never the URL. */
	readonly redactedRef: string;
	readonly deadline: Instant;
};

export type StoreClaimActionInput = {
	readonly store: OneTimeActionStore;
	readonly actionId: string;
	readonly claimAction: SecretValue;
	readonly tenantId: string;
	readonly projectId: string;
	readonly sessionId: string;
	readonly issuedAt: Instant;
	/** Provider-reported deadline. Defaults to the documented 24 hour window. */
	readonly deadline?: Instant;
};

/**
 * Deposit the claim action and hand back only a reference.
 *
 * Single-use: Vercel's accept step consumes the code, so a second redemption is
 * either a replay or a bug, and both should be refused rather than served.
 */
export async function storeClaimAction(
	input: StoreClaimActionInput,
): Promise<StoredClaimAction> {
	const deadline =
		input.deadline ?? input.issuedAt + PROJECT_TRANSFER_CODE_TTL_MS;
	if (deadline <= input.issuedAt) {
		throw new VercelProviderError(
			"CLAIM_EXPIRED",
			"claim action deadline is not in the future",
		);
	}
	const ref = await input.store.put({
		id: input.actionId,
		value: input.claimAction.expose(),
		tenantId: input.tenantId,
		projectId: input.projectId,
		sessionId: input.sessionId,
		audience: CLAIM_ACTION_AUDIENCE,
		expiresAt: deadline,
		singleUse: true,
	});
	return {
		ref,
		redactedRef: redactSecretRef(input.claimAction.ref),
		deadline,
	};
}
