/**
 * The `binding.postgresql/v1` this pack produces.
 *
 * A pack-hosted PostgreSQL emits exactly the same binding profile a managed
 * PostgreSQL product does, which is the whole portability argument: a workload
 * that consumes `binding.postgresql/v1` cannot tell whether it was given Neon or
 * a container, and does not need to.
 *
 * The binding carries a host, a port, and a `credentialRef`. It never carries a
 * connection string, because a connection string is a credential with a hostname
 * attached — `parseCapabilityBinding` rejects a host containing `:` or `@` for
 * exactly that reason.
 */
import {
	type CapabilityBinding,
	parseCapabilityBinding,
	parseSecretRef,
	type SecretRef,
} from "@hobo/bindings";
import { PackError, type VerifiedPackManifest } from "@hobo/pack-framework";

import { POSTGRES_PORT, POSTGRES_SERVER_VERSION } from "./image.js";
import { POSTGRES_PACK_ID } from "./manifest.js";
import { parsePostgresIdentifier } from "./operations.js";

// public-contract: identifies PostgreSQL binding payloads.
export const POSTGRES_BINDING_PROFILE = "binding.postgresql/v1" as const;

export type PostgresBindingInput = {
	readonly bindingId: string;
	readonly resourceRef: string;
	/** In-cluster hostname the container is reachable at. Never a URL. */
	readonly host: string;
	readonly port?: number;
	readonly database: string;
	readonly role: string;
	/** Locator for the role's password. */
	readonly credentialRef: SecretRef;
	/**
	 * Whether the client must use TLS. A pack on a Camp-internal network may
	 * legitimately run without it, so this is a required decision rather than an
	 * assumed `true` — an assumed `true` that is not enforced is worse than an
	 * honest `false`.
	 */
	readonly tls: boolean;
	readonly certificateRef?: SecretRef;
	readonly producerEvidenceRef: string;
};

export function buildPostgresBinding(
	manifest: VerifiedPackManifest,
	input: PostgresBindingInput,
): CapabilityBinding {
	if (manifest.packId !== POSTGRES_PACK_ID) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			`expected ${POSTGRES_PACK_ID}, received ${manifest.packId}`,
		);
	}
	if (!manifest.producesBindingProfiles.includes(POSTGRES_BINDING_PROFILE)) {
		throw new PackError(
			"PROVIDER_CONTRACT_CHANGED",
			`pack manifest no longer declares ${POSTGRES_BINDING_PROFILE}`,
		);
	}
	if (input.tls && input.certificateRef === undefined) {
		// Requiring TLS without saying which certificate authority to trust is how
		// a client ends up with `sslmode=require` and no verification at all.
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			"a TLS binding must reference the certificate the client should verify against",
		);
	}

	return parseCapabilityBinding(
		{
			schemaVersion: "hobo.capability-binding/v1",
			id: input.bindingId,
			resourceRef: input.resourceRef,
			capabilityProfileRef: "data.postgres/v1",
			bindingProfileRef: POSTGRES_BINDING_PROFILE,
			type: "postgresql",
			// Deliberately no `provider`: there is no vendor product here, and
			// naming one would be the misrepresentation this pack exists to avoid.
			endpoints: [
				{
					protocol: "postgresql",
					role: "primary",
					addressRef: {
						host: input.host,
						port: input.port ?? POSTGRES_PORT,
						tls: input.tls,
					},
				},
			],
			credentialRef: input.credentialRef,
			...(input.certificateRef !== undefined
				? { certificateRef: input.certificateRef }
				: undefined),
			metadataRefs: {
				database: parsePostgresIdentifier(input.database, "binding database"),
				role: parsePostgresIdentifier(input.role, "binding role"),
				serverVersion: POSTGRES_SERVER_VERSION,
				packId: POSTGRES_PACK_ID,
				imageDigest: manifest.selectedImage.digest,
			},
			// A container credential does not expire on its own, and claiming an
			// expiry that nothing enforces would be a false promise. Rotation is
			// supported; expiry is not simulated.
			renewable: false,
			rotationSupported: true,
			revocationSupported: true,
			producerEvidenceRef: input.producerEvidenceRef,
		},
		parseSecretRef,
	);
}
