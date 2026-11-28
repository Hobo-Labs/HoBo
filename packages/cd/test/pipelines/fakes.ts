import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventPosition,
	JsonObject,
	JsonValue,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
} from "@hobo/core";
import type {
	CampId,
	CdAction,
	CdAuthorizer,
	CdContext,
	FreightId,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	TelemetrySink,
} from "../../src/ports.js";
import { isJsonString } from "../../src/windows/journal.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

export function camp(id: string): CampId {
	// SAFETY: test fixture ids are literal Camp ids.
	return id as CampId;
}

export function fid(id: string): FreightId {
	// SAFETY: test fixture ids are literal Freight ids.
	return id as FreightId;
}

export type Clock = {
	now: () => number;
	advance: (ms: number) => void;
	set: (ms: number) => void;
};

export function clock(start = T0): Clock {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
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
	constructor(private readonly now: () => number = () => T0) {}
	failNextAppend = 0;

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		if (this.failNextAppend > 0) {
			this.failNextAppend -= 1;
			throw new Error(
				`expected seq ${opts.expectedSeq} lost a race on ${streamId}`,
			);
		}
		const stream = this.streams.get(streamId) ?? [];
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing = isJsonString(key)
				? stream.find((event) => event.meta?.idempotencyKey === key)
				: undefined;
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length)
			throw new Error(
				`expected seq ${opts.expectedSeq} but ${streamId} is at ${stream.length}`,
			);
		const appended: EventEnvelope[] = [];
		let firstPosition: EventPosition | undefined;
		let lastPosition: EventPosition | undefined;
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
			firstPosition ??= position;
			lastPosition = position;
		}
		this.streams.set(streamId, stream);
		const result: AppendResult = { streamId, appended, deduped };
		if (firstPosition !== undefined) result.firstPosition = firstPosition;
		if (lastPosition !== undefined) result.lastPosition = lastPosition;
		return result;
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

	async seed(
		streamId: string,
		type: string,
		data: JsonValue,
		actor: PrincipalRef = OPERATOR,
	): Promise<void> {
		const stream = this.streams.get(streamId) ?? [];
		await this.append(streamId, [{ type, data }], {
			expectedSeq: stream.length,
			actor,
			tenant: TENANT,
		});
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

export class RecordingAuthorizer implements CdAuthorizer {
	readonly calls: {
		action: CdAction;
		subject: JsonObject;
		principal: PrincipalRef;
	}[] = [];
	readonly deny = new Set<CdAction>();
	private decisions = 0;

	async authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>> {
		this.calls.push({ action, subject, principal: ctx.principal });
		if (this.deny.has(action)) return { ok: false, reasons: [] };
		this.decisions += 1;
		return {
			ok: true,
			value: {
				decisionId: `dec-${this.decisions}`,
				proposalOnly: ctx.principal.kind === "agent",
			},
		};
	}
}

export class RecordingTelemetry implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	async spans(_spans: readonly OtelSpan[]): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	named(name: string): OtelMetricPoint[] {
		return this.points.filter((point) => point.name === name);
	}
}
