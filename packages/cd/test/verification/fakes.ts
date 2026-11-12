// Test doubles and builders for the WP9 verification tests. Each double models
// a frozen port (ports.ts, @hobo/core); none is reachable from production code.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
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
	JsonObject,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
	TransportRequest,
	TransportResponse,
} from "@hobo/core";
import {
	Aggregation,
	type Cohort,
	Comparator,
	Direction,
	HealthQueryRecordSchema,
	HealthSourceKind,
	Sensitivity,
	VerificationSpecRecordSchema,
} from "../../src/_generated/cd_pb.js";
import type {
	CampId,
	CdContext,
	CredentialResolver,
	FreightId,
	HealthSamples,
	HealthSource,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	TelemetrySink,
	VerifyPort,
} from "../../src/ports.js";
import { refuse } from "../../src/verification/reasons.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const MINUTE = 60_000;
export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };

export function camp(id: string): CampId {
	// SAFETY: test fixture ids are literal Camp ids.
	return id as CampId;
}

export function fid(id: string): FreightId {
	// SAFETY: test fixture ids are literal Freight ids.
	return id as FreightId;
}

export function clock(start = T0) {
	let current = start;
	return {
		now: () => current,
		set: (ms: number) => {
			current = ms;
		},
		advance: (ms: number) => {
			current += ms;
		},
	};
}

export function context(
	now: () => number,
	principal: PrincipalRef = OPERATOR,
): CdContext {
	return { tenant: TENANT, principal, now };
}

/** In-memory DurableEventStore: per-stream expected-seq CAS and idempotency-key dedup. */
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
			const existing =
				typeof key === "string"
					? stream.find((event) => event.meta?.idempotencyKey === key)
					: undefined;
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length) {
			throw new Error(
				`expected seq ${opts.expectedSeq} but stream ${streamId} is at ${stream.length}`,
			);
		}
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
			if (options.tenant !== undefined && entry.event.tenant !== options.tenant)
				continue;
			if (
				options.filter?.type !== undefined &&
				entry.event.type !== options.filter.type
			)
				continue;
			if (
				options.filter?.streamId !== undefined &&
				entry.event.streamId !== options.filter.streamId
			)
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

	streamIds(): readonly string[] {
		return [...this.streams.keys()];
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
	named(name: string): readonly OtelMetricPoint[] {
		return this.points.filter((point) => point.name === name);
	}
}

type Series = (
	input: Readonly<{
		query: string;
		cohort: Cohort;
		fromMs: number;
		toMs: number;
	}>,
) => Outcome<HealthSamples> | "throw";

/** A health source whose answers the test scripts per query and cohort. */
export class ScriptedHealthSource implements HealthSource {
	calls: Array<
		Readonly<{ query: string; cohort: Cohort; fromMs: number; toMs: number }>
	> = [];
	constructor(
		readonly kind: HealthSourceKind,
		private readonly series: Series,
	) {}
	async query(
		input: Parameters<HealthSource["query"]>[0],
	): Promise<Outcome<HealthSamples>> {
		const call = {
			query: input.query.query,
			cohort: input.cohort,
			fromMs: input.fromMs,
			toMs: input.toMs,
		};
		this.calls.push(call);
		const answer = this.series(call);
		if (answer === "throw") throw new Error("source exploded");
		return answer;
	}
}

export function samples(
	values: readonly number[],
	fromMs = T0,
	toMs = T0 + 10 * MINUTE,
): Outcome<HealthSamples> {
	return { ok: true, value: { values, fromMs, toMs } };
}

export const unavailable = (): Outcome<HealthSamples> =>
	refuse("health-source-http-error", "503 from source");

export class RecordingVerifyPort implements VerifyPort {
	calls: Array<Readonly<{ suite: string; campId: string; freightId: string }>> =
		[];
	constructor(private readonly ok: (suite: string) => boolean = () => true) {}
	async run(
		input: Readonly<{ suite: string; campId: CampId; freightId: FreightId }>,
	): Promise<Outcome<JsonObject>> {
		this.calls.push({
			suite: input.suite,
			campId: input.campId,
			freightId: input.freightId,
		});
		return this.ok(input.suite)
			? { ok: true, value: { passed: 12 } }
			: refuse("verification-suite-failed", "2 failed");
	}
}

/** HttpTransport double: routes by URL prefix, records every request. */
export class ScriptedTransport {
	readonly requests: TransportRequest[] = [];
	constructor(
		private readonly route: (
			request: TransportRequest,
		) => TransportResponse | "throw",
	) {}
	readonly transport: HttpTransport = async (request) => {
		this.requests.push(request);
		const response = this.route(request);
		if (response === "throw") throw new Error("connection reset");
		return response;
	};
}

export function json(status: number, body: unknown): TransportResponse {
	return {
		status,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

export class MapCredentials implements CredentialResolver {
	readonly resolved: Array<Readonly<{ ref: string; scope: string }>> = [];
	constructor(
		private readonly values: Readonly<
			Record<string, Readonly<Record<string, string>>>
		>,
	) {}
	async resolve(
		ref: string,
		scope: string,
	): Promise<Readonly<Record<string, string>>> {
		this.resolved.push({ ref, scope });
		const value = this.values[ref];
		if (!value) throw new Error(`no credential ${ref}`);
		return value;
	}
}

export function query(
	name: string,
	fields: MessageInitShape<typeof HealthQueryRecordSchema> = {},
) {
	return create(HealthQueryRecordSchema, {
		name,
		source: HealthSourceKind.PROMETHEUS,
		endpointRef: "https://prometheus.example.com",
		query: `sum by (track) (${name})`,
		cohortLabel: "track",
		...fields,
	});
}

/** A ten-minute spec with an error-rate threshold. */
export function thresholdSpec(
	overrides: MessageInitShape<typeof VerificationSpecRecordSchema> = {},
) {
	return create(VerificationSpecRecordSchema, {
		windowMs: BigInt(10 * MINUTE),
		requiredObservations: 3,
		progressDeadlineMs: BigInt(30 * MINUTE),
		failOnNoData: true,
		thresholds: [
			{
				query: query("error_rate", { unit: "ratio" }),
				aggregation: Aggregation.MEAN,
				comparator: Comparator.LT,
				value: 0.05,
			},
		],
		...overrides,
	});
}

/** A ten-minute spec with a latency canary-vs-baseline comparison. */
export function comparisonSpec(
	overrides: MessageInitShape<typeof VerificationSpecRecordSchema> = {},
) {
	return create(VerificationSpecRecordSchema, {
		windowMs: BigInt(10 * MINUTE),
		requiredObservations: 3,
		progressDeadlineMs: BigInt(30 * MINUTE),
		failOnNoData: true,
		comparisons: [
			{
				query: query("latency_ms"),
				direction: Direction.HIGHER_IS_WORSE,
				sensitivity: Sensitivity.MEDIUM,
				minSamples: 8,
			},
		],
		...overrides,
	});
}
