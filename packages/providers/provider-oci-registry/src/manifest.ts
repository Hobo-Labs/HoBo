/**
 * Manifest parse boundary: what a manifest or index references, nothing more.
 *
 * The realizer never rewrites a manifest. It copies the exact bytes and reads
 * them only to learn which blobs and child manifests must exist first, so the
 * digest a mirror serves is the digest the source served (D22).
 */
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";
import {
	INDEX_MEDIA_TYPES,
	isDigest,
	MANIFEST_MEDIA_TYPES,
	type ManifestMediaType,
	rejected,
	unparseable,
} from "./reference.js";

export interface Descriptor {
	readonly digest: string;
	readonly size: number;
	readonly mediaType: string;
}

export interface ParsedManifest {
	readonly mediaType: ManifestMediaType;
	/** Config and layers of an image manifest; empty for an index. */
	readonly blobs: readonly Descriptor[];
	/** Child manifests of an index; empty for an image manifest. */
	readonly children: readonly Descriptor[];
	/** Blobs a registry is not required to serve (foreign/non-distributable). */
	readonly skipped: readonly Descriptor[];
}

/** Upper bounds: past these a manifest is a payload, not an image. */
export const MAX_LAYERS = 256;
export const MAX_CHILDREN = 128;

function descriptor(value: JsonValue | undefined, path: string): Descriptor {
	if (!isJsonObject(value)) unparseable(`${path} is not a descriptor`);
	const { digest, size, mediaType } = value;
	if (!isJsonString(digest) || !isDigest(digest))
		rejected(
			`${path}.digest is not a sha256 digest`,
			"copy only sha256-addressed content; other algorithms are not verified by every target registry",
		);
	if (!isJsonNumber(size) || !Number.isSafeInteger(size) || size < 0)
		unparseable(`${path}.size is not a non-negative integer`);
	if (
		!isJsonString(mediaType) ||
		mediaType.length === 0 ||
		mediaType.length > 255
	)
		unparseable(`${path}.mediaType is missing`);
	return { digest, size, mediaType };
}

function nonDistributable(mediaType: string): boolean {
	return (
		mediaType.includes(".foreign.") || mediaType.includes(".nondistributable.")
	);
}

/** Strip parameters from a Content-Type and return it when it is a manifest type. */
export function manifestMediaType(
	contentType: string | undefined,
): ManifestMediaType | undefined {
	const bare = contentType?.split(";")[0]?.trim().toLowerCase();
	return MANIFEST_MEDIA_TYPES.find((type) => type === bare);
}

/**
 * Parse manifest text. `declared` is the media type the registry reported;
 * when it is absent the body's own `mediaType` decides, and when both are
 * absent or unknown (schema 1, a foreign artifact type) the copy is refused.
 */
export function parseManifest(
	text: string,
	declared: string | undefined,
): ParsedManifest {
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		value = JSON.parse(text) as JsonValue;
	} catch {
		return unparseable("manifest is not JSON");
	}
	if (!isJsonObject(value)) return unparseable("manifest is not a JSON object");
	const own = isJsonString(value.mediaType) ? value.mediaType : undefined;
	const mediaType = manifestMediaType(declared) ?? manifestMediaType(own);
	if (mediaType === undefined)
		rejected(
			`manifest media type ${JSON.stringify((declared ?? own ?? "absent").slice(0, 120))} is not one this realizer copies`,
			"convert schema-1 images to OCI or Docker v2 before promotion; the digest must not change in flight",
		);
	if (own !== undefined && manifestMediaType(own) !== mediaType)
		rejected(
			"manifest body mediaType disagrees with the registry's Content-Type",
		);
	if (INDEX_MEDIA_TYPES.includes(mediaType)) {
		const list = value.manifests;
		if (!isJsonArray(list)) return unparseable("index has no manifests array");
		if (list.length > MAX_CHILDREN)
			rejected(
				`index lists ${list.length} manifests, over the ${MAX_CHILDREN} bound`,
			);
		return {
			mediaType,
			blobs: [],
			children: list.map((entry, index) =>
				descriptor(entry, `manifests[${index}]`),
			),
			skipped: [],
		};
	}
	const layers = value.layers;
	if (!isJsonArray(layers)) return unparseable("manifest has no layers array");
	if (layers.length > MAX_LAYERS)
		rejected(
			`manifest lists ${layers.length} layers, over the ${MAX_LAYERS} bound`,
		);
	const all = [
		descriptor(value.config, "config"),
		...layers.map((entry, index) => descriptor(entry, `layers[${index}]`)),
	];
	return {
		mediaType,
		blobs: all.filter((entry) => !nonDistributable(entry.mediaType)),
		children: [],
		skipped: all.filter((entry) => nonDistributable(entry.mediaType)),
	};
}

/** The descriptors a referrers response (or fallback-tag index) lists. */
export function parseReferrers(text: string): readonly Descriptor[] {
	let value: JsonValue;
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		value = JSON.parse(text) as JsonValue;
	} catch {
		return unparseable("referrers response is not JSON");
	}
	if (!isJsonObject(value) || !isJsonArray(value.manifests))
		return unparseable("referrers response is not an index");
	if (value.manifests.length > MAX_CHILDREN)
		rejected(
			`subject has ${value.manifests.length} referrers, over the ${MAX_CHILDREN} bound`,
		);
	return value.manifests.map((entry, index) =>
		descriptor(entry, `referrers[${index}]`),
	);
}
