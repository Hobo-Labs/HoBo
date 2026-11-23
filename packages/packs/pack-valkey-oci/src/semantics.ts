export const VALKEY_DURABILITY_MODES = [
	"none",
	"rdb-snapshots",
	"aof-everysec",
	"aof-always",
] as const;

export type ValkeyDurabilityMode = (typeof VALKEY_DURABILITY_MODES)[number];

export type ValkeyDurabilitySemantics = {
	readonly mode: ValkeyDurabilityMode;
	readonly appendFsync: "no" | "everysec" | "always" | "not-applicable";
	readonly worstCaseLossMs: number | null;
	readonly survivesRestart: boolean;
	readonly acknowledgesBeforeDurable: boolean;
	readonly note: string;
};

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
	readonly evictsKeysWithoutTtl: boolean;
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
	return (VALKEY_DURABILITY_MODES as readonly string[]).includes(value);
}

export function isValkeyEvictionPolicy(
	value: string,
): value is ValkeyEvictionPolicy {
	return (VALKEY_EVICTION_POLICIES as readonly string[]).includes(value);
}

export type ValkeyRetentionSemantics = {
	readonly durability: ValkeyDurabilitySemantics;
	readonly eviction: ValkeyEvictionSemantics;
	readonly keyLossPossible: boolean;
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
