import {
	type EphemeralEntry,
	type EphemeralKey,
	type EphemeralStatePort,
	type EphemeralTtlMs,
	type EphemeralVersion,
	type EphemeralWrite,
	type IncrementTtlMode,
	parseIncrementBy,
} from "@hobo/core";
import { KvRedisCompatibleError } from "@hobo/kv-redis-compatible";

import {
	blobPathname,
	DEFAULT_VERCEL_BLOB_NAMESPACE,
	parseVercelBlobNamespace,
	type VercelBlobNamespace,
} from "./pathname.js";
import {
	encodeStoredRecord,
	entryOf,
	parseIncarnation,
	parseStoredRecord,
	parseWriteId,
	type StoredRecord,
	versionOf,
} from "./record.js";
import {
	classifyBlobWriteError,
	isBlobDeleteRefusal,
	type VercelBlobSdk,
} from "./sdk.js";

export type VercelBlobRetryOptions = {
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
	readonly maxDelayMs?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly random?: () => number;
};

export type VercelBlobEphemeralStateOptions = {
	readonly sdk: VercelBlobSdk;
	readonly storeId?: string;
	readonly namespace?: string;
	readonly now?: () => number;
	readonly newIncarnation?: () => string;
	readonly newWriteId?: () => string;
	readonly readConcurrency?: number;
	readonly retry?: VercelBlobRetryOptions;
};

export class VercelBlobContentionError extends Error {
	readonly code = "HOBO_VERCEL_BLOB_EPHEMERAL_CONTENTION";
	constructor(operation: string, attempts: number) {
		super(
			`ephemeral ${operation} gave up after ${attempts} conflicting writes to one key`,
		);
		this.name = "VercelBlobContentionError";
	}
}

type Read = { readonly record: StoredRecord; readonly etag: string };

type WriteOutcome =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "refused" | "precondition-failed" };

const CONTENT_TYPE = "application/json";
const CACHE_MAX_AGE_SECONDS = 60;
const INTEGER = /^-?\d{1,16}$/u;

export type VercelBlobEphemeralInternals = {
	readonly sdk: VercelBlobSdk;
	readonly storeId: string | undefined;
	readonly namespace: VercelBlobNamespace;
	readonly now: () => number;
	read(pathname: string): Promise<Read | undefined>;
	remove(pathname: string, etag: string): Promise<boolean>;
};

export function vercelBlobInternals(
	options: VercelBlobEphemeralStateOptions,
): VercelBlobEphemeralInternals {
	const { sdk, storeId } = options;
	const namespace = parseVercelBlobNamespace(
		options.namespace ?? DEFAULT_VERCEL_BLOB_NAMESPACE,
	);
	const store = storeId === undefined ? {} : { storeId };
	return {
		sdk,
		storeId,
		namespace,
		now: options.now ?? Date.now,
		async read(pathname) {
			const result = await sdk.get(pathname, {
				...store,
				access: "private",
				useCache: false,
			});
			if (result === null) return undefined;
			if (result.statusCode !== 200) {
				throw new KvRedisCompatibleError(
					"EPHEMERAL_BACKEND_CONTRACT",
					"ephemeral blob read returned no body",
				);
			}
			const body = await new Response(result.stream).text();
			return { record: parseStoredRecord(body), etag: result.blob.etag };
		},
		async remove(pathname, etag) {
			try {
				await sdk.del(pathname, { ...store, ifMatch: etag });
				return true;
			} catch (error) {
				if (error instanceof Error && isBlobDeleteRefusal(error)) return false;
				throw error;
			}
		},
	};
}

export function createVercelBlobEphemeralState(
	options: VercelBlobEphemeralStateOptions,
): EphemeralStatePort {
	const internals = vercelBlobInternals(options);
	const { sdk, namespace, now, read, remove } = internals;
	const store =
		options.storeId === undefined ? {} : { storeId: options.storeId };
	const newIncarnation = () =>
		parseIncarnation(
			options.newIncarnation?.() ?? globalThis.crypto.randomUUID(),
		);
	const newWriteId = () =>
		parseWriteId(options.newWriteId?.() ?? globalThis.crypto.randomUUID());
	const readConcurrency = Math.max(1, options.readConcurrency ?? 8);
	const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 64);
	const baseDelayMs = options.retry?.baseDelayMs ?? 5;
	const maxDelayMs = options.retry?.maxDelayMs ?? 250;
	const sleep =
		options.retry?.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const random = options.retry?.random ?? Math.random;
	const pathOf = (key: EphemeralKey) => blobPathname(namespace, key);
	const isLive = (record: StoredRecord) => record.expiresAtMs > now();

	const backoff = (attempt: number) =>
		sleep(random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));

	async function write(
		pathname: string,
		record: StoredRecord,
		ifMatch: string | undefined,
	): Promise<WriteOutcome> {
		try {
			await sdk.put(pathname, encodeStoredRecord(record), {
				...store,
				access: "private",
				contentType: CONTENT_TYPE,
				addRandomSuffix: false,
				cacheControlMaxAge: CACHE_MAX_AGE_SECONDS,
				...(ifMatch === undefined
					? { allowOverwrite: false }
					: { allowOverwrite: true, ifMatch }),
			});
			return { ok: true };
		} catch (error) {
			const reason =
				error instanceof Error ? classifyBlobWriteError(error) : undefined;
			if (reason === undefined) throw error;
			return { ok: false, reason };
		}
	}

	async function contended<T>(
		operation: string,
		round: () => Promise<{ readonly done: T } | undefined>,
	): Promise<T> {
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			if (attempt > 0) await backoff(attempt);
			const outcome = await round();
			if (outcome !== undefined) return outcome.done;
		}
		throw new VercelBlobContentionError(operation, maxAttempts);
	}

	function ownWrites<T>() {
		const sent = new Map<string, T>();
		return {
			record(record: StoredRecord, result: T) {
				sent.set(record.writeId, result);
				return record;
			},
			landed(current: Read | undefined): { readonly done: T } | undefined {
				const result =
					current === undefined ? undefined : sent.get(current.record.writeId);
				return result === undefined ? undefined : { done: result };
			},
		};
	}

	return {
		async get(key) {
			const current = await read(pathOf(key));
			return current !== undefined && isLive(current.record)
				? entryOf(current.record)
				: undefined;
		},

		async getMany(keys) {
			if (keys.length === 0) return [];
			const unique = [...new Set(keys)];
			const found = new Map<string, EphemeralEntry | undefined>();
			let next = 0;
			const worker = async () => {
				while (next < unique.length) {
					const key = unique[next];
					next += 1;
					if (key === undefined) continue;
					const current = await read(pathOf(key));
					found.set(
						key,
						current !== undefined && isLive(current.record)
							? entryOf(current.record)
							: undefined,
					);
				}
			};
			await Promise.all(
				Array.from(
					{ length: Math.min(readConcurrency, unique.length) },
					worker,
				),
			);
			return keys.map((key) => found.get(key));
		},

		async putIfAbsent(key, value, ttlMs) {
			const pathname = pathOf(key);
			const mine = ownWrites<EphemeralWrite>();
			const fresh = () => {
				const record: StoredRecord = {
					value,
					incarnation: newIncarnation(),
					revision: 1,
					expiresAtMs: now() + ttlMs,
					writeId: newWriteId(),
				};
				return mine.record(record, {
					applied: true,
					version: versionOf(record),
				});
			};
			let create = true;
			return contended("putIfAbsent", async () => {
				if (create) {
					const record = fresh();
					const outcome = await write(pathname, record, undefined);
					if (outcome.ok) {
						return { done: { applied: true, version: versionOf(record) } };
					}
					create = false;
				}
				const current = await read(pathname);
				const landed = mine.landed(current);
				if (landed !== undefined) return landed;
				if (current === undefined) {
					create = true;
					return undefined;
				}
				if (isLive(current.record)) return { done: { applied: false } };
				const record = fresh();
				const outcome = await write(pathname, record, current.etag);
				return outcome.ok
					? { done: { applied: true, version: versionOf(record) } }
					: undefined;
			});
		},

		async compareAndSet(key, expected, value, ttlMs) {
			const pathname = pathOf(key);
			const mine = ownWrites<EphemeralWrite>();
			return contended("compareAndSet", async () => {
				const current = await read(pathname);
				const landed = mine.landed(current);
				if (landed !== undefined) return landed;
				if (
					current === undefined ||
					!isLive(current.record) ||
					versionOf(current.record) !== expected
				) {
					return { done: { applied: false } };
				}
				const record: StoredRecord = {
					value,
					incarnation: current.record.incarnation,
					revision: current.record.revision + 1,
					expiresAtMs: now() + ttlMs,
					writeId: newWriteId(),
				};
				const result: EphemeralWrite = {
					applied: true,
					version: versionOf(record),
				};
				mine.record(record, result);
				const outcome = await write(pathname, record, current.etag);
				return outcome.ok ? { done: result } : undefined;
			});
		},

		async delete(key, expected?: EphemeralVersion) {
			const pathname = pathOf(key);
			return contended("delete", async () => {
				const current = await read(pathname);
				if (current === undefined) return { done: false };
				if (!isLive(current.record)) {
					await remove(pathname, current.etag);
					return { done: false };
				}
				if (expected !== undefined && versionOf(current.record) !== expected) {
					return { done: false };
				}
				return (await remove(pathname, current.etag))
					? { done: true }
					: undefined;
			});
		},

		async increment(key, by, ttlMs, mode: IncrementTtlMode = "on-create") {
			const step = parseIncrementBy(by);
			const pathname = pathOf(key);
			const mine = ownWrites<number>();
			return contended("increment", async () => {
				const current = await read(pathname);
				const landed = mine.landed(current);
				if (landed !== undefined) return landed;
				let record: StoredRecord;
				let result: number;
				if (current === undefined || !isLive(current.record)) {
					result = step;
					record = {
						value: String(step),
						incarnation: newIncarnation(),
						revision: 1,
						expiresAtMs: now() + ttlMs,
						writeId: newWriteId(),
					};
				} else {
					const stored = current.record.value;
					result = INTEGER.test(stored) ? Number(stored) + step : Number.NaN;
					if (!Number.isSafeInteger(result)) {
						throw new KvRedisCompatibleError(
							"EPHEMERAL_BACKEND_REJECTED",
							"ephemeral increment was rejected: the stored value is not an integer, or the sum leaves the safe integer range",
						);
					}
					record = {
						value: String(result),
						incarnation: current.record.incarnation,
						revision: current.record.revision + 1,
						expiresAtMs:
							mode === "refresh" ? now() + ttlMs : current.record.expiresAtMs,
						writeId: newWriteId(),
					};
				}
				mine.record(record, result);
				const outcome = await write(pathname, record, current?.etag);
				return outcome.ok ? { done: result } : undefined;
			});
		},

		async expire(key, ttlMs: EphemeralTtlMs) {
			const pathname = pathOf(key);
			const mine = ownWrites<boolean>();
			return contended("expire", async () => {
				const current = await read(pathname);
				const landed = mine.landed(current);
				if (landed !== undefined) return landed;
				if (current === undefined || !isLive(current.record)) {
					return { done: false };
				}
				const record = mine.record(
					{
						...current.record,
						expiresAtMs: now() + ttlMs,
						writeId: newWriteId(),
					},
					true,
				);
				const outcome = await write(pathname, record, current.etag);
				return outcome.ok ? { done: true } : undefined;
			});
		},
	};
}
