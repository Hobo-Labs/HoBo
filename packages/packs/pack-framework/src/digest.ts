/**
 * Digest-pinned image references.
 *
 * A tag is a mutable pointer. `postgres:17` names whatever the publisher pushed
 * most recently, which means a pack pinned to a tag is a pack whose contents can
 * change between the moment its conformance evidence was gathered and the moment
 * it runs. These parsers therefore accept `<registry>/<repository>@sha256:<hex>`
 * and nothing else: the tag form is unrepresentable past this boundary rather
 * than merely discouraged.
 */
import { PackError } from "./errors.js";
import { isJsonString } from "./json.js";

declare const imageDigestBrand: unique symbol;
declare const pinnedImageRefBrand: unique symbol;
declare const repositoryBrand: unique symbol;

/** `sha256:<64 lowercase hex>`. Construct only through {@link parseImageDigest}. */
export type ImageDigest = string & {
	readonly [imageDigestBrand]: "ImageDigest";
};

/** A fully qualified, digest-pinned reference. */
export type PinnedImageRef = string & {
	readonly [pinnedImageRefBrand]: "PinnedImageRef";
};

/** `<registry-host>[:port]/<path>` with no tag and no digest. */
export type ImageRepository = string & {
	readonly [repositoryBrand]: "ImageRepository";
};

export type ParsedPinnedImageRef = {
	readonly ref: PinnedImageRef;
	readonly registry: string;
	readonly repository: ImageRepository;
	/** Repository path with the registry host removed, e.g. `library/postgres`. */
	readonly repositoryPath: string;
	readonly digest: ImageDigest;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/u;
const PATH_SEGMENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;

/**
 * Parse-don't-validate boundary for a content digest.
 *
 * Only sha256 is accepted. sha512 is defined by the OCI image spec but is not
 * what registries in this repo's evidence actually serve, and accepting an
 * algorithm we have never verified end to end would be an unearned claim.
 */
export function parseImageDigest(input: string): ImageDigest {
	if (!isJsonString(input) || !DIGEST.test(input)) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"image digest must be sha256:<64 lowercase hex characters>",
			{ detail: { length: isJsonString(input) ? input.length : 0 } },
		);
	}
	// SAFETY: `return input as ImageDigest;` is required at this I/O or test boundary.
	return input as ImageDigest;
}

export function parseImageRepository(input: string): ImageRepository {
	if (!isJsonString(input) || input.length === 0 || input.length > 255) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			"image repository must be a 1-255 character <registry>/<path> string",
		);
	}
	if (input !== input.toLowerCase()) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			"image repository must be lowercase (canonical registry form)",
		);
	}
	const slash = input.indexOf("/");
	if (slash <= 0 || slash === input.length - 1) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			"image repository must be fully qualified as <registry-host>/<path>; an implicit Docker Hub default hides which registry is being trusted",
		);
	}
	const host = input.slice(0, slash);
	if (!REGISTRY_HOST.test(host)) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			"image registry host is not a valid host",
		);
	}
	const segments = input.slice(slash + 1).split("/");
	for (const segment of segments) {
		if (!PATH_SEGMENT.test(segment)) {
			throw new PackError(
				"PACK_MANIFEST_INVALID",
				"image repository path segments must match the OCI distribution grammar",
			);
		}
	}
	// SAFETY: `return input as ImageRepository;` is required at this I/O or test boundary.
	return input as ImageRepository;
}

/**
 * Parse `<registry>/<path>@sha256:<hex>`.
 *
 * A reference carrying `:tag` — with or without a digest — is rejected with the
 * pack integrity code, because "pinned plus a tag for readability" is how a
 * moving pointer gets back into a supply chain.
 */
export function parsePinnedImageRef(input: string): ParsedPinnedImageRef {
	if (!isJsonString(input) || input.length === 0) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			"image reference must be a non-empty string",
		);
	}
	const at = input.indexOf("@");
	if (at < 0) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"image reference is not digest-pinned; a pack may only run an image addressed by @sha256:<hex>",
		);
	}
	if (input.indexOf("@", at + 1) >= 0) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"image reference contains more than one digest separator",
		);
	}
	const repositoryPart = input.slice(0, at);
	const digest = parseImageDigest(input.slice(at + 1));

	// A colon after the last slash is a tag. A colon inside the host is a port,
	// which is legitimate, so the check is scoped to the path.
	const lastSlash = repositoryPart.lastIndexOf("/");
	if (repositoryPart.slice(lastSlash + 1).includes(":")) {
		throw new PackError(
			"PACK_INTEGRITY_UNVERIFIED",
			"image reference carries a mutable tag alongside its digest; drop the tag so only the digest can be resolved",
		);
	}

	const repository = parseImageRepository(repositoryPart);
	const registry = repositoryPart.slice(0, repositoryPart.indexOf("/"));
	return {
		// SAFETY: `ref: `${repository}@${digest}` as PinnedImageRef,` is required at this I/O or test boundary.
		ref: `${repository}@${digest}` as PinnedImageRef,
		registry,
		repository,
		repositoryPath: repositoryPart.slice(repositoryPart.indexOf("/") + 1),
		digest,
	};
}

export function tryParsePinnedImageRef(
	input: string,
): ParsedPinnedImageRef | undefined {
	try {
		return parsePinnedImageRef(input);
	} catch {
		return undefined;
	}
}

/**
 * The OCI distribution path that resolves a pinned image, and the only path a
 * pack pull may use. Tag resolution (`/manifests/<tag>`) is not expressible.
 */
export function manifestPathFor(image: ParsedPinnedImageRef): string {
	return `/v2/${image.repositoryPath}/manifests/${image.digest}`;
}
