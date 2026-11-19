import type { PackArchitecture } from "@hobo/pack-framework";

// public-contract: canonical OCI repository for the pack image.
export const POSTGRES_IMAGE_REPOSITORY = "docker.io/library/postgres" as const;

// public-contract: human-readable tag from which the digest was resolved.
export const POSTGRES_RESOLVED_FROM_TAG = "18-alpine" as const;

// public-contract: pinned multi-platform image digest.
export const POSTGRES_IMAGE_INDEX_DIGEST =
	"sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15" as const;

interface PostgresImageDigests {
	"linux/amd64": string;
	"linux/arm64": string;
}

export const POSTGRES_IMAGE_DIGESTS: PostgresImageDigests = {
	"linux/amd64":
		"sha256:b6a16ed0eb96e2c362811f7eeb951eac8b459e7b40be4149ea5444aa7c65569b",
	"linux/arm64":
		"sha256:122c9942437efcbbb8d595fc578dee7d26ee1543c2a8634d183adfa4a1e55b4d",
};

// public-contract: server version represented by the pinned image.
export const POSTGRES_SERVER_VERSION = "18.4" as const;

export const POSTGRES_SERVER_MAJOR = 18 as const;

// public-contract: image data directory used by deployment mounts.
export const POSTGRES_PGDATA = "/var/lib/postgresql/18/docker" as const;

// public-contract: stable volume mount path exposed by the pack.
export const POSTGRES_DATA_MOUNT_PATH = "/var/lib/postgresql" as const;

export const POSTGRES_PORT = 5432 as const;

function postgresImageDigest(
	architecture: PackArchitecture,
): string | undefined {
	switch (architecture) {
		case "linux/amd64":
			return POSTGRES_IMAGE_DIGESTS["linux/amd64"];
		case "linux/arm64":
			return POSTGRES_IMAGE_DIGESTS["linux/arm64"];
		default:
			return undefined;
	}
}

export function postgresImageReference(
	architecture: PackArchitecture,
): string | undefined {
	const digest = postgresImageDigest(architecture);
	return digest === undefined
		? undefined
		: `${POSTGRES_IMAGE_REPOSITORY}@${digest}`;
}
