/**
 * Making the pack selectable.
 *
 * `postgresPackSemanticsOptions` fills in the Yard-side references and the
 * structured capabilities a requirement can gate on. The values that describe the
 * *pack* (realization, ownership, pinned digests, persistence) are not settable
 * here — the framework projection reads them off the verified manifest.
 *
 * `serverVersion` and `maxConnections` are advertised because `data.postgres/v1`
 * declares them as features. `pooling` is advertised as `false`: this pack runs
 * one PostgreSQL server and no pooler, and a `true` here would win selections it
 * cannot serve.
 */
import type { SelectionCandidate } from "@hobo/capability-profiles";
import {
	type PackSemanticsOptions,
	toPackSelectionCandidate,
	type VerifiedPackManifest,
} from "@hobo/pack-framework";

import { POSTGRES_SERVER_MAJOR, POSTGRES_SERVER_VERSION } from "./image.js";

// public-contract: stable catalog definition identifier.
export const POSTGRES_PACK_DEFINITION_ID = "hobo.pack.postgres-oci/v1" as const;

export type PostgresCatalogOptions = {
	/** The Yard that will run the container. Compute host, not a vendor. */
	readonly yardId: string;
	/** Epoch ms after which the pack's evidence must be re-gathered. */
	readonly evidenceExpiresAtMs: number;
	readonly evidenceSignatureValid: boolean;
	readonly maxConnections?: number;
	/** Extensions actually present in the pinned image, if any were verified. */
	readonly extensions?: readonly string[];
	readonly tls?: boolean;
};

export function postgresPackSemanticsOptions(
	options: PostgresCatalogOptions,
): PackSemanticsOptions {
	return {
		definitionId: POSTGRES_PACK_DEFINITION_ID,
		providerId: options.yardId,
		compilerRef: "hobo.compiler.pack-oci/v1",
		executorRef: "hobo.executor.pack-oci/v1",
		permissionProfileRef: "hobo.permission.pack-database/v1",
		bootstrapStrategyRef: "hobo.bootstrap.pack-container/v1",
		trustEvidenceRef: "hobo.trust.pack-signature/v1",
		evidenceExpiresAtMs: options.evidenceExpiresAtMs,
		evidenceSignatureValid: options.evidenceSignatureValid,
		structuredCapabilities: {
			serverVersion: POSTGRES_SERVER_VERSION,
			serverMajor: POSTGRES_SERVER_MAJOR,
			postgresWireProtocol: true,
			transactions: true,
			constraints: true,
			preparedStatements: true,
			jsonDocuments: true,
			maxConnections: options.maxConnections ?? 100,
			// No pooler in this pack. Stated rather than omitted, because an
			// absent capability and a false one behave differently in selection.
			pooling: false,
			// TLS is off unless the Yard terminates it. Reporting an unenforced
			// `true` would let a requirement that gates on TLS pick this pack.
			tls: options.tls ?? false,
			extensions: options.extensions ?? [],
		},
		placementConstraints: [
			// A single-writer volume cannot follow the container across hosts.
			{ key: "storage.localVolume", operator: "equals", values: ["true"] },
		],
		requiresConnectivityProfiles: ["binding.postgresql/v1"],
		remediation: [
			{
				code: "PACK_PERSISTENCE_REQUIRED",
				message:
					"Bind a local persistent volume of at least 1 GiB to pgdata before deploying this pack.",
			},
		],
		secretCustodyAvailable: true,
		supportsRotation: true,
		supportsRevocation: true,
	};
}

export function postgresPackCandidate(
	manifest: VerifiedPackManifest,
	options: PostgresCatalogOptions,
): SelectionCandidate {
	return toPackSelectionCandidate(
		manifest,
		postgresPackSemanticsOptions(options),
	);
}
