/**
 * A `KvRedisExecutor` over the Redis serialization protocol (RESP) on TCP —
 * the binding for a self-hosted Valkey or Redis.
 *
 * Exported from `@hobo/kv-redis-compatible/resp` only, so a runtime that
 * binds the REST transport (the relay on Vercel) never loads a socket client.
 * The client is `ioredis`: pure JavaScript, no native addon, and it speaks to
 * Valkey unchanged because Valkey keeps the Redis protocol.
 *
 * A command-level error (`WRONGTYPE`, `NOSCRIPT`) is a returned error reply,
 * as the executor contract requires; a connection failure is thrown.
 */
import type { EphemeralStatePort } from "@hobo/core";
import { Redis } from "ioredis";

import { createRedisEphemeralState } from "./ephemeral-state.js";
import { KvRedisCompatibleError } from "./errors.js";
import { isJsonNumber, isJsonString } from "./json.js";
import type {
	KvRedisExecutor,
	RedisCommand,
	RedisReply,
	RedisValue,
} from "./protocol.js";

export type RespExecutorOptions = {
	/**
	 * `redis://[user:password@]host:port[/db]` or `rediss://…` for TLS. It
	 * usually carries a credential: it is handed to the client and never
	 * logged, echoed in an error, or stored on the executor.
	 */
	readonly url: string;
	/** Fail a command after this long without a reply. Default 5 s. */
	readonly commandTimeoutMs?: number;
	/** Give up connecting after this long. Default 5 s. */
	readonly connectTimeoutMs?: number;
};

export type RespExecutor = KvRedisExecutor & {
	close(): Promise<void>;
};

/** What `ioredis` hands back for a reply in its default (string) mode. */
type RespWireValue =
	| string
	| number
	| null
	| undefined
	| Uint8Array
	| readonly RespWireValue[];

function normalize(raw: RespWireValue, depth = 0): RedisValue {
	if (raw === null || raw === undefined) return null;
	if (isJsonString(raw) || isJsonNumber(raw)) return raw;
	if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
	if (Array.isArray(raw) && depth < 16) {
		// SAFETY: Array.isArray narrowed a RespWireValue, whose only array arm is RespWireValue[].
		const items = raw as readonly RespWireValue[];
		return items.map((item) => normalize(item, depth + 1));
	}
	throw new KvRedisCompatibleError(
		"EPHEMERAL_BACKEND_CONTRACT",
		"the RESP client returned a value outside the Redis reply space",
	);
}

export function createRespExecutor(options: RespExecutorOptions): RespExecutor {
	const client = new Redis(options.url, {
		maxRetriesPerRequest: 1,
		commandTimeout: options.commandTimeoutMs ?? 5_000,
		connectTimeout: options.connectTimeoutMs ?? 5_000,
	});
	// An unhandled 'error' event would crash the process; a failed command
	// still rejects its own promise, which is where the caller learns of it.
	client.on("error", () => {});

	return {
		async execute(command: RedisCommand): Promise<RedisReply> {
			const [verb, ...args] = command;
			try {
				// SAFETY: ioredis decodes every RESP reply into strings, integers, nulls, buffers, or arrays of them; normalize re-checks and throws on anything else.
				const raw = (await client.call(verb, args)) as RespWireValue;
				return { kind: "value", value: normalize(raw) };
			} catch (error) {
				// ioredis raises a server error reply as a `ReplyError`; anything
				// else (a closed socket, a timeout) is a transport failure.
				if (error instanceof Error && error.name === "ReplyError") {
					return { kind: "error", message: error.message };
				}
				throw error;
			}
		},
		async close() {
			await client.quit().catch(() => client.disconnect());
		},
	};
}

/**
 * Environment names a self-hosted binding is read from, in precedence order.
 * Only the names are part of the contract; values are passed to the client.
 */
// public-contract: env names an operator sets to bind a self-hosted Valkey/Redis.
export const REDIS_PROTOCOL_URL_ENV_NAMES = [
	"VALKEY_URL",
	"REDIS_URL",
] as const;

export type RedisProtocolEnv = {
	/** Which variable supplied the URL — safe to log. */
	readonly source: (typeof REDIS_PROTOCOL_URL_ENV_NAMES)[number];
	readonly url: string;
};

/** The first configured Redis-protocol URL, or `undefined` when none is set. */
export function resolveRedisProtocolEnv(
	env: Readonly<Record<string, string | undefined>>,
): RedisProtocolEnv | undefined {
	for (const name of REDIS_PROTOCOL_URL_ENV_NAMES) {
		const url = env[name];
		if (url === undefined || url === "") continue;
		if (!/^rediss?:\/\//u.test(url)) {
			throw new KvRedisCompatibleError(
				"EPHEMERAL_BINDING_UNAVAILABLE",
				`${name} must be a redis:// or rediss:// URL`,
			);
		}
		return { source: name, url };
	}
	return undefined;
}

export type RespEphemeralState = {
	readonly state: EphemeralStatePort;
	close(): Promise<void>;
};

export type RespEphemeralStateOptions = RespExecutorOptions & {
	readonly wrap?: (executor: KvRedisExecutor) => KvRedisExecutor;
};

/** `EphemeralStatePort` on a self-hosted Valkey or Redis over TCP. */
export function createRespEphemeralState(
	options: RespEphemeralStateOptions,
): RespEphemeralState {
	const executor = createRespExecutor(options);
	return {
		state: createRedisEphemeralState({
			executor: options.wrap ? options.wrap(executor) : executor,
		}),
		close: () => executor.close(),
	};
}
