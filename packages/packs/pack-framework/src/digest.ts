import { PackError } from "./errors.js";
import { isJsonString } from "./json.js";

declare const imageDigestBrand: unique symbol;
declare const pinnedImageRefBrand: unique symbol;
declare const repositoryBrand: unique symbol;

export type ImageDigest = string & {
	readonly [imageDigestBrand]: "ImageDigest";
};

export type PinnedImageRef = string & {
	readonly [pinnedImageRefBrand]: "PinnedImageRef";
};

export type ImageRepository = string & {
	readonly [repositoryBrand]: "ImageRepository";
};

export type ParsedPinnedImageRef = {
	readonly ref: PinnedImageRef;
	readonly registry: string;
	readonly repository: ImageRepository;
	readonly repositoryPath: string;
	readonly digest: ImageDigest;
};

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/u;
const PATH_SEGMENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;

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

export function manifestPathFor(image: ParsedPinnedImageRef): string {
	return `/v2/${image.repositoryPath}/manifests/${image.digest}`;
}
