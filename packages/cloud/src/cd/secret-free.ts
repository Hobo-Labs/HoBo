/**
 * Secret-free-by-construction status / diff projections (ADR-0027).
 * Diffs, status, and events carry references only — never plaintext secrets.
 * Closes the Argo ServerSideDiff / incomplete-masking class of leaks.
 */
import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

// public-contract: secret-free projection schema.
export const SECRET_FREE_SCHEMA = "hobo.secret-free-projection/v1" as const;

/** Secret-bearing field names (not opaque *Id / *Ref / *Hash identifiers). */
const SECRET_KEY_PATTERN =
	/(password|secret|token|api[_-]?key|private[_-]?key|kubeconfig|authorization|^credentials?$)/i;

const PLAINTEXT_SECRET_PATTERN =
	/(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/;

export type SecretRef = Readonly<{
	/** Opaque reference only — never the raw value. */
	ref: string;
	kind: "secretRef" | "valueRef" | "redacted";
}>;

export type SecretFreeDiffChange = Readonly<{
	path: string;
	action: "create" | "update" | "delete" | "unchanged";
	/** Before value is always a ref or redacted marker — never plaintext secret. */
	before?: string | SecretRef;
	after?: string | SecretRef;
}>;

export type SecretFreeDiff = Readonly<{
	schemaVersion: typeof SECRET_FREE_SCHEMA;
	summary: string;
	changes: readonly SecretFreeDiffChange[];
	secretBearingPaths: readonly string[];
	contentHash: `sha256:${string}`;
}>;

export type SecretFreeStatus = Readonly<{
	schemaVersion: typeof SECRET_FREE_SCHEMA;
	resourceId: string;
	state: string;
	outputs: Readonly<Record<string, string | SecretRef>>;
	secretRefs: readonly string[];
	/** True when projection was scrubbed. */
	secretFree: true;
}>;

/**
 * Convert arbitrary outputs into secret-free form.
 * Keys that look secret-bearing become secretRef; values that look like
 * plaintext secrets are always redacted.
 */
export function toSecretFreeOutputs(outputs: Readonly<JsonObject>): {
	readonly outputs: Readonly<Record<string, string | SecretRef>>;
	readonly secretRefs: readonly string[];
} {
	const out: Record<string, string | SecretRef> = {};
	const refs: string[] = [];
	for (const [key, raw] of Object.entries(outputs)) {
		const asString =
			raw === null || raw === undefined
				? ""
				: isJsonString(raw)
					? raw
					: JSON.stringify(raw);
		if (
			SECRET_KEY_PATTERN.test(key) ||
			PLAINTEXT_SECRET_PATTERN.test(asString)
		) {
			const ref = makeSecretRef(key, asString);
			out[key] = Object.freeze({ ref, kind: "secretRef" as const });
			refs.push(ref);
		} else if (isJsonObject(raw) && raw !== null) {
			// Nested objects: only surface a content hash, never nested secrets.
			const hash = contentHash(asString);
			out[key] = Object.freeze({
				ref: `valueRef:${key}:${hash}`,
				kind: "valueRef" as const,
			});
			refs.push(`valueRef:${key}:${hash}`);
		} else {
			out[key] = asString;
		}
	}
	return Object.freeze({
		outputs: Object.freeze(out),
		secretRefs: Object.freeze(refs),
	});
}

export function createSecretFreeDiff(input: {
	readonly summary: string;
	readonly changes: readonly {
		readonly path: string;
		readonly action: SecretFreeDiffChange["action"];
		readonly before?: JsonValue;
		readonly after?: JsonValue;
	}[];
}): SecretFreeDiff {
	const secretBearingPaths: string[] = [];
	const changes = input.changes.map((c) => {
		const secretPath = SECRET_KEY_PATTERN.test(c.path);
		if (secretPath) secretBearingPaths.push(c.path);
		return Object.freeze({
			path: c.path,
			action: c.action,
			...(c.before !== undefined
				? { before: scrubValue(c.path, c.before) }
				: undefined),
			...(c.after !== undefined
				? { after: scrubValue(c.path, c.after) }
				: undefined),
		});
	});
	const body = {
		schemaVersion: SECRET_FREE_SCHEMA,
		summary: input.summary,
		changes,
		secretBearingPaths,
	};
	const contentHash =
		`sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}` as const;
	return Object.freeze({
		schemaVersion: SECRET_FREE_SCHEMA,
		summary: input.summary,
		changes: Object.freeze(changes),
		secretBearingPaths: Object.freeze(secretBearingPaths),
		contentHash,
	});
}

export function createSecretFreeStatus(input: {
	readonly resourceId: string;
	readonly state: string;
	readonly outputs: Readonly<JsonObject>;
}): SecretFreeStatus {
	const scrubbed = toSecretFreeOutputs(input.outputs);
	return Object.freeze({
		schemaVersion: SECRET_FREE_SCHEMA,
		resourceId: input.resourceId,
		state: input.state,
		outputs: scrubbed.outputs,
		secretRefs: scrubbed.secretRefs,
		secretFree: true as const,
	});
}

/**
 * Assert a projection/event payload contains no plaintext secrets.
 * Throws if a known secret pattern is found in string leaves.
 */
// `unknown`, not `JsonValue`: this walks a structure type-testing as it goes
// (`isJsonString`, `isJsonObject`, …), so it is written against untyped input
// already. Demanding `JsonValue` only made every caller launder a domain record
// into a JSON view before it could be *checked for secrets* -- work done purely
// to satisfy the checker, on the path where getting it wrong leaks a credential.
export function assertSecretFree(value: unknown, path = "$"): void {
	if (isJsonString(value)) {
		if (PLAINTEXT_SECRET_PATTERN.test(value)) {
			throw Object.assign(
				new Error(`secret-free violation at ${path}: plaintext secret pattern`),
				{ code: "secret-free-violation", path },
			);
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, i) => {
			assertSecretFree(v, `${path}[${i}]`);
		});
		return;
	}
	if (value && isJsonObject(value)) {
		// SAFETY: `for (const [k, v] of Object.entries(value as JsonObject)) {` is required at this I/O or test boundary.
		for (const [k, v] of Object.entries(value as JsonObject)) {
			// Opaque identifiers (credentialId, grantId, …) are references, not secrets.
			const opaqueId = /(?:Id|Ref|Hash|Digest)$/.test(k);
			if (
				!opaqueId &&
				SECRET_KEY_PATTERN.test(k) &&
				isJsonString(v) &&
				!v.startsWith("secretRef:") &&
				!v.startsWith("valueRef:") &&
				!v.startsWith("sha256:") &&
				!v.startsWith("scoped-") &&
				v.length > 0
			) {
				throw Object.assign(
					new Error(
						`secret-free violation at ${path}.${k}: secret-bearing key holds non-ref string`,
					),
					{ code: "secret-free-violation", path: `${path}.${k}` },
				);
			}
			assertSecretFree(v, `${path}.${k}`);
		}
	}
}

function scrubValue(path: string, value: JsonValue): string | SecretRef {
	const asString = isJsonString(value) ? value : JSON.stringify(value ?? null);
	if (
		SECRET_KEY_PATTERN.test(path) ||
		PLAINTEXT_SECRET_PATTERN.test(asString)
	) {
		return Object.freeze({
			ref: makeSecretRef(path, asString),
			kind: "secretRef" as const,
		});
	}
	if (isJsonString(value)) return value;
	return Object.freeze({
		ref: `valueRef:${path}:${contentHash(asString)}`,
		kind: "valueRef" as const,
	});
}

function makeSecretRef(key: string, value: string): string {
	return `secretRef:${key}:${contentHash(value).slice(0, 16)}`;
}

function contentHash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
