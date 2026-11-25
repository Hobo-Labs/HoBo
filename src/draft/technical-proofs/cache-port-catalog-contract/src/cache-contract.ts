/**
 * Pins the ADR-0118 contract: `hobo:cache` (ephemeral, TTL-first, evictable, never a
 * source of truth) is semantically distinct from `hobo:kv` / `wasi:keyvalue` (durable,
 * authoritative). Deterministic logical clock — no wall-clock reads, no real timers, so
 * the gate-executed example is reproducible.
 */

export const MISS = Symbol("cache-miss");
export type Miss = typeof MISS;

/** `hobo:cache` — ephemeral, TTL-bounded, evictable. Never the source of truth. */
export class SimCache<V> {
	#store = new Map<string, { value: V; expiresAt: number }>();
	constructor(private readonly clock: () => number) {}

	set(key: string, value: V, ttlTicks: number): void {
		this.#store.set(key, { value, expiresAt: this.clock() + ttlTicks });
	}

	/** A cold or expired key is a MISS, never an error. */
	get(key: string): V | Miss {
		const entry = this.#store.get(key);
		if (!entry) return MISS;
		if (this.clock() >= entry.expiresAt) {
			this.#store.delete(key);
			return MISS;
		}
		return entry.value;
	}

	delete(key: string): void {
		this.#store.delete(key);
	}

	/** Memory-pressure eviction — a cache MAY drop entries before TTL. */
	evictAll(): void {
		this.#store.clear();
	}

	get size(): number {
		return this.#store.size;
	}
}

/** `hobo:kv` / `wasi:keyvalue` — durable, authoritative. No TTL, no eviction. */
export class SimDurableKv<V> {
	#store = new Map<string, V>();
	set(key: string, value: V): void {
		this.#store.set(key, value);
	}
	get(key: string): V | undefined {
		return this.#store.get(key);
	}
	delete(key: string): void {
		this.#store.delete(key);
	}
}

/**
 * Cache-aside read: serve from cache; on miss, recompute from the durable source and
 * populate. Correctness never depends on a hit — a cold or evicted cache just recomputes.
 */
export interface CacheAsideResult<V> {
	readonly value: V | undefined;
	readonly hit: boolean;
}

export function cacheAside<V>(
	cache: SimCache<V>,
	key: string,
	loadFromSource: () => V | undefined,
	ttlTicks: number,
): CacheAsideResult<V> {
	const cached = cache.get(key);
	if (cached !== MISS) return { value: cached, hit: true };
	const fresh = loadFromSource();
	if (fresh !== undefined) cache.set(key, fresh, ttlTicks);
	return { value: fresh, hit: false };
}
