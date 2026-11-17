import type { JsonValue } from "./json.js";

// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function diagnosticJson(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
		if (text === undefined) return `[unserializable ${typeof value}]`;
		return JSON.parse(text) as JsonValue;
	} catch {
		// oxlint-disable-next-line anti-slop/no-runtime-typeof
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
