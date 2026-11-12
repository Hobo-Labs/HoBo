// Test doubles for the WP23 fan-out and failover tests. Each models one
// frozen port (ports.ts, @hobo/core eventstore); none is reachable from
// production code.
import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type AppendOptions,
	type AppendResult,
	type ClaimSubscriptionOptions,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	EventStoreError,
	type FenceToken,
	type JsonObject,
	OptimisticSequenceConflictError,
	type PartitionId,
	type PositionedEvent,
	type PrincipalRef,
	type ReadAllOptions,
	type SnapshotRecord,
	type StreamFilter,
	type Subscription,
	type SubscriptionId,
	type SubscriptionLease,
} from "@hobo/core";
import {
	CampConditionRecordSchema,
	CampConditionType,
	CampManagement,
	type CampSetRecord,
	type CampStatusRecord,
	CampStatusRecordSchema,
	ConditionStatus,
	type FanoutRecord,
	FanoutRecordSchema,
	FanoutStrategy,
	type FreightApprovedRecord,
	type FreightQualifiedRecord,
	FreightQualifiedRecordSchema,
	type FreightRecord,
	PlacementCandidateRecordSchema,
	type PlacementDecisionRecord,
	PlacementDecisionRecordSchema,
	PlacementGroupDecisionRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	type ReasonRecord,
	ReasonRecordSchema,
	type ReconcileObservationRecord,
	type SetRecord,
	SetRecordSchema,
	type TaintRecord,
} from "../../src/_generated/cd_pb.js";
import type {
	CampId,
	CampInventory,
	CampTopology,
	CampView,
	CdAction,
	CdAuthorizer,
	CdContext,
	ChangeWindows,
	DeltaLedger,
	DesiredStateReader,
	FreightId,
	FreightLedger,
	InventorySnapshot,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	PromoteRequest,
	PromotionId,
	PromotionService,
	SetId,
	TelemetrySink,
	WindowEvaluation,
} from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const FREIGHT = "sha256:aaaa" as FreightId;
export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

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

export function context(now: () => number, principal: PrincipalRef = OPERATOR): CdContext {
	return { tenant: TENANT, principal, now };
}

export function reasonOf(code: string, message = code): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation: "fix the fixture", subject: code });
}

/**
 * In-memory DurableEventStore with conformance semantics: per-stream
 * expected-seq CAS, idempotency-key dedup, and optional durable leases.
 */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	private readonly all: PositionedEvent[] = [];
	private readonly leases = new Map<string, { holderId: string; fence: bigint; expiresAt: number }>();
	private nextId = 1;
	private fences = 0n;
	/** Test hook: runs before the CAS of the next append. */
	beforeAppend: (() => Promise<void>) | undefined;
	leaseNow: () => number = () => T0;
	claimSubscription?: DurableEventStore["claimSubscription"];
	releaseSubscription?: DurableEventStore["releaseSubscription"];

	constructor(options: Readonly<{ leases?: boolean }> = {}) {
		if (options.leases) {
			this.claimSubscription = async (o: ClaimSubscriptionOptions): Promise<SubscriptionLease> => {
				const key = `${o.subscriptionId}|${o.partitionId}`;
				const held = this.leases.get(key);
				const now = this.leaseNow();
				if (held && held.holderId !== o.holderId && held.expiresAt > now)
					throw new EventStoreError("SUBSCRIPTION_LEASE_CONFLICT", `lease ${key} held by ${held.holderId}`);
				this.fences += 1n;
				const lease = { holderId: o.holderId, fence: this.fences, expiresAt: now + (o.leaseTtlMs ?? 30_000) };
				this.leases.set(key, lease);
				return {
					// SAFETY: test double mints ids from the claim options.
					subscriptionId: o.subscriptionId as SubscriptionId,
					// SAFETY: test double mints ids from the claim options.
					partitionId: o.partitionId as PartitionId,
					holderId: o.holderId,
					// SAFETY: test double; monotonic counter.
					fenceToken: lease.fence as FenceToken,
					expiresAt: new Date(lease.expiresAt).toISOString(),
				};
			};
			this.releaseSubscription = async (o) => {
				const key = `${o.subscriptionId}|${o.partitionId}`;
				if (this.leases.get(key)?.holderId === o.holderId) this.leases.delete(key);
			};
		}
	}

	/** Test helper: take a lease as another holder (simulates a second replica). */
	async holdLease(subscriptionId: string, holderId: string, ttlMs = 30_000): Promise<void> {
		await this.claimSubscription?.({ subscriptionId, partitionId: TENANT, holderId, leaseTtlMs: ttlMs });
	}

	async append(streamId: string, events: EventInput[], opts: AppendOptions): Promise<AppendResult> {
		const hook = this.beforeAppend;
		this.beforeAppend = undefined;
		if (hook) await hook();
		const stream = this.streams.get(streamId) ?? [];
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing = typeof key === "string" ? stream.find((e) => e.meta?.idempotencyKey === key) : undefined;
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length)
			throw new OptimisticSequenceConflictError(streamId, opts.expectedSeq, stream.length);
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
				data: structuredClone(input.data) as EventEnvelope["data"],
			};
			if (input.meta) envelope.meta = structuredClone(input.meta);
			// SAFETY: test double; positions minted from a monotonic counter.
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
		for (const event of this.streams.get(streamId) ?? []) if (event.seq > fromSeq) yield event;
	}

	async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
		for (const entry of [...this.all]) {
			if (options.after !== undefined && entry.position <= options.after) continue;
			if (options.tenant !== undefined && entry.event.tenant !== options.tenant) continue;
			if (options.filter?.type !== undefined && entry.event.type !== options.filter.type) continue;
			if (options.filter?.streamId !== undefined && entry.event.streamId !== options.filter.streamId) continue;
			yield entry;
		}
	}

	subscribe(_filter: StreamFilter, _handler: (event: EventEnvelope) => void): Subscription {
		return { unsubscribe: () => undefined };
	}

	async snapshot(streamId: string, state: never, seq: number): Promise<SnapshotRecord> {
		return { streamId, seq, state, savedAt: new Date(T0).toISOString() };
	}

	async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
		const result = await this.append(request.streamId, [...request.events], request.append);
		return { ...result, effects: [] };
	}

	events(streamId: string): readonly EventEnvelope[] {
		return this.streams.get(streamId) ?? [];
	}

	/** Every event, in journal order (golden replay). */
	journal(): readonly EventEnvelope[] {
		return this.all.map((entry) => entry.event);
	}
}

export class RecordingTelemetry implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	async spans(_spans: readonly OtelSpan[]): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	count(name: string, match: Readonly<Record<string, string>> = {}): number {
		return this.points
			.filter((p) => p.name === name && Object.entries(match).every(([k, v]) => p.attributes[k] === v))
			.reduce((sum, p) => sum + p.value, 0);
	}
}

export class FakeAuthorizer implements CdAuthorizer {
	readonly calls: { action: CdAction; subject: JsonObject }[] = [];
	deny = new Set<CdAction>();
	proposalOnly = new Set<CdAction>();
	async authorize(action: CdAction, subject: JsonObject, _ctx: CdContext) {
		this.calls.push({ action, subject });
		if (this.deny.has(action))
			return { ok: false as const, reasons: [reasonOf("unauthorized", `${action} denied`)] };
		return { ok: true as const, value: { decisionId: `dec-${this.calls.length}`, proposalOnly: this.proposalOnly.has(action) } };
	}
}

/** Freight ledger: usable unless yanked; qualifications recorded by tests or by FakePromotions. */
export class FakeFreight implements Pick<FreightLedger, "isUsable" | "qualifications"> {
	readonly yanked = new Set<string>();
	readonly records: FreightQualifiedRecord[] = [];
	async isUsable(id: FreightId): Promise<boolean> {
		return !this.yanked.has(id);
	}
	async qualifications(id: FreightId): Promise<readonly FreightQualifiedRecord[]> {
		return this.records.filter((q) => q.freightId === id);
	}
	qualify(freightId: string, campId: string, pipeline: string, node: string, atMs: number): void {
		this.records.push(
			create(FreightQualifiedRecordSchema, {
				freightId,
				campId,
				pipeline,
				node,
				verificationId: `ver-${campId}`,
				qualifiedAt: new Date(atMs).toISOString(),
			}),
		);
	}
}

export function asLedger(fake: FakeFreight): FreightLedger {
	const unused = async (): Promise<never> => {
		throw new Error("not used by WP23");
	};
	return {
		record: unused,
		yank: unused,
		approve: unused,
		qualify: unused,
		get: async () => undefined,
		getByAlias: async () => undefined,
		isUsable: (id) => fake.isUsable(id),
		qualifications: (id) => fake.qualifications(id),
		approvals: async (): Promise<readonly FreightApprovedRecord[]> => [],
		list: async (): Promise<readonly FreightRecord[]> => [],
		retire: async () => [],
	};
}

export type PromotionCall = Readonly<{ request: PromoteRequest; at: number }>;

const LIVE: ReadonlySet<PromotionState> = new Set([
	PromotionState.QUEUED,
	PromotionState.RESOLVING,
	PromotionState.AWAITING_APPROVAL,
	PromotionState.AWAITING_WINDOW,
	PromotionState.APPLYING,
	PromotionState.ROLLING_OUT,
	PromotionState.VERIFYING,
]);

/**
 * PromotionService double: idempotent by key; tests settle promotions.
 * Tracks the peak number of live forward promotions (I20 chaos checks).
 */
export class FakePromotions implements PromotionService {
	readonly byId = new Map<string, PromotionRecord>();
	readonly byKey = new Map<string, string>();
	readonly calls: PromotionCall[] = [];
	readonly rollbacks: { campId: string; idempotencyKey: string; reason: string }[] = [];
	readonly refuse = new Set<string>();
	readonly refuseRollback = new Set<string>();
	/** Chaos: throw a transient error on promote with this probability source. */
	throwOn: ((request: PromoteRequest) => boolean) | undefined;
	peakLive = 0;
	private next = 1;
	constructor(
		private readonly freight: FakeFreight,
		private readonly now: () => number,
	) {}

	live(intent = "promote"): PromotionRecord[] {
		return [...this.byId.values()].filter(
			(p) => LIVE.has(p.state) && (this.intents.get(p.promotionId) ?? "promote") === intent,
		);
	}
	private readonly intents = new Map<string, string>();

	async promote(request: PromoteRequest, _ctx: CdContext): Promise<Outcome<PromotionRecord>> {
		this.calls.push({ request, at: this.now() });
		if (this.throwOn?.(request)) throw new Error("transient promotion port failure");
		const known = this.byKey.get(request.idempotencyKey);
		if (known !== undefined) {
			const record = this.byId.get(known);
			if (record) return { ok: true, value: record };
		}
		const target = request.targets[0] ?? "";
		if (this.refuse.has(target)) return { ok: false, reasons: [reasonOf("gate-denied", `gate denied ${target}`)] };
		const promotionId = `prm-${this.next}`;
		this.next += 1;
		const record = create(PromotionRecordSchema, {
			promotionId,
			freightId: request.freightId,
			targetCampIds: [...request.targets],
			pipeline: request.pipeline ?? "",
			node: request.node ?? "",
			state: PromotionState.ROLLING_OUT,
			idempotencyKey: request.idempotencyKey,
			fanoutId: request.fanoutId ?? "",
			sourceCampId: request.sourceCampId ?? "",
			requestedAt: new Date(this.now()).toISOString(),
		});
		this.byId.set(promotionId, record);
		this.byKey.set(request.idempotencyKey, promotionId);
		this.intents.set(promotionId, request.intent ?? "promote");
		this.peakLive = Math.max(this.peakLive, this.live().length);
		return { ok: true, value: record };
	}

	/** Settle the latest forward promotion for a Camp. */
	settle(campId: string, outcome: "pass" | "fail" | "superseded"): void {
		const record = [...this.byId.values()].reverse().find((p) => p.targetCampIds.includes(campId) && LIVE.has(p.state));
		if (!record) return;
		if (outcome === "pass") {
			record.state = PromotionState.PROMOTED;
			this.freight.qualify(record.freightId, campId, record.pipeline, record.node, this.now());
		} else if (outcome === "superseded") record.state = PromotionState.SUPERSEDED;
		else {
			record.state = PromotionState.FAILED;
			record.reasons = [reasonOf("verification-failed", `verification FAIL in ${campId}`)];
		}
	}

	intentOf(promotionId: string): string {
		return this.intents.get(promotionId) ?? "promote";
	}

	async rollback(input: Readonly<{ campId: CampId; reason: string; idempotencyKey: string; toSetId?: SetId }>, _ctx: CdContext): Promise<Outcome<PromotionRecord>> {
		if (this.refuseRollback.has(input.campId)) return { ok: false, reasons: [reasonOf("rollback-refused")] };
		const existing = this.rollbacks.find((r) => r.idempotencyKey === input.idempotencyKey);
		if (!existing) this.rollbacks.push({ campId: input.campId, idempotencyKey: input.idempotencyKey, reason: input.reason });
		return {
			ok: true,
			value: create(PromotionRecordSchema, { promotionId: `rb-${input.campId}`, targetCampIds: [input.campId], state: PromotionState.ROLLED_BACK }),
		};
	}
	async approve(): Promise<Outcome<PromotionRecord>> {
		throw new Error("not used by WP23");
	}
	async get(promotionId: PromotionId): Promise<PromotionRecord | undefined> {
		return this.byId.get(promotionId);
	}
	async list(query?: Readonly<{ campId?: CampId; limit?: number }>): Promise<readonly PromotionRecord[]> {
		return [...this.byId.values()].filter((p) => query?.campId === undefined || p.targetCampIds.includes(query.campId));
	}
	async tick(): Promise<void> {}
}

export function topology(id: string, overrides: Partial<CampTopology> = {}): CampTopology {
	return {
		campId: camp(id),
		yardId: overrides.yardId ?? "yard-eu",
		stationId: overrides.stationId ?? "station-eu",
		provider: overrides.provider ?? "aws",
		regions: overrides.regions ?? ["eu-west-1"],
		envType: overrides.envType ?? "production",
		labels: overrides.labels ?? {},
		management: overrides.management ?? CampManagement.MANAGED,
	};
}

export function healthy(id: string, taints: readonly TaintRecord[] = [], reachable = true): CampStatusRecord {
	return create(CampStatusRecordSchema, {
		campId: id,
		management: CampManagement.MANAGED,
		conditions: [
			create(CampConditionRecordSchema, {
				type: CampConditionType.REACHABLE,
				status: reachable ? ConditionStatus.TRUE : ConditionStatus.FALSE,
			}),
		],
		taints: [...taints],
	});
}

/** CampInventory double over a mutable map of topology + status. */
export class FakeInventory implements CampInventory {
	readonly camps = new Map<string, CampView>();
	statusCalls = 0;
	add(id: string, overrides: Partial<CampTopology> = {}, status = healthy(id)): void {
		this.camps.set(id, { topology: topology(id, overrides), status });
	}
	setStatus(id: string, status: CampStatusRecord): void {
		const view = this.camps.get(id);
		if (view) this.camps.set(id, { ...view, status });
	}
	async status(campId: CampId): Promise<CampStatusRecord | undefined> {
		this.statusCalls += 1;
		return this.camps.get(campId)?.status;
	}
	async list(query?: Parameters<CampInventory["list"]>[0]): Promise<readonly CampView[]> {
		const ids = query?.selector?.campIds ?? [];
		return [...this.camps.values()].filter((v) => ids.length === 0 || ids.includes(v.topology.campId));
	}
	async observe(): Promise<Outcome<CampStatusRecord>> {
		throw new Error("not used by WP23");
	}
	async taint(): Promise<Outcome<CampStatusRecord>> {
		throw new Error("not used by WP23");
	}
	async untaint(): Promise<Outcome<CampStatusRecord>> {
		throw new Error("not used by WP23");
	}
	async manage(): Promise<Outcome<CampStatusRecord>> {
		throw new Error("not used by WP23");
	}
	async defineSet(set: CampSetRecord): Promise<Outcome<CampSetRecord>> {
		return { ok: true, value: set };
	}
	async sets(): Promise<readonly CampSetRecord[]> {
		return [];
	}
	async snapshot(): Promise<InventorySnapshot> {
		return { digest: "sha256:00", camps: [...this.camps.values()] };
	}
	async tick(): Promise<void> {}
}

export class FakeWindows implements ChangeWindows {
	readonly closed = new Set<string>();
	readonly calls: string[][] = [];
	async define(): Promise<never> {
		throw new Error("not used by WP23");
	}
	async list() {
		return [];
	}
	async override(): Promise<never> {
		throw new Error("not used by WP23");
	}
	async evaluate(input: Parameters<ChangeWindows["evaluate"]>[0]): Promise<WindowEvaluation> {
		this.calls.push([...input.windowNames]);
		const open = !this.closed.has(input.campId);
		return { open, rollbackAllowed: true, activeFreezes: open ? [] : ["freeze"], overrides: [] };
	}
}

/** Desired-state double: current Set, resolved plan and last observation per Camp. */
export class FakeDesired implements DesiredStateReader, DeltaLedger {
	readonly sets = new Map<string, SetRecord>();
	readonly resolvedSets = new Map<string, ResolvedDeploymentSet>();
	readonly observations = new Map<string, ReconcileObservationRecord>();
	place(campId: string, resources: readonly Readonly<{ name: string; port: string }>[]): void {
		const set = create(SetRecordSchema, { setId: `set-${campId}`, campId });
		this.sets.set(campId, set);
		this.resolvedSets.set(set.setId, {
			plan: { resources: resources.map((r) => ({ ...r, provider: "aws", deps: [] })) },
		} as unknown as ResolvedDeploymentSet);
	}
	async current(campId: CampId) {
		return this.sets.get(campId);
	}
	async get(setId: SetId) {
		return [...this.sets.values()].find((s) => s.setId === setId);
	}
	async history() {
		return [];
	}
	async resolved(set: SetRecord): Promise<ResolvedDeploymentSet> {
		const found = this.resolvedSets.get(set.setId);
		if (!found) throw new Error(`no resolved set ${set.setId}`);
		return found;
	}
	async status(campId: CampId) {
		return this.observations.get(campId);
	}
	async *changes(): AsyncIterable<never> {}
	async open(): Promise<never> {
		throw new Error("not used by WP23");
	}
	async update(): Promise<never> {
		throw new Error("not used by WP23");
	}
	async apply(): Promise<never> {
		throw new Error("not used by WP23");
	}
	async reject(): Promise<void> {}
}

/** A decision of `n` Camps `c000…` chunked into groups of `size`. */
export function decisionOf(
	n: number,
	size: number,
	options: Readonly<{ pipeline?: string; node?: string; mandatory?: readonly string[]; prefix?: string; decisionId?: string }> = {},
): PlacementDecisionRecord {
	const prefix = options.prefix ?? "c";
	const ids = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
	const groups = [];
	for (let i = 0; i < n; i += size) {
		const index = groups.length;
		const name = index === 0 && options.mandatory?.includes("pilot") ? "pilot" : `g${index}`;
		groups.push(
			create(PlacementGroupDecisionRecordSchema, {
				name,
				index,
				campIds: ids.slice(i, i + size),
				mandatory: options.mandatory?.includes(name) ?? false,
			}),
		);
	}
	return create(PlacementDecisionRecordSchema, {
		decisionId: options.decisionId ?? `dec-${n}-${size}`,
		placement: "web",
		pipeline: options.pipeline ?? "web",
		node: options.node ?? "prod",
		inventoryDigest: "sha256:00",
		groups,
		candidates: ids.map((campId) => create(PlacementCandidateRecordSchema, { campId, selected: true })),
	});
}

export function fanoutOf(overrides: Partial<Omit<FanoutRecord, "$typeName">> = {}): FanoutRecord {
	return create(FanoutRecordSchema, {
		strategy: FanoutStrategy.PROGRESSIVE_PER_GROUP,
		minSuccessMs: BigInt(MINUTE),
		progressDeadlineMs: BigInt(30 * MINUTE),
		maxFailuresPercent: overrides.maxFailures ? 0 : 5,
		rollbackOnHalt: true,
		...overrides,
	});
}
