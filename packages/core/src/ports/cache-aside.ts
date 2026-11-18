import type {
	EphemeralKey,
	EphemeralStatePort,
	EphemeralTtlMs,
} from "./ephemeral-state.js";

export async function readThroughCache(
	cache: EphemeralStatePort,
	key: EphemeralKey,
	ttl: EphemeralTtlMs,
	loadFromSource: () => string | undefined | Promise<string | undefined>,
): Promise<string | undefined> {
	const cached = await cache.get(key);
	if (cached !== undefined) return cached.value;
	const value = await loadFromSource();
	if (value !== undefined) await cache.putIfAbsent(key, value, ttl);
	return value;
}
