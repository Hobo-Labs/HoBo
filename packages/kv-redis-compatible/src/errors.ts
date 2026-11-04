import type { JsonValue } from "./json.js";

/**
 * Errors raised by the provider-neutral Redis-compatible layer.
 *
 * Nothing here interpolates a command argument: a conformance run writes real
 * application values, and an error message is the one string that reliably
 * reaches a log and a CI annotation.
 */

export const KV_REDIS_ERROR_CODES = [
	"INVALID_KV_REQUIREMENT",
	"INVALID_CONFORMANCE_CASE",
	"CONFORMANCE_EXECUTOR_FAILED",
	"QUEUE_TOPIC_IMPLICATION",
] as const;

export type KvRedisErrorCode = (typeof KV_REDIS_ERROR_CODES)[number];

export class KvRedisCompatibleError extends Error {
	readonly code: KvRedisErrorCode;

	constructor(
		code: KvRedisErrorCode,
		message: string,
		options: { cause?: unknown } = {},
	) {
		super(message, options.cause !== undefined ? { cause: options.cause } : {});
		this.name = "KvRedisCompatibleError";
		this.code = code;
	}
}

export function isKvRedisCompatibleError(
	value: JsonValue | KvRedisCompatibleError,
): value is KvRedisCompatibleError {
	return value instanceof KvRedisCompatibleError;
}
