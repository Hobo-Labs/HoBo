import { CoreParseError } from "../errors.js";
import type { JsonValue } from "../json.js";

// public-contract: version tag a binding reports so a host can refuse a mismatch.
export const EPHEMERAL_STATE_PORT_CONTRACT_VERSION =
	"hobo.core.ephemeral-state/v1" as const;

export const EPHEMERAL_STATE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const EPHEMERAL_STATE_MAX_KEY_LENGTH = 512;
export const EPHEMERAL_STATE_MAX_VERSION_LENGTH = 128;

export type EphemeralKey = string & { readonly __brand: "EphemeralKey" };
export type EphemeralVersion = string & {
	readonly __brand: "EphemeralVersion";
};
export type EphemeralTtlMs = number & { readonly __brand: "EphemeralTtlMs" };

// domain-view: parse-don't-validate entry carrying the branded version; its generated ephemeral_state_pb.ts EphemeralEntry is the wire form.
export interface EphemeralEntry {
	readonly value: string;
	readonly version: EphemeralVersion;
}

export type EphemeralWrite =
	| { readonly applied: true; readonly version: EphemeralVersion }
	| { readonly applied: false };

export type IncrementTtlMode = "on-create" | "refresh";

export interface EphemeralStatePort {
	get(key: EphemeralKey): Promise<EphemeralEntry | undefined>;
	getMany(
		keys: readonly EphemeralKey[],
	): Promise<readonly (EphemeralEntry | undefined)[]>;
	putIfAbsent(
		key: EphemeralKey,
		value: string,
		ttlMs: EphemeralTtlMs,
	): Promise<EphemeralWrite>;
	compareAndSet(
		key: EphemeralKey,
		expected: EphemeralVersion,
		value: string,
		ttlMs: EphemeralTtlMs,
	): Promise<EphemeralWrite>;
	delete(key: EphemeralKey, expected?: EphemeralVersion): Promise<boolean>;
	increment(
		key: EphemeralKey,
		by: number,
		ttlMs: EphemeralTtlMs,
		mode?: IncrementTtlMode,
	): Promise<number>;
	expire(key: EphemeralKey, ttlMs: EphemeralTtlMs): Promise<boolean>;
}

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
	"ring.append": 3,
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

export async function releaseEphemeralLock(
	port: EphemeralStatePort,
	lease: EphemeralLockLease,
): Promise<boolean> {
	return port.delete(lease.key, lease.version);
}

export const EPHEMERAL_RING_MAX_CAPACITY = 10_000;
const RING_NAME = /^[\x21-\x7a\x7c\x7e]{1,128}$/u;

export interface EphemeralRingOptions {
	readonly name: string;
	readonly capacity: number;
	readonly ttlMs: EphemeralTtlMs;
}

// domain-view: entry with a numeric sequence; its generated ephemeral_state_pb.ts EphemeralRingEntry is the wire form.
export interface EphemeralRingEntry {
	readonly seq: number;
	readonly value: string;
}

// domain-view: read window over the ring; its generated ephemeral_state_pb.ts EphemeralRingRead is the wire form.
export interface EphemeralRingRead {
	readonly entries: readonly EphemeralRingEntry[];
	readonly head: number;
	readonly next: number;
	readonly gaps: readonly number[];
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
