/**
 * What a capture may hold. The composition declares one `SecretCaptureSpec`
 * per secret name (the hosted relay's live in `@hobo/hobo`); this module
 * parses them once, so the app only ever holds specs that meet
 * `#SecretCaptureSpec` in `data-models/secret_capture.cue`.
 */

import { create } from "@bufbuild/protobuf";
import {
	type SecretCaptureSpec,
	SecretCaptureSpecSchema,
} from "../_generated/secret_capture_pb.js";
import { SecretCaptureError } from "./errors.js";

export type SecretCaptureTarget = "runtime" | "deploy" | "writer";
export type SecretCaptureCharset = "printable-line" | "printable-multiline";

/** The largest value any capture accepts (a 4096-bit PEM key fits many times over). */
export const SECRET_CAPTURE_MAX_BYTES = 32_768;

const NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const LINE = /^[^\n]+$/u;

declare const parsedSpec: unique symbol;

export type ParsedSecretCaptureSpec = Readonly<{
	name: string;
	target: SecretCaptureTarget;
	label: string;
	purpose: string;
	minBytes: number;
	maxBytes: number;
	charset: SecretCaptureCharset;
	/** The extra shape check, compiled; absent when the spec names none. */
	pattern: RegExp | undefined;
	readonly [parsedSpec]: true;
}>;

/** A secret name the store accepts as an entry key. */
export function isSecretCaptureName(value: string): boolean {
	return NAME.test(value);
}

function invalid(): never {
	throw new SecretCaptureError(
		"SECRET_CAPTURE_INVALID_INPUT",
		"a secret capture spec does not meet its constraints",
	);
}

export function parseSecretCaptureSpec(
	record: SecretCaptureSpec,
): ParsedSecretCaptureSpec {
	const target = (["runtime", "deploy", "writer"] as const).find(
		(candidate) => candidate === record.target,
	);
	const charset = (["printable-line", "printable-multiline"] as const).find(
		(candidate) => candidate === record.charset,
	);
	if (
		target === undefined ||
		charset === undefined ||
		!NAME.test(record.name) ||
		!LINE.test(record.label) ||
		record.label.length > 80 ||
		!LINE.test(record.purpose) ||
		record.purpose.length > 240 ||
		record.minBytes < 1 ||
		record.maxBytes < record.minBytes ||
		record.maxBytes > SECRET_CAPTURE_MAX_BYTES
	)
		return invalid();
	let pattern: RegExp | undefined;
	if (record.pattern !== "") {
		if (!record.pattern.startsWith("^") || !record.pattern.endsWith("$"))
			return invalid();
		try {
			pattern = new RegExp(record.pattern, "u");
		} catch {
			return invalid();
		}
	}
	// SAFETY: every field above was checked; the brand records that.
	return Object.freeze({
		name: record.name,
		target,
		label: record.label,
		purpose: record.purpose,
		minBytes: record.minBytes,
		maxBytes: record.maxBytes,
		charset,
		pattern,
	}) as ParsedSecretCaptureSpec;
}

/** Build and parse a spec from its fields, for compositions and tests. */
export function secretCaptureSpec(
	init: Partial<Omit<SecretCaptureSpec, "$typeName" | "$unknown">>,
): ParsedSecretCaptureSpec {
	return parseSecretCaptureSpec(create(SecretCaptureSpecSchema, init));
}
