import { KvRedisCompatibleError } from "./errors.js";
import { isJsonNumber, isJsonString } from "./json.js";

export type RedisValue = string | number | null | readonly RedisValue[];

export type RedisReply =
	| { readonly kind: "value"; readonly value: RedisValue }
	| { readonly kind: "error"; readonly message: string };

export type RedisCommand = readonly [string, ...string[]];

export type FillKind = "max-value-bytes" | "over-max-value-bytes";

export type CommandArgTemplate = string | { readonly fill: FillKind };

export type CommandTemplate = readonly [string, ...CommandArgTemplate[]];

export type ReplyExpectation =
	| { readonly kind: "value"; readonly value: RedisValue }
	| { readonly kind: "one-of"; readonly values: readonly RedisValue[] }
	| {
			readonly kind: "integer-between";
			readonly min: number;
			readonly max: number;
	  }
	| { readonly kind: "error" }
	| { readonly kind: "byte-length"; readonly of: FillKind };

export const CONFORMANCE_KEY_NAMESPACE = "hobo:conf:";

export interface FillSizes {
	readonly "max-value-bytes": number | undefined;
	readonly "over-max-value-bytes": number | undefined;
}

function fillPayload(bytes: number): string {
	return "x".repeat(bytes);
}

export function resolveFillSizes(maxValueBytes: number | undefined): FillSizes {
	if (maxValueBytes === undefined) {
		return { "max-value-bytes": undefined, "over-max-value-bytes": undefined };
	}
	if (!Number.isInteger(maxValueBytes) || maxValueBytes <= 0) {
		throw new KvRedisCompatibleError(
			"INVALID_CONFORMANCE_CASE",
			"maxValueBytes must be a positive integer number of bytes",
		);
	}
	return {
		"max-value-bytes": maxValueBytes,
		"over-max-value-bytes": maxValueBytes + 1,
	};
}

export function requiredFills(template: CommandTemplate): readonly FillKind[] {
	const kinds = new Set<FillKind>();
	for (const arg of template.slice(1)) {
		if (!isJsonString(arg)) kinds.add(arg.fill);
	}
	return [...kinds].sort((a, b) => a.localeCompare(b));
}

export function resolveCommand(
	template: CommandTemplate,
	options: { readonly keyPrefix: string; readonly fills: FillSizes },
): RedisCommand {
	const [verb, ...args] = template;
	const resolved: string[] = [];
	for (const arg of args) {
		if (!isJsonString(arg)) {
			const bytes = options.fills[arg.fill];
			if (bytes === undefined) {
				throw new KvRedisCompatibleError(
					"INVALID_CONFORMANCE_CASE",
					`command needs a ${arg.fill} payload but no value-size limit was declared`,
				);
			}
			resolved.push(fillPayload(bytes));
			continue;
		}
		resolved.push(
			arg.startsWith(CONFORMANCE_KEY_NAMESPACE)
				? `${options.keyPrefix}${arg}`
				: arg,
		);
	}
	return [verb, ...resolved];
}

export function describeCommand(command: RedisCommand): string {
	const [verb, ...args] = command;
	const shown = args.map((arg) =>
		arg.length > 32 ? `${arg.slice(0, 29)}…(${arg.length}B)` : arg,
	);
	return [verb, ...shown].join(" ");
}

function sameValue(actual: RedisValue, expected: RedisValue): boolean {
	if (Array.isArray(actual) && Array.isArray(expected)) {
		const a = actual as readonly RedisValue[];
		const b = expected as readonly RedisValue[];
		return (
			a.length === b.length &&
			a.every((item, index) => sameValue(item, b[index] ?? null))
		);
	}
	if (Array.isArray(actual) || Array.isArray(expected)) return false;
	if (isJsonNumber(actual) || isJsonNumber(expected)) {
		if (actual === null || expected === null) return actual === expected;
		return String(actual) === String(expected);
	}
	return actual === expected;
}

export type ExpectationOutcome = {
	readonly ok: boolean;
	readonly detail: string;
};

function summarize(value: RedisValue): string {
	if (value === null) return "nil";
	if (Array.isArray(value))
		return `array(${(value as readonly RedisValue[]).length})`;
	if (isJsonNumber(value)) return `integer(${value})`;
	return value.length > 24
		? `string(${value.length}B)`
		: `string(${JSON.stringify(value)})`;
}

export function evaluateExpectation(
	expectation: ReplyExpectation,
	reply: RedisReply,
	fills: FillSizes,
): ExpectationOutcome {
	if (expectation.kind === "error") {
		return reply.kind === "error"
			? { ok: true, detail: "rejected as required" }
			: {
					ok: false,
					detail: `expected an error reply, got ${summarize(reply.value)}`,
				};
	}
	if (reply.kind === "error") {
		return { ok: false, detail: "implementation returned an error reply" };
	}

	switch (expectation.kind) {
		case "value":
			return sameValue(reply.value, expectation.value)
				? { ok: true, detail: "reply matched" }
				: {
						ok: false,
						detail: `expected ${summarize(expectation.value)}, got ${summarize(reply.value)}`,
					};
		case "one-of":
			return expectation.values.some((candidate) =>
				sameValue(reply.value, candidate),
			)
				? { ok: true, detail: "reply matched one of the accepted forms" }
				: {
						ok: false,
						detail: `got ${summarize(reply.value)}, which is not an accepted form`,
					};
		case "integer-between": {
			const numeric = isJsonNumber(reply.value)
				? reply.value
				: isJsonString(reply.value) && /^-?\d+$/u.test(reply.value)
					? Number(reply.value)
					: undefined;
			if (numeric === undefined) {
				return {
					ok: false,
					detail: `expected an integer, got ${summarize(reply.value)}`,
				};
			}
			return numeric >= expectation.min && numeric <= expectation.max
				? { ok: true, detail: `integer ${numeric} is within range` }
				: {
						ok: false,
						detail: `integer ${numeric} is outside [${expectation.min}, ${expectation.max}]`,
					};
		}
		case "byte-length": {
			const bytes = fills[expectation.of];
			if (bytes === undefined) {
				return { ok: false, detail: `no declared size for ${expectation.of}` };
			}
			if (!isJsonString(reply.value)) {
				return {
					ok: false,
					detail: `expected a string reply, got ${summarize(reply.value)}`,
				};
			}
			return Buffer.byteLength(reply.value, "utf8") === bytes
				? { ok: true, detail: `round-tripped ${bytes} bytes` }
				: {
						ok: false,
						detail: `expected ${bytes} bytes back, got ${Buffer.byteLength(reply.value, "utf8")}`,
					};
		}
	}
}

export interface KvRedisExecutor {
	execute(command: RedisCommand): Promise<RedisReply>;
	advanceTime?(ms: number): Promise<void>;
}
