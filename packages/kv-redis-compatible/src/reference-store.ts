/**
 * A deterministic reference store.
 *
 * Two jobs. First, the suite itself needs testing: a conformance suite nobody
 * has run against a known-good implementation is a suite whose passing result
 * means nothing. Second, an adapter author needs something to point their
 * transport at — running the suite through a REST or RESP adapter backed by
 * this store proves the *adapter*, offline and deterministically, without
 * anyone's staging cluster.
 *
 * It is not a Redis. It implements exactly the commands the cases use, in
 * memory, and time is arithmetic rather than sleep so the expiry case is exact
 * rather than flaky. Anything unimplemented is an error reply, which is also
 * what `transport.unknown-command-is-an-error` requires.
 */
import type { KvRedisExecutor, RedisCommand, RedisReply } from "./protocol.js";

type Entry = {
	kind: "string" | "list" | "hash" | "zset";
	string?: string;
	list?: string[];
	hash?: Map<string, string>;
	zset?: Map<string, number>;
	expiresAtMs?: number;
};

export type ReferenceStoreOptions = {
	/** Values strictly larger than this are rejected, as a real store would. */
	readonly maxValueBytes?: number;
	/** Break a specific command verb, to prove a failing run reports `fail`. */
	readonly breakVerb?: string;
};

export type ReferenceStore = KvRedisExecutor & {
	/** Commands seen, for assertions about what the suite actually exercised. */
	readonly commands: readonly RedisCommand[];
	/**
	 * Required here, unlike on the executor port.
	 *
	 * Time control is optional for a real adapter — a live endpoint has a
	 * clock nobody can wind. The reference store always has one, and saying so
	 * in the type is what lets an adapter harness borrow the *server's* clock
	 * without a cast.
	 */
	advanceTime(ms: number): Promise<void>;
};

const ok: RedisReply = { kind: "value", value: "OK" };
const nil: RedisReply = { kind: "value", value: null };
const int = (value: number): RedisReply => ({ kind: "value", value });
const str = (value: string): RedisReply => ({ kind: "value", value });
const err = (message: string): RedisReply => ({ kind: "error", message });

export function createReferenceRedisStore(
	options: ReferenceStoreOptions = {},
): ReferenceStore {
	const store = new Map<string, Entry>();
	const commands: RedisCommand[] = [];
	let nowMs = 1_000_000;

	const live = (key: string): Entry | undefined => {
		const entry = store.get(key);
		if (entry === undefined) return undefined;
		if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs) {
			store.delete(key);
			return undefined;
		}
		return entry;
	};

	const setString = (
		key: string,
		value: string,
		expiresAtMs?: number,
	): void => {
		store.set(key, {
			kind: "string",
			string: value,
			...(expiresAtMs !== undefined ? { expiresAtMs } : undefined),
		});
	};

	function handleSet(args: readonly string[]): RedisReply {
		const [key, value, ...rest] = args;
		if (key === undefined || value === undefined)
			return err("ERR wrong number of arguments");
		if (
			options.maxValueBytes !== undefined &&
			Buffer.byteLength(value, "utf8") > options.maxValueBytes
		) {
			return err("ERR value is larger than the maximum allowed size");
		}
		let expiresAtMs: number | undefined;
		let nx = false;
		for (let index = 0; index < rest.length; index += 1) {
			// SAFETY: `const flag = (rest[index] as string).toUpperCase();` is required at this I/O or test boundary.
			const flag = (rest[index] as string).toUpperCase();
			if (flag === "NX") {
				nx = true;
				continue;
			}
			if (flag === "EX" || flag === "PX") {
				const raw = rest[index + 1];
				if (raw === undefined || !/^\d+$/u.test(raw))
					return err("ERR invalid expire time");
				index += 1;
				expiresAtMs = nowMs + Number(raw) * (flag === "EX" ? 1000 : 1);
				continue;
			}
			return err(`ERR syntax error near ${flag}`);
		}
		if (nx && live(key) !== undefined) return nil;
		setString(key, value, expiresAtMs);
		return ok;
	}

	function handleIncrBy(key: string | undefined, by: number): RedisReply {
		if (key === undefined) return err("ERR wrong number of arguments");
		const entry = live(key);
		if (entry === undefined) {
			setString(key, String(by));
			return int(by);
		}
		if (entry.kind !== "string" || !/^-?\d+$/u.test(entry.string ?? "")) {
			return err("ERR value is not an integer or out of range");
		}
		const next = Number(entry.string) + by;
		entry.string = String(next);
		return int(next);
	}

	async function execute(command: RedisCommand): Promise<RedisReply> {
		commands.push(command);
		const [rawVerb, ...args] = command;
		const verb = rawVerb.toUpperCase();
		if (
			options.breakVerb !== undefined &&
			verb === options.breakVerb.toUpperCase()
		) {
			return err("ERR deliberately broken for the failing-run test");
		}
		const key = args[0];

		switch (verb) {
			case "PING":
				return str("PONG");
			case "ECHO":
				return args[0] === undefined
					? err("ERR wrong number of arguments")
					: str(args[0]);
			case "SET":
				return handleSet(args);
			case "GET": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return nil;
				return entry.kind === "string"
					? str(entry.string ?? "")
					: err("WRONGTYPE");
			}
			case "DEL": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const present = live(key) !== undefined;
				store.delete(key);
				return int(present ? 1 : 0);
			}
			case "EXISTS":
				return int(key !== undefined && live(key) !== undefined ? 1 : 0);
			case "TYPE": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				return str(entry === undefined ? "none" : entry.kind);
			}
			case "TTL": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return int(-2);
				if (entry.expiresAtMs === undefined) return int(-1);
				return int(Math.ceil((entry.expiresAtMs - nowMs) / 1000));
			}
			case "PERSIST": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined || entry.expiresAtMs === undefined)
					return int(0);
				delete entry.expiresAtMs;
				return int(1);
			}
			case "INCR":
				return handleIncrBy(key, 1);
			case "INCRBY": {
				const by = args[1];
				if (by === undefined || !/^-?\d+$/u.test(by))
					return err("ERR not an integer");
				return handleIncrBy(key, Number(by));
			}
			case "RPUSH": {
				if (key === undefined || args[1] === undefined)
					return err("ERR wrong number of arguments");
				const entry = live(key) ?? { kind: "list" as const, list: [] };
				if (entry.kind !== "list") return err("WRONGTYPE");
				entry.list = [...(entry.list ?? []), ...args.slice(1)];
				store.set(key, entry);
				return int(entry.list.length);
			}
			case "LPOP": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return nil;
				if (entry.kind !== "list") return err("WRONGTYPE");
				const head = (entry.list ?? []).shift();
				return head === undefined ? nil : str(head);
			}
			case "LLEN": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return int(0);
				if (entry.kind !== "list") return err("WRONGTYPE");
				return int((entry.list ?? []).length);
			}
			case "LRANGE": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return { kind: "value", value: [] };
				if (entry.kind !== "list") return err("WRONGTYPE");
				const list = entry.list ?? [];
				const start = Number(args[1] ?? "0");
				const rawStop = Number(args[2] ?? "-1");
				const stop = rawStop < 0 ? list.length + rawStop : rawStop;
				return { kind: "value", value: list.slice(start, stop + 1) };
			}
			case "HSET": {
				if (
					key === undefined ||
					args[1] === undefined ||
					args[2] === undefined
				) {
					return err("ERR wrong number of arguments");
				}
				const entry = live(key) ?? {
					kind: "hash" as const,
					hash: new Map<string, string>(),
				};
				if (entry.kind !== "hash") return err("WRONGTYPE");
				const hash = entry.hash ?? new Map<string, string>();
				const added = hash.has(args[1]) ? 0 : 1;
				hash.set(args[1], args[2]);
				entry.hash = hash;
				store.set(key, entry);
				return int(added);
			}
			case "HGET": {
				if (key === undefined || args[1] === undefined)
					return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return nil;
				if (entry.kind !== "hash") return err("WRONGTYPE");
				const field = (entry.hash ?? new Map<string, string>()).get(args[1]);
				return field === undefined ? nil : str(field);
			}
			case "ZADD": {
				if (
					key === undefined ||
					args[1] === undefined ||
					args[2] === undefined
				) {
					return err("ERR wrong number of arguments");
				}
				const entry = live(key) ?? {
					kind: "zset" as const,
					zset: new Map<string, number>(),
				};
				if (entry.kind !== "zset") return err("WRONGTYPE");
				const zset = entry.zset ?? new Map<string, number>();
				const added = zset.has(args[2]) ? 0 : 1;
				zset.set(args[2], Number(args[1]));
				entry.zset = zset;
				store.set(key, entry);
				return int(added);
			}
			case "ZRANGE": {
				if (key === undefined) return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return { kind: "value", value: [] };
				if (entry.kind !== "zset") return err("WRONGTYPE");
				const ordered = [...(entry.zset ?? new Map<string, number>()).entries()]
					.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
					.map(([member]) => member);
				const start = Number(args[1] ?? "0");
				const rawStop = Number(args[2] ?? "-1");
				const stop = rawStop < 0 ? ordered.length + rawStop : rawStop;
				return { kind: "value", value: ordered.slice(start, stop + 1) };
			}
			case "ZSCORE": {
				if (key === undefined || args[1] === undefined)
					return err("ERR wrong number of arguments");
				const entry = live(key);
				if (entry === undefined) return nil;
				if (entry.kind !== "zset") return err("WRONGTYPE");
				const score = (entry.zset ?? new Map<string, number>()).get(args[1]);
				return score === undefined ? nil : str(String(score));
			}
			default:
				return err(`ERR unknown command '${verb}'`);
		}
	}

	return {
		get commands() {
			return commands;
		},
		execute,
		async advanceTime(ms: number) {
			nowMs += ms;
		},
	};
}

/** The same store with no time control, to exercise the skip path. */
export function createTimelessReferenceStore(
	options: ReferenceStoreOptions = {},
): KvRedisExecutor {
	const inner = createReferenceRedisStore(options);
	return { execute: (command) => inner.execute(command) };
}
