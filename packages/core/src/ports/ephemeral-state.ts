/**
 * Ephemeral state: short-lived, loss-tolerant key/value state with TTL,
 * compare-and-set, and atomic counters.
 *
 * This is the port for state a service may lose. Every write carries a TTL, so
 * nothing written through it outlives its usefulness, and a caller must be able
 * to rebuild anything it reads from an authoritative source (GitHub, Vercel,
 * the event store). It is deliberately not an `EventStore`: there is no stream,
 * no position, no durability claim, and no fencing beyond the per-key version.
 *
 * The primitives are the ones a Redis-protocol store can serve atomically in a
 * single round trip — a server-side script per conditional write — so the same
 * port binds to a hosted REST cache, a self-hosted Valkey/Redis over TCP, or an
 * in-memory engine, with identical semantics. Implementations live outside
 * core (`@hobo/kv-redis-compatible`, `@hobo/provider-upstash`); the lock and
 * ring helpers below are built only on the port, so they behave identically on
 * every binding.
 */
import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";

// public-contract: version tag a binding reports so a host can refuse a mismatch.
export const EPHEMERAL_STATE_PORT_CONTRACT_VERSION =
	"hobo.core.ephemeral-state/v1" as const;

/** Longest TTL the port accepts. Ephemeral means days, not forever. */
export const EPHEMERAL_STATE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Longest key the port accepts, in characters (printable ASCII only). */
export const EPHEMERAL_STATE_MAX_KEY_LENGTH = 512;
/** Longest opaque version token an implementation may hand out. */
export const EPHEMERAL_STATE_MAX_VERSION_LENGTH = 128;

export type EphemeralKey = string & { readonly __brand: "EphemeralKey" };
/**
 * Opaque, per-key version token. Each successful write of a key yields a token
 * that no earlier write of that key — including a write to a previous
 * incarnation that was deleted or expired — ever yielded, so a stale
 * compare-and-set cannot succeed against a recreated key (no ABA).
 */
export type EphemeralVersion = string & {
	readonly __brand: "EphemeralVersion";
};
export type EphemeralTtlMs = number & { readonly __brand: "EphemeralTtlMs" };

// domain-view: parse-don't-validate entry carrying the branded version; its generated ephemeral_state_pb.ts EphemeralEntry is the wire form.
export interface EphemeralEntry {
	readonly value: string;
	readonly version: EphemeralVersion;
}

/** Outcome of a conditional write. `applied: false` is a lost race, not an error. */
export type EphemeralWrite =
	| { readonly applied: true; readonly version: EphemeralVersion }
	| { readonly applied: false };

/**
 * `on-create` sets the TTL only when the counter is created, so a fixed window
 * (a rate counter) expires on schedule however often it is bumped. `refresh`
 * resets it on every increment, so an active counter (a sequence) never lapses.
 */
export type IncrementTtlMode = "on-create" | "refresh";

export interface EphemeralStatePort {
	/** Current value and version, or `undefined` when absent or expired. */
	get(key: EphemeralKey): Promise<EphemeralEntry | undefined>;
	/** `get` for several keys in one round trip; the result is index-aligned. */
	getMany(
		keys: readonly EphemeralKey[],
	): Promise<readonly (EphemeralEntry | undefined)[]>;
	/** Create the key with `ttlMs` unless it exists. Exactly one concurrent caller wins. */
	putIfAbsent(
		key: EphemeralKey,
		value: string,
		ttlMs: EphemeralTtlMs,
	): Promise<EphemeralWrite>;
	/**
	 * Replace the value only when the stored version is `expected`; the TTL is
	 * reset to `ttlMs`. Absent keys never match.
	 */
	compareAndSet(
		key: EphemeralKey,
		expected: EphemeralVersion,
		value: string,
		ttlMs: EphemeralTtlMs,
	): Promise<EphemeralWrite>;
	/** Delete; with `expected`, only when the stored version matches. True when a key was removed. */
	delete(key: EphemeralKey, expected?: EphemeralVersion): Promise<boolean>;
	/**
	 * Atomically add `by` (a safe integer, may be negative or zero) and return
	 * the new value. A missing key starts at zero and is created with `ttlMs`.
	 * A key holding a non-integer value is a rejected call, not a reset.
	 */
	increment(
		key: EphemeralKey,
		by: number,
		ttlMs: EphemeralTtlMs,
		mode?: IncrementTtlMode,
	): Promise<number>;
	/** Reset the TTL of an existing key. False when the key is absent. */
	expire(key: EphemeralKey, ttlMs: EphemeralTtlMs): Promise<boolean>;
}

/**
 * Steady-state backend commands (round trips) each call issues on a
 * Redis-protocol binding — the unit a hosted cache bills by.
 *
 * Every conditional write is one server-side script call (`EVALSHA`). The
 * first call of each script against a server whose script cache does not hold
 * it costs one extra command (`EVALSHA` answers `NOSCRIPT`, then `EVAL`), and
 * a restarted or flushed server pays that again. `getMany` of zero keys and a
 * ring read of an empty range issue nothing for the empty part.
 */
// public-contract: per-operation command budget the relay meters against.
export const EPHEMERAL_STATE_COMMAND_COST = Object.freeze({
	get: 1,
	getMany: 1,
	putIfAbsent: 1,
	compareAndSet: 1,
	delete: 1,
	increment: 1,
	expire: 1,
	"lock.acquire": 1,
	"lock.renew": 1,
	"lock.release": 1,
	/** increment(seq) + putIfAbsent(entry) + delete(evicted); 2 until the ring first fills. */
	"ring.append": 3,
	/** get(seq) + getMany(window); 1 when the window is empty. */
	"ring.read": 2,
} as const);

export type EphemeralStateOperation = keyof typeof EPHEMERAL_STATE_COMMAND_COST;

export class EphemeralStateParseError extends CoreParseError {
	constructor(
		path: string,
		expected: string,
		received: JsonValue | undefined,
		message?: string,
	) {
		super("HOBO_CORE_EPHEMERAL_STATE_PARSE", path, expected, received, message);
		this.name = "EphemeralStateParseError";
	}
}

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/u;

export function parseEphemeralKey(value: string): EphemeralKey {
	if (
		value.length === 0 ||
		value.length > EPHEMERAL_STATE_MAX_KEY_LENGTH ||
		!PRINTABLE_ASCII.test(value)
	) {
		throw new EphemeralStateParseError(
			"key",
			`1..${EPHEMERAL_STATE_MAX_KEY_LENGTH} printable ASCII characters with no whitespace`,
			value.length > 64 ? `${value.slice(0, 61)}...` : value,
		);
	}
	// SAFETY: the brand is applied only after the shape check above.
	return value as EphemeralKey;
}

export function parseEphemeralVersion(value: string): EphemeralVersion {
	if (
		value.length === 0 ||
		value.length > EPHEMERAL_STATE_MAX_VERSION_LENGTH ||
		!PRINTABLE_ASCII.test(value)
	) {
		throw new EphemeralStateParseError(
			"version",
			`1..${EPHEMERAL_STATE_MAX_VERSION_LENGTH} printable ASCII characters`,
			value.slice(0, EPHEMERAL_STATE_MAX_VERSION_LENGTH),
		);
	}
	// SAFETY: the brand is applied only after the shape check above.
	return value as EphemeralVersion;
}

export function parseEphemeralTtlMs(value: number): EphemeralTtlMs {
	if (
		!Number.isSafeInteger(value) ||
		value <= 0 ||
		value > EPHEMERAL_STATE_MAX_TTL_MS
	) {
		throw new EphemeralStateParseError(
			"ttlMs",
			`integer milliseconds in 1..${EPHEMERAL_STATE_MAX_TTL_MS}`,
			Number.isFinite(value) ? value : String(value),
		);
	}
	// SAFETY: the brand is applied only after the range check above.
	return value as EphemeralTtlMs;
}

export function parseIncrementBy(value: number): number {
	if (!Number.isSafeInteger(value)) {
		throw new EphemeralStateParseError(
			"by",
			"safe integer",
			Number.isFinite(value) ? value : String(value),
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Locks: putIfAbsent to acquire, compareAndSet to renew, versioned delete to
// release. A lease is only as good as its TTL — a holder that stalls past it
// has lost the lock, and its release then fails instead of freeing a lock
// someone else now holds.
// ---------------------------------------------------------------------------

// domain-view: lease carrying the branded key and version; its generated ephemeral_state_pb.ts EphemeralLockLease is the wire form.
export interface EphemeralLockLease {
	readonly key: EphemeralKey;
	readonly owner: string;
	readonly version: EphemeralVersion;
}

function parseOwner(owner: string): string {
	if (owner.length === 0 || owner.length > 256) {
		throw new EphemeralStateParseError(
			"owner",
			"non-empty owner token of at most 256 characters",
			owner.slice(0, 64),
		);
	}
	return owner;
}

/** One command. `undefined` when another owner (or a live earlier lease of this owner) holds it. */
export async function acquireEphemeralLock(
	port: EphemeralStatePort,
	key: EphemeralKey,
	owner: string,
	ttlMs: EphemeralTtlMs,
): Promise<EphemeralLockLease | undefined> {
	const token = parseOwner(owner);
	const write = await port.putIfAbsent(key, token, ttlMs);
	return write.applied
		? { key, owner: token, version: write.version }
		: undefined;
}

/** One command. Returns the renewed lease, or `undefined` when the lease was lost. */
export async function renewEphemeralLock(
	port: EphemeralStatePort,
	lease: EphemeralLockLease,
	ttlMs: EphemeralTtlMs,
): Promise<EphemeralLockLease | undefined> {
	const write = await port.compareAndSet(
		lease.key,
		lease.version,
		lease.owner,
		ttlMs,
	);
	return write.applied ? { ...lease, version: write.version } : undefined;
}

/** One command. True only when this lease still held the lock. */
export async function releaseEphemeralLock(
	port: EphemeralStatePort,
	lease: EphemeralLockLease,
): Promise<boolean> {
	return port.delete(lease.key, lease.version);
}

// ---------------------------------------------------------------------------
// Ring: a capped, append-only feed with a monotonic sequence.
//
// Layout: one counter key `ring:{<name>}:seq` and one entry key per sequence
// number `ring:{<name>}:e:<seq>`. The braces are a Redis Cluster hash tag, so
// every key of a ring lands in one slot and a multi-key read is legal on a
// clustered Valkey too. Every key carries the ring TTL; the counter's TTL is
// refreshed on each append, so it always outlives every entry, and an idle
// ring disappears whole and restarts at sequence 1 — which `read` reports as
// `reset` rather than letting a cursor silently point past the head.
// ---------------------------------------------------------------------------

export const EPHEMERAL_RING_MAX_CAPACITY = 10_000;
const RING_NAME = /^[\x21-\x7a\x7c\x7e]{1,128}$/u; // printable ASCII without `{` or `}`

export interface EphemeralRingOptions {
	readonly name: string;
	/** Entries retained; older ones are evicted on append. */
	readonly capacity: number;
	/** TTL of every ring key; an idle ring disappears after this. */
	readonly ttlMs: EphemeralTtlMs;
}

// domain-view: entry with a numeric sequence; its generated ephemeral_state_pb.ts EphemeralRingEntry is the wire form.
export interface EphemeralRingEntry {
	readonly seq: number;
	readonly value: string;
}

// domain-view: read window over the ring; its generated ephemeral_state_pb.ts EphemeralRingRead is the wire form.
export interface EphemeralRingRead {
	/** Present entries in ascending sequence order. */
	readonly entries: readonly EphemeralRingEntry[];
	/** Highest sequence allocated so far (0 for an empty or expired ring). */
	readonly head: number;
	/** Pass as `afterSeq` to continue. */
	readonly next: number;
	/**
	 * Sequence numbers inside the window with no entry: an append whose entry
	 * write has not landed yet (or never will — its writer died). Re-read from
	 * `gap - 1` to pick a late one up; it is evicted like any other entry.
	 */
	readonly gaps: readonly number[];
	/** True when `afterSeq` was beyond the head: the ring expired and restarted. */
	readonly reset: boolean;
}

export interface EphemeralRing {
	readonly name: string;
	readonly capacity: number;
	readonly keys: {
		readonly seq: EphemeralKey;
		entry(seq: number): EphemeralKey;
	};
	append(value: string): Promise<{ readonly seq: number }>;
	read(afterSeq: number, limit?: number): Promise<EphemeralRingRead>;
}

export class EphemeralRingError extends Error {
	readonly code = "HOBO_CORE_EPHEMERAL_RING_SEQUENCE_COLLISION";
	constructor(message: string) {
		super(message);
		this.name = "EphemeralRingError";
	}
}

export function createEphemeralRing(
	port: EphemeralStatePort,
	options: EphemeralRingOptions,
): EphemeralRing {
	if (!RING_NAME.test(options.name)) {
		throw new EphemeralStateParseError(
			"ring.name",
			"1..128 printable ASCII characters without braces",
			options.name.slice(0, 64),
		);
	}
	if (
		!Number.isSafeInteger(options.capacity) ||
		options.capacity <= 0 ||
		options.capacity > EPHEMERAL_RING_MAX_CAPACITY
	) {
		throw new EphemeralStateParseError(
			"ring.capacity",
			`integer in 1..${EPHEMERAL_RING_MAX_CAPACITY}`,
			options.capacity,
		);
	}
	const { name, capacity, ttlMs } = options;
	const seqKey = parseEphemeralKey(`ring:{${name}}:seq`);
	const entryKey = (seq: number): EphemeralKey =>
		parseEphemeralKey(`ring:{${name}}:e:${seq}`);

	return {
		name,
		capacity,
		keys: { seq: seqKey, entry: entryKey },
		async append(value) {
			const seq = await port.increment(seqKey, 1, ttlMs, "refresh");
			const write = await port.putIfAbsent(entryKey(seq), value, ttlMs);
			if (!write.applied) {
				// The counter always outlives every entry, so an existing entry key
				// at a freshly allocated sequence means something else wrote it.
				throw new EphemeralRingError(
					`ring ${name}: an entry already exists at freshly allocated sequence ${seq}`,
				);
			}
			if (seq > capacity) await port.delete(entryKey(seq - capacity));
			return { seq };
		},
		async read(afterSeq, limit = capacity) {
			if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
				throw new EphemeralStateParseError(
					"ring.afterSeq",
					"non-negative integer",
					afterSeq,
				);
			}
			if (!Number.isSafeInteger(limit) || limit <= 0) {
				throw new EphemeralStateParseError(
					"ring.limit",
					"positive integer",
					limit,
				);
			}
			const stored = await port.get(seqKey);
			const head = stored === undefined ? 0 : Number(stored.value);
			const reset = afterSeq > head;
			const oldest = Math.max(1, head - capacity + 1);
			const from = Math.max(reset ? 0 : afterSeq + 1, oldest);
			const to = Math.min(head, from + Math.min(limit, capacity) - 1);
			if (to < from) {
				return {
					entries: [],
					head,
					next: reset ? head : afterSeq,
					gaps: [],
					reset,
				};
			}
			const seqs: number[] = [];
			for (let seq = from; seq <= to; seq += 1) seqs.push(seq);
			const found = await port.getMany(seqs.map(entryKey));
			const entries: EphemeralRingEntry[] = [];
			const gaps: number[] = [];
			for (const [index, seq] of seqs.entries()) {
				const entry = found[index];
				if (entry === undefined) gaps.push(seq);
				else entries.push({ seq, value: entry.value });
			}
			return { entries, head, next: to, gaps, reset };
		},
	};
}
