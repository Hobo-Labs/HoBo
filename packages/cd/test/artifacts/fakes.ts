// Test doubles for the WP3 artifact store, verifier and provenance tests.
// Each models a frozen port (ports.ts, @hobo/core eventstore/http-transport);
// none is reachable from production code.
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventPosition,
	HttpTransport,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import { parseDigest } from "../../src/artifacts/digest.js";
import { isJsonString, type JsonValue } from "../../src/artifacts/json.js";
import type {
	CdContext,
	CredentialResolver,
	Digest,
	OtelMetricPoint,
	OtelSpan,
	TelemetrySink,
} from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };

export function context(now: () => number = () => T0): CdContext {
	return { tenant: TENANT, principal: OPERATOR, now };
}

/** A digest the test knows is well-formed, parsed (never asserted) into the brand. */
export function pinned(value: string): Digest {
	const digest = parseDigest(value);
	if (digest === undefined) throw new Error(`not a sha256 digest: ${value}`);
	return digest;
}

export function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

/**
 * In-memory DurableEventStore with the conformance-suite semantics the
 * journal relies on: expected-seq CAS (a stale expectedSeq throws) and
 * per-stream idempotency-key dedup checked before the CAS.
 */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	private readonly all: PositionedEvent[] = [];
	private nextId = 1;

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
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
				`expected seq ${opts.expectedSeq} but stream ${streamId} is at ${stream.length}`,
			);
		const appended: EventEnvelope[] = [];
		for (const input of fresh) {
			const envelope: EventEnvelope = {
				id: `evt-${this.nextId}`,
				type: input.type,
				v: input.v ?? 1,
				streamId,
				seq: stream.length + 1,
				ts: new Date(T0).toISOString(),
				actor: opts.actor,
				tenant: opts.tenant,
				data: structuredClone(input.data),
			};
			if (input.meta) envelope.meta = input.meta;
			// SAFETY: test double; positions come from a monotonic counter.
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
		for (const entry of this.all) {
			if (options.after !== undefined && entry.position <= options.after)
				continue;
			yield entry;
		}
	}

	subscribe(
		_filter: StreamFilter,
		_handler: (event: EventEnvelope) => void,
	): Subscription {
		return { unsubscribe: () => undefined };
	}

	async snapshot(
		streamId: string,
		state: never,
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

	events(streamId: string): readonly EventEnvelope[] {
		return this.streams.get(streamId) ?? [];
	}

	allEvents(): readonly EventEnvelope[] {
		return this.all.map((entry) => entry.event);
	}
}

export class RecordingTelemetry implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	readonly recordedSpans: OtelSpan[] = [];
	async spans(spans: readonly OtelSpan[]): Promise<void> {
		this.recordedSpans.push(...spans);
	}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	count(name: string, match: Readonly<Record<string, string>> = {}): number {
		return this.points
			.filter(
				(point) =>
					point.name === name &&
					Object.entries(match).every(
						([key, value]) => point.attributes[key] === value,
					),
			)
			.reduce((sum, point) => sum + point.value, 0);
	}
}

export type Route = (
	request: TransportRequest,
) => TransportResponse | undefined;

/** HttpTransport double: answers from routes in order, records every request. */
export class ScriptedTransport {
	readonly requests: TransportRequest[] = [];
	private readonly routes: Route[] = [];

	route(route: Route): this {
		this.routes.push(route);
		return this;
	}

	on(method: string, url: string, response: Partial<TransportResponse>): this {
		return this.route((request) =>
			request.method === method && request.url === url
				? { status: 200, headers: {}, body: "", ...response }
				: undefined,
		);
	}

	readonly http: HttpTransport = async (request) => {
		this.requests.push(request);
		for (const route of this.routes) {
			const response = route(request);
			if (response !== undefined) return response;
		}
		return { status: 404, headers: {}, body: "" };
	};
}

export function json(status: number, value: JsonValue): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	};
}

export class StaticCredentials implements CredentialResolver {
	readonly calls: { ref: string; scope: string }[] = [];
	constructor(private readonly values: Readonly<Record<string, string>>) {}
	async resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>> {
		this.calls.push({ ref, scope });
		return this.values;
	}
}
