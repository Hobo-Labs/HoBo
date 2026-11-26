import type { SelectionCandidate } from "@hobo/capability-profiles";
import {
	type PackSemanticsOptions,
	toPackSelectionCandidate,
	type VerifiedPackManifest,
} from "@hobo/pack-framework";

import { POSTGRES_SERVER_MAJOR, POSTGRES_SERVER_VERSION } from "./image.js";

export const POSTGRES_PACK_DEFINITION_ID = "hobo.pack.postgres-oci/v1" as const;

export type PostgresCatalogOptions = {
	readonly yardId: string;
	readonly evidenceExpiresAtMs: number;
	readonly evidenceSignatureValid: boolean;
	readonly maxConnections?: number;
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
			pooling: false,
			tls: options.tls ?? false,
			extensions: options.extensions ?? [],
		},
		placementConstraints: [
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
