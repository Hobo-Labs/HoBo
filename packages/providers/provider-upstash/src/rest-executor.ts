import type {
	KvRedisExecutor,
	RedisCommand,
	RedisReply,
	RedisValue,
} from "@hobo/kv-redis-compatible";

import { providerErrorForStatus, UpstashProviderError } from "./errors.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "./json.js";
import {
	createGuardedTransport,
	type TransportPolicy,
	UPSTASH_DATA_PLANE_POLICY,
	type UpstashTransport,
} from "./transport.js";

export type UpstashRestExecutorOptions = {
	readonly transport: UpstashTransport;
	readonly restEndpointUrl: string;
	readonly resolveToken: () => Promise<string>;
	readonly policy?: TransportPolicy;
	readonly userAgent?: string;
	readonly wait?: (ms: number) => Promise<void>;
};

function parseRedisValue(value: JsonValue, depth = 0): RedisValue {
	if (depth > 16) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"redis reply nested deeper than the 16 level cap",
		);
	}
	if (value === null) return null;
	if (isJsonString(value)) return value;
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value)) {
			throw new UpstashProviderError(
				"PROVIDER_CONTRACT_CHANGED",
				"redis reply contained a non-finite number",
			);
		}
		return value;
	}
	if (isJsonArray(value)) {
		return value.map((entry) => parseRedisValue(entry, depth + 1));
	}
	throw new UpstashProviderError(
		"PROVIDER_CONTRACT_CHANGED",
		"redis reply contained an unsupported JSON value",
	);
}

export function parseRestReply(body: string): RedisReply {
	let decoded: JsonValue;
	try {
		decoded = JSON.parse(body) as JsonValue;
	} catch (cause) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the REST endpoint returned a body that is not JSON",
			{
				cause: cause instanceof Error ? cause : new Error(String(cause)),
			},
		);
	}
	if (!isJsonObject(decoded)) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the REST endpoint returned something other than a result envelope",
		);
	}
	const envelope = decoded;
	if (isJsonString(envelope.error)) {
		return { kind: "error", message: envelope.error };
	}
	if (!("result" in envelope)) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the REST envelope carried neither a result nor an error",
		);
	}
	const result = envelope.result;
	if (result === undefined) {
		throw new UpstashProviderError(
			"PROVIDER_CONTRACT_CHANGED",
			"the REST envelope carried neither a result nor an error",
		);
	}
	return { kind: "value", value: parseRedisValue(result) };
}

function errorEnvelope(body: string): RedisReply | undefined {
	try {
		const reply = parseRestReply(body);
		return reply.kind === "error" ? reply : undefined;
	} catch {
		return undefined;
	}
}

const COMMAND_VERB = /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function createUpstashRestExecutor(
	options: UpstashRestExecutorOptions,
): KvRedisExecutor {
	const policy = options.policy ?? UPSTASH_DATA_PLANE_POLICY;
	const transport = createGuardedTransport(options.transport, policy);
	const userAgent = options.userAgent ?? "hobo-provider-upstash/0.0.1";
	const wait =
		options.wait ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	return {
		async execute(command: RedisCommand): Promise<RedisReply> {
			const [verb] = command;
			if (!COMMAND_VERB.test(verb)) {
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"redis command verb must be a plain identifier",
				);
			}

			const token = await options.resolveToken();
			const response = await transport.request({
				method: "POST",
				url: options.restEndpointUrl,
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json",
					"user-agent": userAgent,
				},
				body: JSON.stringify(command),
				timeoutMs: policy.timeoutMs,
				maxResponseBytes: policy.maxResponseBytes,
			});

			if (response.status === 200) return parseRestReply(response.body);
			if (response.status === 400) {
				const reply = errorEnvelope(response.body);
				if (reply !== undefined) return reply;
			}
			if (response.status === 401 || response.status === 403) {
				throw new UpstashProviderError(
					"PROVIDER_AUTH_FAILED",
					"the REST token was rejected; it may have been rotated after a claim, or the database may have been reaped",
					{ detail: { status: response.status, verb } },
				);
			}
			if (response.status === 404) {
				throw new UpstashProviderError(
					"LEASE_EXPIRED",
					"the REST endpoint no longer exists; an unclaimed temporary database is reaped at expiry",
					{ detail: { status: 404, verb } },
				);
			}
			throw providerErrorForStatus(response.status, {
				method: "POST",
				body: response.body,
			});
		},
		async advanceTime(ms: number): Promise<void> {
			if (!Number.isFinite(ms) || ms < 0 || ms > Number.MAX_SAFE_INTEGER) {
				throw new UpstashProviderError(
					"PROVIDER_CONTRACT_CHANGED",
					"time advancement must be a finite non-negative safe duration",
				);
			}
			let remaining = ms;
			do {
				const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
				await wait(delay);
				remaining -= delay;
			} while (remaining > 0);
		},
	};
}
