/**
 * Client-side privacy masking before any network send or local persistence.
 * Default masks: password / email / tel inputs + configurable selectors.
 */
import {
	defaultPrivacyPolicy,
	type PrivacyPolicy,
	type RrwebEvent,
} from "./types.js";

const SENSITIVE_INPUT_TYPES = new Set(["password", "email", "tel"]);

const MASK_TOKEN = "••••";

export type MaskContext = Readonly<{
	tag?: string;
	type?: string;
	attributes?: Readonly<Record<string, string>>;
	text?: string;
	selectorHints?: readonly string[];
}>;

/**
 * Returns true when a DOM-ish node context should be fully masked under policy.
 */
export function shouldMaskNode(
	ctx: MaskContext,
	policy: PrivacyPolicy = defaultPrivacyPolicy(),
): boolean {
	const type = (ctx.type ?? ctx.attributes?.type ?? "").toLowerCase();
	if (policy.maskPasswords && type === "password") return true;
	if (policy.maskEmails && type === "email") return true;
	if (policy.maskTel && type === "tel") return true;
	if (policy.maskInputs && (ctx.tag === "input" || ctx.tag === "textarea")) {
		return true;
	}
	const attrs = ctx.attributes ?? {};
	for (const sel of policy.maskSelectors) {
		if (sel.startsWith("[") && sel.endsWith("]")) {
			const attr = sel
				.slice(1, -1)
				.split("=")[0]
				?.replace(/^data-/, "data-");
			// Attribute presence selectors like [data-hobo-mask]
			const bare = sel.slice(1, -1);
			if (!bare.includes("=") && bare in attrs) return true;
			if (
				bare.startsWith("type=") &&
				type === bare.slice(5).replace(/['"]/g, "")
			) {
				return true;
			}
			if (attr && attr in attrs) return true;
		}
		if (
			sel.startsWith(".") &&
			ctx.selectorHints?.some((h) => h.includes(sel.slice(1)))
		) {
			return true;
		}
		if (sel.includes("input[type=") && SENSITIVE_INPUT_TYPES.has(type)) {
			return true;
		}
	}
	return false;
}

/**
 * Redact a single rrweb-like event under the privacy policy.
 * Never ships raw password/email/tel values under default policy.
 */
export function maskRrwebEvent(
	event: RrwebEvent,
	policy: PrivacyPolicy = defaultPrivacyPolicy(),
): RrwebEvent {
	const data = deepMask(event.data, policy);
	return Object.freeze({
		type: event.type,
		timestamp: event.timestamp,
		data: Object.freeze(data),
	});
}

export function maskRrwebEvents(
	events: readonly RrwebEvent[],
	policy: PrivacyPolicy = defaultPrivacyPolicy(),
): readonly RrwebEvent[] {
	return Object.freeze(events.map((e) => maskRrwebEvent(e, policy)));
}

export const SENSITIVE_DEBUG_KEY =
	/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|private[_-]?key|credentials?)$/i;
const HIDDEN_REASONING_KEY =
	/^(?:reasoning|chain[_-]?of[_-]?thought|hidden[_-]?reasoning|thoughts)$/i;
// Each alternative starts once per run it reads. The JWT one starts where a run
// of base64url characters starts and finds the first `eyJ` in it, the URL one at
// the first letter of a scheme run, and the assignment one checks for the key
// name in one look-ahead: the forms they replace started again at every `eyJ`,
// at every letter, and at every place a key name could end, each reading to the
// end of the run, so a long hostile string took quadratic time to test. Each
// accepts exactly the strings its old form did.
export const SECRET_STRING =
	/(?:Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5})[A-Za-z0-9_-]*?eyJ[A-Za-z0-9_-]{5,}\.|(?<![A-Za-z0-9+.-])[0-9+.-]*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s/]+@|\b[A-Z](?=[A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?))[A-Z0-9_]*\s*=)/i;

/** Redact generic debug payloads before every persistence path, at every level. */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: these walk whatever debug payload a recorder hands them, which nobody has parsed, and must look at each value's representation to mask it before it is kept. */
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

/**
 * Assert that known sensitive plaintext never appears in a serialized blob
 * under default policy (privacy regression helper).
 */
export function assertNoSensitivePlaintext(
	blob: string,
	forbidden: readonly string[] = [
		"hunter2",
		"user@example.com",
		"+15551212",
		"4111111111111111",
	],
): void {
	for (const secret of forbidden) {
		if (blob.includes(secret)) {
			throw Object.assign(
				new Error(
					`privacy regression: sensitive plaintext leaked into replay blob`,
				),
				{ code: "replay-privacy-leak", secretHint: `${secret.slice(0, 3)}…` },
			);
		}
	}
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: deepMask walks whatever rrweb event a recorder hands it, which nobody has parsed, and must look at each value's representation to mask it before it is sent. */
function deepMask(
	value: unknown,
	policy: PrivacyPolicy,
	path: string[] = [],
): Record<string, unknown> | unknown {
	if (Array.isArray(value)) {
		return value.map((v, i) => deepMask(v, policy, [...path, String(i)]));
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	// SAFETY: value is a non-null, non-array object here.
	const obj = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	const tag =
		typeof obj.tagName === "string" ? obj.tagName.toLowerCase() : undefined;
	let attrs: Record<string, string> | undefined;
	if (obj.attributes && typeof obj.attributes === "object") {
		// SAFETY: rrweb serializes a node's attributes as a string map.
		attrs = obj.attributes as Record<string, string>;
	}
	const type =
		typeof obj.type === "string"
			? obj.type
			: typeof attrs?.type === "string"
				? attrs.type
				: undefined;
	let context: MaskContext = {};
	if (tag !== undefined) context = { ...context, tag };
	if (type !== undefined) context = { ...context, type };
	if (attrs !== undefined) context = { ...context, attributes: attrs };
	const mask = shouldMaskNode(context, policy);

	for (const [k, v] of Object.entries(obj)) {
		if (policy.blockAttributes.includes(k) && mask) {
			out[k] = MASK_TOKEN;
			continue;
		}
		if (
			mask &&
			(k === "textContent" ||
				k === "value" ||
				k === "inputValue" ||
				k === "text")
		) {
			out[k] = MASK_TOKEN;
			continue;
		}
		// Network plugin redaction: strip Authorization and cookie headers.
		if (k === "headers" && v && typeof v === "object" && !Array.isArray(v)) {
			// SAFETY: v is a non-null, non-array object here.
			const headers = { ...(v as Record<string, unknown>) };
			for (const h of Object.keys(headers)) {
				if (/^(authorization|cookie|set-cookie|x-api-key)$/i.test(h)) {
					headers[h] = MASK_TOKEN;
				}
			}
			out[k] = headers;
			continue;
		}
		out[k] = deepMask(v, policy, [...path, k]);
	}
	return out;
}

/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */

export { defaultPrivacyPolicy, MASK_TOKEN };
