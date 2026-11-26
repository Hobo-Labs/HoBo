/**
 * A captured secret value, once it has passed its spec's checks. It is the
 * only type that holds a value, and it redacts itself everywhere a value
 * could leak by accident: `String(x)`, template strings, `JSON.stringify`,
 * `util.inspect` and `console.log` all print `[redacted secret]`. The value
 * is read once, with `reveal()`, at the store boundary.
 */

import { SecretCaptureError } from "./errors.js";
import type { ParsedSecretCaptureSpec } from "./spec.js";

const REDACTED = "[redacted secret]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Printable ASCII, one line. */
const PRINTABLE_LINE = /^[\x20-\x7e]+$/u;
/** Printable ASCII plus CR and LF (a PEM key). */
const PRINTABLE_MULTILINE = /^[\x20-\x7e\r\n]+$/u;

/** Why a value was refused; the only detail a refusal carries about it. */
export type SecretValueRejection =
	| "empty"
	| "too-short"
	| "too-long"
	| "charset"
	| "surrounding-whitespace"
	| "format";

const REJECTION_TEXT = {
	empty: "it is empty",
	"too-short": "it is shorter than this secret can be",
	"too-long": "it is longer than this secret can be",
	charset: "it has characters this secret cannot contain",
	"surrounding-whitespace": "it starts or ends with a space",
	format: "it is not in this secret's format",
} satisfies Readonly<Record<SecretValueRejection, string>>;

export class CapturedSecret {
	readonly name: string;
	readonly byteLength: number;
	readonly #value: string;

	private constructor(name: string, value: string) {
		this.name = name;
		this.#value = value;
		this.byteLength = Buffer.byteLength(value, "utf8");
	}

	/**
	 * Check `raw` against the spec and hold it. A refusal names the reason
	 * (`SecretValueRejection`), never the value or any part of it.
	 */
	static parse(spec: ParsedSecretCaptureSpec, raw: string): CapturedSecret {
		const reason = rejection(spec, raw);
		if (reason !== undefined)
			throw new SecretCaptureError(
				"SECRET_CAPTURE_INVALID_VALUE",
				`${spec.name} was not stored: ${REJECTION_TEXT[reason]}.`,
				"Check the value and submit it again in the same form.",
			);
		return new CapturedSecret(spec.name, raw);
	}

	/** The value, for the store write only. */
	reveal(): string {
		return this.#value;
	}

	toString(): string {
		return REDACTED;
	}

	toJSON(): string {
		return REDACTED;
	}

	[INSPECT](): string {
		return REDACTED;
	}
}

export function rejection(
	spec: ParsedSecretCaptureSpec,
	raw: string,
): SecretValueRejection | undefined {
	if (raw.length === 0) return "empty";
	const bytes = Buffer.byteLength(raw, "utf8");
	if (bytes > spec.maxBytes) return "too-long";
	const charset =
		spec.charset === "printable-line" ? PRINTABLE_LINE : PRINTABLE_MULTILINE;
	if (!charset.test(raw)) return "charset";
	if (spec.charset === "printable-line" && raw.trim() !== raw)
		return "surrounding-whitespace";
	if (bytes < spec.minBytes) return "too-short";
	if (spec.pattern !== undefined && !spec.pattern.test(raw)) return "format";
	return undefined;
}
