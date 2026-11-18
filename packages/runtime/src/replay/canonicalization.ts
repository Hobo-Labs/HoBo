import type { CanonicalizationVersion } from "./types.js";

/** Version 1 is the historical, locale-sensitive encoding. */
export function canonicalizationVersion(
	value: CanonicalizationVersion | undefined,
	defaultVersion?: CanonicalizationVersion,
): CanonicalizationVersion {
	if (value === undefined && defaultVersion !== undefined)
		return defaultVersion;
	if (value === 1 || value === 2) return value;
	throw new RangeError("unsupported replay canonicalization version");
}

export function compareCanonicalStrings(
	left: string,
	right: string,
	version: CanonicalizationVersion,
): number {
	if (version === 1) return left.localeCompare(right);
	return left < right ? -1 : left > right ? 1 : 0;
}
