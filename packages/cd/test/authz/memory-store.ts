// In-memory DurableEventStore for the WP19 tests (authz + telemetry), with the
// conformance-suite semantics the authorizer and the telemetry projections rely
// on: per-stream expected-seq CAS, per-stream idempotency-key dedup checked
// before the CAS, global positions, `readAll` filtered by type/stream/tenant,
// and an injected clock for envelope timestamps. Test-only.
import {
	type AppendOptions,
	type AppendResult,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	type PrincipalRef,
	type ReadAllOptions,
	type SnapshotRecord,
	type StreamFilter,
	type Subscription,
} from "@hobo/core";
import type { CampId, CdContext } from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const APPROVER: PrincipalRef = { kind: "user", id: "lead@acme" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

export function camp(id: string): CampId {
	// SAFETY: test fixture ids are literal Camp ids.
	return id as CampId;
}

export type Clock = { now: () => number; set: (ms: number) => void };

export function clock(start = T0): Clock {
	let current = start;
	return {
		now: () => current,
		set: (ms) => {
			current = ms;
		},
	};
}

export function context(
	now: () => number,
	principal: PrincipalRef = OPERATOR,
): CdContext {
	return { tenant: TENANT, principal, now };
}

export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	readonly all: PositionedEvent[] = [];
	private nextId = 1;
	/** When set, the next append throws this error once (fault injection). */
	failNextAppend: Error | undefined;
	/** When > 0, that many appends fail with a sequence conflict first. */
	conflictsBeforeAppend = 0;

	constructor(private readonly now: () => number = () => T0) {}

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		if (this.failNextAppend) {
			const error = this.failNextAppend;
			this.failNextAppend = undefined;
			throw error;
		}
		const stream = this.streams.get(streamId) ?? [];
		if (this.conflictsBeforeAppend > 0) {
			this.conflictsBeforeAppend -= 1;
			throw new OptimisticSequenceConflictError(
				streamId,
				opts.expectedSeq,
				stream.length + 1,
			);
		}
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing =
				key === undefined
					? undefined
					: stream.find((event) => event.meta?.idempotencyKey === key);
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length)
			throw new OptimisticSequenceConflictError(
				streamId,
				opts.expectedSeq,
				stream.length,
			);
		const appended: EventEnvelope[] = [];
		for (const input of fresh) {
			const envelope: EventEnvelope = {
				id: `evt-${this.nextId}`,
				type: input.type,
				v: input.v ?? 1,
				streamId,
				seq: stream.length + 1,
				ts: new Date(this.now()).toISOString(),
				actor: opts.actor,
				tenant: opts.tenant,
				data: structuredClone(input.data),
			};
			if (input.meta) envelope.meta = input.meta;
			// SAFETY: test double; positions are minted from a monotonic counter.
			const position = BigInt(this.nextId) as EventPosition;
			this.nextId += 1;
			stream.push(envelope);
			this.all.push({ position, event: envelope });
			appended.push(envelope);
		}
		this.streams.set(streamId, stream);
		return { streamId, appended, deduped };
	}

	async *read(streamId: string, fromSeq = 0): AsyncIterable<EventEnvelope> {
		for (const event of this.streams.get(streamId) ?? [])
			if (event.seq > fromSeq) yield event;
	}

	async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
		let count = 0;
		for (const item of this.all.slice()) {
			if (options.after !== undefined && item.position <= options.after)
				continue;
			if (options.tenant && item.event.tenant !== options.tenant) continue;
			if (options.filter?.type && item.event.type !== options.filter.type)
				continue;
			if (
				options.filter?.streamId &&
				item.event.streamId !== options.filter.streamId
			)
				continue;
			if (options.limit !== undefined && count >= options.limit) return;
			count += 1;
			yield item;
		}
	}

	stream(streamId: string): EventEnvelope[] {
		return [...(this.streams.get(streamId) ?? [])];
	}

	events(type: string): EventEnvelope[] {
		return this.all
			.filter((item) => item.event.type === type)
			.map((item) => item.event);
	}

	subscribe(
		_filter: StreamFilter,
		_handler: (event: EventEnvelope) => void,
	): Subscription {
		return { unsubscribe: () => undefined };
	}

	async snapshot(
		streamId: string,
		state: SnapshotRecord["state"],
		seq: number,
	): Promise<SnapshotRecord> {
		return { streamId, seq, state, savedAt: new Date(T0).toISOString() };
	}

	async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
		const result = await this.append(
			request.streamId,
			[...request.events],
			request.append,
		);
		return { ...result, effects: [] };
	}
}
