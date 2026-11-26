/**
 * The effectful driver for `prisma.claimable-postgres/v1`.
 *
 * Same three commitments as the Neon driver, with one honest difference:
 * Prisma's expiry is **not** provider-reported. The pinned `create-db` CLI
 * computes `deletionDate` as `Date.now() + ttl` on the machine that ran it, so
 * the record labels it `cli-local-clock` and the documented 24-hour window is
 * recorded separately as the *documented* basis. A caller that needs a
 * provider-attested deadline should not use this product for that decision.
 */
import {
	type CapabilityBinding,
	type NonSecretEndpointRef,
	parseSecretRef,
	type SecretRef,
} from "@hobo/bindings";
import {
	parseResourceLifecycleObservation,
	type ResourceLifecycleContext,
	type ResourceLifecycleObservation,
} from "@hobo/core";

import type {
	PrismaAssociatedResourceRef as PrismaAssociatedResourceRefWire,
	PrismaClaimAction as PrismaClaimActionWire,
	PrismaClaimPlan as PrismaClaimPlanWire,
	PrismaDestroyOutcome as PrismaDestroyOutcomeWire,
} from "./_generated/provider_prisma_postgres_pb.js";
import { buildPrismaCapabilityBinding } from "./binding.js";
import type {
	CreateInput,
	PrismaClient,
	PrismaResourceSnapshot,
} from "./client.js";
import { parsePostgresConnectionUri } from "./connection-string.js";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
import { PrismaProviderError } from "./errors.js";
import type { PrismaCreateResult } from "./output.js";
import {
	assertAllowedDatabaseHost,
	assertAllowedProviderUrl,
	DEFAULT_CLAIM_URL_POLICY,
} from "./urls.js";
import type { DomainView } from "./wire.js";

// public-contract: stable Resource Definition identifier.
export const PRISMA_DEFINITION_ID = "prisma.claimable-postgres/v1";
// public-contract: provider identifier used in offers and receipts.
export const PRISMA_PROVIDER_ID = "prisma";

/** Documented default lifetime for an unclaimed database, in hours. */
export const PRISMA_DOCUMENTED_TTL_HOURS = 24;

export type PrismaClaimState =
	| "unclaimed"
	| "claimed-pending-rotation"
	| "complete"
	| "expired";

// domain-view: `kind` is the two-member ceremony union the wire form can only
// carry as a string, and an absent `url` stays absent rather than becoming the
// empty string proto3 would otherwise allow.
export type PrismaClaimAction = DomainView<
	PrismaClaimActionWire,
	{
		kind: "human-ceremony" | "owner-api";
		url?: string;
	}
>;

/**
 * The relationship a bundled claim strategy needs.
 *
 * A Vercel-style bundled claim transfers several resources in one ceremony. To
 * take part, the bundler has to know *which* provider-side object this HoBo
 * resource corresponds to, whether it can also be claimed on its own, and
 * where the standalone ceremony lives. That is exactly this type — and nothing
 * in it is a credential, so a bundler may persist it.
 */
// domain-view: `standaloneClaimSupported` and `requiresWorkspace` are the
// literal `true` this product always reports — a bundler reading them as
// booleans would have to handle a case that cannot arise — and the identity
// fields are pinned to this package's own constants.
export type PrismaAssociatedResourceRef = DomainView<
	PrismaAssociatedResourceRefWire,
	{
		schemaVersion: "hobo.provider-prisma-postgres.associated-resource/v1";
		kind: "prisma-postgres-project";
		providerId: typeof PRISMA_PROVIDER_ID;
		definitionId: typeof PRISMA_DEFINITION_ID;
		/** True: this resource can be claimed by itself, outside any bundle. */
		standaloneClaimSupported: true;
		/** The claim lands in a Prisma Data Platform workspace with capacity. */
		requiresWorkspace: true;
		bundleStrategy: "associated-resource";
		expirySource: "cli-local-clock";
	}
>;

// domain-view: pins the claim boundary as literal types — a plan naming the
// wrong strategy, boundary, resource kind, or atomicity fails to compile
// instead of failing a CUE check later — and spells `state` with the CUE
// vocabulary rather than the numeric proto enum.
export type PrismaClaimPlan = DomainView<
	PrismaClaimPlanWire,
	{
		strategy: "resource-claim";
		boundary: "resource";
		resourceKind: "prisma-postgres-project";
		atomicity: "single-resource";
		state: PrismaClaimState;
		actions: readonly PrismaClaimAction[];
		/** Required here: a bundled claim has nothing to work with without it. */
		associatedResource: PrismaAssociatedResourceRef;
	}
>;

export type PrismaClaimableDatabase = {
	readonly schemaVersion: "hobo.provider-prisma-postgres.claimable-database/v1";
	readonly definitionId: typeof PRISMA_DEFINITION_ID;
	readonly providerId: typeof PRISMA_PROVIDER_ID;
	readonly resourceRef: string;
	readonly projectId: string;
	readonly databaseName: string;
	readonly region: string;
	readonly endpoint: NonSecretEndpointRef;
	readonly credentialRef?: SecretRef;
	readonly binding?: CapabilityBinding;
	readonly expiresAtMs: number;
	readonly expiresAtIso: string;
	/** Never `provider-reported`: the pinned CLI computes it locally. */
	readonly expirySource: "cli-local-clock";
	readonly documentedTtlHours: number;
	readonly observedAtMs: number;
	readonly claim: PrismaClaimPlan;
	readonly adopted: boolean;
	/** Which output contract produced this record. */
	readonly outputMode: "json" | "human-v1" | "local-journal";
};

export type OwnershipEvidence = {
	readonly currentDatabase: string;
	readonly currentUser: string;
	readonly systemIdentifier: string;
	readonly observedAtMs: number;
};

export interface OwnershipProbePort {
	probe(input: {
		readonly credentialRef: SecretRef;
		readonly endpoint: NonSecretEndpointRef;
	}): Promise<OwnershipEvidence>;
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
	readonly attestedBy: string;
	readonly evidenceRef: string;
};

export type ClaimAttestation = {
	readonly claimedAtMs: number;
	readonly attestedBy: string;
	readonly workspaceId: string;
};

export type ClaimVerification = {
	readonly state: PrismaClaimState;
	readonly complete: boolean;
	readonly blockingActions: readonly PrismaClaimAction[];
	readonly reasons: readonly string[];
};

export type PrismaDriverOptions = {
	readonly client: PrismaClient;
	readonly custody: SecretCustodyPort;
	readonly clock: () => number;
	readonly probe?: OwnershipProbePort;
	readonly producerEvidenceRef?: string;
	/** Optional. Without it, `destroy` cannot revoke the deposited locator. */
	readonly revocation?: SecretRevocationPort;
	/** Independent provider read/settlement evidence. Never a locally computed TTL. */
	readonly retirement?: (
		record: PrismaClaimableDatabase,
		context: ResourceLifecycleContext,
	) => Promise<ResourceLifecycleObservation>;
};

export type ProvisionInput = CreateInput & { readonly resourceRef: string };

const CLAIM_CEREMONY_ID = "prisma.claim.transfer-to-workspace";
const CLAIM_ROTATION_ID = "prisma.claim.rotate-owner-credentials";

function claimActions(
	claimUrl: string,
	claimed: boolean,
	rotation: RotationAttestation | undefined,
): readonly PrismaClaimAction[] {
	return [
		{
			id: CLAIM_CEREMONY_ID,
			kind: "human-ceremony",
			description:
				"Open the claim URL, sign in to the Prisma Data Platform, choose a workspace with capacity, and authorize the transfer.",
			blocking: true,
			completed: claimed,
			url: claimUrl,
		},
		{
			id: CLAIM_ROTATION_ID,
			kind: "owner-api",
			description:
				"Rotate the database credential in the owning workspace. Prisma does not document the pre-claim connection string being invalidated by the transfer, so the creating party must be assumed to still hold a live credential until this is done.",
			blocking: true,
			completed: rotation !== undefined,
		},
	];
}

/**
 * What `observe` can honestly say.
 *
 * Prisma documents no read-by-id endpoint for a claimable database, so an
 * observation is a *journal* read plus a clock comparison — never a provider
 * re-read. `evidence` says so out loud, because a caller deciding whether to
 * retry needs to know the difference between "the provider says it is gone" and
 * "our own note says it should be gone by now".
 */
export type PrismaObservation =
	| {
			readonly kind: "live";
			readonly record: PrismaClaimableDatabase;
			readonly evidence: "local-journal";
			readonly remainingMs: number;
	  }
	| {
			readonly kind: "expired";
			readonly record: PrismaClaimableDatabase;
			readonly evidence: "local-journal";
			readonly expiredForMs: number;
	  }
	| {
			readonly kind: "unresolved";
			readonly idempotencyKey: string;
			readonly attemptedAtMs: number;
			readonly evidence: "local-journal";
	  }
	| {
			readonly kind: "absent";
			readonly idempotencyKey: string;
			readonly evidence: "local-journal";
	  };

/** What a destroy could actually accomplish against this product. */
export type PrismaDestroyOutcome = DomainView<
	PrismaDestroyOutcomeWire,
	{ reapMode: "ttl-expiry" | "already-expired" | "provider-confirmed" }
>;

/** Revoking custody is the only revocation this provider can perform. */
export interface SecretRevocationPort {
	revoke(ref: SecretRef): Promise<void>;
}

export type PrismaClaimableDatabaseDriver = {
	readonly definitionId: typeof PRISMA_DEFINITION_ID;
	readonly providerId: typeof PRISMA_PROVIDER_ID;
	provision(input: ProvisionInput): Promise<PrismaClaimableDatabase>;
	observe(input: {
		readonly idempotencyKey: string;
		readonly resourceRef: string;
	}): Promise<PrismaObservation>;
	rotateBinding(record: PrismaClaimableDatabase): Promise<never>;
	destroy(
		record: PrismaClaimableDatabase,
		context?: ResourceLifecycleContext,
	): Promise<PrismaDestroyOutcome>;
	verifyOwnership(
		record: PrismaClaimableDatabase,
	): Promise<OwnershipVerification>;
	verifyClaim(record: PrismaClaimableDatabase): ClaimVerification;
	attestClaim(
		record: PrismaClaimableDatabase,
		attestation: ClaimAttestation,
	): PrismaClaimableDatabase;
	attestRotation(
		record: PrismaClaimableDatabase,
		attestation: RotationAttestation,
	): PrismaClaimableDatabase;
	assertLeaseLive(record: PrismaClaimableDatabase): void;
	associatedResource(
		record: PrismaClaimableDatabase,
	): PrismaAssociatedResourceRef;
};

export function createPrismaClaimableDatabaseDriver(
	options: PrismaDriverOptions,
): PrismaClaimableDatabaseDriver {
	const producerEvidenceRef =
		options.producerEvidenceRef ??
		"hobo.evidence/provider-prisma-postgres/create-db@1.2.1#2026-08-08";

	function associatedResourceFrom(fields: {
		readonly projectId: string;
		readonly claimUrl: string;
		readonly region: string;
		readonly databaseName: string;
		readonly expiresAtIso: string;
	}): PrismaAssociatedResourceRef {
		const claimUrl = assertAllowedProviderUrl(
			fields.claimUrl,
			DEFAULT_CLAIM_URL_POLICY,
		);
		return {
			schemaVersion: "hobo.provider-prisma-postgres.associated-resource/v1",
			kind: "prisma-postgres-project",
			providerId: PRISMA_PROVIDER_ID,
			definitionId: PRISMA_DEFINITION_ID,
			projectId: fields.projectId,
			claimUrl: claimUrl.toString(),
			claimHost: claimUrl.hostname,
			standaloneClaimSupported: true,
			requiresWorkspace: true,
			bundleStrategy: "associated-resource",
			region: fields.region,
			databaseName: fields.databaseName,
			expiresAtIso: fields.expiresAtIso,
			expirySource: "cli-local-clock",
		};
	}

	function planFor(
		fields: {
			readonly projectId: string;
			readonly claimUrl: string;
			readonly region: string;
			readonly databaseName: string;
			readonly expiresAtIso: string;
			readonly expiresAtMs: number;
		},
		state: {
			readonly claimed: boolean;
			readonly rotation?: RotationAttestation;
			readonly nowMs: number;
		},
	): PrismaClaimPlan {
		const claimState: PrismaClaimState = state.claimed
			? state.rotation === undefined
				? "claimed-pending-rotation"
				: "complete"
			: fields.expiresAtMs <= state.nowMs
				? "expired"
				: "unclaimed";
		return {
			strategy: "resource-claim",
			boundary: "resource",
			resourceKind: "prisma-postgres-project",
			atomicity: "single-resource",
			claimUrl: fields.claimUrl,
			state: claimState,
			actions: claimActions(fields.claimUrl, state.claimed, state.rotation),
			associatedResource: associatedResourceFrom(fields),
		};
	}

	/** The only scope in which a plaintext connection string exists. */
	async function captureCredential(
		result: PrismaCreateResult,
		resourceRef: string,
	): Promise<{
		readonly endpoint: NonSecretEndpointRef;
		readonly databaseName: string;
		readonly credentialRef?: SecretRef;
		readonly binding?: CapabilityBinding;
		readonly snapshotHost: string;
		readonly snapshotPort: number;
		readonly snapshotTls: boolean;
	}> {
		if (result.connectionString === null) {
			throw new PrismaProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"create-db reported success without a connection string; there is nothing to bind",
			);
		}
		const parts = parsePostgresConnectionUri(result.connectionString);
		assertAllowedDatabaseHost(parts.host);
		if (!parts.hasPassword) {
			throw new PrismaProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"create-db returned a connection string with no password; refusing to bind an incomplete credential",
			);
		}
		const endpoint: NonSecretEndpointRef = {
			host: parts.host,
			port: parts.port,
			path: `/${parts.database}`,
			tls: parts.tls,
		};
		const ref = await depositSecret(options.custody, result.connectionString, {
			providerId: PRISMA_PROVIDER_ID,
			resourceRef,
			purpose: "connection-string",
			labels: { region: result.region },
		});
		const binding = buildPrismaCapabilityBinding({
			bindingId: `${resourceRef}#postgres`,
			resourceRef,
			endpoint,
			credentialRef: ref,
			expiresAtMs: result.deletionDateMs,
			producerEvidenceRef,
			databaseName: parts.database,
			projectId: result.projectId,
			region: result.region,
		});
		return {
			endpoint,
			databaseName: parts.database,
			credentialRef: ref.ref,
			binding,
			snapshotHost: parts.host,
			snapshotPort: parts.port,
			snapshotTls: parts.tls,
		};
	}

	/**
	 * Re-parse the journalled locator instead of asserting it.
	 *
	 * The journal is a persisted, potentially hand-edited artifact, so its
	 * `credentialRef` is untrusted input on the way back in. Casting it to
	 * `SecretRef` would let a corrupted locator travel all the way to a
	 * custody resolve, and the failure would surface as somebody else's bug.
	 */
	function adoptedCredentialRef(
		snapshot: PrismaResourceSnapshot,
	): SecretRef | undefined {
		if (snapshot.credentialRef === "") return undefined;
		try {
			return parseSecretRef(snapshot.credentialRef).ref;
		} catch (cause) {
			throw new PrismaProviderError(
				"SECRET_REFERENCE_INVALID",
				`the journalled credential locator for project ${snapshot.projectId} is not a secret reference`,
				{
					cause: cause instanceof Error ? cause : new Error(String(cause)),
					detail: { projectId: snapshot.projectId },
				},
			);
		}
	}

	function fromSnapshot(
		snapshot: PrismaResourceSnapshot,
		resourceRef: string,
	): PrismaClaimableDatabase {
		const nowMs = options.clock();
		const endpoint: NonSecretEndpointRef = {
			host: snapshot.host,
			port: snapshot.port,
			path: `/${snapshot.databaseName}`,
			tls: snapshot.tls,
		};
		const credentialRef = adoptedCredentialRef(snapshot);
		return {
			schemaVersion: "hobo.provider-prisma-postgres.claimable-database/v1",
			definitionId: PRISMA_DEFINITION_ID,
			providerId: PRISMA_PROVIDER_ID,
			resourceRef,
			projectId: snapshot.projectId,
			databaseName: snapshot.databaseName,
			region: snapshot.region,
			endpoint,
			...(credentialRef !== undefined ? { credentialRef } : undefined),
			expiresAtMs: snapshot.deletionDateMs,
			expiresAtIso: snapshot.deletionDateIso,
			expirySource: "cli-local-clock",
			documentedTtlHours: PRISMA_DOCUMENTED_TTL_HOURS,
			observedAtMs: nowMs,
			claim: planFor(
				{
					projectId: snapshot.projectId,
					claimUrl: snapshot.claimUrl,
					region: snapshot.region,
					databaseName: snapshot.databaseName,
					expiresAtIso: snapshot.deletionDateIso,
					expiresAtMs: snapshot.deletionDateMs,
				},
				{ claimed: false, nowMs },
			),
			adopted: true,
			outputMode: "local-journal",
		};
	}

	return {
		definitionId: PRISMA_DEFINITION_ID,
		providerId: PRISMA_PROVIDER_ID,

		async provision(input) {
			const outcome = await options.client.create({
				idempotencyKey: input.idempotencyKey,
				...(input.region !== undefined ? { region: input.region } : undefined),
				...(input.ttl !== undefined ? { ttl: input.ttl } : undefined),
			});
			if (outcome.kind === "adopted") {
				if (
					input.region !== undefined &&
					outcome.snapshot.region !== input.region
				)
					throw new PrismaProviderError(
						"PROVISIONING_CONFLICT",
						"the private resource snapshot reports a different region than requested",
					);
				return fromSnapshot(outcome.snapshot, input.resourceRef);
			}

			const { result } = outcome;
			const captured = await captureCredential(result, input.resourceRef);
			const nowMs = options.clock();

			await options.client.recordSnapshot(input.idempotencyKey, {
				projectId: result.projectId,
				claimUrl: result.claimUrl,
				region: result.region,
				name: result.name,
				deletionDateIso: result.deletionDateIso,
				deletionDateMs: result.deletionDateMs,
				host: captured.snapshotHost,
				port: captured.snapshotPort,
				databaseName: captured.databaseName,
				tls: captured.snapshotTls,
				credentialRef: captured.credentialRef ?? "",
			});
			if (input.region !== undefined && result.region !== input.region)
				throw new PrismaProviderError(
					"PROVISIONING_CONFLICT",
					"the provider returned a different region than requested; allocation remains in private custody",
				);

			return {
				schemaVersion: "hobo.provider-prisma-postgres.claimable-database/v1",
				definitionId: PRISMA_DEFINITION_ID,
				providerId: PRISMA_PROVIDER_ID,
				resourceRef: input.resourceRef,
				projectId: result.projectId,
				databaseName: captured.databaseName,
				region: result.region,
				endpoint: captured.endpoint,
				...(captured.credentialRef !== undefined
					? { credentialRef: captured.credentialRef }
					: undefined),
				...(captured.binding !== undefined
					? { binding: captured.binding }
					: undefined),
				expiresAtMs: result.deletionDateMs,
				expiresAtIso: result.deletionDateIso,
				expirySource: "cli-local-clock",
				documentedTtlHours: PRISMA_DOCUMENTED_TTL_HOURS,
				observedAtMs: nowMs,
				claim: planFor(
					{
						projectId: result.projectId,
						claimUrl: result.claimUrl,
						region: result.region,
						databaseName: captured.databaseName,
						expiresAtIso: result.deletionDateIso,
						expiresAtMs: result.deletionDateMs,
					},
					{ claimed: false, nowMs },
				),
				adopted: false,
				outputMode: result.outputMode,
			};
		},

		async observe(input) {
			const outcome = await options.client.observe(input.idempotencyKey);
			if (outcome.kind === "known") {
				const record = fromSnapshot(outcome.snapshot, input.resourceRef);
				const nowMs = options.clock();
				if (record.expiresAtMs <= nowMs) {
					return {
						kind: "expired",
						record,
						evidence: "local-journal",
						expiredForMs: nowMs - record.expiresAtMs,
					};
				}
				return {
					kind: "live",
					record,
					evidence: "local-journal",
					remainingMs: record.expiresAtMs - nowMs,
				};
			}
			if (outcome.kind === "unresolved") {
				return {
					kind: "unresolved",
					idempotencyKey: input.idempotencyKey,
					attemptedAtMs: outcome.attemptedAtMs,
					evidence: "local-journal",
				};
			}
			return {
				kind: "absent",
				idempotencyKey: input.idempotencyKey,
				evidence: "local-journal",
			};
		},

		async rotateBinding(record) {
			// Not "unimplemented" — unavailable. The temporary tier has no
			// documented credential-rotation surface (no API, no console for an
			// unclaimed project), so the only way to get a new credential is a
			// new database. Returning a fresh binding here by re-provisioning
			// would silently change identity under the caller.
			throw new PrismaProviderError(
				"BINDING_ROTATION_REQUIRED",
				"a temporary Prisma Postgres database has no documented rotation surface; claim it into a workspace and rotate there, or provision a replacement",
				{
					detail: {
						projectId: record.projectId,
						claimUrl: record.claim.claimUrl,
					},
				},
			);
		},

		async destroy(record, context) {
			const nowMs = options.clock();
			const alreadyExpired = record.expiresAtMs <= nowMs;
			let providerConfirmed = false;
			let retirementEvidenceRef = "",
				usageEvidenceRef = "";
			if (options.retirement !== undefined) {
				if (
					!context ||
					context.providerId !== PRISMA_PROVIDER_ID ||
					context.productId !== PRISMA_DEFINITION_ID ||
					context.resourceId !== record.resourceRef ||
					(context.physicalId !== undefined &&
						context.physicalId !== record.projectId)
				)
					throw new PrismaProviderError(
						"CLEANUP_FAILED",
						"provider retirement requires the exact resource and financial scope",
					);
				const wire = await options.retirement(structuredClone(record), {
					...context,
					nowMs,
					physicalId: record.projectId,
				});
				const { $typeName: _wireType, ...evidence } = wire;
				const observed = parseResourceLifecycleObservation(evidence, {
					...context,
					nowMs: options.clock(),
					physicalId: record.projectId,
				});
				if (
					observed.status === "absent" &&
					observed.operationTerminal &&
					observed.usageFinal
				) {
					providerConfirmed = true;
					retirementEvidenceRef = observed.evidenceRef;
					usageEvidenceRef = observed.usageEvidenceRef;
				}
			}

			// A claimed database has left the TTL regime: nothing reaps it, and
			// this package has no delete call. Saying "destroyed" would leave a
			// live database behind a closed ledger entry.
			if (
				!providerConfirmed &&
				(record.claim.state === "complete" ||
					record.claim.state === "claimed-pending-rotation")
			) {
				throw new PrismaProviderError(
					"CLEANUP_FAILED",
					"this database was claimed into a Prisma workspace, so it is no longer auto-deleted and `create-db` offers no delete command; remove it from the owning workspace",
					{
						detail: {
							projectId: record.projectId,
							claimState: record.claim.state,
						},
					},
				);
			}

			let custodyRevoked = false;
			if (
				record.credentialRef !== undefined &&
				options.revocation !== undefined
			) {
				try {
					await options.revocation.revoke(record.credentialRef);
					custodyRevoked = true;
				} catch (cause) {
					throw new PrismaProviderError(
						"CLEANUP_FAILED",
						`custody refused to revoke the credential for project ${record.projectId}`,
						{
							cause: cause instanceof Error ? cause : new Error(String(cause)),
							detail: { projectId: record.projectId },
						},
					);
				}
			}

			if (providerConfirmed)
				return {
					released: true,
					reapMode: "provider-confirmed",
					custodyRevoked,
					retirementEvidenceRef,
					usageEvidenceRef,
					expiresAtIso: record.expiresAtIso,
					detail: "independent provider retirement and final usage confirmed",
				};

			// Honest accounting: `released` is false while the provider-side
			// project is still alive on its timer, however tidy our own side is.
			return {
				released: false,
				reapMode: alreadyExpired ? "already-expired" : "ttl-expiry",
				custodyRevoked,
				expiresAtIso: record.expiresAtIso,
				detail: alreadyExpired
					? "the CLI-computed deletion deadline has passed; actual provider retirement remains unverified and financial exposure must be retained"
					: `no delete command exists for a temporary database; it is reaped when the deadline computed by the CLI (${record.expiresAtIso}) passes`,
			};
		},

		async verifyOwnership(record) {
			const signals: OwnershipSignal[] = [];
			const reasons: string[] = [];

			// There is no documented read-by-id endpoint, so there is no
			// control-plane signal to gather. Saying so is the honest report.
			signals.push({
				id: "control-plane-reread",
				independent: true,
				passed: false,
				detail:
					"Prisma documents no read-by-id API for a claimable database, so the control plane cannot be re-queried",
			});
			reasons.push(
				"no provider read API exists to independently re-confirm this resource",
			);

			if (options.probe === undefined || record.credentialRef === undefined) {
				signals.push({
					id: "data-plane-probe",
					independent: true,
					passed: false,
					detail: "no independent data-plane probe is configured",
				});
				reasons.push(
					"ownership is asserted only by local journal state; configure an OwnershipProbePort for an independent check",
				);
			} else {
				const evidence = await options.probe.probe({
					credentialRef: record.credentialRef,
					endpoint: record.endpoint,
				});
				const passed = evidence.currentDatabase === record.databaseName;
				signals.push({
					id: "data-plane-probe",
					independent: true,
					passed,
					detail: passed
						? "the data plane reports the expected database"
						: "the data plane reports a different database",
				});
				if (!passed)
					reasons.push(
						"data-plane probe disagrees with the recorded database name",
					);
			}

			// The data-plane probe is the only signal that can pass here, so it
			// is the only one required — but its absence still fails closed.
			const probeSignal = signals.find(
				(signal) => signal.id === "data-plane-probe",
			);
			return {
				verified: probeSignal?.passed === true,
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
				reasons.push(
					"the 24-hour window closed before the database was claimed",
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
				throw new PrismaProviderError(
					"CLAIM_NOT_VERIFIED",
					"a claim attestation needs a real claim instant",
				);
			}
			if (attestation.workspaceId.trim() === "") {
				throw new PrismaProviderError(
					"CLAIM_NOT_VERIFIED",
					"a claim attestation must name the workspace the database was transferred into",
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
			const ceremony = record.claim.actions.find(
				(action) => action.id === CLAIM_CEREMONY_ID,
			);
			if (ceremony?.completed !== true) {
				throw new PrismaProviderError(
					"CLAIM_NOT_VERIFIED",
					"credential rotation can only be attested after the workspace transfer has been attested",
				);
			}
			if (
				!Number.isFinite(attestation.rotatedAtMs) ||
				attestation.rotatedAtMs <= 0
			) {
				throw new PrismaProviderError(
					"BINDING_ROTATION_REQUIRED",
					"a rotation attestation needs a real rotation instant",
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

		assertLeaseLive(record) {
			const nowMs = options.clock();
			if (
				record.claim.state === "complete" ||
				record.claim.state === "claimed-pending-rotation"
			) {
				return;
			}
			if (record.expiresAtMs <= nowMs) {
				throw new PrismaProviderError(
					"LEASE_EXPIRED",
					`the claimable database lease lapsed at ${record.expiresAtIso} (deadline computed by the CLI, not attested by Prisma)`,
					{
						detail: {
							projectId: record.projectId,
							expiresAtMs: record.expiresAtMs,
						},
					},
				);
			}
		},

		associatedResource(record) {
			return record.claim.associatedResource;
		},
	};
}
