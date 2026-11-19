
export const MISS = Symbol("cache-miss");
export type Miss = typeof MISS;

export class SimCache<V> {
	#store = new Map<string, { value: V; expiresAt: number }>();
	constructor(private readonly clock: () => number) {}

	set(key: string, value: V, ttlTicks: number): void {
		this.#store.set(key, { value, expiresAt: this.clock() + ttlTicks });
	}

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

	evictAll(): void {
		this.#store.clear();
	}

	get size(): number {
		return this.#store.size;
	}
}

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
