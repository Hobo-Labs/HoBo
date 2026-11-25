/**
 * The in-memory ephemeral-state engine.
 *
 * It is a `KvRedisExecutor` that answers exactly the commands the
 * ephemeral-state binding issues — `HMGET`, `DEL`, `PEXPIRE`, and `EVAL` /
 * `EVALSHA` of the five scripts in `ephemeral-scripts.ts` — with each script's
 * semantics written out in TypeScript, under an injectable clock. So the
 * in-memory port is the *same* `createRedisEphemeralState` the TCP and REST
 * bindings use, over a different executor, and the conformance suite compares
 * these TypeScript semantics with the Lua ones on a real server.
 *
 * It keeps a script cache the way a server does: `EVALSHA` of a script it has
 * not seen through `EVAL` answers `NOSCRIPT`, so the fallback path and its
 * command cost are exercised in-process. Anything else is an error reply.
 */
import type { EphemeralStatePort } from "@hobo/core";
import {
	EPHEMERAL_SCRIPTS,
	type EphemeralScriptName,
	scriptSha1,
} from "./ephemeral-scripts.js";
import { createRedisEphemeralState } from "./ephemeral-state.js";
import type {
	KvRedisExecutor,
	RedisCommand,
	RedisReply,
	RedisValue,
} from "./protocol.js";

export type ManualClock = {
	readonly now: () => number;
	advance(ms: number): void;
};

/** Deterministic time for tests: starts at `startMs` and moves only when told. */
export function createManualClock(startMs = 1_000_000): ManualClock {
	let nowMs = startMs;
	return {
		now: () => nowMs,
		advance(ms) {
			if (!Number.isFinite(ms) || ms < 0) {
				throw new RangeError("a manual clock only moves forward");
			}
			nowMs += ms;
		},
	};
}

export type MemoryRedisExecutorOptions = {
	/** Milliseconds since an arbitrary epoch. Defaults to wall time. */
	readonly now?: () => number;
};

export type MemoryRedisExecutor = KvRedisExecutor & {
	/** Forget every cached script handle, as `SCRIPT FLUSH` or a restart does. */
	flushScripts(): void;
};

type Hash = { v: string; i: string; r: number; expiresAtMs: number };

const val = (value: RedisValue): RedisReply => ({ kind: "value", value });
const err = (message: string): RedisReply => ({ kind: "error", message });

const SCRIPT_BY_BODY: ReadonlyMap<string, EphemeralScriptName> = new Map(
	Object.values(EPHEMERAL_SCRIPTS).map((script) => [script.body, script.name]),
);

const INTEGER = /^-?\d+$/u;

export function createMemoryRedisExecutor(
	options: MemoryRedisExecutorOptions = {},
): MemoryRedisExecutor {
	const now = options.now ?? Date.now;
	const store = new Map<string, Hash>();
	const loaded = new Map<string, EphemeralScriptName>();

	const live = (key: string): Hash | undefined => {
		const hash = store.get(key);
		if (hash === undefined) return undefined;
		if (hash.expiresAtMs <= now()) {
			store.delete(key);
			return undefined;
		}
		return hash;
	};

	const ttl = (raw: string | undefined): number | undefined =>
		raw !== undefined && /^\d+$/u.test(raw) && Number(raw) > 0
			? Number(raw)
			: undefined;

	function run(
		name: EphemeralScriptName,
		keys: readonly string[],
		argv: readonly string[],
	): RedisReply {
		const key = keys[0] ?? "";
		switch (name) {
			case "putIfAbsent": {
				const [stored, rawTtl, incarnation] = argv;
				const ms = ttl(rawTtl);
				if (stored === undefined || ms === undefined || !incarnation)
					return err("ERR invalid putIfAbsent arguments");
				if (live(key) !== undefined) return val(null);
				store.set(key, {
					v: stored,
					i: incarnation,
					r: 1,
					expiresAtMs: now() + ms,
				});
				return val(`${incarnation}:1`);
			}
			case "compareAndSet": {
				const [expected, stored, rawTtl] = argv;
				const ms = ttl(rawTtl);
				if (expected === undefined || stored === undefined || ms === undefined)
					return err("ERR invalid compareAndSet arguments");
				const hash = live(key);
				if (hash === undefined || `${hash.i}:${hash.r}` !== expected)
					return val(null);
				hash.r += 1;
				hash.v = stored;
				hash.expiresAtMs = now() + ms;
				return val(`${hash.i}:${hash.r}`);
			}
			case "deleteIfVersion": {
				const hash = live(key);
				if (hash === undefined || `${hash.i}:${hash.r}` !== argv[0])
					return val(0);
				store.delete(key);
				return val(1);
			}
			case "increment": {
				const [rawBy, rawTtl, incarnation, mode] = argv;
				const ms = ttl(rawTtl);
				if (
					rawBy === undefined ||
					!INTEGER.test(rawBy) ||
					ms === undefined ||
					!incarnation
				)
					return err("ERR invalid increment arguments");
				const hash = live(key);
				if (hash === undefined) {
					const next = Number(rawBy);
					store.set(key, {
						v: String(next),
						i: incarnation,
						r: 1,
						expiresAtMs: now() + ms,
					});
					return val(next);
				}
				if (!INTEGER.test(hash.v))
					return err("ERR hash value is not an integer");
				const next = Number(hash.v) + Number(rawBy);
				hash.v = String(next);
				hash.r += 1;
				if (mode === "refresh") hash.expiresAtMs = now() + ms;
				return val(next);
			}
			case "getMany":
				return val(
					keys.map((each) => {
						const hash = live(each);
						return hash === undefined ? null : [hash.v, `${hash.i}:${hash.r}`];
					}),
				);
		}
	}

	function script(
		name: EphemeralScriptName,
		rest: readonly string[],
	): RedisReply {
		const [rawCount, ...tail] = rest;
		if (rawCount === undefined || !/^\d+$/u.test(rawCount))
			return err("ERR numkeys is not an integer");
		const count = Number(rawCount);
		if (count > tail.length)
			return err("ERR numkeys is greater than the number of args");
		return run(name, tail.slice(0, count), tail.slice(count));
	}

	async function execute(command: RedisCommand): Promise<RedisReply> {
		const [rawVerb, ...args] = command;
		const verb = rawVerb.toUpperCase();
		switch (verb) {
			case "HMGET": {
				const [key, ...fields] = args;
				if (key === undefined || fields.length === 0)
					return err("ERR wrong number of arguments for 'hmget' command");
				const hash = live(key);
				return val(
					fields.map((field) => {
						if (hash === undefined) return null;
						if (field === "v") return hash.v;
						if (field === "i") return hash.i;
						if (field === "r") return String(hash.r);
						return null;
					}),
				);
			}
			case "DEL":
				return val(
					args.filter((key) => live(key) !== undefined && store.delete(key))
						.length,
				);
			case "PEXPIRE": {
				const [key, rawTtl] = args;
				const ms =
					rawTtl !== undefined && INTEGER.test(rawTtl)
						? Number(rawTtl)
						: undefined;
				if (key === undefined || ms === undefined)
					return err("ERR value is not an integer or out of range");
				const hash = live(key);
				if (hash === undefined) return val(0);
				hash.expiresAtMs = now() + ms;
				return val(1);
			}
			case "EVAL": {
				const [body, ...rest] = args;
				const name = body === undefined ? undefined : SCRIPT_BY_BODY.get(body);
				if (body === undefined || name === undefined)
					return err(
						"ERR the in-memory engine runs only the ephemeral-state scripts",
					);
				loaded.set(await scriptSha1(body), name);
				return script(name, rest);
			}
			case "EVALSHA": {
				const [sha, ...rest] = args;
				const name =
					sha === undefined ? undefined : loaded.get(sha.toLowerCase());
				if (name === undefined)
					return err("NOSCRIPT No matching script. Please use EVAL.");
				return script(name, rest);
			}
			default:
				return err(`ERR unknown command '${verb}'`);
		}
	}

	return {
		execute,
		flushScripts() {
			loaded.clear();
		},
	};
}

export type MemoryEphemeralStateOptions = MemoryRedisExecutorOptions & {
	readonly newIncarnation?: (() => string) | undefined;
};

/**
 * The in-memory `EphemeralStatePort`: the shared Redis-protocol binding over
 * the in-memory engine. Pair it with `createManualClock` for exact TTL tests.
 */
export function createMemoryEphemeralState(
	options: MemoryEphemeralStateOptions = {},
): EphemeralStatePort {
	return createRedisEphemeralState({
		executor: createMemoryRedisExecutor(options),
		newIncarnation: options.newIncarnation,
	});
}
