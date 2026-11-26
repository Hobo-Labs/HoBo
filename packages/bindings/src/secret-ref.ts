/**
 * SecretRef — a locator for secret authority, never the secret itself.
 *
 * Provider-returned connection strings and tokens are captured server-side and
 * deposited into secret custody immediately; plans, manifests, events, receipts,
 * projections, UI payloads, and logs only ever see one of these references plus
 * non-secret endpoint metadata.
 */

declare const secretRefBrand: unique symbol;

export type SecretRef = string & { readonly [secretRefBrand]: "SecretRef" };

/** Registered locator schemes. Open for extension, closed to arbitrary input. */
export const SECRET_REF_SCHEMES = [
	"vault",
	"azure-kv",
	"aws-sm",
	"gcp-sm",
	"op",
	"infisical",
	"hobo-secret",
	"hobo-token",
] as const;

export type SecretRefScheme = (typeof SECRET_REF_SCHEMES)[number];

export type ParsedSecretRef = {
	readonly ref: SecretRef;
	readonly scheme: SecretRefScheme;
	readonly authority: string;
	readonly path: readonly string[];
	/** Scheme-specific field selector (URI fragment) when the scheme allows it. */
	readonly field?: string;
};

type MutableParsedSecretRef = {
	ref: SecretRef;
	scheme: SecretRefScheme;
	authority: string;
	path: readonly string[];
	field?: string;
};

export class SecretRefError extends Error {
	readonly code:
		| "SECRET_REFERENCE_INVALID"
		| "SECRET_REFERENCE_FORBIDDEN_SCHEME"
		| "SECRET_REFERENCE_EMBEDS_VALUE";

	constructor(
		code:
			| "SECRET_REFERENCE_INVALID"
			| "SECRET_REFERENCE_FORBIDDEN_SCHEME"
			| "SECRET_REFERENCE_EMBEDS_VALUE",
		message: string,
	) {
		// The offending input is deliberately not interpolated: a rejected
		// reference is frequently a leaked plaintext credential.
		super(message);
		this.name = "SecretRefError";
		this.code = code;
	}
}

/** Schemes whose specification permits a `#field` selector. */
const FIELD_SCHEMES = new Set<SecretRefScheme>([
	"vault",
	"op",
	"infisical",
	"hobo-secret",
]);

/** Shapes that indicate a plaintext credential was passed where a ref belongs. */
const PLAINTEXT_MARKERS: readonly RegExp[] = [
	/^postgres(?:ql)?:\/\//iu,
	/^rediss?:\/\//iu,
	/^mysql:\/\//iu,
	/^mongodb(?:\+srv)?:\/\//iu,
	/^amqps?:\/\//iu,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
	/^Bearer\s+\S+/iu,
	/^(?:sk|pk|ghp|gho|xox[abpsr])[-_][A-Za-z0-9_-]{8,}/u,
	/^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./u,
];

// `\p{Cc}` rather than an explicit escape range: it also covers the C1 block
// (U+0080-U+009F), so terminal-escape smuggling is rejected on the same path
// as the C0 log-forging characters this guard already caught.
const CONTROL_CHARS = /\p{Cc}/u;

function assertNoPlaintext(input: string): void {
	for (const marker of PLAINTEXT_MARKERS) {
		if (marker.test(input)) {
			throw new SecretRefError(
				"SECRET_REFERENCE_EMBEDS_VALUE",
				"value looks like a plaintext credential, not a secret locator; deposit it into secret custody and reference it instead",
			);
		}
	}
}

/**
 * Parse an opaque locator URI into a branded {@link SecretRef}.
 *
 * Rejects: unregistered schemes, embedded userinfo, control characters and
 * log-forging sequences, path traversal, empty paths, and fragments on schemes
 * whose specification does not define one.
 */
export function parseSecretRef(input: string): ParsedSecretRef {
	if (input.length === 0) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference must be a non-empty string",
		);
	}
	if (input.length > 2048) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference exceeds the 2048 character limit",
		);
	}
	if (CONTROL_CHARS.test(input)) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference contains control characters",
		);
	}
	assertNoPlaintext(input);

	const separator = input.indexOf("://");
	if (separator <= 0) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference must be a <scheme>://<authority>/<path> URI",
		);
	}
	const scheme = input.slice(0, separator);
	if (scheme !== scheme.toLowerCase()) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference scheme must be lowercase",
		);
	}
	const typedScheme = SECRET_REF_SCHEMES.find(
		(candidate) => candidate === scheme,
	);
	if (typedScheme === undefined) {
		throw new SecretRefError(
			"SECRET_REFERENCE_FORBIDDEN_SCHEME",
			`secret reference scheme ${JSON.stringify(scheme)} is not registered`,
		);
	}
	let remainder = input.slice(separator + 3);
	let field: string | undefined;
	const hash = remainder.indexOf("#");
	if (hash >= 0) {
		field = remainder.slice(hash + 1);
		remainder = remainder.slice(0, hash);
		if (!FIELD_SCHEMES.has(typedScheme)) {
			throw new SecretRefError(
				"SECRET_REFERENCE_INVALID",
				`scheme ${scheme} does not define a fragment selector`,
			);
		}
		if (field.length === 0 || !/^[A-Za-z0-9._-]+$/u.test(field)) {
			throw new SecretRefError(
				"SECRET_REFERENCE_INVALID",
				"fragment selector must be a simple field name",
			);
		}
	}
	if (remainder.includes("?")) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference must not carry a query string",
		);
	}
	if (remainder.includes("@")) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference must not embed userinfo",
		);
	}

	const segments = remainder.split("/").filter((segment) => segment.length > 0);
	if (segments.length < 2) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference needs an authority and at least one path segment",
		);
	}
	for (const segment of segments) {
		if (segment === "." || segment === "..") {
			throw new SecretRefError(
				"SECRET_REFERENCE_INVALID",
				"secret reference must not contain path traversal segments",
			);
		}
		if (!/^[A-Za-z0-9._~-]+$/u.test(segment)) {
			throw new SecretRefError(
				"SECRET_REFERENCE_INVALID",
				"secret reference path segments must be unreserved URI characters",
			);
		}
	}

	const authority = segments[0];
	if (authority === undefined) {
		throw new SecretRefError(
			"SECRET_REFERENCE_INVALID",
			"secret reference needs an authority and at least one path segment",
		);
	}
	const path = segments.slice(1);
	// SAFETY: every segment was validated as an unreserved URI component above.
	const canonical = `${scheme}://${authority}/${path.join("/")}${
		field !== undefined ? `#${field}` : ""
	}` as SecretRef;

	// SAFETY: scheme, authority, path, and ref were all established by the checks above.
	const parsed = {
		ref: canonical,
		scheme: typedScheme,
		authority,
		path,
	} as MutableParsedSecretRef;
	if (field !== undefined) parsed.field = field;
	return parsed;
}

export function tryParseSecretRef(input: string): ParsedSecretRef | undefined {
	try {
		return parseSecretRef(input);
	} catch {
		return undefined;
	}
}

/**
 * The only formatter for a reference in user-facing or operator output.
 *
 * A reference is not itself a secret, but its full path can disclose tenant
 * layout, so everything past the first path segment is elided.
 */
export function redactSecretRef(
	ref: ParsedSecretRef | SecretRef | string,
): string {
	const parsed = isParsedSecretRef(ref) ? ref : tryParseSecretRef(ref);
	if (parsed === undefined) return "<redacted-secret-ref>";
	const head = parsed.path[0] ?? "";
	const tail = parsed.path.length > 1 ? "/…" : "";
	return `${parsed.scheme}://${parsed.authority}/${head}${tail}${
		parsed.field !== undefined ? "#…" : ""
	}`;
}

function isParsedSecretRef(
	ref: ParsedSecretRef | SecretRef | string,
): ref is ParsedSecretRef {
	return "scheme" in Object(ref);
}

/**
 * A resolved secret value that refuses to serialize itself.
 *
 * Only the authorized runtime projection path calls {@link SecretValue.expose}.
 * `toString`, `toJSON`, and Node inspection all return the redacted reference,
 * which is what keeps a credential out of an interpolated shell command, a log
 * line, or a thrown error's message.
 */
export class SecretValue {
	readonly #value: string;
	readonly #ref: ParsedSecretRef;

	constructor(ref: ParsedSecretRef, value: string) {
		this.#ref = ref;
		this.#value = value;
	}

	get ref(): SecretRef {
		return this.#ref.ref;
	}

	expose(): string {
		return this.#value;
	}

	toString(): string {
		return redactSecretRef(this.#ref);
	}

	toJSON(): string {
		return redactSecretRef(this.#ref);
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return `SecretValue(${redactSecretRef(this.#ref)})`;
	}
}
