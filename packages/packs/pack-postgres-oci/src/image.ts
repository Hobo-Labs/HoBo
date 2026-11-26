/**
 * The pinned PostgreSQL image.
 *
 * Every digest here was read out of the Docker Hub registry API on 2026-08-08 by
 * resolving the `18-alpine` tag to its OCI image index and then taking the
 * per-platform manifest digests out of that index. The tag is recorded only as
 * provenance: nothing in this package can resolve it, because
 * `parsePinnedImageRef` refuses a reference that carries one.
 *
 * Pinning the *per-platform* manifest digest rather than the index digest is
 * deliberate. The index digest is what a `docker pull` resolves, but it is one
 * more indirection between the pack and the bytes that actually run, and the
 * pack already knows which architecture it is deploying to.
 */
import type { PackArchitecture } from "@hobo/pack-framework";

/** Fully qualified so it is never ambiguous which registry is being trusted. */
// public-contract: canonical OCI repository for the pack image.
export const POSTGRES_IMAGE_REPOSITORY = "docker.io/library/postgres" as const;

/**
 * The tag these digests were resolved from. Provenance only — a pull by tag is
 * unrepresentable in this package.
 */
// public-contract: human-readable tag from which the digest was resolved.
export const POSTGRES_RESOLVED_FROM_TAG = "18-alpine" as const;

/** Digest of the OCI image index the per-platform digests came out of. */
// public-contract: pinned multi-platform image digest.
export const POSTGRES_IMAGE_INDEX_DIGEST =
	"sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15" as const;

/**
 * Per-platform manifest digests.
 *
 * Only the two architectures HoBo has evidence for are pinned. The index also
 * carries linux/arm/v6, linux/arm/v7, linux/386, linux/ppc64le, linux/riscv64,
 * and linux/s390x; they are omitted rather than copied, because pinning a digest
 * nobody has run is a claim without evidence — `ARCHITECTURE_UNSUPPORTED` is the
 * honest answer for them.
 */
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

/** `PG_VERSION` read from the pinned amd64 image's config blob. */
// public-contract: server version represented by the pinned image.
export const POSTGRES_SERVER_VERSION = "18.4" as const;

/** `PG_MAJOR` read from the same config blob. */
export const POSTGRES_SERVER_MAJOR = 18 as const;

/**
 * `PGDATA` as the pinned image sets it.
 *
 * PostgreSQL 18 images moved this to a version-specific directory and moved the
 * declared `VOLUME` up to the parent, so that `pg_upgrade --link` can see both
 * major versions. Mounting the old `/var/lib/postgresql/data` path against an 18
 * image is the mistake this constant exists to prevent.
 */
// public-contract: image data directory used by deployment mounts.
export const POSTGRES_PGDATA = "/var/lib/postgresql/18/docker" as const;

/** The path the durable volume must be mounted at for this image. */
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
