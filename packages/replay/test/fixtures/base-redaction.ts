/**
 * `redactDebugPayload` as it stood on the base branch (169d87fcf819), copied by a script
 * with only the declarations it reaches, as the oracle the differential test
 * holds the shared redactor to. Not edited by hand but for the lint's disable
 * block and SAFETY lines; do not import it from src.
 */

const MASK_TOKEN = "••••";

const SENSITIVE_DEBUG_KEY =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|credentials?)$/i;
const HIDDEN_REASONING_KEY =
	/^(?:reasoning|chain[_-]?of[_-]?thought|hidden[_-]?reasoning|thoughts)$/i;
const SECRET_STRING =
	/(?:Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s/]+@|\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=)/i;

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: the base walked whatever debug payload a recorder handed it, which nobody had parsed; this copy is that walk as it stood. */
/** Redact generic debug payloads before every persistence path, at every level. */
export function redactDebugPayload(
	payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	// SAFETY: redactDebugValue maps an object to an object of the same keys.
	return Object.freeze(redactDebugValue(payload) as Record<string, unknown>);
}

function redactDebugValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(redactDebugValue));
	}
	if (typeof value === "string") {
		return SECRET_STRING.test(value) ? MASK_TOKEN : value;
	}
	if (value === null || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	// SAFETY: value is a non-null object here, so its entries are string keys.
	for (const [key, nested] of Object.entries(
		value as Record<string, unknown>,
	)) {
		if (SENSITIVE_DEBUG_KEY.test(key) || HIDDEN_REASONING_KEY.test(key)) {
			out[key] = MASK_TOKEN;
			continue;
		}
		out[key] = redactDebugValue(nested);
	}
	return Object.freeze(out);
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
