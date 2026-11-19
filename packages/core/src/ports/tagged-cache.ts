import { createHash, randomUUID } from "node:crypto";
import { fromJsonString } from "@bufbuild/protobuf";
import {
	type TaggedCacheEntryRecord,
	TaggedCacheEntryRecordSchema,
	type TaggedCacheReadRecord,
	type TaggedCacheTagEpochRecord,
} from "../_generated/tagged_cache_pb.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "../json.js";
import {
	EPHEMERAL_STATE_MAX_TTL_MS,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	parseEphemeralKey,
	parseEphemeralTtlMs,
} from "./ephemeral-state.js";

export type TaggedCacheRead = Readonly<
	Omit<TaggedCacheReadRecord, "$typeName">
>;
export interface TaggedCachePort {
	get(key: EphemeralKey): Promise<string | undefined>;
	put(
		key: EphemeralKey,
		value: string,
		ttl: EphemeralTtlMs,
		tags: readonly string[],
	): Promise<void>;
	delete(key: EphemeralKey): Promise<boolean>;
	invalidate(tag: string): Promise<void>;
	readThrough(
		key: EphemeralKey,
		ttl: EphemeralTtlMs,
		tags: readonly string[],
		load: () => string | undefined | Promise<string | undefined>,
	): Promise<TaggedCacheRead>;
}

export class TaggedCacheError extends Error {
	readonly code = "cache.tagged.invalid";
}

type TagEpoch = Readonly<Omit<TaggedCacheTagEpochRecord, "$typeName">>;
type TagEpochs = readonly TagEpoch[];
type CachedEntry = Readonly<
	Omit<TaggedCacheEntryRecord, "$typeName" | "tagEpochs"> & {
		tagEpochs: TagEpochs;
	}
>;
const EPOCH =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_TAGS = 64;
const ATTEMPTS = 32;
const EPOCH_TTL = parseEphemeralTtlMs(EPHEMERAL_STATE_MAX_TTL_MS);

function identifier(value: string, name: string): string {
	if (
		value.trim().length === 0 ||
		value.length > 128 ||
		/[\p{Cc}]/u.test(value)
	)
		throw new TaggedCacheError(
			`${name} must contain 1 to 128 characters without control characters`,
		);
	return value;
}

function normalizedTags(tags: readonly string[]): string[] {
	const unique = [...new Set(tags.map((tag) => identifier(tag, "tag")))].sort();
	if (unique.length > MAX_TAGS)
		throw new TaggedCacheError(
			`cache entries support at most ${MAX_TAGS} tags`,
		);
	return unique;
}

function decodeEntry(text: string): CachedEntry | undefined {
	const value = parseJsonValue(text);
	if (
		!isJsonObject(value) ||
		!isJsonString(value.value) ||
		!isJsonArray(value.tagEpochs)
	)
		return undefined;
	let record: TaggedCacheEntryRecord;
	try {
		record = fromJsonString(TaggedCacheEntryRecordSchema, text);
	} catch {
		return undefined;
	}
	const entries = record.tagEpochs;
	if (
		entries.length > MAX_TAGS ||
		entries.some(
			({ tag, epoch }) =>
				!EPOCH.test(epoch) ||
				tag.trim().length === 0 ||
				tag.length > 128 ||
				/[\p{Cc}]/u.test(tag),
		) ||
		new Set(entries.map((item) => item.tag)).size !== entries.length
	)
		return undefined;
	return {
		value: record.value,
		tagEpochs: entries
			.map(({ tag, epoch }) => ({ tag, epoch }))
			.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0)),
	};
}

export function createTaggedCache(
	state: EphemeralStatePort,
	namespace: string,
): TaggedCachePort {
	const owner = identifier(namespace, "namespace");
	function storageKey(kind: "entry" | "tag", key: string): EphemeralKey {
		const digest = createHash("sha256")
			.update(JSON.stringify([owner, kind, key]))
			.digest("hex");
		return parseEphemeralKey(`tagged-cache:${digest}`);
	}
	async function epoch(tag: string): Promise<string> {
		const key = storageKey("tag", tag);
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const existing = await state.get(key);
			if (existing && EPOCH.test(existing.value)) {
				if (await state.expire(key, EPOCH_TTL)) return existing.value;
				continue;
			}
			const token = randomUUID();
			const write = existing
				? await state.compareAndSet(key, existing.version, token, EPOCH_TTL)
				: await state.putIfAbsent(key, token, EPOCH_TTL);
			if (write.applied) return token;
		}
		throw new TaggedCacheError("cache tag changed too frequently");
	}
	async function epochs(tags: readonly string[]): Promise<TagEpochs> {
		const values: TagEpoch[] = [];
		for (const tag of tags) values.push({ tag, epoch: await epoch(tag) });
		return values;
	}
	async function read(
		key: EphemeralKey,
		expectedTags?: readonly string[],
	): Promise<string | undefined> {
		const storedKey = storageKey("entry", parseEphemeralKey(key));
		const stored = await state.get(storedKey);
		if (!stored) return undefined;
		const entry = decodeEntry(stored.value);
		const tags = entry ? entry.tagEpochs.map((item) => item.tag) : [];
		const sameTags =
			expectedTags === undefined ||
			(tags.length === expectedTags.length &&
				tags.every((tag, index) => tag === expectedTags[index]));
		if (entry && sameTags) {
			const current =
				tags.length === 0
					? []
					: await state.getMany(tags.map((tag) => storageKey("tag", tag)));
			if (
				current.length === tags.length &&
				entry.tagEpochs.every(
					(item, index) => current[index]?.value === item.epoch,
				)
			)
				return entry.value;
		}
		await state.delete(storedKey, stored.version);
		return undefined;
	}
	async function store(
		key: EphemeralKey,
		value: string,
		ttl: EphemeralTtlMs,
		tagEpochs: TagEpochs,
		overwrite: boolean,
	): Promise<void> {
		const storedKey = storageKey("entry", parseEphemeralKey(key));
		const payload = JSON.stringify({ value, tagEpochs });
		const duration = parseEphemeralTtlMs(ttl);
		if (!overwrite) {
			await state.putIfAbsent(storedKey, payload, duration);
			return;
		}
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			const existing = await state.get(storedKey);
			const write = existing
				? await state.compareAndSet(
						storedKey,
						existing.version,
						payload,
						duration,
					)
				: await state.putIfAbsent(storedKey, payload, duration);
			if (write.applied) return;
		}
		throw new TaggedCacheError("cache entry changed too frequently");
	}
	return {
		get(key) {
			return read(key);
		},
		async put(key, value, ttl, tags) {
			await store(key, value, ttl, await epochs(normalizedTags(tags)), true);
		},
		delete(key) {
			return state.delete(storageKey("entry", parseEphemeralKey(key)));
		},
		async invalidate(tag) {
			const key = storageKey("tag", identifier(tag, "tag"));
			for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
				const existing = await state.get(key);
				const token = randomUUID();
				const write = existing
					? await state.compareAndSet(key, existing.version, token, EPOCH_TTL)
					: await state.putIfAbsent(key, token, EPOCH_TTL);
				if (write.applied) return;
			}
			throw new TaggedCacheError("cache tag changed too frequently");
		},
		async readThrough(key, ttl, tags, load) {
			const normalized = normalizedTags(tags);
			const cached = await read(key, normalized);
			if (cached !== undefined) return { hit: true, value: cached };
			const snapshot = await epochs(normalized);
			const value = await load();
			if (value === undefined) return { hit: false };
			await store(key, value, ttl, snapshot, false);
			return { hit: false, value };
		},
	};
}
