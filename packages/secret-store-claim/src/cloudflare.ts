/**
 * The Cloudflare offer: a temporary account the agent creates at deploy
 * time, which the owner claims through Cloudflare's own claim page within
 * 60 minutes, holding HoBo's config-service Worker.
 *
 * Built here: the account and its claim, through
 * `@hobo/provider-cloudflare`'s `provisionTemporaryAccountYard` (the human's
 * acceptance of Cloudflare's Terms and Privacy Policy recorded before the
 * first call, the proof-of-work budget checked, the API token into custody,
 * the claim URL into a one-time action), and the HoBo claim bundle whose
 * item carries that action. The claim URL moves from the provider package's
 * vault straight into the HoBo one-time action store; it is never returned.
 *
 * Designed, not built (ADR-0179 amendment): the config-service Worker itself
 * (secrets envelope-encrypted in a Durable Object, read by the relay with its
 * Vercel OIDC token, written by the deploy workflow with its GitHub OIDC
 * token) and its upload with the temporary token. Until the Worker exists
 * the temporary token is destroyed when provisioning returns, and the
 * offer's `runtimeBinding` stays "designed".
 *
 * Source: https://developers.cloudflare.com/workers/platform/claim-deployments/
 * (read 2026-11-12).
 */

import type { ClaimBundle, OneTimeActionStore } from "@hobo/claims";
import {
	type ConsentEvidenceInput,
	createInMemoryConsentLedger,
	createInMemoryOneTimeActionVault,
	createInMemorySecretCustody,
	isTemporaryAccountError,
	provisionTemporaryAccountYard,
	type TemporaryAccountTransportPort,
} from "@hobo/provider-cloudflare";
import {
	type ClaimScope,
	SECRET_STORE_CLAIM_ITEM,
	sealClaimAction,
	secretStoreBundleId,
	secretStoreClaimBundle,
	secretStoreClaimItem,
} from "./claim.js";
import { SecretStoreError } from "./errors.js";

// public-contract: the claim item's provider id; `hobo claim open` redeems with it.
export const CLOUDFLARE_PROVIDER_ID = "cloudflare-temporary";

/** What the plan and the skill may show: no token, no URL. */
export type CloudflareStoreReceipt = Readonly<{
	accountId: string;
	claimDeadlineMs: number;
	consentEvidenceRef: string;
}>;

export async function provisionCloudflareTemporaryStore(input: {
	readonly transport: TemporaryAccountTransportPort;
	/** The human's acceptance; absent means no account is created. */
	readonly consent: ConsentEvidenceInput | undefined;
	readonly deploymentRef: string;
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly now: Date;
	readonly idempotencyKey?: string;
}): Promise<
	Readonly<{ receipt: CloudflareStoreReceipt; bundle: ClaimBundle }>
> {
	if (input.consent === undefined)
		throw new SecretStoreError(
			"SECRET_STORE_CONSENT_REQUIRED",
			"a Cloudflare temporary account needs the owner to accept Cloudflare's Terms of Service and Privacy Policy first",
		);
	const nowMs = input.now.getTime();
	const vault = createInMemoryOneTimeActionVault();
	const custody = createInMemorySecretCustody();
	const audienceRef = `hobo-secret-store:${input.scope.sessionId}`;
	try {
		const receipt = await provisionTemporaryAccountYard({
			transport: input.transport,
			custody,
			consentLedger: createInMemoryConsentLedger({ nowMs: () => nowMs }),
			actionVault: vault,
			consent: input.consent,
			audienceRef,
			nowMs,
			...(input.idempotencyKey !== undefined
				? { idempotencyKey: input.idempotencyKey }
				: undefined),
		});
		const claimUrl = await vault.redeem({
			ref: receipt.claimActionRef,
			audienceRef,
			nowMs,
		});
		await vault.revoke(receipt.claimActionRef);
		// The Worker upload that would use it is designed only: drop it now.
		await custody.destroy(receipt.apiTokenRef);

		const deadlineMs = receipt.lease.claimExpiresAtMs;
		const bundleId = secretStoreBundleId(input.deploymentRef, nowMs);
		const action = await sealClaimAction({
			store: input.store,
			scope: input.scope,
			id: `${bundleId}.owner`,
			audience: CLOUDFLARE_PROVIDER_ID,
			value: claimUrl,
			expiresAtMs: deadlineMs,
			nowMs,
		});
		return Object.freeze({
			receipt: Object.freeze({
				accountId: receipt.accountId,
				claimDeadlineMs: deadlineMs,
				consentEvidenceRef: receipt.consentEvidenceRef,
			}),
			bundle: secretStoreClaimBundle({
				id: bundleId,
				deploymentRef: input.deploymentRef,
				items: [
					secretStoreClaimItem({
						id: SECRET_STORE_CLAIM_ITEM,
						subjectRef: `cloudflare-account:${receipt.accountId}`,
						providerId: CLOUDFLARE_PROVIDER_ID,
						strategy: "cloudflare-temporary",
						mode: "account-claim",
						oneTimeActionRef: action,
						deadlineMs,
						credentials: "reauthorized",
						// Cloudflare: claiming grants the platform no lasting access.
						creatorAuthorityAfterClaim: "reauthorization-required",
						verificationRef: `cloudflare-account:${receipt.accountId}`,
					}),
				],
			}),
		});
	} catch (error) {
		if (error instanceof SecretStoreError) throw error;
		throw new SecretStoreError(
			"SECRET_STORE_PROVIDER_FAILED",
			error instanceof Error && isTemporaryAccountError(error)
				? `Cloudflare temporary account: ${error.code}`
				: "Cloudflare temporary account could not be created",
		);
	}
}
