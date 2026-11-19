import { isDeepStrictEqual } from "node:util";
import type {
	ActorHost,
	ActorLease,
	ActorStateHandle,
	FoldEvent,
} from "@hobo/core";
import { mustGet } from "@hobo/core/total-access";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";

export const ACTOR_HOST_RUNTIME_PORT_VERSION =
	"hobo.actor-host-runtime-port/v1";

export type ActorHostLease = ActorLease;
export type ActorHostState<S = unknown> = ActorStateHandle<S>;
export type ActorHostPort = ActorHost;

export class LeaseConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseConflictError";
	}
}

export class LeaseExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LeaseExpiredError";
	}
}

export class StaleFenceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StaleFenceError";
	}
}

interface ManualClock {
	now(): string;
	nowMs(): number;
	advance(deltaMs: number): string;
}

export function createManualActorClock(
	startInstant = "2026-06-25T00:00:00.000Z",
): ManualClock {
	let nowMs = normalizeInstantMs(startInstant, "startInstant");

	return Object.freeze({
		now() {
			return new Date(nowMs).toISOString();
		},
		nowMs() {
			return nowMs;
		},
		advance(deltaMs: number) {
			if (!Number.isInteger(deltaMs) || deltaMs < 0) {
				throw new TypeError("deltaMs must be a non-negative integer");
			}
			nowMs += deltaMs;
			return this.now();
		},
	});
}

export function createInMemoryActorHost(
	options: { clock?: ManualClock; leaseTtlMs?: number } = {},
) {
	const clock = options.clock ?? createManualActorClock();
	const leaseTtlMs = requirePositiveInteger(
		options.leaseTtlMs ?? 30_000,
		"options.leaseTtlMs",
	);
	const leases = new Map<string, LeaseRecord>();
	const leaseRecords = new WeakMap<ActorHostLease, LeaseRecord>();
	const streams = new Map<string, ActorStream>();

	const port: ActorHostPort = Object.freeze({
		acquire(key: string, request: { holderId: string }) {
			const actorKey = requireNonEmptyString(key, "key");
			const holderId = requireNonEmptyString(
				request.holderId,
				"request.holderId",
			);
			const nowMs = clock.nowMs();
			const current = leases.get(actorKey);

			if (current && !current.released && current.expiresAtMs > nowMs) {
				throw new LeaseConflictError(
					`lease conflict for ${actorKey}: held by ${current.holderId} until ${formatInstant(current.expiresAtMs)}`,
				);
			}

			const next: LeaseRecord = {
				key: actorKey,
				holderId,
				fenceToken: (current?.fenceToken ?? 0n) + 1n,
				expiresAtMs: nowMs + leaseTtlMs,
				released: false,
			};
			leases.set(actorKey, next);

			return createLeaseFacade(next, {
				clock,
				leaseTtlMs,
				leases,
				leaseRecords,
			});
		},

		state<S>(
			key: string,
			request: {
				initialState: S;
				fold: (state: S, event: FoldEvent) => S;
				snapshotKey?: object;
			},
		) {
			const actorKey = requireNonEmptyString(key, "key");
			if (!(request.fold instanceof Function)) {
				throw new TypeError("request.fold must be a function");
			}
			if (!("initialState" in request)) {
				throw new TypeError("request.initialState is required");
			}

			return new DurableActorState<S>({
				key: actorKey,
				fold: request.fold,
				snapshotKey: request.snapshotKey ?? request.fold,
				initialState: structuredClone(request.initialState),
				stream: getStream(streams, actorKey),
				clock,
				validateLease(lease) {
					return validateLeaseForAppend(
						leases,
						leaseRecords,
						clock,
						actorKey,
						lease,
					);
				},
			});
		},
	});

	return port;
}

type LeaseRecord = {
	key: string;
	holderId: string;
	fenceToken: bigint;
	expiresAtMs: number;
	released: boolean;
};

type ActorStream = {
	events: FoldEvent[];
	snapshot: {
		seq: number;
		state: unknown;
		initialState: unknown;
		key: object;
	} | null;
};

class DurableActorState<S> implements ActorHostState<S> {
	readonly key: string;
	readonly #fold: (state: S, event: FoldEvent) => S;
	readonly #initialState: S;
	readonly #snapshotKey: object;
	readonly #stream: ActorStream;
	readonly #clock: ManualClock;
	readonly #validateLease: (lease: ActorHostLease) => LeaseRecord;

	constructor(options: {
		key: string;
		fold: (state: S, event: FoldEvent) => S;
		initialState: S;
		snapshotKey: object;
		stream: ActorStream;
		clock: ManualClock;
		validateLease: (lease: ActorHostLease) => LeaseRecord;
	}) {
		this.key = options.key;
		this.#fold = options.fold;
		this.#initialState = options.initialState;
		this.#snapshotKey = options.snapshotKey;
		this.#stream = options.stream;
		this.#clock = options.clock;
		this.#validateLease = options.validateLease;
	}

	append(lease: ActorHostLease, event: FoldEvent) {
		const leaseRecord = this.#validateLease(lease);
		const body = normalizeEvent(event);
		const seq = this.#stream.events.length + 1;
		const record: FoldEvent = Object.freeze({
			...body,
			apiVersion: ACTOR_HOST_RUNTIME_PORT_VERSION,
			streamId: this.key,
			seq,
			holderId: leaseRecord.holderId,
			appendedAt: this.#clock.now(),
		});
		this.#stream.events.push(record);
		return {
			streamId: this.key,
			seq,
			fenceToken: leaseRecord.fenceToken,
		};
	}

	read() {
		const stored = this.#stream.snapshot;
		const snapshot =
			stored &&
			stored.key === this.#snapshotKey &&
			isDeepStrictEqual(stored.initialState, this.#initialState)
				? stored
				: null;
		const snapshotSeq = snapshot?.seq ?? 0;
		let state = snapshot
			? (structuredClone(snapshot.state) as S)
			: structuredClone(this.#initialState);
		const tail = this.#stream.events.filter(
			(event) => Number(event.seq) > snapshotSeq,
		);

		for (const event of tail) {
			state = this.#fold(state, structuredClone(event));
		}

		return {
			streamId: this.key,
			seq: this.#stream.events.length,
			state,
		};
	}

	passivate(lease: ActorHostLease) {
		this.#validateLease(lease);
		const projection = this.read();
		this.#validateLease(lease);
		this.#stream.snapshot = {
			seq: projection.seq,
			state: structuredClone(projection.state),
			initialState: structuredClone(this.#initialState),
			key: this.#snapshotKey,
		};
		lease.release();
		return projection;
	}
}

function createLeaseFacade(
	record: LeaseRecord,
	ctx: {
		clock: ManualClock;
		leaseTtlMs: number;
		leases: Map<string, LeaseRecord>;
		leaseRecords: WeakMap<ActorHostLease, LeaseRecord>;
	},
): ActorHostLease {
	const lease: ActorHostLease = Object.freeze({
		key: record.key,
		holderId: record.holderId,
		fenceToken: record.fenceToken,
		get expiresAt() {
			return formatInstant(record.expiresAtMs);
		},
		renew() {
			const current = ctx.leases.get(record.key);
			if (!sameLease(current, record)) {
				throw new StaleFenceError(
					`stale fence for ${record.key}: ${record.fenceToken.toString()}`,
				);
			}
			if (record.expiresAtMs <= ctx.clock.nowMs()) {
				throw new LeaseExpiredError(
					`expired lease for ${record.key}: ${record.fenceToken.toString()}`,
				);
			}
			record.expiresAtMs = ctx.clock.nowMs() + ctx.leaseTtlMs;
			return lease;
		},
		release() {
			const current = ctx.leases.get(record.key);
			if (sameLease(current, record)) {
				record.released = true;
			}
		},
	});
	ctx.leaseRecords.set(lease, record);
	return lease;
}

function validateLeaseForAppend(
	leases: Map<string, LeaseRecord>,
	leaseRecords: WeakMap<ActorHostLease, LeaseRecord>,
	clock: ManualClock,
	key: string,
	lease: ActorHostLease,
) {
	const leaseRecord = leaseRecords.get(lease);
	if (!leaseRecord || leaseRecord.key !== key) {
		throw new StaleFenceError(`stale fence for ${key}: lease key mismatch`);
	}

	const current = leases.get(key);
	if (!sameLease(current, leaseRecord)) {
		throw new StaleFenceError(
			`stale fence for ${key}: ${leaseRecord.fenceToken.toString()}`,
		);
	}
	if (!current || current.released || current.expiresAtMs <= clock.nowMs()) {
		throw new LeaseExpiredError(
			`expired lease for ${key}: ${leaseRecord.fenceToken.toString()}`,
		);
	}
	return leaseRecord;
}

function sameLease(current: LeaseRecord | undefined, record: LeaseRecord) {
	return Boolean(
		current &&
			current.key === record.key &&
			current.holderId === record.holderId &&
			current.fenceToken === record.fenceToken,
	);
}

function getStream(streams: Map<string, ActorStream>, key: string) {
	if (!streams.has(key)) {
		streams.set(key, { events: [], snapshot: null });
	}
	return mustGet(streams, key);
}

function normalizeEvent(event: FoldEvent) {
	if (!event || !isJsonObject(event) || Array.isArray(event)) {
		throw new TypeError("event must be an object");
	}
	const type = requireNonEmptyString(event.type, "event.type");
	return Object.freeze({
		...structuredClone(event),
		type,
	});
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string`);
	}
	return value;
}

function requirePositiveInteger(value: number, fieldName: string) {
	if (!Number.isInteger(value) || value <= 0) {
		throw new TypeError(`${fieldName} must be a positive integer`);
	}
	return value;
}

function normalizeInstantMs(value: string, fieldName: string) {
	const timestamp = Date.parse(value);
	if (!isJsonString(value) || Number.isNaN(timestamp)) {
		throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
	}
	return timestamp;
}

function formatInstant(timestampMs: number) {
	return new Date(timestampMs).toISOString();
}
