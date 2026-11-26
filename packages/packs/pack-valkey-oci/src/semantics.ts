/**
 * Persistence, eviction, and durability — stated, not implied.
 *
 * The reason this module exists at all: "Redis-compatible" is routinely read as
 * "a database". It is a store whose durability, key retention, and failure
 * behaviour are *configuration*, and the same server can be a durable keyspace or
 * a lossy cache depending on four settings. A pack that shipped those settings as
 * defaults and said nothing would be advertising a guarantee it does not have.
 *
 * So every mode here carries its own worst-case data loss in the type, and the
 * eviction policies are split by whether they can discard a key that has no TTL.
 * Selection reads these facts (`durability`, `keyLossPossible`) instead of
 * inferring them from the profile name.
 */

/** How the server writes the keyspace to the volume. */
export const VALKEY_DURABILITY_MODES = [
	"none",
	"rdb-snapshots",
	"aof-everysec",
	"aof-always",
] as const;

export type ValkeyDurabilityMode = (typeof VALKEY_DURABILITY_MODES)[number];

export type ValkeyDurabilitySemantics = {
	readonly mode: ValkeyDurabilityMode;
	/** The `appendfsync` value, when an append-only file is in use. */
	readonly appendFsync: "no" | "everysec" | "always" | "not-applicable";
	/**
	 * What is lost when the process dies unexpectedly. Stated as a duration in
	 * ms, with `null` meaning "the entire keyspace since the last restart".
	 */
	readonly worstCaseLossMs: number | null;
	/** Whether a committed write is expected to be there after a restart. */
	readonly survivesRestart: boolean;
	/** Whether a write is acknowledged before it reaches the volume. */
	readonly acknowledgesBeforeDurable: boolean;
	readonly note: string;
};

/**
 * The four modes and their real guarantees.
 *
 * `aof-always` is included for completeness and is deliberately described as
 * expensive rather than recommended: an fsync per write turns the store's latency
 * into the volume's latency, which is usually the wrong trade for the workloads
 * that reach for a Redis-compatible store in the first place.
 */
interface ValkeyDurabilityMap {
	none: ValkeyDurabilitySemantics;
	"rdb-snapshots": ValkeyDurabilitySemantics;
	"aof-everysec": ValkeyDurabilitySemantics;
	"aof-always": ValkeyDurabilitySemantics;
}

export const VALKEY_DURABILITY: ValkeyDurabilityMap = {
	none: {
		mode: "none",
		appendFsync: "not-applicable",
		worstCaseLossMs: null,
		survivesRestart: false,
		acknowledgesBeforeDurable: true,
		note: "Cache mode. Nothing is written to the volume, so a restart starts from an empty keyspace. Choose this when the data can be recomputed and say so out loud.",
	},
	"rdb-snapshots": {
		mode: "rdb-snapshots",
		appendFsync: "not-applicable",
		// The snapshot schedule this pack renders is at most 60s apart.
		worstCaseLossMs: 60_000,
		survivesRestart: true,
		acknowledgesBeforeDurable: true,
		note: "Point-in-time snapshots. A crash loses everything written since the last snapshot; a clean shutdown does not. Cheap, and honest about being coarse.",
	},
	"aof-everysec": {
		mode: "aof-everysec",
		appendFsync: "everysec",
		worstCaseLossMs: 1_000,
		survivesRestart: true,
		acknowledgesBeforeDurable: true,
		note: "Append-only file fsynced once a second. Bounded loss of roughly one second of writes, which is the usual choice when the keyspace matters.",
	},
	"aof-always": {
		mode: "aof-always",
		appendFsync: "always",
		worstCaseLossMs: 0,
		survivesRestart: true,
		acknowledgesBeforeDurable: false,
		note: "fsync per write. No acknowledged write is lost, and the store's write latency becomes the volume's fsync latency.",
	},
};

/**
 * Eviction policies, split by what they are allowed to discard.
 *
 * The `allkeys-*` policies can evict a key that was never given a TTL, which
 * means a client that wrote a key and read it back a moment later may not find
 * it. That is a legitimate cache, and it is not a key/value store that keeps what
 * you put in it — hence `keyLossPossible`.
 */
export const VALKEY_EVICTION_POLICIES = [
	"noeviction",
	"allkeys-lru",
	"allkeys-lfu",
	"allkeys-random",
	"volatile-lru",
	"volatile-lfu",
	"volatile-random",
	"volatile-ttl",
] as const;

export type ValkeyEvictionPolicy = (typeof VALKEY_EVICTION_POLICIES)[number];

export type ValkeyEvictionSemantics = {
	readonly policy: ValkeyEvictionPolicy;
	/** Can a key without a TTL be discarded to make room? */
	readonly evictsKeysWithoutTtl: boolean;
	/** What happens to a write once `maxmemory` is reached. */
	readonly writeBehaviourAtLimit: "error" | "evict-then-accept";
	readonly note: string;
};

interface ValkeyEvictionMap {
	noeviction: ValkeyEvictionSemantics;
	"allkeys-lru": ValkeyEvictionSemantics;
	"allkeys-lfu": ValkeyEvictionSemantics;
	"allkeys-random": ValkeyEvictionSemantics;
	"volatile-lru": ValkeyEvictionSemantics;
	"volatile-lfu": ValkeyEvictionSemantics;
	"volatile-random": ValkeyEvictionSemantics;
	"volatile-ttl": ValkeyEvictionSemantics;
}

export const VALKEY_EVICTION: ValkeyEvictionMap = {
	noeviction: {
		policy: "noeviction",
		evictsKeysWithoutTtl: false,
		writeBehaviourAtLimit: "error",
		note: "Writes are refused with an out-of-memory error at the limit. Nothing silently disappears, and the client has to handle a failure it can see.",
	},
	"allkeys-lru": {
		policy: "allkeys-lru",
		evictsKeysWithoutTtl: true,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Least-recently-used across the whole keyspace. A key with no TTL can vanish.",
	},
	"allkeys-lfu": {
		policy: "allkeys-lfu",
		evictsKeysWithoutTtl: true,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Least-frequently-used across the whole keyspace. A key with no TTL can vanish.",
	},
	"allkeys-random": {
		policy: "allkeys-random",
		evictsKeysWithoutTtl: true,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Uniformly random victim across the whole keyspace. A key with no TTL can vanish.",
	},
	"volatile-lru": {
		policy: "volatile-lru",
		evictsKeysWithoutTtl: false,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Least-recently-used among keys that carry a TTL; keys without one are kept, and writes fail once only such keys remain.",
	},
	"volatile-lfu": {
		policy: "volatile-lfu",
		evictsKeysWithoutTtl: false,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Least-frequently-used among keys that carry a TTL.",
	},
	"volatile-random": {
		policy: "volatile-random",
		evictsKeysWithoutTtl: false,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Random victim among keys that carry a TTL.",
	},
	"volatile-ttl": {
		policy: "volatile-ttl",
		evictsKeysWithoutTtl: false,
		writeBehaviourAtLimit: "evict-then-accept",
		note: "Shortest remaining TTL first.",
	},
};

export function isValkeyDurabilityMode(
	value: string,
): value is ValkeyDurabilityMode {
	// SAFETY: `return (VALKEY_DURABILITY_MODES as readonly string[]).includes(value);` is required at this I/O or test boundary.
	return (VALKEY_DURABILITY_MODES as readonly string[]).includes(value);
}

export function isValkeyEvictionPolicy(
	value: string,
): value is ValkeyEvictionPolicy {
	// SAFETY: `return (VALKEY_EVICTION_POLICIES as readonly string[]).includes(value);` is required at this I/O or test boundary.
	return (VALKEY_EVICTION_POLICIES as readonly string[]).includes(value);
}

/**
 * The two settings that decide whether the store keeps what it is given.
 *
 * A caller gets one record instead of two lookups plus a judgement call, because
 * the interesting property is the *combination*: `aof-always` with
 * `allkeys-lru` is durable against a crash and still allowed to throw your key
 * away under memory pressure.
 */
export type ValkeyRetentionSemantics = {
	readonly durability: ValkeyDurabilitySemantics;
	readonly eviction: ValkeyEvictionSemantics;
	/** True when a successfully written key may later be gone. */
	readonly keyLossPossible: boolean;
	/** True only when a committed write survives a crash *and* stays present. */
	readonly behavesAsDurableKeyspace: boolean;
};

export function valkeyRetentionSemantics(input: {
	readonly durabilityMode: ValkeyDurabilityMode;
	readonly evictionPolicy: ValkeyEvictionPolicy;
}): ValkeyRetentionSemantics {
	const durability = VALKEY_DURABILITY[input.durabilityMode];
	const eviction = VALKEY_EVICTION[input.evictionPolicy];
	const keyLossPossible =
		!durability.survivesRestart || eviction.evictsKeysWithoutTtl;
	return {
		durability,
		eviction,
		keyLossPossible,
		behavesAsDurableKeyspace:
			durability.survivesRestart && !eviction.evictsKeysWithoutTtl,
	};
}
