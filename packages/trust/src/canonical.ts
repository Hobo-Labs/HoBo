/**
 * Canonical serialization for evidence digests.
 *
 * Two evidence records that differ only in authoring key order must produce
 * byte-identical bytes, otherwise a digest is a formatting artefact rather than
 * a statement about content.
 */
import { createHash } from "node:crypto";

export type CanonicalValue =
	| string
	| number
	| boolean
	| null
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue | undefined };

export class CanonicalizationError extends Error {
	readonly code = "CANONICALIZATION_FAILED" as const;

	constructor(message: string) {
		super(message);
		this.name = "CanonicalizationError";
	}
}

/** Deterministic JSON: sorted object keys, dropped `undefined`, no whitespace. */
export function canonicalize(value: CanonicalValue): string {
	if (value === null) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new CanonicalizationError(
				"non-finite numbers are not canonicalizable",
			);
		}
		return JSON.stringify(value);
	}
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${(value as readonly CanonicalValue[])
			.map((entry) => canonicalize(entry))
			.join(",")}]`;
	}
	const record = value as {
		readonly [key: string]: CanonicalValue | undefined;
	};
	const keys = Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${keys
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalize(record[key] as CanonicalValue)}`,
		)
		.join(",")}}`;
}

export function sha256Of(value: CanonicalValue): string {
	return `sha256:${createHash("sha256").update(canonicalize(value), "utf8").digest("hex")}`;
}

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
