/**
 * From a verified manifest plus a parsed configuration to a container spec.
 *
 * The spec is pure data: an image reference, an environment map, secret-file
 * mounts, volume mounts, and the probes copied from the manifest. Nothing here
 * schedules anything — a Yard executor consumes this, and keeping the description
 * separate from the execution is what lets the whole path be tested offline.
 *
 * The password reaches PostgreSQL through `POSTGRES_PASSWORD_FILE`, not
 * `POSTGRES_PASSWORD`. The upstream entrypoint supports the `_FILE` form for
 * `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`, and
 * `POSTGRES_INITDB_ARGS` (checked 2026-08-08), and a value in a file is not
 * visible in `docker inspect`, in a container-runtime API response, or in a crash
 * report the way an environment variable is.
 */
import type { SecretRef } from "@hobo/bindings";
import {
	PackError,
	type PackProbes,
	type PackVolumeBinding,
	type ParsedPackConfiguration,
	type VerifiedPackManifest,
} from "@hobo/pack-framework";

import {
	POSTGRES_DATA_MOUNT_PATH,
	POSTGRES_PGDATA,
	POSTGRES_PORT,
} from "./image.js";
import { POSTGRES_DATA_VOLUME, POSTGRES_PACK_ID } from "./manifest.js";
import { parsePostgresIdentifier } from "./operations.js";

/** Where custody projects the password inside the container. */
// public-contract: fixed secret mount consumed by the PostgreSQL image.
export const POSTGRES_PASSWORD_FILE_PATH =
	"/run/secrets/postgres-superuser-password" as const;

export type PackSecretFileMount = {
	readonly path: string;
	readonly secretRef: SecretRef;
	/** Octal file mode. Owner-read only for credential material. */
	readonly mode: "0400";
};

export type PackVolumeMount = {
	readonly volumeName: string;
	readonly mountPath: string;
	readonly binding: PackVolumeBinding;
};

export type PostgresContainerSpec = {
	readonly packId: typeof POSTGRES_PACK_ID;
	readonly image: string;
	readonly architecture: string;
	readonly command: readonly string[];
	/** Non-secret environment only. Asserted, not assumed. */
	readonly env: Readonly<Record<string, string>>;
	readonly secretFiles: readonly PackSecretFileMount[];
	readonly volumeMounts: readonly PackVolumeMount[];
	readonly ports: readonly {
		readonly name: string;
		readonly containerPort: number;
	}[];
	readonly probes: PackProbes;
	readonly resources: VerifiedPackManifest["resourceBounds"];
};

/**
 * Environment values that must never be set here.
 *
 * `POSTGRES_PASSWORD` is in the list because the `_FILE` variant is the whole
 * point, and `POSTGRES_HOST_AUTH_METHOD: trust` is in it because that is the one
 * setting that turns an authenticated database into an open one.
 */
const FORBIDDEN_ENV_KEYS = new Set([
	"POSTGRES_PASSWORD",
	"POSTGRES_INITDB_ARGS",
]);

export function buildPostgresContainerSpec(
	manifest: VerifiedPackManifest,
	config: ParsedPackConfiguration,
): PostgresContainerSpec {
	if (manifest.packId !== POSTGRES_PACK_ID) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			`expected ${POSTGRES_PACK_ID}, received ${manifest.packId}`,
		);
	}

	const volumeName = config.requireString("dataVolume");
	if (volumeName !== POSTGRES_DATA_VOLUME) {
		throw new PackError(
			"PACK_PERSISTENCE_REQUIRED",
			`dataVolume must name the declared volume ${POSTGRES_DATA_VOLUME}`,
			{ detail: { supplied: volumeName } },
		);
	}
	// Throws PACK_PERSISTENCE_REQUIRED when nothing is bound, which is the point:
	// a spec for a database with no durable storage should not be constructible.
	const binding = config.requireVolumeBinding(volumeName);
	if (binding.storage.kind !== "local-volume") {
		throw new PackError(
			"PACK_PERSISTENCE_REQUIRED",
			"PGDATA cannot live on external object storage; bind a local volume",
			{ detail: { kind: binding.storage.kind } },
		);
	}

	const passwordRef = config.requireSecretRef("superuserPasswordRef");
	const database = parsePostgresIdentifier(
		config.requireString("databaseName"),
		"databaseName",
	);
	const ownerRole = parsePostgresIdentifier(
		config.requireString("ownerRole"),
		"ownerRole",
	);
	const hostAuthMethod = config.requireString("hostAuthMethod");
	const maxConnections = config.requireInteger("maxConnections");

	const env = {
		POSTGRES_PASSWORD_FILE: POSTGRES_PASSWORD_FILE_PATH,
		POSTGRES_USER: ownerRole,
		POSTGRES_DB: database,
		POSTGRES_HOST_AUTH_METHOD: hostAuthMethod,
		// Set explicitly even though it matches the image default: a future image
		// that changes PGDATA should fail this pack's conformance rather than
		// silently write to a directory outside the mounted volume.
		PGDATA: POSTGRES_PGDATA,
	};
	for (const key of Object.keys(env)) {
		if (FORBIDDEN_ENV_KEYS.has(key)) {
			throw new PackError(
				"PACK_CONFIGURATION_INVALID",
				`${key} must not be set by this pack; the credential travels as a file`,
			);
		}
	}

	return {
		packId: POSTGRES_PACK_ID,
		image: manifest.selectedImage.reference.ref,
		architecture: manifest.selectedArchitecture,
		// `docker-entrypoint.sh postgres` is the image's own entrypoint plus cmd;
		// server flags are appended as separate argv elements, never as a string.
		command: ["postgres", "-c", `max_connections=${maxConnections}`],
		env,
		secretFiles: [
			{
				path: POSTGRES_PASSWORD_FILE_PATH,
				secretRef: passwordRef,
				mode: "0400",
			},
		],
		volumeMounts: [
			{ volumeName, mountPath: POSTGRES_DATA_MOUNT_PATH, binding },
		],
		ports: [{ name: "postgres", containerPort: POSTGRES_PORT }],
		probes: manifest.probes,
		resources: manifest.resourceBounds,
	};
}
