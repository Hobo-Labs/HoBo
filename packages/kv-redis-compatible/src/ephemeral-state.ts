/**
 * `EphemeralStatePort` over any Redis-protocol command executor.
 *
 * The executor is the same `KvRedisExecutor` the conformance suite drives, so
 * one implementation of the port serves every binding: a RESP socket to a
 * self-hosted Valkey or Redis (`./resp`), a REST-fronted store's executor
 * (supplied by its provider package), or the in-memory engine
 * (`./ephemeral-memory`).
 * Only the executor differs, which is what "no relay code change" means.
 *
 * Command cost, per call (see `EPHEMERAL_STATE_COMMAND_COST` in `@hobo/core`):
 *
 * | method | commands |
 * |---|---|
 * | `get` | 1 (`HMGET`) |
 * | `getMany` | 1 (`EVALSHA`), 0 for no keys |
 * | `putIfAbsent`, `compareAndSet`, `increment` | 1 (`EVALSHA`) |
 * | `delete` | 1 (`DEL`, or `EVALSHA` with an expected version) |
 * | `expire` | 1 (`PEXPIRE`) |
 *
 * Add one `EVAL` the first time each script meets a server whose script cache
 * lacks it (`NOSCRIPT`); the handle is then cached by the server.
 */
import {
	type EphemeralEntry,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	type EphemeralWrite,
	type IncrementTtlMode,
	parseEphemeralVersion,
	parseIncrementBy,
} from "@hobo/core";

import {
	EPHEMERAL_SCRIPTS,
	type EphemeralScriptName,
	scriptSha1,
} from "./ephemeral-scripts.js";
import { KvRedisCompatibleError } from "./errors.js";
import { isJsonNumber, isJsonString } from "./json.js";
import type { KvRedisExecutor, RedisReply, RedisValue } from "./protocol.js";

export type RedisEphemeralStateOptions = {
	readonly executor: KvRedisExecutor;
	/**
	 * Incarnation token for a key this call creates. Must not repeat for the
	 * same key; the default is a random UUID. Override only for determinism.
	 */
	readonly newIncarnation?: (() => string) | undefined;
};

function contract(message: string): KvRedisCompatibleError {
	return new KvRedisCompatibleError("EPHEMERAL_BACKEND_CONTRACT", message);
}

function value(reply: RedisReply, operation: string): RedisValue {
	if (reply.kind === "error") {
		throw new KvRedisCompatibleError(
			"EPHEMERAL_BACKEND_REJECTED",
			`ephemeral ${operation} was rejected by the store: ${reply.message}`,
		);
	}
	return reply.value;
}

function integer(raw: RedisValue, operation: string): number {
	const parsed = isJsonNumber(raw)
		? raw
		: isJsonString(raw) && /^-?\d+$/u.test(raw)
			? Number(raw)
			: Number.NaN;
	if (!Number.isSafeInteger(parsed)) {
		throw contract(`ephemeral ${operation} expected an integer reply`);
	}
	return parsed;
}

function version(raw: RedisValue, operation: string): EphemeralVersion {
	if (!isJsonString(raw)) {
		throw contract(`ephemeral ${operation} expected a version string reply`);
	}
	return parseEphemeralVersion(raw);
}

function write(raw: RedisValue, operation: string): EphemeralWrite {
	return raw === null
		? { applied: false }
		: { applied: true, version: version(raw, operation) };
}

/** `[value, "<i>:<r>"]` from GET_MANY, or `[v, i, r]` from HMGET. */
function entry(
	parts: readonly RedisValue[],
	operation: string,
): EphemeralEntry | undefined {
	if (parts.length === 2) {
		const [stored, token] = parts;
		if (stored === null || token === null) return undefined;
		if (!isJsonString(stored) && !isJsonNumber(stored)) {
			throw contract(`ephemeral ${operation} expected a string value`);
		}
		return {
			value: String(stored),
			version: version(token ?? null, operation),
		};
	}
	if (parts.length === 3) {
		const [stored, incarnation, revision] = parts;
		if (incarnation === null || incarnation === undefined) return undefined;
		if (
			(!isJsonString(stored) && !isJsonNumber(stored)) ||
			!isJsonString(incarnation) ||
			(!isJsonString(revision) && !isJsonNumber(revision))
		) {
			throw contract(`ephemeral ${operation} expected a stored entry`);
		}
		return {
			value: String(stored),
			version: parseEphemeralVersion(`${incarnation}:${revision}`),
		};
	}
	throw contract(`ephemeral ${operation} expected a stored entry`);
}

function asArray(raw: RedisValue, operation: string): readonly RedisValue[] {
	if (!Array.isArray(raw)) {
		throw contract(`ephemeral ${operation} expected an array reply`);
	}
	// SAFETY: Array.isArray narrowed a RedisValue, whose only array arm is RedisValue[].
	return raw as readonly RedisValue[];
}

export function createRedisEphemeralState(
	options: RedisEphemeralStateOptions,
): EphemeralStatePort {
	const { executor } = options;
	const newIncarnation =
		options.newIncarnation ?? (() => globalThis.crypto.randomUUID());
	const shas = new Map<EphemeralScriptName, Promise<string>>();

	const shaOf = (name: EphemeralScriptName): Promise<string> => {
		let sha = shas.get(name);
		if (sha === undefined) {
			sha = scriptSha1(EPHEMERAL_SCRIPTS[name].body);
			shas.set(name, sha);
		}
		return sha;
	};

	async function evalScript(
		name: EphemeralScriptName,
		keys: readonly string[],
		args: readonly string[],
	): Promise<RedisValue> {
		const tail = [String(keys.length), ...keys, ...args];
		const cached = await executor.execute([
			"EVALSHA",
			await shaOf(name),
			...tail,
		]);
		if (cached.kind === "error" && cached.message.startsWith("NOSCRIPT")) {
			return value(
				await executor.execute(["EVAL", EPHEMERAL_SCRIPTS[name].body, ...tail]),
				name,
			);
		}
		return value(cached, name);
	}

	return {
		async get(key: EphemeralKey) {
			const raw = value(
				await executor.execute(["HMGET", key, "v", "i", "r"]),
				"get",
			);
			return entry(asArray(raw, "get"), "get");
		},

		async getMany(keys: readonly EphemeralKey[]) {
			if (keys.length === 0) return [];
			const raw = asArray(await evalScript("getMany", keys, []), "getMany");
			if (raw.length !== keys.length) {
				throw contract("ephemeral getMany returned a misaligned array");
			}
			return raw.map((item) =>
				item === null ? undefined : entry(asArray(item, "getMany"), "getMany"),
			);
		},

		async putIfAbsent(
			key: EphemeralKey,
			stored: string,
			ttlMs: EphemeralTtlMs,
		) {
			return write(
				await evalScript(
					"putIfAbsent",
					[key],
					[stored, String(ttlMs), newIncarnation()],
				),
				"putIfAbsent",
			);
		},

		async compareAndSet(
			key: EphemeralKey,
			expected: EphemeralVersion,
			stored: string,
			ttlMs: EphemeralTtlMs,
		) {
			return write(
				await evalScript(
					"compareAndSet",
					[key],
					[expected, stored, String(ttlMs)],
				),
				"compareAndSet",
			);
		},

		async delete(key: EphemeralKey, expected?: EphemeralVersion) {
			const raw =
				expected === undefined
					? value(await executor.execute(["DEL", key]), "delete")
					: await evalScript("deleteIfVersion", [key], [expected]);
			return integer(raw, "delete") > 0;
		},

		async increment(
			key: EphemeralKey,
			by: number,
			ttlMs: EphemeralTtlMs,
			mode: IncrementTtlMode = "on-create",
		) {
			return integer(
				await evalScript(
					"increment",
					[key],
					[String(parseIncrementBy(by)), String(ttlMs), newIncarnation(), mode],
				),
				"increment",
			);
		},

		async expire(key: EphemeralKey, ttlMs: EphemeralTtlMs) {
			const raw = value(
				await executor.execute(["PEXPIRE", key, String(ttlMs)]),
				"expire",
			);
			return integer(raw, "expire") === 1;
		},
	};
}
