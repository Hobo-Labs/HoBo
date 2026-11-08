/**
 * The effectful driver for `upstash.temporary-redis/v1`.
 *
 * Four things this file is careful about:
 *
 * 1. **The token never leaves.** `provision` returns a record whose only
 *    credential-shaped field is a SecretRef. The plaintext exists inside one
 *    function scope and goes straight to custody.
 * 2. **Expiry is whatever the provider said.** There is no 72-hour timer here.
 *    If the response stops reporting an expiry, the record says so rather than
 *    substituting the documented number.
 * 3. **A claim is not complete when the expiry disappears.** The creating
 *    party still holds a working token afterwards, so the claim stays open on
 *    a blocking rotation ceremony until someone attests it happened.
 * 4. **There is no teardown.** This surface publishes no delete endpoint, so
 *    `destroy` refuses rather than pretending, except where expiry has already
 *    done the job.
 */
import type { CapabilityBinding, SecretRef } from "@hobo/bindings";
import {
	parseResourceLifecycleObservation,
	type ResourceLifecycleContext,
	type ResourceLifecycleObservation,
} from "@hobo/core";

import type {
	UpstashClaimAction as UpstashClaimActionWire,
	UpstashClaimPlan as UpstashClaimPlanWire,
	UpstashDestroyOutcome as UpstashDestroyOutcomeWire,
	UpstashTemporaryRedis as UpstashTemporaryRedisWire,
} from "./_generated/temporary_redis_pb.js";
import { buildUpstashCapabilityBinding } from "./binding.js";
import type { UpstashClient } from "./client.js";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
import {
	UPSTASH_DEFINITION_ID,
	UPSTASH_PROVIDER_ID,
	UPSTASH_UNCLAIMED_LIMITS,
} from "./definition.js";
import { UpstashProviderError } from "./errors.js";
import type { StartRedisDatabase, StartRedisMetrics } from "./start-redis.js";
import type { DomainView } from "./wire.js";

export type UpstashClaimState =
	| "unclaimed"
	| "claimed-pending-rotation"
	| "complete"
	| "expired";

/**
 * Evidence that the human claim ceremony happened.
 *
 * The anonymous surface has no status field and no authenticated read, so
 * there is no call that answers "was this claimed?". Rather than infer it from
 * something that only correlates, the driver takes an attestation: somebody
 * says the ceremony completed, and says who and against what evidence. That
 * keeps the honest answer — *we cannot observe this* — visible in the type
 * instead of buried in a heuristic.
 */
export type ClaimAttestation = {
	readonly claimedAtMs: number;
	/** Who completed the ceremony in the Upstash console. */
	readonly attestedBy: string;
	/** Locator for the evidence. Never a credential. */
	readonly evidenceRef: string;
};

export type UpstashClaimActionKind = "human-ceremony" | "owner-console";

// domain-view: `kind` is the two-member ceremony union the wire form can only
// carry as a string, and an absent `url` stays absent rather than becoming the
// empty string proto3 would otherwise allow.
export type UpstashClaimAction = DomainView<
	UpstashClaimActionWire,
	{
		kind: UpstashClaimActionKind;
		url?: string;
	}
>;

// domain-view: pins the claim boundary as literal types — a plan naming the
// wrong strategy, boundary, resource kind, or atomicity fails to compile
// instead of failing a CUE check later — and spells `state` with the CUE
// vocabulary rather than the numeric proto enum.
export type UpstashClaimPlan = DomainView<
	UpstashClaimPlanWire,
	{
		strategy: "resource-claim";
		/**
		 * Claiming moves one database into an Upstash account. It never
		 * transfers the account, so this is a resource boundary.
		 */
		boundary: "resource";
		resourceKind: "upstash-redis-database";
		atomicity: "single-resource";
		state: UpstashClaimState;
		/** Required here; the wire form leaves a submessage absent-able. */
		actions: readonly UpstashClaimAction[];
	}
>;

// domain-view: carries branded `SecretRef` locators rather than the plain
// strings a proto3 scalar allows, and adds the emitted `CapabilityBinding`,
// whose wire form belongs to @hobo/bindings — duplicating it in this package's
// proto would create a second definition of it.
export type UpstashTemporaryRedis = DomainView<
	UpstashTemporaryRedisWire,
	{
		schemaVersion: "hobo.provider-upstash.temporary-redis/v1";
		definitionId: typeof UPSTASH_DEFINITION_ID;
		providerId: typeof UPSTASH_PROVIDER_ID;
		credentialRef?: SecretRef;
		restUrlRef?: SecretRef;
		/**
		 * Provider-reported expiry.
		 *
		 * Never computed. A caller that wants to know what to expect *before*
		 * the call reads `limits.documentedExpiryHours`, which is named as
		 * documentation precisely so the two cannot be confused. The provider
		 * states a calendar date, so this is the start of that day — see
		 * {@link StartRedisDatabase.expiresAtMs}.
		 */
		expiresAtMs: number;
		expirySource: "provider-reported";
		observedAtMs: number;
		claim: UpstashClaimPlan;
		limits: typeof UPSTASH_UNCLAIMED_LIMITS;
	}
> & {
	readonly binding?: CapabilityBinding;
};

/**
 * An optional data-plane probe.
 *
 * Ownership asserted only by the same control-plane call that created the
 * resource is not independent evidence. Without this port, verification
 * reports `verified: false` and says why.
 */
export interface RedisProbePort {
	probe(input: {
		readonly credentialRef: SecretRef;
		readonly restEndpointUrl: string;
	}): Promise<{ readonly reachable: boolean; readonly detail: string }>;
}

export type OwnershipSignal = {
	readonly id: string;
	readonly independent: boolean;
	readonly passed: boolean;
	readonly detail: string;
};

export type OwnershipVerification = {
	readonly verified: boolean;
	readonly signals: readonly OwnershipSignal[];
	readonly reasons: readonly string[];
};

export type RotationAttestation = {
	readonly rotatedAtMs: number;
	/** Who rotated the token in the owner's Upstash console. */
	readonly attestedBy: string;
	/** Locator for the rotation evidence. Never the new token. */
	readonly evidenceRef: string;
};

export type ClaimVerification = {
	readonly state: UpstashClaimState;
	readonly complete: boolean;
	readonly blockingActions: readonly UpstashClaimAction[];
	readonly reasons: readonly string[];
};

export type DestroyOutcome = DomainView<
	UpstashDestroyOutcomeWire,
	{ manualAction?: string }
>;

export type UpstashDriverOptions = {
	readonly client: UpstashClient;
	readonly custody: SecretCustodyPort;
	readonly clock: () => number;
	readonly probe?: RedisProbePort;
	/** Evidence locator recorded on every emitted binding. */
	readonly producerEvidenceRef?: string;
	/** Independent provider absence and final usage, bound to the caller's financial scope. */
	readonly retirement?: (
		record: UpstashTemporaryRedis,
		context: ResourceLifecycleContext,
	) => Promise<ResourceLifecycleObservation>;
};

export type ProvisionInput = {
	readonly resourceRef: string;
	readonly idempotencyKey: string;
};

export type ObserveInput = {
	readonly resourceRef: string;
	readonly idempotencyKey: string;
	/** Previous record, if any. Used for independent continuity checks. */
	readonly previous?: UpstashTemporaryRedis;
	readonly claim?: ClaimAttestation;
	readonly rotation?: RotationAttestation;
};

const CLAIM_CEREMONY_ID = "upstash.claim.transfer-to-account";
const CLAIM_ROTATION_ID = "upstash.claim.rotate-rest-token";

function claimActions(
	claimUrl: string,
	claim: ClaimAttestation | undefined,
	rotation: RotationAttestation | undefined,
): readonly UpstashClaimAction[] {
	const claimed = claim !== undefined;
	return [
		{
			id: CLAIM_CEREMONY_ID,
			kind: "human-ceremony",
			description:
				"Open the console URL, sign in to Upstash, and claim the database. Until this happens the database is deleted at the reported expiry, and anyone holding its id and token can read and write it.",
			blocking: true,
			completed: claimed,
			url: claimUrl,
		},
		{
			id: CLAIM_ROTATION_ID,
			kind: "owner-console",
			description:
				"Reset the REST token in the Upstash console. The no-signup surface exposes no rotation API, and the pre-claim token keeps working until an owner does this by hand, so the creating party still holds a live credential.",
			blocking: true,
			completed: rotation !== undefined,
		},
	];
}

/**
 * Derive claim state from evidence.
 *
 * A claim is never inferred from the provider response, because the response
 * carries nothing that distinguishes a claimed database from an unclaimed one.
 * It is derived from attestations, and `complete` additionally requires the
 * rotation — the creating party's token keeps working across a claim, so a
 * claim without a rotation has not actually ended anyone's access.
 */
function claimStateFor(
	database: StartRedisDatabase,
	nowMs: number,
	claim: ClaimAttestation | undefined,
	rotation: RotationAttestation | undefined,
): UpstashClaimState {
	if (claim !== undefined) {
		return rotation === undefined ? "claimed-pending-rotation" : "complete";
	}
	if (database.expiresAtMs <= nowMs) return "expired";
	return "unclaimed";
}

export type UpstashTemporaryRedisDriver = {
	readonly definitionId: typeof UPSTASH_DEFINITION_ID;
	readonly providerId: typeof UPSTASH_PROVIDER_ID;
	provision(input: ProvisionInput): Promise<UpstashTemporaryRedis>;
	observe(input: ObserveInput): Promise<UpstashTemporaryRedis>;
	/** Read-only observation. Unlike adoption this never re-POSTs a create. */
	observeMetrics(databaseId: string): Promise<StartRedisMetrics>;
	verifyOwnership(
		record: UpstashTemporaryRedis,
	): Promise<OwnershipVerification>;
	verifyClaim(record: UpstashTemporaryRedis): ClaimVerification;
	/**
	 * Record that the human claim ceremony happened.
	 *
	 * Attestation rather than observation, because the anonymous surface
	 * exposes nothing that distinguishes a claimed database from an unclaimed
	 * one. See {@link ClaimAttestation}.
	 */
	attestClaim(
		record: UpstashTemporaryRedis,
		attestation: ClaimAttestation,
	): UpstashTemporaryRedis;
	/**
	 * Record that an owner rotated the token.
	 *
	 * Named for what it is. There is no `rotateBinding` on this driver,
	 * because a method with that name would imply the driver can rotate, and
	 * it cannot: the anonymous surface exposes no rotation API.
	 */
	attestRotation(
		record: UpstashTemporaryRedis,
		attestation: RotationAttestation,
	): UpstashTemporaryRedis;
	destroy(
		record: UpstashTemporaryRedis,
		context?: ResourceLifecycleContext,
	): Promise<DestroyOutcome>;
	assertLeaseLive(record: UpstashTemporaryRedis): void;
	/** The claim window is the lease window; missing it is terminal. */
	assertClaimable(record: UpstashTemporaryRedis): void;
};

export function createUpstashTemporaryRedisDriver(
	options: UpstashDriverOptions,
): UpstashTemporaryRedisDriver {
	const producerEvidenceRef =
		options.producerEvidenceRef ??
		"hobo.evidence/provider-upstash/temporary-redis@2026-08-08";

	/**
	 * The only place a plaintext token exists. It is deposited before this
	 * function returns and is never assigned to the record.
	 */
	async function captureCredentials(
		database: StartRedisDatabase,
		resourceRef: string,
	): Promise<{
		readonly credentialRef: SecretRef;
		readonly restUrlRef: SecretRef;
		readonly redisProtocolUrlRef?: SecretRef;
		readonly binding: CapabilityBinding;
	}> {
		const tokenRef = await depositSecret(options.custody, database.token, {
			providerId: UPSTASH_PROVIDER_ID,
			resourceRef,
			purpose: "redis-rest-token",
		});
		const urlRef = await depositSecret(
			options.custody,
			database.restEndpointUrl,
			{
				providerId: UPSTASH_PROVIDER_ID,
				resourceRef,
				purpose: "redis-rest-url",
			},
		);

		const binding = buildUpstashCapabilityBinding({
			bindingId: `${resourceRef}#redis-rest`,
			resourceRef,
			databaseId: database.databaseId,
			restEndpointHost: database.restEndpointHost,
			tokenRef,
			urlRef,
			...(database.expiresAtMs !== undefined
				? { expiresAtMs: database.expiresAtMs }
				: undefined),
			producerEvidenceRef,
		});
		const native =
			database.redisProtocolUrl === undefined
				? undefined
				: await depositSecret(options.custody, database.redisProtocolUrl, {
						providerId: UPSTASH_PROVIDER_ID,
						resourceRef,
						purpose: "redis-protocol-url",
					});
		return {
			credentialRef: tokenRef.ref,
			restUrlRef: urlRef.ref,
			binding,
			...(native === undefined
				? undefined
				: { redisProtocolUrlRef: native.ref }),
		};
	}

	async function toRecord(
		database: StartRedisDatabase,
		input: {
			readonly resourceRef: string;
			readonly adopted: boolean;
			readonly claim?: ClaimAttestation;
			readonly rotation?: RotationAttestation;
		},
	): Promise<UpstashTemporaryRedis> {
		const nowMs = options.clock();
		const captured = await captureCredentials(database, input.resourceRef);

		return {
			schemaVersion: "hobo.provider-upstash.temporary-redis/v1",
			definitionId: UPSTASH_DEFINITION_ID,
			providerId: UPSTASH_PROVIDER_ID,
			resourceRef: input.resourceRef,
			databaseId: database.databaseId,
			restEndpointHost: database.restEndpointHost,
			restEndpointUrl: database.restEndpointUrl,
			credentialRef: captured.credentialRef,
			restUrlRef: captured.restUrlRef,
			redisProtocolUrlRef: captured.redisProtocolUrlRef,
			binding: captured.binding,
			expiresAtMs: database.expiresAtMs,
			expiresAtIso: database.expiresAtIso,
			expiresRaw: database.expiresRaw,
			statedTtlDays: database.statedTtlDays,
			expirySource: "provider-reported",
			observedAtMs: nowMs,
			claim: {
				strategy: "resource-claim",
				boundary: "resource",
				resourceKind: "upstash-redis-database",
				atomicity: "single-resource",
				claimUrl: database.consoleUrl,
				state: claimStateFor(database, nowMs, input.claim, input.rotation),
				actions: claimActions(database.consoleUrl, input.claim, input.rotation),
			},
			metricsUrl: database.metricsUrl,
			limits: UPSTASH_UNCLAIMED_LIMITS,
			adopted: input.adopted,
		};
	}

	return {
		definitionId: UPSTASH_DEFINITION_ID,
		providerId: UPSTASH_PROVIDER_ID,
		async observeMetrics(databaseId) {
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
					databaseId,
				)
			)
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"metrics observation requires the exact database UUID",
				);
			return options.client.getMetrics(
				`https://upstash.com/start-redis/metrics/${databaseId}`,
				databaseId,
			);
		},

		async provision(input) {
			const outcome = await options.client.createDatabase({
				idempotencyKey: input.idempotencyKey,
			});
			return toRecord(outcome.database, {
				resourceRef: input.resourceRef,
				adopted: outcome.adopted,
			});
		},

		async observe(input) {
			const database = await options.client.adoptDatabase(input.idempotencyKey);
			if (
				input.previous !== undefined &&
				input.previous.restEndpointHost !== database.restEndpointHost
			) {
				// The endpoint moving under a stable id is how a binding
				// silently starts pointing somewhere else.
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"the observed database reports a different REST endpoint; this is not the resource that was provisioned",
					{
						detail: {
							databaseId: database.databaseId,
							expected: input.previous.restEndpointHost,
							observed: database.restEndpointHost,
						},
					},
				);
			}
			return toRecord(database, {
				resourceRef: input.resourceRef,
				adopted: true,
				...(input.claim !== undefined ? { claim: input.claim } : undefined),
				...(input.rotation !== undefined
					? { rotation: input.rotation }
					: undefined),
			});
		},

		async verifyOwnership(record) {
			const signals: OwnershipSignal[] = [];
			const reasons: string[] = [];

			// Signal 1: a fresh control-plane read, independent of the create.
			let reread: StartRedisDatabase | undefined;
			try {
				reread = await options.client.adoptDatabase(record.databaseId);
			} catch (cause) {
				signals.push({
					id: "control-plane-reread",
					independent: true,
					passed: false,
					detail:
						cause instanceof UpstashProviderError
							? cause.message
							: "control-plane read failed",
				});
				reasons.push(
					"the provider could not confirm the database on an independent read",
				);
			}
			if (reread !== undefined) {
				const matches =
					reread.databaseId === record.databaseId &&
					reread.restEndpointHost === record.restEndpointHost;
				signals.push({
					id: "control-plane-reread",
					independent: true,
					passed: matches,
					detail: matches
						? "the provider re-reports the same database id and endpoint"
						: "the provider reports a different database id or endpoint",
				});
				if (!matches)
					reasons.push("database identity changed between observations");
			}

			// Signal 2: a data-plane probe. Without it, signal 1 is the
			// provider vouching for itself.
			if (options.probe === undefined || record.credentialRef === undefined) {
				signals.push({
					id: "data-plane-probe",
					independent: true,
					passed: false,
					detail: "no independent data-plane probe is configured",
				});
				reasons.push(
					"ownership is asserted only by the provider control plane; configure a RedisProbePort for an independent check",
				);
			} else {
				const evidence = await options.probe.probe({
					credentialRef: record.credentialRef,
					restEndpointUrl: record.restEndpointUrl,
				});
				signals.push({
					id: "data-plane-probe",
					independent: true,
					passed: evidence.reachable,
					detail: evidence.detail,
				});
				if (!evidence.reachable) {
					reasons.push(
						"the data-plane probe could not reach the database with this token",
					);
				}
			}

			return {
				verified: signals.every((signal) => signal.passed),
				signals,
				reasons,
			};
		},

		verifyClaim(record) {
			const blockingActions = record.claim.actions.filter(
				(action) => action.blocking && !action.completed,
			);
			const reasons: string[] = [];
			if (record.claim.state === "expired") {
				reasons.push("the claim window closed before the database was claimed");
			}
			if (record.claim.state === "claimed-pending-rotation") {
				reasons.push(
					"the claim ceremony is attested, but the creating party's REST token keeps working until an owner resets it in the console",
				);
			}
			for (const action of blockingActions) {
				reasons.push(
					`blocking claim action ${action.id} has not been completed`,
				);
			}
			return {
				state: record.claim.state,
				complete:
					record.claim.state === "complete" && blockingActions.length === 0,
				blockingActions,
				reasons,
			};
		},

		attestClaim(record, attestation) {
			if (
				!Number.isFinite(attestation.claimedAtMs) ||
				attestation.claimedAtMs <= 0
			) {
				throw new UpstashProviderError(
					"CLAIM_NOT_VERIFIED",
					"a claim attestation needs a real claim instant",
				);
			}
			if (
				attestation.attestedBy.length === 0 ||
				attestation.evidenceRef.length === 0
			) {
				throw new UpstashProviderError(
					"CLAIM_NOT_VERIFIED",
					"a claim attestation needs an attesting party and an evidence locator",
				);
			}
			if (record.claim.state === "expired") {
				throw new UpstashProviderError(
					"CLAIM_EXPIRED",
					"the claim window closed before this database was claimed, so a claim cannot be attested against it",
					{
						detail: {
							databaseId: record.databaseId,
							expiresAtIso: record.expiresAtIso,
						},
					},
				);
			}
			const actions = record.claim.actions.map((action) =>
				action.id === CLAIM_CEREMONY_ID
					? { ...action, completed: true }
					: action,
			);
			return {
				...record,
				claim: { ...record.claim, state: "claimed-pending-rotation", actions },
			};
		},

		attestRotation(record, attestation) {
			const claimed = record.claim.actions.some(
				(action) => action.id === CLAIM_CEREMONY_ID && action.completed,
			);
			if (!claimed) {
				throw new UpstashProviderError(
					"CLAIM_NOT_VERIFIED",
					"token rotation can only be attested after the claim ceremony has been attested; rotating in the console requires an owning account",
					{ detail: { claimState: record.claim.state } },
				);
			}
			if (
				!Number.isFinite(attestation.rotatedAtMs) ||
				attestation.rotatedAtMs <= 0
			) {
				throw new UpstashProviderError(
					"CLAIM_NOT_VERIFIED",
					"a rotation attestation needs a real rotation instant",
				);
			}
			if (
				attestation.attestedBy.length === 0 ||
				attestation.evidenceRef.length === 0
			) {
				throw new UpstashProviderError(
					"CLAIM_NOT_VERIFIED",
					"a rotation attestation needs an attesting party and an evidence locator",
				);
			}
			const actions = record.claim.actions.map((action) =>
				action.id === CLAIM_ROTATION_ID
					? { ...action, completed: true }
					: action,
			);
			return {
				...record,
				claim: { ...record.claim, state: "complete", actions },
			};
		},

		async destroy(record, context) {
			const nowMs = options.clock();
			if (options.retirement !== undefined) {
				if (
					!context ||
					context.providerId !== UPSTASH_PROVIDER_ID ||
					context.productId !== UPSTASH_DEFINITION_ID ||
					context.resourceId !== record.resourceRef ||
					(context.physicalId !== undefined &&
						context.physicalId !== record.databaseId)
				)
					throw new UpstashProviderError(
						"CLEANUP_FAILED",
						"provider retirement requires the exact resource and financial scope",
					);
				const wire = await options.retirement(structuredClone(record), {
					...context,
					nowMs,
					physicalId: record.databaseId,
				});
				const { $typeName: _wireType, ...evidence } = wire;
				const observed = parseResourceLifecycleObservation(evidence, {
					...context,
					nowMs: options.clock(),
					physicalId: record.databaseId,
				});
				if (
					observed.status === "absent" &&
					observed.operationTerminal &&
					observed.usageFinal
				)
					return {
						destroyed: true,
						reason: `provider retirement and final usage confirmed by ${observed.evidenceRef}`,
						retirementEvidenceRef: observed.evidenceRef,
						usageEvidenceRef: observed.usageEvidenceRef,
					};
			}
			if (
				record.claim.state !== "unclaimed" &&
				record.claim.state !== "expired"
			) {
				throw new UpstashProviderError(
					"CLEANUP_FAILED",
					"a claimed database belongs to the owning Upstash account and can only be deleted from its console",
					{
						detail: {
							databaseId: record.databaseId,
							claimUrl: record.claim.claimUrl,
						},
					},
				);
			}
			if (record.expiresAtMs <= nowMs) {
				// A deadline is an expected lifecycle event, not a read of the
				// provider's current state. A claim or delayed reaper can outlive it.
				return {
					destroyed: false,
					reason:
						"the provider-reported expiry has passed; actual retirement remains unverified and financial exposure must be retained",
				};
			}
			// Refusing is the honest outcome. A `destroy` that quietly
			// returned success would leave a live, credentialed, anonymous
			// database behind while the caller's state said it was gone.
			throw new UpstashProviderError(
				"CLEANUP_FAILED",
				"the Upstash no-signup surface publishes no delete endpoint, so this database cannot be destroyed by the driver",
				{
					detail: {
						databaseId: record.databaseId,
						expiresAtIso: record.expiresAtIso,
					},
				},
			);
		},

		assertLeaseLive(record) {
			const nowMs = options.clock();
			// A claimed database is no longer on a lease the provider reaps.
			if (record.claim.state === "claimed-pending-rotation") return;
			if (record.claim.state === "complete") return;
			if (record.expiresAtMs <= nowMs) {
				throw new UpstashProviderError(
					"LEASE_EXPIRED",
					`the temporary database expired at ${record.expiresAtIso}`,
					{
						detail: {
							databaseId: record.databaseId,
							expiresAtMs: record.expiresAtMs,
						},
					},
				);
			}
		},

		assertClaimable(record) {
			const nowMs = options.clock();
			if (record.claim.state !== "unclaimed") return;
			if (record.expiresAtMs <= nowMs) {
				// Same instant as the lease, different consequence: the data
				// is gone *and* the claim URL will never work again, so this
				// is not something a retry recovers.
				throw new UpstashProviderError(
					"CLAIM_EXPIRED",
					`the claim window closed at ${record.expiresAtIso} with the database unclaimed; there is no re-claim path`,
					{
						detail: {
							databaseId: record.databaseId,
							claimUrl: record.claim.claimUrl,
						},
					},
				);
			}
		},
	};
}

/**
 * Manual teardown guidance.
 *
 * Exported because a caller that catches `CLEANUP_FAILED` needs to be able to
 * tell an operator what to actually do, and inventing that string at each call
 * site is how the advice drifts.
 */
export function manualTeardownGuidance(
	record: UpstashTemporaryRedis,
): DestroyOutcome {
	return {
		destroyed: false,
		reason:
			"this surface has no delete endpoint; an unclaimed database is removed only when its expiry passes",
		manualAction:
			record.claim.state === "unclaimed" || record.claim.state === "expired"
				? `Leave it to expire at ${record.expiresAtIso}, or claim it at ${record.claim.claimUrl} and then delete it from the Upstash console.`
				: `This database has been claimed, so delete it from the Upstash console of the owning account (${record.claim.claimUrl}).`,
	};
}
