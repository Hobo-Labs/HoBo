/**
 * The claim that hands a secret store to its owner, as a HoBo claim bundle
 * (`@hobo/claims`), so `hobo claim status|open|finalize` drives it like any
 * other ownership ceremony.
 *
 * Bearer material (a provider claim URL, a sealed admin credential) goes into
 * the one-time action store, encrypted, bound to tenant, project, session and
 * audience, single-use, with an expiry; the claim item carries only the
 * action's reference. `hobo claim open <item>` redeems it in the owner's own
 * terminal. Nothing here returns, logs or throws the value.
 *
 * The scope matches the one `hobo claim open` redeems with: tenant
 * `HOBO_TENANT` (default "default"), project `HOBO_PROJECT` (default the
 * deployment ref), session the deployment ref, audience the item's provider.
 */
import type {
	ClaimBundle,
	ClaimItem,
	CreatorAuthorityAfterClaim,
	CredentialContinuity,
	OneTimeActionStore,
	OwnershipTransitionMode,
} from "@hobo/claims";
import { secretStoreError } from "./errors.js";

// public-contract: the claim item id `hobo claim open|finalize` takes for the store.
export const SECRET_STORE_CLAIM_ITEM = "secret-store";

export type ClaimScope = Readonly<{
	tenantId: string;
	projectId: string;
	sessionId: string;
}>;

/** The scope `hobo claim open` redeems a deployment's actions with. */
export function claimScopeFor(
	deploymentRef: string,
	env: Readonly<Record<string, string | undefined>>,
): ClaimScope {
	return Object.freeze({
		tenantId: env.HOBO_TENANT ?? "default",
		projectId: env.HOBO_PROJECT ?? deploymentRef,
		sessionId: deploymentRef,
	});
}

/** A bundle id `#SecretStoreBinding.claimBundleId` accepts. */
export function secretStoreBundleId(
	deploymentRef: string,
	nowMs: number,
	suffix = "",
): string {
	const ref = deploymentRef
		.toLowerCase()
		.replaceAll(/[^a-z0-9._-]/gu, "-")
		.slice(0, 64);
	return `secret-store.${ref || "deployment"}.${suffix}${Math.trunc(nowMs)}`;
}

// The file-backed store `hobo claim` uses takes ids of this shape.
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Seal `value` for one redemption by the item's audience; returns the reference. */
export async function sealClaimAction(input: {
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly id: string;
	/** The claim item's provider id: `hobo claim open` redeems with it. */
	readonly audience: string;
	readonly value: string;
	readonly expiresAtMs: number;
	readonly nowMs: number;
	/** Default true. False only for HoBo's own revocation material, revoked after use. */
	readonly singleUse?: boolean;
}): Promise<string> {
	if (!ACTION_ID.test(input.id) || input.value === "")
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"a claim action needs a plain id and a value",
		);
	if (input.expiresAtMs <= input.nowMs)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			`the claim action ${input.id} would already be expired`,
		);
	const ref = await input.store.put({
		id: input.id,
		value: input.value,
		tenantId: input.scope.tenantId,
		projectId: input.scope.projectId,
		sessionId: input.scope.sessionId,
		audience: input.audience,
		expiresAt: input.expiresAtMs,
		singleUse: input.singleUse ?? true,
	});
	return ref.id;
}

/** One claim item for a secret store, refs only. */
export function secretStoreClaimItem(input: {
	readonly id: string;
	readonly subjectRef: string;
	readonly providerId: string;
	readonly strategy: string;
	readonly mode: OwnershipTransitionMode;
	readonly oneTimeActionRef: string;
	readonly deadlineMs: number;
	readonly credentials: CredentialContinuity;
	readonly creatorAuthorityAfterClaim: CreatorAuthorityAfterClaim;
	readonly verificationRef: string;
}): ClaimItem {
	const item: ClaimItem = {
		id: input.id,
		subjectRef: input.subjectRef,
		subjectKind: "resource",
		providerId: input.providerId,
		claimStrategyRef: `secret-store:${input.strategy}`,
		mode: input.mode,
		oneTimeActionRef: input.oneTimeActionRef,
		deadline: input.deadlineMs,
		continuity: {
			endpoint: "preserved",
			data: "preserved",
			credentials: input.credentials,
		},
		creatorAuthorityAfterClaim: input.creatorAuthorityAfterClaim,
		verificationRef: input.verificationRef,
		// Revocation of HoBo's own bootstrap authority is part of verification
		// (`verifySelfHostedInfisicalClaim`), so finalize cannot pass without it.
		postClaimActions: [],
		completedPostClaimActions: [],
		status: "pending",
	};
	return Object.freeze(item);
}

/** The bundle: one item per independent ceremony, never called atomic. */
export function secretStoreClaimBundle(input: {
	readonly id: string;
	readonly deploymentRef: string;
	readonly items: readonly ClaimItem[];
}): ClaimBundle {
	if (input.items.length === 0)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"a claim bundle needs at least one item",
		);
	const deadlines = input.items
		.map((item) => item.deadline)
		.filter((deadline): deadline is number => deadline !== undefined);
	const bundle: ClaimBundle = {
		schemaVersion: "hobo.claim-bundle/v1",
		id: input.id,
		deploymentRef: input.deploymentRef,
		items: input.items,
		dependencyEdges: [],
		atomicity:
			input.items.length === 1 ? "single-resource" : "best-effort-saga",
		...(deadlines.length > 0
			? { earliestDeadline: Math.min(...deadlines) }
			: undefined),
		compensation: {
			onTimeout: "retain-until-provider-expiry",
			onPartialClaim: "continue-and-repair",
		},
		status: "pending",
	};
	return Object.freeze(bundle);
}
