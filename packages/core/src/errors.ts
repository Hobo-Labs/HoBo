import type { JsonValue } from "./json.js";

/**
 * Render an arbitrary value as the JSON view a parse error carries.
 *
 * `CoreParseError.received` is typed `JsonValue | undefined` because it is
 * *reported* — serialized into a message, logged, put on a wire — not inspected
 * as a domain object. The values that fail a parse are the opposite: whatever
 * the caller actually handed over, which is `unknown` at a parse boundary and a
 * domain type at an invariant check.
 *
 * Round-tripping through `JSON.stringify` is what makes those two ends meet,
 * and it is the honest conversion rather than a cast: the diagnostic is a
 * snapshot of the offending value at the moment it was refused, which is
 * exactly what serializing gives.
 *
 * Two shapes cannot survive the trip, and both answer with a description rather
 * than throwing. An error raised *while building an error* would replace a
 * precise "this field was wrong" with a stack trace pointing at the reporter,
 * which is the one failure mode a diagnostic must not have:
 *
 * - values `JSON.stringify` returns `undefined` for (a function, a bare
 *   `undefined`, a symbol),
 * - values it refuses outright (a circular object, a BigInt).
 */
export function diagnosticJson(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return `[unserializable ${typeof value}]`;
		// SAFETY: the output of JSON.stringify parses back to a JsonValue.
		return JSON.parse(text) as JsonValue;
	} catch {
		return `[unserializable ${typeof value}]`;
	}
}

export class CoreParseError extends Error {
	readonly path: string;
	readonly expected: string;
	readonly received: JsonValue | undefined;
	readonly code: string;

	constructor(
		code: string,
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super(message ?? `${path}: expected ${expected}`);
		this.name = "CoreParseError";
		this.code = code;
		this.path = path;
		this.expected = expected;
		this.received = received;
	}
}

export class EnvelopeParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_ENVELOPE_PARSE", path, expected, received, message);
		this.name = "EnvelopeParseError";
	}
}

export class ManifestParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_MANIFEST_PARSE", path, expected, received, message);
		this.name = "ManifestParseError";
	}
}

export class PortDescriptorParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_PORT_DESCRIPTOR_PARSE", path, expected, received, message);
		this.name = "PortDescriptorParseError";
	}
}
