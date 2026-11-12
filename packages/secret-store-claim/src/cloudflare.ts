/**
 * The Cloudflare offer, as an EXPERIMENT (ADR-0179 amendment, "The
 * Cloudflare experiment"): proof that HoBo can obtain a valid Cloudflare
 * claim link through the documented REST flow, and, optionally, that HoBo's
 * config-service Worker runs on the account it hands over. It is not the
 * relay's store: the relay keeps Infisical and its Vercel project, and the
 * routing gate never picks this offer unless asked by name.
 *
 * The flow, in order:
 *
 * 1. the owner's typed acceptance of Cloudflare's Terms of Service and
 *    Privacy Policy is recorded before the first request (no account
 *    without it);
 * 2. challenge, then proof of work (on a worker thread by default), then
 *    `POST /provisioning/previews`, through `@hobo/provider-cloudflare`'s
 *    temporary-account Yard: the API token goes into custody, the claim URL
 *    into a one-time vault;
 * 3. with `worker`: the config-service Worker is uploaded with its Durable
 *    Object binding and SQLite-class migration, its health is checked, and
 *    its store is seeded once with a single-use bootstrap credential (whose
 *    hash is baked in) so no live credential is left behind. A failure here
 *    is recorded on the receipt and does not withhold the claim link;
 * 4. the claim URL moves from the vault straight into HoBo's one-time claim
 *    store (`hobo claim open secret-store` reveals it in the owner's own
 *    terminal), never returned;
 * 5. the temporary API token is destroyed, on every path.
 *
 * Source: https://developers.cloudflare.com/workers/platform/claim-deployments/
 * (read 2026-11-12: no claim-status endpoint is documented).
 */

import { randomBytes } from "node:crypto";
import type { ClaimBundle, OneTimeActionStore } from "@hobo/claims";
import {
	CONFIG_BINDING_VAR,
	CONFIG_SERVICE_COMPATIBILITY_DATE,
	CONFIG_SERVICE_MAIN_MODULE,
	CONFIG_STORE_BINDING,
	CONFIG_STORE_CLASS,
	CONFIG_STORE_MIGRATION_TAG,
	ConfigServiceClientError,
	createConfigServiceClient,
	formatWorkerBinding,
	newBootstrapCredential,
	newStoreId,
	type WorkerBindingInput,
	type WorkerModule,
} from "@hobo/config-service-worker";
import {
	type ConsentEvidenceInput,
	createInMemoryConsentLedger,
	createInMemoryOneTimeActionVault,
	createInMemorySecretCustody,
	isTemporaryAccountError,
	type PreviewChallenge,
	type PreviewChallengeSolution,
	provisionTemporaryAccountYard,
	solvePreviewChallengeOffThread,
	type TemporaryAccountTransportPort,
	type TemporaryAccountYardReceipt,
	uploadTemporaryAccountWorker,
} from "@hobo/provider-cloudflare";
import {
	type ClaimScope,
	SECRET_STORE_CLAIM_ITEM,
	sealClaimAction,
	secretStoreBundleId,
	secretStoreClaimBundle,
	secretStoreClaimItem,
} from "./claim.js";
import { SecretStoreError, secretStoreError } from "./errors.js";

// public-contract: the claim item's provider id; `hobo claim open` redeems with it.
export const CLOUDFLARE_PROVIDER_ID = "cloudflare-temporary";

/**
 * How long after Cloudflare's claim deadline finalize waits before it treats
 * the Worker still answering as proof of a claim. Cloudflare documents the
 * deletion of an unclaimed account, not how soon after the deadline it
 * happens; this margin is HoBo's assumption, checked live before relied on.
 */
export const CLOUDFLARE_DELETION_GRACE_MS = 15 * 60_000;

export type CloudflareWorkerOutcome = Readonly<
	| { outcome: "serving"; origin: string; storeId: string }
	| { outcome: "failed"; stage: "upload" | "health" | "seed"; code: string }
>;

/** What the plan and the skill may show: no token, no URL but the Worker's public origin. */
export type CloudflareStoreReceipt = Readonly<{
	accountId: string;
	claimDeadlineMs: number;
	consentEvidenceRef: string;
	worker?: CloudflareWorkerOutcome;
}>;

/** The experiment's Worker: its modules and who its binding trusts. */
export type CloudflareWorkerExperiment = Readonly<{
	modules: readonly WorkerModule[];
	binding: Omit<
		WorkerBindingInput,
		"storeId" | "bootstrapSha256" | "bootstrapExpiresAt"
	>;
	/** Reaches the Worker's workers.dev origin (health and the seed). */
	fetch?: typeof fetch;
	/** workers.dev can take a few seconds to route a new script. */
	healthAttempts?: number;
	/** Default random; fixed only where a recorded request must name it (the pact). */
	storeId?: string;
	sleep?: (ms: number) => Promise<void>;
}>;

/** A provider or Worker error's code; anything else is "UNEXPECTED". Never a message. */
function codeOf(error: Error | undefined): string {
	if (error instanceof ConfigServiceClientError) return error.code;
	if (error !== undefined && isTemporaryAccountError(error)) return error.code;
	return "UNEXPECTED";
}
async function runWorkerExperiment(
	experiment: CloudflareWorkerExperiment,
	transport: TemporaryAccountTransportPort,
	custody: ReturnType<typeof createInMemorySecretCustody>,
	receipt: TemporaryAccountYardReceipt,
	nowMs: number,
): Promise<CloudflareWorkerOutcome> {
	const storeId = experiment.storeId ?? newStoreId();
	const bootstrap = await newBootstrapCredential();
	let origin: string;
	try {
		const deployed = await uploadTemporaryAccountWorker({
			transport,
			custody,
			receipt,
			nowMs,
			upload: {
				scriptName: `hobo-config-${storeId.slice(0, 12)}`,
				mainModule: CONFIG_SERVICE_MAIN_MODULE,
				modules: experiment.modules,
				compatibilityDate: CONFIG_SERVICE_COMPATIBILITY_DATE,
				durableObject: {
					binding: CONFIG_STORE_BINDING,
					className: CONFIG_STORE_CLASS,
					migrationTag: CONFIG_STORE_MIGRATION_TAG,
				},
				plainText: {
					[CONFIG_BINDING_VAR]: formatWorkerBinding({
						...experiment.binding,
						storeId,
						bootstrapSha256: bootstrap.sha256,
						// The credential is useless once the account would be gone.
						bootstrapExpiresAt: new Date(receipt.lease.claimExpiresAtMs),
					}),
				},
			},
		});
		origin = deployed.workersDevUrl;
	} catch (error) {
		return {
			outcome: "failed",
			stage: "upload",
			code: codeOf(error instanceof Error ? error : undefined),
		};
	}
	const client = createConfigServiceClient({
		origin,
		...(experiment.fetch !== undefined
			? { fetch: experiment.fetch }
			: undefined),
	});
	const sleep =
		experiment.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = experiment.healthAttempts ?? 10;
	let healthy = false;
	let lastCode = "UNAVAILABLE";
	for (let attempt = 0; attempt < attempts && !healthy; attempt++) {
		try {
			const nonce = randomBytes(16).toString("base64url");
			healthy = (await client.health(nonce)).storeId === storeId;
			if (!healthy) lastCode = "STORE_MISMATCH";
		} catch (error) {
			lastCode = codeOf(error instanceof Error ? error : undefined);
		}
		if (!healthy && attempt + 1 < attempts) await sleep(3000);
	}
	if (!healthy) return { outcome: "failed", stage: "health", code: lastCode };
	try {
		// Burn the bootstrap credential: the experiment's store starts empty.
		await client.seed(bootstrap.credential, { relay: {}, deploy: {} });
	} catch (error) {
		return {
			outcome: "failed",
			stage: "seed",
			code: codeOf(error instanceof Error ? error : undefined),
		};
	}
	return { outcome: "serving", origin: client.origin, storeId };
}

export async function provisionCloudflareTemporaryStore(input: {
	readonly transport: TemporaryAccountTransportPort;
	/** The human's acceptance; absent means no account is created. */
	readonly consent: ConsentEvidenceInput | undefined;
	readonly deploymentRef: string;
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly now: Date;
	readonly idempotencyKey?: string;
	/** Default: on a worker thread. */
	readonly solveChallenge?: (
		challenge: PreviewChallenge,
	) => Promise<PreviewChallengeSolution>;
	/** The config-service Worker experiment; absent: the account and its claim only. */
	readonly worker?: CloudflareWorkerExperiment;
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
	let receipt: TemporaryAccountYardReceipt | undefined;
	try {
		receipt = await provisionTemporaryAccountYard({
			transport: input.transport,
			custody,
			consentLedger: createInMemoryConsentLedger({ nowMs: () => nowMs }),
			actionVault: vault,
			consent: input.consent,
			audienceRef,
			nowMs,
			solveChallenge: input.solveChallenge ?? solvePreviewChallengeOffThread,
			...(input.idempotencyKey !== undefined
				? { idempotencyKey: input.idempotencyKey }
				: undefined),
		});
		const worker =
			input.worker === undefined
				? undefined
				: await runWorkerExperiment(
						input.worker,
						input.transport,
						custody,
						receipt,
						nowMs,
					);
		const claimUrl = await vault.redeem({
			ref: receipt.claimActionRef,
			audienceRef,
			nowMs,
		});
		await vault.revoke(receipt.claimActionRef);

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
				...(worker !== undefined ? { worker } : undefined),
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
						verificationRef:
							worker?.outcome === "serving"
								? `cloudflare-worker:${worker.storeId}:${worker.origin}`
								: `cloudflare-account:${receipt.accountId}`,
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
	} finally {
		// The temporary token never outlives provisioning, whatever happened.
		if (receipt !== undefined) await custody.destroy(receipt.apiTokenRef);
	}
}

const WORKER_REF =
	/^cloudflare-worker:([a-z0-9]{16,32}):(https:\/\/[a-z0-9.-]+\.workers\.dev)$/u;

/**
 * `hobo claim finalize secret-store` for a Cloudflare item. Cloudflare
 * documents no claim-status endpoint and the temporary token is destroyed at
 * provisioning, so the one observable is the documented deletion: an
 * unclaimed account and its resources are deleted at the deadline. Finalize
 * therefore passes only after the deadline plus `graceMs`, when the
 * experiment's Worker still answers with its store id and a fresh nonce.
 * Without the Worker experiment there is nothing to observe, and finalize
 * says so rather than pass.
 */
export async function verifyCloudflareTemporaryClaim(input: {
	readonly verificationRef: string;
	readonly deadlineMs: number | undefined;
	readonly nowMs: number;
	readonly fetch?: typeof fetch;
	readonly graceMs?: number;
}): Promise<{ readonly verified: boolean; readonly evidenceRef: string }> {
	const match = WORKER_REF.exec(input.verificationRef);
	if (match === null)
		return secretStoreError(
			"SECRET_STORE_CLAIM_UNVERIFIED",
			"Cloudflare documents no claim-status endpoint and HoBo keeps no token, so a claim without the config-service Worker experiment cannot be verified; check the account in the Cloudflare dashboard",
		);
	const [, storeId = "", origin = ""] = match;
	const after =
		(input.deadlineMs ?? Number.POSITIVE_INFINITY) +
		(input.graceMs ?? CLOUDFLARE_DELETION_GRACE_MS);
	if (input.nowMs < after)
		return secretStoreError(
			"SECRET_STORE_CLAIM_UNVERIFIED",
			`too early to verify: Cloudflare deletes an unclaimed account at its deadline, so run finalize after ${Number.isFinite(after) ? new Date(after).toISOString() : "the deadline"}`,
		);
	const client = createConfigServiceClient({
		origin,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
	});
	try {
		const nonce = randomBytes(16).toString("base64url");
		const health = await client.health(nonce);
		return health.storeId === storeId
			? {
					verified: true,
					evidenceRef: `cloudflare-worker:${storeId}:served-after-deadline`,
				}
			: {
					verified: false,
					evidenceRef: "cloudflare-worker:another-store-answered",
				};
	} catch (error) {
		return {
			verified: false,
			evidenceRef: `cloudflare-worker:${storeId}:not-serving:${codeOf(error instanceof Error ? error : undefined)}`,
		};
	}
}
