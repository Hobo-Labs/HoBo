// Test doubles for the WP22 inventory and placement tests. Each models the
// frozen port it stands in for (ports.ts, @hobo/core eventstore); none is
// reachable from production code.
import { create } from "@bufbuild/protobuf";
import {
	type AppendOptions,
	type AppendResult,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	type JsonObject,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	type PrincipalRef,
	type ReadAllOptions,
	type SnapshotRecord,
	type StreamFilter,
	type Subscription,
} from "@hobo/core";
import {
	CampManagement,
	type RailDeliveryRecord,
	RailDeliveryRecordSchema,
	RailFailoverRecordSchema,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type {
	CampId,
	CampTopology,
	CdAction,
	CdAuthorizer,
	CdContext,
	DesiredStateReader,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	RailDeliveryReader,
	TelemetrySink,
	TopologyReader,
} from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const STATION: PrincipalRef = { kind: "service", id: "station-eu" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

/** Brand a Camp id in a test. */
export function camp(id: string): CampId {
	// SAFETY: test fixture ids are literal Camp ids.
	return id as CampId;
}

export function clock(start = T0) {
	let current = start;
	return {
		now: () => current,
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

/**
 * In-memory DurableEventStore with conformance-suite semantics: per-stream
 * expected-seq CAS (a stale expectedSeq throws the core conflict error) and
 * per-stream idempotency-key dedup checked before the CAS.
 */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	private readonly all: PositionedEvent[] = [];
	private nextId = 1;
	appendCalls = 0;
	/** Test hook: run before the CAS check of the next append (simulates a concurrent writer). */
	beforeAppend: (() => Promise<void>) | undefined;

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		this.appendCalls += 1;
		const hook = this.beforeAppend;
		this.beforeAppend = undefined;
		if (hook) await hook();
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
			throw new OptimisticSequenceConflictError(
				streamId,
				opts.expectedSeq,
				stream.length,
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
			if (input.meta) envelope.meta = structuredClone(input.meta);
			// SAFETY: test double; positions are minted here from a monotonic counter.
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
		for (const event of [...(this.streams.get(streamId) ?? [])]) {
			if (event.seq > fromSeq) yield event;
		}
	}

	async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
		let yielded = 0;
		for (const entry of [...this.all]) {
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
			if (options.limit !== undefined && yielded >= options.limit) return;
			yielded += 1;
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

	/** Test helper: raw events of one stream. */
	events(streamId: string): readonly EventEnvelope[] {
		return this.streams.get(streamId) ?? [];
	}

	/** Test helper: append a Station-side reconcile status event for a Camp. */
	async reconcileEvent(
		campId: string,
		type: string = CD_EVENTS.StatusObserved,
		fenceToken = "7",
	): Promise<void> {
		const stream = CD_STREAMS.campStatus(campId);
		await this.append(
			stream,
			[
				{
					type,
					data: {
						campId,
						reconcilerId: "rec-1",
						fenceToken,
						status: "RECONCILE_STATUS_CONVERGED",
					},
				},
			],
			{
				expectedSeq: this.events(stream).length,
				actor: STATION,
				tenant: TENANT,
			},
		);
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
	count(name: string): number {
		return this.points
			.filter((point) => point.name === name)
			.reduce((sum, point) => sum + point.value, 0);
	}
}

export function reasonOf(code: string, message: string): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: "fix the fixture",
		subject: code,
	});
}

export type AuthorizerCall = Readonly<{
	action: CdAction;
	principal: PrincipalRef;
	subject: JsonObject;
}>;

/** Allows users and services; agents get proposal-only; listed actions are denied. */
export class FakeAuthorizer implements CdAuthorizer {
	readonly calls: AuthorizerCall[] = [];
	readonly denied = new Set<CdAction>();
	async authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>> {
		this.calls.push({ action, principal: ctx.principal, subject });
		if (this.denied.has(action))
			return {
				ok: false,
				reasons: [reasonOf("policy-denied", `${action} denied`)],
			};
		return {
			ok: true,
			value: {
				decisionId: `dec-${this.calls.length}`,
				proposalOnly: ctx.principal.kind === "agent",
			},
		};
	}
}

export function topology(
	campId: string,
	overrides: Partial<Omit<CampTopology, "campId">> = {},
): CampTopology {
	return {
		campId: camp(campId),
		yardId: overrides.yardId ?? "yard-a",
		stationId: overrides.stationId ?? "station-eu",
		provider: overrides.provider ?? "aws",
		regions: overrides.regions ?? ["eu-west-1"],
		envType: overrides.envType ?? "prod",
		labels: overrides.labels ?? {},
		management: overrides.management ?? CampManagement.MANAGED,
	};
}

export class FakeTopology implements TopologyReader {
	constructor(public declared: CampTopology[] = []) {}
	async camps(): Promise<readonly CampTopology[]> {
		return this.declared;
	}
	async camp(campId: CampId): Promise<CampTopology | undefined> {
		return this.declared.find((entry) => entry.campId === campId);
	}
}

export function railDelivery(
	input: Partial<{
		campSets: string[];
		automatic: boolean;
		requiredSignals: number;
		maxFanoutCamps: number;
	}> = {},
): RailDeliveryRecord {
	return create(RailDeliveryRecordSchema, {
		railDigest: `sha256:${"a".repeat(64)}`,
		campSets: input.campSets ?? [],
		failover: create(RailFailoverRecordSchema, {
			automatic: input.automatic ?? false,
			maxConcurrent: 1,
			requiredSignals: input.requiredSignals ?? 2,
		}),
		maxFanoutCamps: input.maxFanoutCamps ?? 1_000,
	});
}

export class FakeRails implements RailDeliveryReader {
	constructor(
		public delivery: RailDeliveryRecord | undefined = railDelivery(),
	) {}
	async forStation(): Promise<RailDeliveryRecord | undefined> {
		return this.delivery;
	}
	async forCamp(): Promise<RailDeliveryRecord | undefined> {
		return this.delivery;
	}
}

/** Only `status` is read by the inventory (claims from the latest observation). */
export class FakeDesired implements DesiredStateReader {
	readonly observations = new Map<string, ReconcileObservationRecord>();
	async current() {
		return undefined;
	}
	async get() {
		return undefined;
	}
	async history() {
		return [];
	}
	async resolved(): Promise<never> {
		throw new Error("not used by the inventory");
	}
	async status(
		campId: CampId,
	): Promise<ReconcileObservationRecord | undefined> {
		return this.observations.get(campId);
	}
	async *changes(): AsyncIterable<never> {}
}
