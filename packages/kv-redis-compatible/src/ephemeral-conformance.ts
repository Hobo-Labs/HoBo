/**
 * Conformance for `EphemeralStatePort` bindings.
 *
 * Same idea as the command-level suite in `cases.ts`, one level up: the cases
 * are data plus a `run` over an injected context, so a binding author runs the
 * identical suite against the in-memory engine, a RESP socket, or a REST
 * endpoint, and a vitest file is a loop over `EPHEMERAL_STATE_CONFORMANCE_CASES`.
 *
 * Every case needs the whole context — several clients, time control, and a
 * command meter — so there is nothing to skip: a lane that cannot supply the
 * context does not run the suite at all. Time control on a real server is a
 * sleep; pick `ttlMs` so that sleeping a few multiples of it is affordable.
 */
import {
	acquireEphemeralLock,
	createEphemeralRing,
	EPHEMERAL_STATE_COMMAND_COST,
	type EphemeralKey,
	type EphemeralStateOperation,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	parseEphemeralKey,
	parseEphemeralTtlMs,
	releaseEphemeralLock,
	renewEphemeralLock,
} from "@hobo/core";

import type { CommandUsage } from "./ephemeral-meter.js";
import { KvRedisCompatibleError } from "./errors.js";

export type EphemeralConformanceContext = {
	/**
	 * Independent clients of one backend (separate connections where the
	 * binding has them). Concurrency cases spread writers across all of them.
	 */
	readonly clients: readonly [EphemeralStatePort, ...EphemeralStatePort[]];
	/** Move the backend's clock forward: arithmetic in memory, a sleep on a server. */
	readonly advanceTime: (ms: number) => Promise<void>;
	/** Commands `clients[0]` has sent so far. */
	readonly usage: () => CommandUsage;
	/** Prefix for every key and ring a case writes, so runs do not collide. */
	readonly keyPrefix: string;
	/** The unit TTL cases scale their waits from. */
	readonly ttlMs: number;
};

export type EphemeralConformanceArea =
	| "key-value"
	| "versioning"
	| "concurrency"
	| "ttl"
	| "counter"
	| "lock"
	| "ring"
	| "cost";

export type EphemeralConformanceCase = {
	readonly id: string;
	readonly area: EphemeralConformanceArea;
	readonly rationale: string;
	run(context: EphemeralConformanceContext): Promise<void>;
};

export class EphemeralConformanceFailure extends Error {
	constructor(caseId: string, message: string) {
		super(`${caseId}: ${message}`);
		this.name = "EphemeralConformanceFailure";
	}
}

type Scope = {
	readonly state: EphemeralStatePort;
	readonly key: (suffix: string) => EphemeralKey;
	readonly ttl: EphemeralTtlMs;
	readonly scaled: (factor: number) => EphemeralTtlMs;
	readonly check: (condition: boolean, message: string) => void;
	readonly client: (index: number) => EphemeralStatePort;
};

function scope(id: string, context: EphemeralConformanceContext): Scope {
	return {
		state: context.clients[0],
		key: (suffix) => parseEphemeralKey(`${context.keyPrefix}${id}:${suffix}`),
		ttl: parseEphemeralTtlMs(context.ttlMs),
		scaled: (factor) => parseEphemeralTtlMs(Math.round(context.ttlMs * factor)),
		check(condition, message) {
			if (!condition) throw new EphemeralConformanceFailure(id, message);
		},
		client: (index) =>
			context.clients[index % context.clients.length] ?? context.clients[0],
	};
}

function define(
	id: string,
	area: EphemeralConformanceArea,
	rationale: string,
	body: (s: Scope, context: EphemeralConformanceContext) => Promise<void>,
): EphemeralConformanceCase {
	return {
		id,
		area,
		rationale,
		run: (context) => body(scope(id, context), context),
	};
}

async function rejects<T>(operation: () => Promise<T>): Promise<boolean> {
	try {
		await operation();
		return false;
	} catch (error) {
		return error instanceof KvRedisCompatibleError;
	}
}

const ROUND_TRIP_VALUES = [
	"",
	"plain",
	'café — 🚀 \u0000 nul and "quotes"',
	JSON.stringify({ lease: { jobId: 42, runner: "r-1" } }),
	"x".repeat(64 * 1024),
];

export const EPHEMERAL_STATE_CONFORMANCE_CASES: readonly EphemeralConformanceCase[] =
	[
		define(
			"key-value.absent-is-undefined",
			"key-value",
			"A missing key reads as undefined, never as an empty string or a zero; callers rebuild on undefined.",
			async ({ state, key, check }) => {
				check(
					(await state.get(key("nothing"))) === undefined,
					"absent key returned an entry",
				);
			},
		),
		define(
			"key-value.round-trip",
			"key-value",
			"Values reach the store byte-for-byte: empty, UTF-8 beyond the BMP, a NUL, JSON, and a 64 KiB payload.",
			async ({ state, key, ttl, check }) => {
				for (const [index, stored] of ROUND_TRIP_VALUES.entries()) {
					const write = await state.putIfAbsent(key(`v${index}`), stored, ttl);
					check(write.applied, `value ${index} was not written`);
					const read = await state.get(key(`v${index}`));
					check(read?.value === stored, `value ${index} did not round-trip`);
					check(
						write.applied && read?.version === write.version,
						`value ${index} read a different version`,
					);
				}
			},
		),
		define(
			"key-value.get-many-is-index-aligned",
			"key-value",
			"getMany answers in the order asked, with undefined holes for absent keys, in one round trip.",
			async ({ state, key, ttl, check }) => {
				await state.putIfAbsent(key("a"), "A", ttl);
				await state.putIfAbsent(key("c"), "C", ttl);
				const found = await state.getMany([key("c"), key("b"), key("a")]);
				check(found.length === 3, "getMany changed the number of results");
				check(
					found[0]?.value === "C" &&
						found[1] === undefined &&
						found[2]?.value === "A",
					"getMany misaligned its results",
				);
				check(
					(await state.getMany([])).length === 0,
					"getMany of no keys returned entries",
				);
			},
		),
		define(
			"key-value.put-if-absent-keeps-existing",
			"key-value",
			"putIfAbsent on a live key is a lost race: not applied, and the stored value and version are untouched.",
			async ({ state, key, ttl, check }) => {
				const first = await state.putIfAbsent(key("k"), "first", ttl);
				const second = await state.putIfAbsent(key("k"), "second", ttl);
				check(first.applied && !second.applied, "second putIfAbsent applied");
				const read = await state.get(key("k"));
				check(
					read?.value === "first" &&
						first.applied &&
						read.version === first.version,
					"existing entry changed",
				);
			},
		),
		define(
			"key-value.delete",
			"key-value",
			"Unconditional delete reports whether a key was removed; a versioned delete removes only the version it names.",
			async ({ state, key, ttl, check }) => {
				await state.putIfAbsent(key("plain"), "x", ttl);
				check(
					await state.delete(key("plain")),
					"delete of a live key reported nothing removed",
				);
				check(
					!(await state.delete(key("plain"))),
					"delete of an absent key reported a removal",
				);
				const write = await state.putIfAbsent(key("versioned"), "x", ttl);
				check(write.applied, "setup write failed");
				if (!write.applied) return;
				const moved = await state.compareAndSet(
					key("versioned"),
					write.version,
					"y",
					ttl,
				);
				check(
					!(await state.delete(key("versioned"), write.version)),
					"stale versioned delete removed the key",
				);
				check(
					moved.applied &&
						(await state.delete(key("versioned"), moved.version)),
					"current versioned delete failed",
				);
				check(
					(await state.get(key("versioned"))) === undefined,
					"versioned delete left the key",
				);
			},
		),
		define(
			"versioning.cas-advances-and-rejects-stale",
			"versioning",
			"Every successful compareAndSet yields a version never seen before for that key, and any earlier version is rejected.",
			async ({ state, key, ttl, check }) => {
				const seen: EphemeralVersion[] = [];
				const first = await state.putIfAbsent(key("k"), "0", ttl);
				check(first.applied, "setup write failed");
				if (!first.applied) return;
				seen.push(first.version);
				let current = first.version;
				for (let step = 1; step <= 5; step += 1) {
					const write = await state.compareAndSet(
						key("k"),
						current,
						String(step),
						ttl,
					);
					check(
						write.applied,
						`compareAndSet ${step} with the current version failed`,
					);
					if (!write.applied) return;
					check(
						!seen.includes(write.version),
						`version repeated at step ${step}`,
					);
					seen.push(write.version);
					current = write.version;
				}
				for (const stale of seen.slice(0, -1)) {
					const write = await state.compareAndSet(
						key("k"),
						stale,
						"stale",
						ttl,
					);
					check(!write.applied, "a stale version was accepted");
				}
				check(
					(await state.get(key("k")))?.value === "5",
					"stale writes changed the value",
				);
			},
		),
		define(
			"versioning.cas-on-absent-never-applies",
			"versioning",
			"compareAndSet never creates a key: an absent key matches no version.",
			async ({ state, key, ttl, check }) => {
				const forged = await state.putIfAbsent(key("donor"), "x", ttl);
				check(forged.applied, "setup write failed");
				if (!forged.applied) return;
				const write = await state.compareAndSet(
					key("absent"),
					forged.version,
					"y",
					ttl,
				);
				check(!write.applied, "compareAndSet created a key");
				check(
					(await state.get(key("absent"))) === undefined,
					"absent key appeared",
				);
			},
		),
		define(
			"versioning.no-aba-after-recreate",
			"versioning",
			"A version from a deleted incarnation of a key never matches the recreated key, so a stale holder cannot overwrite it.",
			async ({ state, key, ttl, check }) => {
				const old = await state.putIfAbsent(key("k"), "old", ttl);
				check(old.applied, "setup write failed");
				if (!old.applied) return;
				await state.delete(key("k"));
				const fresh = await state.putIfAbsent(key("k"), "new", ttl);
				check(
					fresh.applied && fresh.version !== old.version,
					"recreated key reused the old version",
				);
				const write = await state.compareAndSet(
					key("k"),
					old.version,
					"stale",
					ttl,
				);
				check(
					!write.applied,
					"a version from the previous incarnation was accepted",
				);
			},
		),
		define(
			"concurrency.put-if-absent-race-has-one-winner",
			"concurrency",
			"Many clients racing putIfAbsent on one key: exactly one applies, and the stored value is the winner's.",
			async ({ key, ttl, check, client }) => {
				const racers = 32;
				const writes = await Promise.all(
					Array.from({ length: racers }, (_, index) =>
						client(index).putIfAbsent(key("k"), `racer-${index}`, ttl),
					),
				);
				const winners = writes.flatMap((write, index) =>
					write.applied ? [index] : [],
				);
				check(winners.length === 1, `${winners.length} racers won`);
				const read = await client(0).get(key("k"));
				check(
					read?.value === `racer-${winners[0]}`,
					"stored value is not the winner's",
				);
			},
		),
		define(
			"concurrency.cas-conflict-has-one-winner",
			"concurrency",
			"Two clients holding the same version both compareAndSet: exactly one applies.",
			async ({ key, ttl, check, client }) => {
				const base = await client(0).putIfAbsent(key("k"), "base", ttl);
				check(base.applied, "setup write failed");
				if (!base.applied) return;
				const [a, b] = await Promise.all([
					client(0).compareAndSet(key("k"), base.version, "a", ttl),
					client(1).compareAndSet(key("k"), base.version, "b", ttl),
				]);
				check(
					a.applied !== b.applied,
					"both or neither conflicting writers applied",
				);
			},
		),
		define(
			"concurrency.cas-loop-loses-no-update",
			"concurrency",
			"Concurrent read-modify-write loops over compareAndSet lose no update: the final count equals the writes made.",
			async ({ key, ttl, check, client }) => {
				const writers = 8;
				const perWriter = 5;
				await client(0).putIfAbsent(key("counter"), "0", ttl);
				let conflicts = 0;
				await Promise.all(
					Array.from({ length: writers }, async (_, index) => {
						const state = client(index);
						for (let done = 0; done < perWriter; ) {
							const read = await state.get(key("counter"));
							if (read === undefined)
								throw new EphemeralConformanceFailure(
									"concurrency.cas-loop-loses-no-update",
									"counter vanished",
								);
							const write = await state.compareAndSet(
								key("counter"),
								read.version,
								String(Number(read.value) + 1),
								ttl,
							);
							if (write.applied) done += 1;
							else conflicts += 1;
						}
					}),
				);
				const final = await client(0).get(key("counter"));
				check(
					final?.value === String(writers * perWriter),
					`final count ${final?.value} after ${writers * perWriter} writes (${conflicts} conflicts)`,
				);
			},
		),
		define(
			"counter.increment-is-atomic",
			"counter",
			"Concurrent increments from many clients each see a distinct value, and the total is exact.",
			async ({ key, ttl, check, client }) => {
				const count = 50;
				const results = await Promise.all(
					Array.from({ length: count }, (_, index) =>
						client(index).increment(key("n"), 1, ttl),
					),
				);
				const sorted = [...results].sort((a, b) => a - b);
				check(
					sorted.every((value, index) => value === index + 1),
					"increments were not a permutation of 1..n",
				);
				check(
					(await client(0).get(key("n")))?.value === String(count),
					"stored count is wrong",
				);
			},
		),
		define(
			"counter.by-zero-negative-and-type-guard",
			"counter",
			"increment takes zero and negative steps, and refuses a key holding a non-integer instead of resetting it.",
			async ({ state, key, ttl, check }) => {
				check((await state.increment(key("n"), 5, ttl)) === 5, "create by 5");
				check((await state.increment(key("n"), 0, ttl)) === 5, "by 0");
				check((await state.increment(key("n"), -7, ttl)) === -2, "by -7");
				await state.putIfAbsent(key("text"), "not-a-number", ttl);
				check(
					await rejects(() => state.increment(key("text"), 1, ttl)),
					"increment of a non-integer was not rejected",
				);
				check(
					(await state.get(key("text")))?.value === "not-a-number",
					"rejected increment changed the value",
				);
			},
		),
		define(
			"ttl.entries-expire",
			"ttl",
			"An entry is readable before its TTL and gone after it, and the key is free to create again.",
			async ({ state, key, ttl, check }, { advanceTime, ttlMs }) => {
				await state.putIfAbsent(key("k"), "x", ttl);
				await advanceTime(ttlMs * 0.4);
				check(
					(await state.get(key("k")))?.value === "x",
					"entry expired early",
				);
				await advanceTime(ttlMs);
				check(
					(await state.get(key("k"))) === undefined,
					"entry outlived its TTL",
				);
				check(
					(await state.putIfAbsent(key("k"), "y", ttl)).applied,
					"expired key could not be recreated",
				);
			},
		),
		define(
			"ttl.cas-resets-ttl-and-expire-extends",
			"ttl",
			"compareAndSet resets the TTL it is given; expire extends a live key and reports false for an absent one.",
			async ({ state, key, ttl, scaled, check }, { advanceTime, ttlMs }) => {
				const write = await state.putIfAbsent(key("cas"), "x", ttl);
				await state.putIfAbsent(key("exp"), "x", ttl);
				await advanceTime(ttlMs * 0.6);
				check(
					write.applied &&
						(await state.compareAndSet(key("cas"), write.version, "y", ttl))
							.applied,
					"refreshing compareAndSet failed",
				);
				check(
					await state.expire(key("exp"), scaled(3)),
					"expire of a live key reported false",
				);
				await advanceTime(ttlMs * 0.6);
				check(
					(await state.get(key("cas")))?.value === "y",
					"compareAndSet did not reset the TTL",
				);
				check(
					(await state.get(key("exp"))) !== undefined,
					"expire did not extend the TTL",
				);
				await advanceTime(ttlMs * 0.6);
				check(
					(await state.get(key("cas"))) === undefined,
					"compareAndSet TTL did not lapse",
				);
				check(
					!(await state.expire(key("absent"), ttl)),
					"expire of an absent key reported true",
				);
			},
		),
		define(
			"ttl.increment-window-modes",
			"ttl",
			"on-create increments keep the window fixed (a rate counter lapses on schedule); refresh increments keep an active counter alive.",
			async ({ state, key, ttl, check }, { advanceTime, ttlMs }) => {
				await state.increment(key("window"), 1, ttl);
				await state.increment(key("seq"), 1, ttl, "refresh");
				await advanceTime(ttlMs * 0.6);
				await state.increment(key("window"), 1, ttl);
				await state.increment(key("seq"), 1, ttl, "refresh");
				await advanceTime(ttlMs * 0.6);
				check(
					(await state.increment(key("window"), 1, ttl)) === 1,
					"on-create counter outlived its window",
				);
				check(
					(await state.increment(key("seq"), 1, ttl, "refresh")) === 3,
					"refresh counter lapsed while active",
				);
			},
		),
		define(
			"lock.owner-only-release",
			"lock",
			"A lock has one holder; renewal and release work only with the current lease.",
			async ({ key, ttl, check, client }) => {
				const a = await acquireEphemeralLock(
					client(0),
					key("lock"),
					"owner-a",
					ttl,
				);
				const b = await acquireEphemeralLock(
					client(1),
					key("lock"),
					"owner-b",
					ttl,
				);
				check(
					a !== undefined && b === undefined,
					"lock did not have exactly one holder",
				);
				if (a === undefined) return;
				const renewed = await renewEphemeralLock(client(0), a, ttl);
				check(renewed !== undefined, "holder could not renew");
				check(
					!(await releaseEphemeralLock(client(1), a)),
					"release with a pre-renewal lease succeeded",
				);
				check(
					renewed !== undefined &&
						(await releaseEphemeralLock(client(0), renewed)),
					"holder could not release",
				);
				check(
					(await acquireEphemeralLock(
						client(1),
						key("lock"),
						"owner-b",
						ttl,
					)) !== undefined,
					"released lock could not be taken",
				);
			},
		),
		define(
			"lock.contention-has-one-holder",
			"lock",
			"Many contenders acquiring at once: exactly one lease is granted.",
			async ({ key, ttl, check, client }) => {
				const leases = await Promise.all(
					Array.from({ length: 16 }, (_, index) =>
						acquireEphemeralLock(
							client(index),
							key("lock"),
							`owner-${index}`,
							ttl,
						),
					),
				);
				check(
					leases.filter((lease) => lease !== undefined).length === 1,
					"contention granted more or fewer than one lease",
				);
			},
		),
		define(
			"lock.expired-lease-is-lost",
			"lock",
			"After the TTL another owner can take the lock, and the previous holder can neither renew nor release it.",
			async ({ key, ttl, check, client }, { advanceTime, ttlMs }) => {
				const a = await acquireEphemeralLock(
					client(0),
					key("lock"),
					"owner-a",
					ttl,
				);
				check(a !== undefined, "first acquire failed");
				if (a === undefined) return;
				await advanceTime(ttlMs * 1.5);
				const b = await acquireEphemeralLock(
					client(1),
					key("lock"),
					"owner-b",
					ttl,
				);
				check(b !== undefined, "expired lock could not be taken");
				check(
					(await renewEphemeralLock(client(0), a, ttl)) === undefined,
					"expired holder renewed",
				);
				check(
					!(await releaseEphemeralLock(client(0), a)),
					"expired holder released someone else's lock",
				);
				check(
					(await client(0).get(key("lock")))?.value === "owner-b",
					"lock no longer names the new holder",
				);
			},
		),
		define(
			"ring.ordering-and-pagination",
			"ring",
			"Appends get consecutive sequence numbers and read back in order, page by page through `next`.",
			async ({ state, ttl, check }, { keyPrefix }) => {
				const ring = createEphemeralRing(state, {
					name: `${keyPrefix}ring-order`,
					capacity: 10,
					ttlMs: ttl,
				});
				for (let index = 1; index <= 5; index += 1) {
					check(
						(await ring.append(`e${index}`)).seq === index,
						`append ${index} got the wrong sequence`,
					);
				}
				const first = await ring.read(0, 2);
				check(
					first.entries.map((entry) => entry.value).join() === "e1,e2" &&
						first.next === 2,
					"first page wrong",
				);
				const rest = await ring.read(first.next);
				check(
					rest.entries.map((entry) => entry.seq).join() === "3,4,5" &&
						rest.head === 5 &&
						rest.next === 5,
					"second page wrong",
				);
				const caughtUp = await ring.read(rest.next);
				check(
					caughtUp.entries.length === 0 &&
						!caughtUp.reset &&
						caughtUp.next === 5,
					"caught-up read wrong",
				);
			},
		),
		define(
			"ring.capped-with-physical-eviction",
			"ring",
			"A ring keeps only its newest `capacity` entries: reads start at the oldest retained one and evicted entry keys are gone.",
			async ({ state, ttl, check }, { keyPrefix }) => {
				const ring = createEphemeralRing(state, {
					name: `${keyPrefix}ring-cap`,
					capacity: 4,
					ttlMs: ttl,
				});
				for (let index = 1; index <= 10; index += 1)
					await ring.append(`e${index}`);
				const read = await ring.read(0);
				check(
					read.entries.map((entry) => entry.seq).join() === "7,8,9,10",
					"capped read wrong",
				);
				const evicted = await state.getMany(
					[1, 5, 6].map((seq) => ring.keys.entry(seq)),
				);
				check(
					evicted.every((entry) => entry === undefined),
					"evicted entries are still stored",
				);
			},
		),
		define(
			"ring.concurrent-appends-are-unique",
			"ring",
			"Concurrent appenders across clients get distinct sequence numbers with no gap once all have landed.",
			async ({ ttl, check, client }, { keyPrefix }) => {
				const rings = [0, 1, 2, 3].map((index) =>
					createEphemeralRing(client(index), {
						name: `${keyPrefix}ring-race`,
						capacity: 50,
						ttlMs: ttl,
					}),
				);
				const appended = await Promise.all(
					Array.from({ length: 20 }, (_, index) =>
						rings[index % rings.length]?.append(`e${index}`),
					),
				);
				const seqs = appended
					.map((entry) => entry?.seq ?? 0)
					.sort((a, b) => a - b);
				check(
					seqs.every((seq, index) => seq === index + 1),
					"sequences were not 1..20",
				);
				const read = await rings[0]?.read(0);
				check(
					read?.entries.length === 20 && read.gaps.length === 0,
					"read did not return every append in order",
				);
			},
		),
		define(
			"ring.gaps-and-reset",
			"ring",
			"A sequence allocated without an entry is reported as a gap, and a ring that expired while idle reports reset to a cursor past its head.",
			async ({ state, ttl, check }, { keyPrefix, advanceTime, ttlMs }) => {
				const ring = createEphemeralRing(state, {
					name: `${keyPrefix}ring-gap`,
					capacity: 10,
					ttlMs: ttl,
				});
				await ring.append("e1");
				await state.increment(ring.keys.seq, 1, ttl, "refresh"); // a writer that died before its entry write
				await ring.append("e3");
				const read = await ring.read(0);
				check(
					read.gaps.join() === "2" &&
						read.entries.map((entry) => entry.seq).join() === "1,3",
					"gap not reported",
				);
				await advanceTime(ttlMs * 1.5);
				const after = await ring.read(3);
				check(
					after.reset && after.head === 0 && after.entries.length === 0,
					"expired ring did not report reset",
				);
				check(
					(await ring.append("fresh")).seq === 1,
					"expired ring did not restart at 1",
				);
			},
		),
		define(
			"cost.matches-documented-command-cost",
			"cost",
			"Each operation sends exactly the commands EPHEMERAL_STATE_COMMAND_COST documents once scripts are cached — the figure the relay budgets against.",
			async ({ state, key, ttl, check }, { usage, keyPrefix }) => {
				const measure = async <T>(
					operation: EphemeralStateOperation,
					call: () => Promise<T>,
					expected: number = EPHEMERAL_STATE_COMMAND_COST[operation],
				) => {
					const before = usage().total;
					await call();
					const sent = usage().total - before;
					check(
						sent === expected,
						`${operation} sent ${sent} commands, documented ${expected}`,
					);
				};
				// Warm every script handle so the steady-state cost is what is measured.
				const warm = await state.putIfAbsent(key("warm"), "1", ttl);
				if (warm.applied)
					await state.compareAndSet(key("warm"), warm.version, "2", ttl);
				await state.increment(key("warm-n"), 1, ttl);
				await state.getMany([key("warm")]);
				const last = await state.get(key("warm"));
				if (last !== undefined) await state.delete(key("warm"), last.version);

				await measure("get", () => state.get(key("a")));
				await measure("getMany", () => state.getMany([key("a"), key("b")]));
				const created = await state.putIfAbsent(key("a"), "x", ttl);
				await measure("putIfAbsent", () =>
					state.putIfAbsent(key("a"), "y", ttl),
				);
				if (created.applied)
					await measure("compareAndSet", () =>
						state.compareAndSet(key("a"), created.version, "z", ttl),
					);
				await measure("increment", () => state.increment(key("n"), 1, ttl));
				await measure("expire", () => state.expire(key("n"), ttl));
				await measure("delete", () => state.delete(key("n")));
				await measure("lock.acquire", () =>
					acquireEphemeralLock(state, key("lock"), "me", ttl),
				);
				const lease = await acquireEphemeralLock(
					state,
					key("lock2"),
					"me",
					ttl,
				);
				if (lease !== undefined) {
					let renewed = lease;
					await measure("lock.renew", async () => {
						renewed = (await renewEphemeralLock(state, lease, ttl)) ?? lease;
					});
					await measure("lock.release", () =>
						releaseEphemeralLock(state, renewed),
					);
				}
				const ring = createEphemeralRing(state, {
					name: `${keyPrefix}ring-cost`,
					capacity: 2,
					ttlMs: ttl,
				});
				await measure("ring.read", () => ring.read(0), 1);
				await measure("ring.append", () => ring.append("1"), 2);
				await ring.append("2");
				await measure("ring.append", () => ring.append("3"));
				await measure("ring.read", () => ring.read(0));
			},
		),
	];

export type EphemeralConformanceResult = {
	readonly id: string;
	readonly area: EphemeralConformanceArea;
	readonly status: "pass" | "fail";
	readonly detail: string;
};

/** Run every case in order, outside a test runner; a thrown non-failure aborts the run. */
export async function runEphemeralStateConformance(
	context: EphemeralConformanceContext,
): Promise<readonly EphemeralConformanceResult[]> {
	const results: EphemeralConformanceResult[] = [];
	for (const entry of EPHEMERAL_STATE_CONFORMANCE_CASES) {
		try {
			await entry.run(context);
			results.push({
				id: entry.id,
				area: entry.area,
				status: "pass",
				detail: "ok",
			});
		} catch (error) {
			if (!(error instanceof EphemeralConformanceFailure)) throw error;
			results.push({
				id: entry.id,
				area: entry.area,
				status: "fail",
				detail: error.message,
			});
		}
	}
	return results;
}
