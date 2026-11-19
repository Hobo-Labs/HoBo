import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { CacheReadRecord } from "../_generated/tagged_cache_pb.js";
import {
	type EphemeralStatePort,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "./ephemeral-state.js";
import { createTaggedCache, TaggedCacheError } from "./tagged-cache.js";

export type CacheRead = Readonly<Omit<CacheReadRecord, "$typeName">>;
export interface CacheClient {
	get(key: string): Promise<Uint8Array | undefined>;
	set(
		key: string,
		value: Uint8Array,
		ttlMs: number,
		tags?: readonly string[],
	): Promise<void>;
	delete(key: string): Promise<boolean>;
	invalidate(tag: string): Promise<void>;
	readThrough(
		key: string,
		ttlMs: number,
		tags: readonly string[],
		load: () => Uint8Array | undefined | Promise<Uint8Array | undefined>,
	): Promise<CacheRead>;
}

function decode(value: string): Uint8Array | undefined {
	const bytes = Buffer.from(value, "base64");
	return bytes.toString("base64") === value ? new Uint8Array(bytes) : undefined;
}

export function createCacheClient(
	state: EphemeralStatePort,
	namespace: string,
): CacheClient {
	if (
		namespace.trim().length === 0 ||
		namespace.length > 128 ||
		/[\p{Cc}]/u.test(namespace)
	)
		throw new TaggedCacheError(
			"namespace must contain 1 to 128 characters without control characters",
		);
	const digest = createHash("sha256")
		.update(JSON.stringify(["binary-cache", namespace]))
		.digest("hex");
	const cache = createTaggedCache(state, `client:${digest}`);
	return {
		async get(key) {
			const parsed = parseEphemeralKey(key);
			const value = await cache.get(parsed);
			if (value === undefined) return undefined;
			const decoded = decode(value);
			if (decoded === undefined) await cache.delete(parsed);
			return decoded;
		},
		async set(key, value, ttlMs, tags = []) {
			await cache.put(
				parseEphemeralKey(key),
				Buffer.from(value).toString("base64"),
				parseEphemeralTtlMs(ttlMs),
				tags,
			);
		},
		delete(key) {
			return cache.delete(parseEphemeralKey(key));
		},
		invalidate(tag) {
			return cache.invalidate(tag);
		},
		async readThrough(key, ttlMs, tags, load) {
			const parsed = parseEphemeralKey(key);
			const ttl = parseEphemeralTtlMs(ttlMs);
			const encodedLoad = async () => {
				const value = await load();
				return value === undefined
					? undefined
					: Buffer.from(value).toString("base64");
			};
			for (let attempt = 0; attempt < 2; attempt++) {
				const result = await cache.readThrough(parsed, ttl, tags, encodedLoad);
				if (result.value === undefined) return { hit: false };
				const value = decode(result.value);
				if (value !== undefined) return { hit: result.hit, value };
				await cache.delete(parsed);
			}
			throw new TaggedCacheError("cache value could not be decoded");
		},
	};
}
