/**
 * The generic offer: any store that publishes auth.md and advertises
 * anonymous agent registration in its protected-resource metadata. The agent
 * registers through `@hobo/auth-md`, starts the human claim, and seals the
 * claim URL into the HoBo claim bundle; the owner opens it with
 * `hobo claim open secret-store` and approves on the store's own page.
 *
 * Metadata beats prose: availability is `anonymousRegistrationSupported`,
 * computed from the metadata record, never from what `/auth.md` says.
 *
 * Designed, not built: how the relay reads such a store at run time. The
 * store must also accept the relay's workload identity (its Vercel OIDC
 * token); auth.md describes agent registration, not workload federation, so
 * no store HoBo can discover today says how. The offer's `runtimeBinding`
 * is therefore "designed", and selection passes it over unless asked.
 */

import { create } from "@bufbuild/protobuf";
import {
	type AgentRegistration,
	type AuthMdDiscovery,
	discoverAuthMd,
	type HttpPort,
	initiateHumanClaim,
	isAuthMdError,
	registerAnonymousAgent,
	type Scope,
	type SessionBinding,
} from "@hobo/auth-md";
import type { ClaimBundle, OneTimeActionStore } from "@hobo/claims";
import { SecretStoreEvidenceSchema } from "./_generated/secret_store_claim_pb.js";
import {
	type ClaimScope,
	SECRET_STORE_CLAIM_ITEM,
	sealClaimAction,
	secretStoreBundleId,
	secretStoreClaimBundle,
	secretStoreClaimItem,
} from "./claim.js";
import { SecretStoreError } from "./errors.js";
import {
	type ParsedSecretStoreEvidence,
	parseSecretStoreEvidence,
} from "./select.js";

// public-contract: the claim item's provider id; `hobo claim open` redeems with it.
export const AUTH_MD_PROVIDER_ID = "auth-md";

/** Probe one candidate store. Never throws for an absent or refusing store. */
export async function probeAuthMdStore(input: {
	readonly port: HttpPort;
	readonly resource: string;
	readonly requiredScopes?: readonly Scope[];
}): Promise<
	Readonly<{
		evidence: ParsedSecretStoreEvidence;
		discovery?: AuthMdDiscovery;
	}>
> {
	const unavailable = (detail: string) => ({
		evidence: parseSecretStoreEvidence(
			create(SecretStoreEvidenceSchema, {
				kind: "auth-md",
				available: false,
				detail,
			}),
		),
	});
	let discovery: AuthMdDiscovery;
	try {
		discovery = await discoverAuthMd({
			port: input.port,
			resource: input.resource,
		});
	} catch (error) {
		return unavailable(
			isAuthMdError(error)
				? `no usable auth.md metadata (${error.code})`
				: "no usable auth.md metadata",
		);
	}
	if (!discovery.anonymousRegistrationSupported)
		return unavailable("auth.md metadata advertises no anonymous registration");
	const missing = (input.requiredScopes ?? []).filter(
		(scope) => !discovery.effectiveScopes.includes(scope),
	);
	if (missing.length > 0)
		return unavailable(`auth.md metadata lacks ${missing.join(", ")}`);
	return {
		evidence: parseSecretStoreEvidence(
			create(SecretStoreEvidenceSchema, {
				kind: "auth-md",
				available: true,
			}),
		),
		discovery,
	};
}

export async function provisionAuthMdStore(input: {
	readonly port: HttpPort;
	readonly discovery: AuthMdDiscovery;
	readonly binding: SessionBinding;
	readonly requestedScopes: readonly Scope[];
	readonly deploymentRef: string;
	readonly store: OneTimeActionStore;
	readonly scope: ClaimScope;
	readonly now: Date;
}): Promise<
	Readonly<{ registration: AgentRegistration; bundle: ClaimBundle }>
> {
	const nowMs = input.now.getTime();
	let registration: AgentRegistration;
	let claimUrl: string;
	let deadlineMs: number;
	try {
		registration = await registerAnonymousAgent({
			port: input.port,
			discovery: input.discovery,
			binding: input.binding,
			requestedScopes: input.requestedScopes,
			now: () => input.now,
		});
		const initiation = await initiateHumanClaim({
			port: input.port,
			registration,
			requestedPostClaimScopes: input.requestedScopes,
			now: () => input.now,
		});
		claimUrl = initiation.claimUrl;
		deadlineMs = Date.parse(initiation.expiresAt);
	} catch (error) {
		throw new SecretStoreError(
			"SECRET_STORE_PROVIDER_FAILED",
			isAuthMdError(error)
				? `auth.md registration or claim failed (${error.code})`
				: "auth.md registration or claim failed",
		);
	}
	const bundleId = secretStoreBundleId(input.deploymentRef, nowMs);
	// HoBo treats the claim URL as bearer material even where auth.md calls it
	// safe to show: it is sealed, and opened once by the owner.
	const action = await sealClaimAction({
		store: input.store,
		scope: input.scope,
		id: `${bundleId}.owner`,
		audience: AUTH_MD_PROVIDER_ID,
		value: claimUrl,
		expiresAtMs: deadlineMs,
		nowMs,
	});
	return Object.freeze({
		registration,
		bundle: secretStoreClaimBundle({
			id: bundleId,
			deploymentRef: input.deploymentRef,
			items: [
				secretStoreClaimItem({
					id: SECRET_STORE_CLAIM_ITEM,
					subjectRef: input.discovery.metadata.resource,
					providerId: AUTH_MD_PROVIDER_ID,
					strategy: "auth-md",
					mode: "account-claim",
					oneTimeActionRef: action,
					deadlineMs,
					credentials: "rotated",
					// auth.md forces rotation after the human claims the work.
					creatorAuthorityAfterClaim: "reauthorization-required",
					verificationRef: `authmd-registration:${registration.registrationRef}`,
				}),
			],
		}),
	});
}
