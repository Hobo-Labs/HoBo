/**
 * `scanForCredentialMaterial` as it stood on the base branch (169d87fcf819), copied by a
 * script with only the declarations it reaches, as the oracle the differential
 * test holds the shared detectors to. Not edited by hand; do not import it from src.
 */
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../../src/json.js";

type CredentialScanHit = {
	readonly label: string;
	readonly path: string;
};

/** Patterns that must never appear in anything this package serializes. */
const CREDENTIAL_PATTERNS: readonly {
	readonly label: string;
	readonly pattern: RegExp;
}[] = [
	{
		label: "claim or drop url with parameters",
		pattern: /https?:\/\/\S*(?:claim|drop)\S*[?#]\S+/iu,
	},
	{
		label: "netlify session or site parameter",
		pattern: /\b(?:session_id|nf_jwt)=/iu,
	},
	{ label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{8,}/iu },
	{
		label: "netlify personal access token",
		pattern: /\bnfp_[A-Za-z0-9_-]{8,}/u,
	},
	{
		label: "netlify auth token assignment",
		pattern: /NETLIFY_(?:AUTH_)?TOKEN\s*[=:]\s*\S/iu,
	},
	{
		label: "connection string",
		pattern: /\b(?:postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?):\/\//iu,
	},
	{
		label: "api key assignment",
		pattern: /\bapi[_-]?key\s*[=:]\s*[^"\s,}]+/iu,
	},
	{
		label: "password assignment",
		pattern: /\b(?:password|passwd|pwd)\s*[=:]\s*[^"\s,}]+/iu,
	},
	{ label: "jwt", pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u },
	{ label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/**
 * Walk a JSON value and report credential-shaped strings with the path that
 * carried them, so a failure names the field rather than the haystack.
 */
export function scanForCredentialMaterial(
	value: JsonValue,
): readonly CredentialScanHit[] {
	const hits: CredentialScanHit[] = [];
	const seen = new WeakSet<object>();

	const walk = (node: JsonValue, path: string): void => {
		if (isJsonString(node)) {
			for (const pattern of CREDENTIAL_PATTERNS) {
				if (pattern.pattern.test(node)) {
					hits.push({ label: pattern.label, path });
				}
			}
			return;
		}
		if (node !== null && (isJsonArray(node) || isJsonObject(node))) {
			if (seen.has(node)) return;
			seen.add(node);
			const toJSON = "toJSON" in node ? node.toJSON : undefined;
			if (toJSON instanceof Function) {
				// SAFETY: custom serialization is an I/O boundary; scan its wire view.
				walk(toJSON.call(node) as JsonValue, path);
				return;
			}
		}
		if (isJsonArray(node)) {
			node.forEach((entry, index) => {
				walk(entry, `${path}[${index}]`);
			});
			return;
		}
		if (!isJsonObject(node)) return;
		for (const [key, entry] of Object.entries(node)) {
			walk(entry, path === "" ? key : `${path}.${key}`);
		}
	};

	walk(value, "");
	return hits;
}
