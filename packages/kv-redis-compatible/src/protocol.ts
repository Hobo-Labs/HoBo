/**
 * The command/reply model the conformance suite is written against.
 *
 * This is deliberately *not* a Redis client. A conformance case is pure data —
 * a command template and an expectation — and the thing that actually talks to
 * a store is injected. That is what lets the same suite run against a REST
 * transport, a RESP socket, and an in-memory fake without the cases changing.
 */
import { KvRedisCompatibleError } from "./errors.js";
import { isJsonNumber, isJsonString } from "./json.js";

/** A Redis reply value, in the shape a client surfaces it. */
export type RedisValue = string | number | null | readonly RedisValue[];

/**
 * A reply is either a value or an error. Modelling the error arm explicitly
 * is what makes "this command must be rejected" a passing expectation rather
 * than a thrown exception the runner has to guess the meaning of.
 */
export type RedisReply =
	| { readonly kind: "value"; readonly value: RedisValue }
	| { readonly kind: "error"; readonly message: string };

/** A fully resolved command: the verb followed by its arguments. */
export type RedisCommand = readonly [string, ...string[]];

/**
 * Payloads whose size depends on the implementation's declared limit. The
 * case cannot hardcode them, and the runner refuses to invent a limit.
 */
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
	/** The reply must be an error. Which error is implementation detail. */
	| { readonly kind: "error" }
	/** A string reply of exactly the filled byte length. Proves a round-trip. */
	| { readonly kind: "byte-length"; readonly of: FillKind };

/**
 * Keys used by conformance cases. The runner may prefix anything starting
 * with this so a suite can run against a live store without colliding with
 * application data.
 */
// public-contract: key marker an executor must not rewrite further.
export const CONFORMANCE_KEY_NAMESPACE = "hobo:conf:";

export interface FillSizes {
	readonly "max-value-bytes": number | undefined;
	readonly "over-max-value-bytes": number | undefined;
}

function fillPayload(bytes: number): string {
	// ASCII so byte length and code-unit length agree, which keeps the
	// expectation checkable without re-encoding on the assertion side.
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

/** Fill kinds a template needs. Used to decide whether a case can run at all. */
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

/** Human-readable command form for a report. Arguments are length-capped. */
export function describeCommand(command: RedisCommand): string {
	const [verb, ...args] = command;
	const shown = args.map((arg) =>
		arg.length > 32 ? `${arg.slice(0, 29)}…(${arg.length}B)` : arg,
	);
	return [verb, ...shown].join(" ");
}

function sameValue(actual: RedisValue, expected: RedisValue): boolean {
	if (Array.isArray(actual) && Array.isArray(expected)) {
		// SAFETY: `const a = actual as readonly RedisValue[];` is required at this I/O or test boundary.
		const a = actual as readonly RedisValue[];
		// SAFETY: `const b = expected as readonly RedisValue[];` is required at this I/O or test boundary.
		const b = expected as readonly RedisValue[];
		return (
			a.length === b.length &&
			a.every((item, index) => sameValue(item, b[index] ?? null))
		);
	}
	if (Array.isArray(actual) || Array.isArray(expected)) return false;
	// Redis replies cross the string/integer line freely across transports:
	// `TTL` is an integer over RESP and can arrive as a JSON number or a
	// numeric string over REST. Comparing the canonical text of both is the
	// honest reading of "the same reply".
	if (isJsonNumber(actual) || isJsonNumber(expected)) {
		if (actual === null || expected === null) return actual === expected;
		return String(actual) === String(expected);
	}
	return actual === expected;
}

export type ExpectationOutcome = {
	readonly ok: boolean;
	/** Why it failed. Never contains a filled payload or a stored value. */
	readonly detail: string;
};

function summarize(value: RedisValue): string {
	if (value === null) return "nil";
	if (Array.isArray(value))
		// SAFETY: `return `array(${(value as readonly RedisValue[]).length})`;` is required at this I/O or test boundary.
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

/**
 * The port a conformance run drives. One method is required; time control is
 * optional, and its absence downgrades TTL-expiry cases to `skipped` rather
 * than letting them pass by assumption.
 */
export interface KvRedisExecutor {
	execute(command: RedisCommand): Promise<RedisReply>;
	/**
	 * Move the implementation's notion of time forward. A real store satisfies
	 * this by sleeping; a deterministic fake satisfies it by arithmetic.
	 */
	advanceTime?(ms: number): Promise<void>;
}
