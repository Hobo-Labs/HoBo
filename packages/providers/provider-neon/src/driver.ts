/**
 * The effectful driver for `neon.claimable-postgres/v1`.
 *
 * Three things this file is careful about:
 *
 * 1. The credential never leaves. `provision` returns a record whose only
 *    credential-shaped fields are SecretRefs; the plaintext exists inside one
 *    function scope and is handed straight to custody.
 * 2. Expiry is whatever the provider said. There is no 72-hour timer here.
 * 3. A claim is not complete when the provider says `CLAIMED`. The creating
 *    party's connection string keeps working across a Neon claim, so the claim
 *    stays open on a blocking owner rotation ceremony until someone attests
 *    that it happened.
 */
import type { CapabilityBinding, SecretRef } from "@hobo/bindings";

import type {
	NeonClaimAction as NeonClaimActionWire,
	NeonClaimPlan as NeonClaimPlanWire,
} from "./_generated/provider_neon_pb.js";
import type { NeonDatabaseResponse, NeonDatabaseStatus } from "./api.js";
import {
	buildNeonCapabilityBinding,
	endpointsFor,
	type NeonEndpoints,
} from "./binding.js";
import type { CreateDatabaseInput, NeonClient } from "./client.js";
import {
	deriveDirectConnectionUri,
	parsePostgresConnectionUri,
	toDirectHost,
} from "./connection-string.js";
import { depositSecret, type SecretCustodyPort } from "./custody.js";
import { NeonProviderError } from "./errors.js";
import type { DomainView } from "./wire.js";

// public-contract: stable Resource Definition identifier.
export const NEON_DEFINITION_ID = "neon.claimable-postgres/v1";
// public-contract: provider identifier used in offers and receipts.
export const NEON_PROVIDER_ID = "neon";

/** Documented unclaimed-tier limits. https://neon.com/docs/reference/claimable-postgres */
export const NEON_UNCLAIMED_LIMITS = {
	maxStorageBytes: 100 * 1024 * 1024,
	maxTransferBytes: 1024 * 1024 * 1024,
	branches: false,
	region: "aws-us-east-2",
	postgresMajorVersion: 17,
} as const;

export type NeonClaimState =
	| "unclaimed"
	| "claiming"
	| "claimed-pending-rotation"
	| "complete"
	| "expired";

export type NeonClaimActionKind = "human-ceremony" | "owner-api";

// domain-view: `kind` is the two-member ceremony union the wire form can only
// carry as a string, and an absent `url` stays absent rather than becoming the
// empty string proto3 would otherwise allow.
export type NeonClaimAction = DomainView<
	NeonClaimActionWire,
	{
		kind: NeonClaimActionKind;
		url?: string;
	}
>;

// domain-view: pins the claim boundary as literal types — a plan naming the
// wrong strategy, boundary, resource kind, or atomicity fails to compile
// instead of failing a CUE check later — and spells `state` with the CUE
// vocabulary rather than the numeric proto enum.
export type NeonClaimPlan = DomainView<
	NeonClaimPlanWire,
	{
		strategy: "resource-claim";
		/**
		 * The claim transfers one database/project into an existing or new
		 * Neon account. It never transfers the account itself, so this is a
		 * resource boundary, not an account boundary.
		 */
		boundary: "resource";
		resourceKind: "neon-project-database";
		atomicity: "single-resource";
		state: NeonClaimState;
		actions: readonly NeonClaimAction[];
	}
>;

export type NeonClaimableDatabase = {
	readonly schemaVersion: "hobo.provider-neon.claimable-database/v1";
	readonly definitionId: typeof NEON_DEFINITION_ID;
	readonly providerId: typeof NEON_PROVIDER_ID;
	readonly resourceRef: string;
	readonly databaseId: string;
	readonly neonProjectId: string;
	readonly providerStatus: NeonDatabaseStatus;
	readonly databaseName: string;
	readonly endpoints: NeonEndpoints;
	readonly credentialRef?: SecretRef;
	readonly directCredentialRef?: SecretRef;
	readonly binding?: CapabilityBinding;
	readonly expiresAtMs: number;
	readonly expiresAtIso: string;
	/** Always `provider-reported`; recorded so a receipt can prove it. */
	readonly expirySource: "provider-reported";
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly observedAtMs: number;
	readonly claim: NeonClaimPlan;
	readonly limits: typeof NEON_UNCLAIMED_LIMITS;
	readonly logicalReplicationEnabled: boolean;
	/** True when this record came from adopting an earlier ambiguous attempt. */
	readonly adopted: boolean;
};

export type OwnershipEvidence = {
	readonly currentDatabase: string;
	readonly currentUser: string;
	/** `pg_control_system().system_identifier`, or any stable cluster identity. */
	readonly systemIdentifier: string;
	readonly observedAtMs: number;
};

/**
 * An optional data-plane probe. Ownership that is only asserted by the same
 * control-plane response that created the resource is not independent, so
 * without this port verification reports `verified: false`.
 */
export interface OwnershipProbePort {
	probe(input: {
		readonly credentialRef: SecretRef;
		readonly endpoint: NeonEndpoints["direct"];
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
	/** Who performed the rotation in the owner's Neon account. */
	readonly attestedBy: string;
	/** Locator for the rotation evidence. Never the new credential. */
	readonly evidenceRef: string;
};

export type ClaimVerification = {
	readonly state: NeonClaimState;
	readonly complete: boolean;
	readonly blockingActions: readonly NeonClaimAction[];
	readonly reasons: readonly string[];
};

export type NeonDriverOptions = {
	readonly client: NeonClient;
	readonly custody: SecretCustodyPort;
	readonly clock: () => number;
	readonly probe?: OwnershipProbePort;
	/** Evidence locator recorded on every emitted binding. */
	readonly producerEvidenceRef?: string;
};

export type ProvisionInput = CreateDatabaseInput & {
	/** HoBo-side resource identity this database is bound to. */
	readonly resourceRef: string;
};

export type ObserveInput = {
	readonly databaseId: string;
	readonly resourceRef: string;
	/** Previous record, if any. Used for independent continuity checks. */
	readonly previous?: NeonClaimableDatabase;
	readonly rotation?: RotationAttestation;
};

const CLAIM_CEREMONY_ID = "neon.claim.transfer-to-account";
const CLAIM_ROTATION_ID = "neon.claim.rotate-owner-credentials";

function claimActions(
	claimUrl: string,
	status: NeonDatabaseStatus,
	rotation: RotationAttestation | undefined,
): readonly NeonClaimAction[] {
	return [
		{
			id: CLAIM_CEREMONY_ID,
			kind: "human-ceremony",
			description:
				"Open the claim URL, sign in to Neon, choose an organization, and complete the transfer.",
			blocking: true,
			completed: status === "CLAIMED",
			url: claimUrl,
		},
		{
			id: CLAIM_ROTATION_ID,
			kind: "owner-api",
			description:
				"Rotate the database role password in the owning Neon account. The pre-claim connection string keeps working until this happens, so the creating party still holds a live credential.",
			blocking: true,
			completed: rotation !== undefined,
		},
	];
}

function claimStateFor(
	status: NeonDatabaseStatus,
	expiresAtMs: number,
	nowMs: number,
	rotation: RotationAttestation | undefined,
): NeonClaimState {
	if (status === "CLAIMED") {
		return rotation === undefined ? "claimed-pending-rotation" : "complete";
	}
	if (expiresAtMs <= nowMs) return "expired";
	return status === "CLAIMING" ? "claiming" : "unclaimed";
}

export type NeonClaimableDatabaseDriver = {
	readonly definitionId: typeof NEON_DEFINITION_ID;
	readonly providerId: typeof NEON_PROVIDER_ID;
	provision(input: ProvisionInput): Promise<NeonClaimableDatabase>;
	observe(input: ObserveInput): Promise<NeonClaimableDatabase>;
	verifyOwnership(
		record: NeonClaimableDatabase,
	): Promise<OwnershipVerification>;
	verifyClaim(record: NeonClaimableDatabase): ClaimVerification;
	attestRotation(
		record: NeonClaimableDatabase,
		attestation: RotationAttestation,
	): NeonClaimableDatabase;
	assertLeaseLive(record: NeonClaimableDatabase): void;
};

export function createNeonClaimableDatabaseDriver(
	options: NeonDriverOptions,
): NeonClaimableDatabaseDriver {
	const producerEvidenceRef =
		options.producerEvidenceRef ??
		"hobo.evidence/provider-neon/claimable-postgres@2026-08-08";

	/**
	 * The only place a plaintext connection string exists. It is deposited
	 * before the function returns and is never assigned to the record.
	 */
	async function captureCredentials(
		response: NeonDatabaseResponse,
		resourceRef: string,
	): Promise<{
		readonly endpoints: NeonEndpoints;
		readonly databaseName: string;
		readonly credentialRef?: SecretRef;
		readonly directCredentialRef?: SecretRef;
		readonly binding?: CapabilityBinding;
	}> {
		if (response.connectionString === null) {
			// Documented: `connection_string` is null once claimed. There is
			// nothing to deposit and nothing to bind.
			return {
				endpoints: {
					pooled: { host: "unknown.invalid", tls: true },
					direct: { host: "unknown.invalid", tls: true },
				},
				databaseName: "unknown",
			};
		}

		const parts = parsePostgresConnectionUri(response.connectionString);
		if (!parts.hasPassword) {
			throw new NeonProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"provider connection string carried no password; refusing to bind an incomplete credential",
			);
		}
		const endpoints = endpointsFor(parts, toDirectHost(parts.host));

		const pooledRef = await depositSecret(
			options.custody,
			response.connectionString,
			{
				providerId: NEON_PROVIDER_ID,
				resourceRef,
				purpose: "connection-string-pooled",
			},
		);

		const directUri = deriveDirectConnectionUri(response.connectionString);
		const directRef =
			directUri === undefined
				? undefined
				: await depositSecret(options.custody, directUri, {
						providerId: NEON_PROVIDER_ID,
						resourceRef,
						purpose: "connection-string-direct",
					});

		const binding = buildNeonCapabilityBinding({
			bindingId: `${resourceRef}#postgres`,
			resourceRef,
			endpoints,
			pooledCredentialRef: pooledRef,
			...(directRef !== undefined
				? { directCredentialRef: directRef }
				: undefined),
			expiresAtMs: response.expiresAtMs,
			producerEvidenceRef,
			databaseName: parts.database,
		});

		return {
			endpoints,
			databaseName: parts.database,
			credentialRef: pooledRef.ref,
			...(directRef !== undefined
				? { directCredentialRef: directRef.ref }
				: undefined),
			binding,
		};
	}

	async function toRecord(
		response: NeonDatabaseResponse,
		input: {
			readonly resourceRef: string;
			readonly adopted: boolean;
			readonly logicalReplicationEnabled: boolean;
			readonly rotation?: RotationAttestation;
			readonly previous?: NeonClaimableDatabase;
		},
	): Promise<NeonClaimableDatabase> {
		const nowMs = options.clock();
		const captured =
			input.previous !== undefined && response.connectionString === null
				? {
						endpoints: input.previous.endpoints,
						databaseName: input.previous.databaseName,
						...(input.previous.credentialRef !== undefined
							? { credentialRef: input.previous.credentialRef }
							: undefined),
						...(input.previous.directCredentialRef !== undefined
							? { directCredentialRef: input.previous.directCredentialRef }
							: undefined),
						...(input.previous.binding !== undefined
							? { binding: input.previous.binding }
							: undefined),
					}
				: await captureCredentials(response, input.resourceRef);

		return {
			schemaVersion: "hobo.provider-neon.claimable-database/v1",
			definitionId: NEON_DEFINITION_ID,
			providerId: NEON_PROVIDER_ID,
			resourceRef: input.resourceRef,
			databaseId: response.databaseId,
			neonProjectId: response.neonProjectId,
			providerStatus: response.status,
			databaseName: captured.databaseName,
			endpoints: captured.endpoints,
			...(captured.credentialRef !== undefined
				? { credentialRef: captured.credentialRef }
				: undefined),
			...(captured.directCredentialRef !== undefined
				? { directCredentialRef: captured.directCredentialRef }
				: undefined),
			...(captured.binding !== undefined
				? { binding: captured.binding }
				: undefined),
			expiresAtMs: response.expiresAtMs,
			expiresAtIso: response.expiresAtIso,
			expirySource: "provider-reported",
			createdAtMs: response.createdAtMs,
			updatedAtMs: response.updatedAtMs,
			observedAtMs: nowMs,
			claim: {
				strategy: "resource-claim",
				boundary: "resource",
				resourceKind: "neon-project-database",
				atomicity: "single-resource",
				claimUrl: response.claimUrl,
				state: claimStateFor(
					response.status,
					response.expiresAtMs,
					nowMs,
					input.rotation,
				),
				actions: claimActions(
					response.claimUrl,
					response.status,
					input.rotation,
				),
			},
			limits: NEON_UNCLAIMED_LIMITS,
			logicalReplicationEnabled: input.logicalReplicationEnabled,
			adopted: input.adopted,
		};
	}

	return {
		definitionId: NEON_DEFINITION_ID,
		providerId: NEON_PROVIDER_ID,

		async provision(input) {
			const outcome = await options.client.createDatabase({
				ref: input.ref,
				idempotencyKey: input.idempotencyKey,
				...(input.enableLogicalReplication !== undefined
					? { enableLogicalReplication: input.enableLogicalReplication }
					: undefined),
			});
			return toRecord(outcome.response, {
				resourceRef: input.resourceRef,
				adopted: outcome.adopted,
				logicalReplicationEnabled: input.enableLogicalReplication === true,
			});
		},

		async observe(input) {
			const response = await options.client.getDatabase(input.databaseId);
			if (
				input.previous !== undefined &&
				input.previous.neonProjectId !== response.neonProjectId
			) {
				throw new NeonProviderError(
					"PROVISIONING_CONFLICT",
					"the observed database now reports a different Neon project; this is not the resource that was provisioned",
					{
						detail: {
							databaseId: input.databaseId,
							expected: input.previous.neonProjectId,
							observed: response.neonProjectId,
						},
					},
				);
			}
			return toRecord(response, {
				resourceRef: input.resourceRef,
				adopted: true,
				logicalReplicationEnabled:
					input.previous?.logicalReplicationEnabled ?? false,
				...(input.rotation !== undefined
					? { rotation: input.rotation }
					: undefined),
				...(input.previous !== undefined
					? { previous: input.previous }
					: undefined),
			});
		},

		async verifyOwnership(record) {
			const signals: OwnershipSignal[] = [];
			const reasons: string[] = [];

			// Signal 1: a fresh read, independent of the create response.
			let reread: NeonDatabaseResponse | undefined;
			try {
				reread = await options.client.getDatabase(record.databaseId);
			} catch (cause) {
				signals.push({
					id: "control-plane-reread",
					independent: true,
					passed: false,
					detail:
						cause instanceof NeonProviderError
							? cause.message
							: "control-plane read failed",
				});
				reasons.push(
					"the provider could not confirm the database on an independent read",
				);
			}
			if (reread !== undefined) {
				const matches = reread.neonProjectId === record.neonProjectId;
				signals.push({
					id: "control-plane-reread",
					independent: true,
					passed: matches,
					detail: matches
						? "the provider re-reports the same project for this database id"
						: "the provider reports a different project for this database id",
				});
				if (!matches)
					reasons.push("project identity changed between observations");
			}

			// Signal 2: the endpoint the binding points at is still the one the
			// provider names. Endpoint drift is how a claim silently rebinds.
			const endpointStable =
				reread === null ||
				reread === undefined ||
				reread.connectionString === null ||
				parsePostgresConnectionUri(reread.connectionString).host ===
					record.endpoints.pooled.host;
			signals.push({
				id: "endpoint-continuity",
				independent: true,
				passed: endpointStable,
				detail: endpointStable
					? "the pooled endpoint host is unchanged"
					: "the pooled endpoint host moved",
			});
			if (!endpointStable)
				reasons.push("endpoint host changed since provisioning");

			// Signal 3: a data-plane probe. Without it, everything above is the
			// provider vouching for itself.
			if (options.probe === undefined || record.credentialRef === undefined) {
				signals.push({
					id: "data-plane-probe",
					independent: true,
					passed: false,
					detail: "no independent data-plane probe is configured",
				});
				reasons.push(
					"ownership is asserted only by the provider control plane; configure an OwnershipProbePort for an independent check",
				);
			} else {
				const evidence = await options.probe.probe({
					credentialRef: record.credentialRef,
					endpoint: record.endpoints.direct,
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
			for (const action of blockingActions) {
				reasons.push(
					`blocking claim action ${action.id} has not been completed`,
				);
			}
			return {
				state: record.claim.state,
				// `CLAIMED` at the provider is not `complete` here: rotation is
				// what actually removes the creator's authority.
				complete:
					record.claim.state === "complete" && blockingActions.length === 0,
				blockingActions,
				reasons,
			};
		},

		attestRotation(record, attestation) {
			if (record.providerStatus !== "CLAIMED") {
				throw new NeonProviderError(
					"CLAIM_NOT_VERIFIED",
					"credential rotation can only be attested after the provider reports the database as CLAIMED",
					{ detail: { providerStatus: record.providerStatus } },
				);
			}
			if (
				!Number.isFinite(attestation.rotatedAtMs) ||
				attestation.rotatedAtMs <= 0
			) {
				throw new NeonProviderError(
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
			if (record.providerStatus === "CLAIMED") return;
			if (record.expiresAtMs <= nowMs) {
				throw new NeonProviderError(
					record.claim.state === "claiming" ? "CLAIM_EXPIRED" : "LEASE_EXPIRED",
					`the claimable database expired at ${record.expiresAtIso}`,
					{
						detail: {
							databaseId: record.databaseId,
							expiresAtMs: record.expiresAtMs,
						},
					},
				);
			}
		},
	};
}
