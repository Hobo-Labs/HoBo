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
	readonly commandTimeoutMs?: number;
	readonly connectTimeoutMs?: number;
};

export type RespExecutor = KvRedisExecutor & {
	close(): Promise<void>;
};

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
	client.on("error", () => {});

	return {
		async execute(command: RedisCommand): Promise<RedisReply> {
			const [verb, ...args] = command;
			try {
				const raw = (await client.call(verb, args)) as RespWireValue;
				return { kind: "value", value: normalize(raw) };
			} catch (error) {
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

export const REDIS_PROTOCOL_URL_ENV_NAMES = [
	"VALKEY_URL",
	"REDIS_URL",
] as const;

export type RedisProtocolEnv = {
	readonly source: (typeof REDIS_PROTOCOL_URL_ENV_NAMES)[number];
	readonly url: string;
};

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
