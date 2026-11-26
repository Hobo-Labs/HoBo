/**
 * The pinned Valkey image.
 *
 * Every digest here was read out of the Docker Hub registry API on 2026-08-08 by
 * resolving the `9-alpine` tag to its OCI image index and taking the per-platform
 * manifest digests from that index. The tag is provenance only — nothing in this
 * package can resolve it, because `parsePinnedImageRef` refuses a reference that
 * carries one.
 */
import type { PackArchitecture } from "@hobo/pack-framework";

// public-contract: canonical OCI repository for the pack image.
export const VALKEY_IMAGE_REPOSITORY = "docker.io/valkey/valkey" as const;

/** Provenance only. A pull by tag is unrepresentable in this package. */
// public-contract: human-readable tag from which the digest was resolved.
export const VALKEY_RESOLVED_FROM_TAG = "9-alpine" as const;

/** Digest of the OCI image index the per-platform digests came out of. */
// public-contract: pinned multi-platform image digest.
export const VALKEY_IMAGE_INDEX_DIGEST =
	"sha256:ee91f7a174ac4d6a6b0685b3a60e321f0a9dbbb691f9b0e285be2ba1d1be8328" as const;

/**
 * Per-platform manifest digests.
 *
 * The index also carries `linux/arm/v7` and `linux/ppc64le`. Those are omitted
 * rather than copied: pinning a digest nobody has run is a support claim without
 * evidence, and `ARCHITECTURE_UNSUPPORTED` is the honest answer instead.
 */
interface ValkeyImageDigests {
	"linux/amd64": string;
	"linux/arm64": string;
}

export const VALKEY_IMAGE_DIGESTS: ValkeyImageDigests = {
	"linux/amd64":
		"sha256:3fe38a705227d29534a199e876b38d5474dec4d3baca980ac6894df539416562",
	"linux/arm64":
		"sha256:5a345cba0feab47d27275e90515580e95a3de3ee00a132efc6f8f8eb67115213",
};

/** `VALKEY_VERSION` read from the pinned amd64 image's config blob. */
// public-contract: server version represented by the pinned image.
export const VALKEY_SERVER_VERSION = "9.1.1" as const;

export const VALKEY_SERVER_MAJOR = 9 as const;

/**
 * The image's `WORKDIR`, and where this pack mounts its volume.
 *
 * Worth being precise about: the pinned image declares **no** `VOLUME`. Redis's
 * official image did; Valkey's does not. A container started without an explicit
 * mount therefore writes its RDB file into the container's own filesystem layer
 * and loses it on removal, with no anonymous volume left behind as a consolation.
 * That is exactly why this pack requires the mount rather than defaulting.
 */
// public-contract: stable volume mount path exposed by the pack.
export const VALKEY_DATA_MOUNT_PATH = "/data" as const;

export const VALKEY_PORT = 6379 as const;

/** Where the rendered, non-secret server config is placed. */
// public-contract: image configuration path used by generated deployments.
export const VALKEY_CONFIG_PATH = "/etc/valkey/valkey.conf" as const;

/**
 * Where custody projects the `requirepass` directive.
 *
 * A separate file that the main config `include`s at its end, so the password is
 * never an argv element (`ps`-visible) and never an environment variable
 * (`/proc/<pid>/environ`- and `docker inspect`-visible).
 */
// public-contract: secret include path used by generated deployments.
export const VALKEY_REQUIREPASS_INCLUDE_PATH =
	"/run/secrets/valkey-requirepass.conf" as const;

function valkeyImageDigest(architecture: PackArchitecture): string | undefined {
	switch (architecture) {
		case "linux/amd64":
			return VALKEY_IMAGE_DIGESTS["linux/amd64"];
		case "linux/arm64":
			return VALKEY_IMAGE_DIGESTS["linux/arm64"];
		default:
			return undefined;
	}
}

export function valkeyImageReference(
	architecture: PackArchitecture,
): string | undefined {
	const digest = valkeyImageDigest(architecture);
	return digest === undefined
		? undefined
		: `${VALKEY_IMAGE_REPOSITORY}@${digest}`;
}
