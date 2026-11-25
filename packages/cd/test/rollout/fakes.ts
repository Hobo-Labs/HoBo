// Test doubles and builders for the WP10 rollout tests. Each double models a
// frozen port (ports.ts, @hobo/core); none is reachable from production code.
import { create } from "@bufbuild/protobuf";
import type {
	AppendOptions,
	AppendResult,
	ApplyResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventPosition,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
	RoutingPlan,
	RoutingPlanId,
	RoutingStatus,
	SnapshotRecord,
	StreamFilter,
	Subscription,
	TrafficRoutingOfferingId,
} from "@hobo/core";
import {
	type ChangeWindowRecord,
	type DeltaRecord,
	type ObligationRef,
	ObligationRefSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type RolloutStrategy,
	type SetRecord,
	SetRecordSchema,
	type VerificationResultRecord,
	VerificationResultRecordSchema,
	type VerificationSpecRecord,
	VerificationSpecRecordSchema,
	VerificationVerdict,
	type WindowOverrideRecord,
} from "../../src/_generated/cd_pb.js";
import type {
	ApprovalPort,
	ApprovalStatus,
	CampId,
	CdContext,
	ChangeWindows,
	DeltaId,
	DeltaLedger,
	DesiredStateChange,
	DesiredStateReader,
	FreightId,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	SetId,
	TelemetrySink,
	TrafficShifter,
	VerificationEngine,
	VerificationId,
	WindowEvaluation,
} from "../../src/ports.js";
import { isJsonString } from "../../src/rollout/json.js";
import { stageShare } from "../../src/rollout/routing.js";

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
	/** Make the next append to a stream whose id starts with this prefix fail once. */
	failNextAppend: string | undefined;

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		if (
			this.failNextAppend !== undefined &&
			streamId.startsWith(this.failNextAppend)
		) {
			this.failNextAppend = undefined;
			throw new Error(`injected append failure on ${streamId}`);
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
	async spans(_spans: readonly OtelSpan[]): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	named(name: string): readonly OtelMetricPoint[] {
		return this.points.filter((point) => point.name === name);
	}
}

/**
 * A TrafficShifter that realizes stage plans in memory. `stuck` makes the
 * provider acknowledge `full` while the observed routing stays on the previous
 * split (provider self-report vs observed traffic).
 */
export class FakeTraffic implements TrafficShifter {
	readonly shifts: Array<
		Readonly<{ campId: CampId; percent: number; planId: string }>
	> = [];
	readonly active = new Map<CampId, string>();
	offeringsByCamp = new Map<string, readonly TrafficRoutingOfferingId[]>();
	stuck = new Set<string>();
	refuse = new Set<string>();
	throwOn = new Set<string>();

	async offerings(
		campId: CampId,
	): Promise<readonly TrafficRoutingOfferingId[]> {
		return this.offeringsByCamp.get(campId) ?? ["lb.weighted"];
	}

	async shift(
		input: Readonly<{ campId: CampId; plan: RoutingPlan; signal: AbortSignal }>,
	): Promise<ApplyResult> {
		const percent = stageShare(input.plan) ?? -1;
		this.shifts.push({
			campId: input.campId,
			percent,
			planId: input.plan.planId,
		});
		if (this.throwOn.has(input.campId))
			throw new Error("provider connection reset");
		if (this.refuse.has(input.campId))
			return {
				planId: input.plan.planId,
				provider: "simple",
				realized: "none",
				notes: ["traffic-cutover-refused"],
			};
		if (!this.stuck.has(input.campId))
			this.active.set(input.campId, input.plan.planId);
		return {
			planId: input.plan.planId,
			provider: "simple",
			realized: "full",
			notes: [],
		};
	}

	async status(
		campId: CampId,
		planId: RoutingPlanId,
	): Promise<RoutingStatus | null> {
		const active = this.active.get(campId) === planId;
		return { planId, active, realized: active ? "full" : "partial", notes: [] };
	}

	percents(campId: string): readonly number[] {
		return this.shifts
			.filter((shift) => shift.campId === campId)
			.map((shift) => shift.percent);
	}
}

type Script = (
	input: Readonly<{ campId: string; cohortAware: boolean; call: number }>,
) => VerificationVerdict | "pending";

/** A VerificationEngine whose verdicts the test scripts per Camp and call. */
export class FakeVerification implements VerificationEngine {
	readonly started: Array<
		Readonly<{
			id: VerificationId;
			campId: string;
			cohortAware: boolean;
			freightId: string;
		}>
	> = [];
	private readonly results = new Map<string, VerificationResultRecord>();
	private readonly pendingIds = new Set<string>();
	constructor(public script: Script = () => VerificationVerdict.PASS) {}

	async start(
		input: Parameters<VerificationEngine["start"]>[0],
	): Promise<VerificationId> {
		const call = this.started.filter((s) => s.campId === input.campId).length;
		// SAFETY: test double ids.
		const id = `ver-${input.campId}-${call}` as VerificationId;
		this.started.push({
			id,
			campId: input.campId,
			cohortAware: input.cohortAware,
			freightId: input.freightId,
		});
		const verdict = this.script({
			campId: input.campId,
			cohortAware: input.cohortAware,
			call,
		});
		if (verdict === "pending") this.pendingIds.add(id);
		else this.complete(id, input.campId, input.freightId, verdict);
		return id;
	}

	complete(
		id: string,
		campId: string,
		freightId: string,
		verdict: VerificationVerdict,
	): void {
		this.pendingIds.delete(id);
		this.results.set(
			id,
			create(VerificationResultRecordSchema, {
				verificationId: id,
				campId,
				freightId,
				verdict,
			}),
		);
	}

	/** Complete every pending verification with this verdict. */
	settle(verdict: VerificationVerdict): void {
		for (const started of this.started)
			if (this.pendingIds.has(started.id))
				this.complete(started.id, started.campId, started.freightId, verdict);
	}

	async get(id: VerificationId): Promise<VerificationResultRecord | undefined> {
		return this.results.get(id);
	}

	async tick(): Promise<readonly VerificationResultRecord[]> {
		return [];
	}
}

/** ChangeWindows whose verdict the test toggles. */
export class FakeWindows implements ChangeWindows {
	open = true;
	rollbackAllowed = true;
	readonly evaluations: Array<
		Readonly<{ campId: string; intent: string; windowNames: readonly string[] }>
	> = [];
	async define(
		window: ChangeWindowRecord,
	): Promise<Outcome<ChangeWindowRecord>> {
		return { ok: true, value: window };
	}
	async list(): Promise<readonly ChangeWindowRecord[]> {
		return [];
	}
	async override(
		input: WindowOverrideRecord,
	): Promise<Outcome<WindowOverrideRecord>> {
		return { ok: true, value: input };
	}
	async evaluate(
		input: Parameters<ChangeWindows["evaluate"]>[0],
	): Promise<WindowEvaluation> {
		this.evaluations.push({
			campId: input.campId,
			intent: input.intent,
			windowNames: input.windowNames,
		});
		return {
			open: this.open,
			rollbackAllowed: this.rollbackAllowed,
			activeFreezes: this.open ? [] : ["year-end-freeze"],
			overrides: [],
		};
	}
}

/** Desired state: current Sets and reconcile observations per Camp; records opened Deltas. */
export class FakeDesired implements DesiredStateReader, DeltaLedger {
	readonly sets = new Map<string, SetRecord>();
	readonly currentByCamp = new Map<string, string>();
	readonly statusByCamp = new Map<string, ReconcileObservationRecord>();
	readonly deltas = new Map<string, DeltaRecord>();

	/** Record `freightId` as the converged current Set on the Camp, with a predecessor Set. */
	promoted(
		campId: string,
		freightId: string,
		options: Readonly<{ predecessor?: boolean; converged?: boolean }> = {},
	): void {
		const predecessorId = `set-${campId}-prev`;
		if (options.predecessor !== false)
			this.sets.set(
				predecessorId,
				create(SetRecordSchema, {
					setId: predecessorId,
					campId,
					freightId: "freight-prev",
				}),
			);
		const setId = `set-${campId}-${freightId}`;
		this.sets.set(
			setId,
			create(SetRecordSchema, {
				setId,
				campId,
				freightId,
				predecessorSetId: options.predecessor === false ? "" : predecessorId,
			}),
		);
		this.currentByCamp.set(campId, setId);
		this.statusByCamp.set(
			campId,
			create(ReconcileObservationRecordSchema, {
				campId,
				setId,
				status:
					options.converged === false
						? ReconcileStatus.CONVERGING
						: ReconcileStatus.CONVERGED,
			}),
		);
	}

	converge(campId: string): void {
		const status = this.statusByCamp.get(campId);
		if (status) status.status = ReconcileStatus.CONVERGED;
	}

	async current(campId: CampId): Promise<SetRecord | undefined> {
		const id = this.currentByCamp.get(campId);
		return id ? this.sets.get(id) : undefined;
	}
	async get(id: SetId | DeltaId): Promise<never> {
		// SAFETY: the double serves both get overloads (Set and Delta ids never collide in tests).
		return (this.sets.get(id) ?? this.deltas.get(id)) as never;
	}
	async history(): Promise<readonly SetRecord[]> {
		return [];
	}
	async resolved(): Promise<never> {
		throw new Error("not used by the rollout orchestrator");
	}
	async status(
		campId: CampId,
	): Promise<ReconcileObservationRecord | undefined> {
		return this.statusByCamp.get(campId);
	}
	async *changes(): AsyncIterable<DesiredStateChange> {}
	async open(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		this.deltas.set(delta.deltaId, delta);
		return { ok: true, value: delta };
	}
	async update(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		return { ok: true, value: delta };
	}
	async apply(): Promise<never> {
		throw new Error("the rollout orchestrator never applies a Set (I2, I7)");
	}
	async reject(): Promise<void> {}
}

export class FakeApprovals implements ApprovalPort {
	readonly requests: Array<Readonly<{ subject: string; requestId: string }>> =
		[];
	answer: ApprovalStatus = "pending";
	async request(
		input: Parameters<ApprovalPort["request"]>[0],
	): Promise<Readonly<{ requestId: string }>> {
		const requestId = `apr-${this.requests.length + 1}`;
		this.requests.push({ subject: input.subject, requestId });
		return { requestId };
	}
	async status(): Promise<ApprovalStatus> {
		return this.answer;
	}
}

export function promotion(
	input: Readonly<{
		id?: string;
		freight?: string;
		targets: readonly string[];
		strategy: RolloutStrategy;
	}>,
): PromotionRecord {
	return create(PromotionRecordSchema, {
		promotionId: input.id ?? "promo-1",
		freightId: input.freight ?? "freight-1",
		targetCampIds: [...input.targets],
		strategy: input.strategy,
	});
}

export function spec(
	fields: Readonly<{ deadlineMs?: number }> = {},
): VerificationSpecRecord {
	return create(VerificationSpecRecordSchema, {
		windowMs: 600_000n,
		requiredObservations: 3,
		progressDeadlineMs: BigInt(fields.deadlineMs ?? 1_800_000),
		failOnNoData: true,
	});
}

export function obligation(kind: string, id = kind): ObligationRef {
	return create(ObligationRefSchema, { id, kind });
}
