/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-chained-type-assertions, anti-slop/no-conditional-empty-object-spread -- SAFETY: test doubles implement only the port members the service and read API call, so they are cast to the full port once; ids they mint are branded here. */
// Test doubles for the CD service host (WP12). Each fake implements only the
// members of the frozen ports that the service or the read API call; the rest
// throw so an unexpected dependency is loud.
import { create } from "@bufbuild/protobuf";
import type {
	DurableEventStore,
	EventEnvelope,
	EventPosition,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
} from "@hobo/core";
import { PersistenceUnavailableError } from "@hobo/core";
import type {
	CampStatusRecord,
	ComplianceRecord,
	FailoverRecord,
	FanoutStatusRecord,
	FreightApprovedRecord,
	FreightAvailabilityRecord,
	FreightQualifiedRecord,
	FreightRecord,
	PipelineRecord,
	PlacementDecisionRecord,
	PreviewEnvironmentRecord,
	PromotionRecord,
	ReconcileObservationRecord,
	RetentionPolicyRecord,
	SetRecord,
} from "../../src/_generated/cd_pb.js";
import type {
	CampId,
	CampReconciler,
	CampTopology,
	CampView,
	ContinuousDelivery,
	DeliveryFeedHandler,
	FeedRequest,
	FeedResponse,
	OtelMetricPoint,
	OtelSpan,
	ReconcilerId,
	TelemetrySink,
	TopologyReader,
} from "../../src/ports.js";

export const principal: PrincipalRef = {
	kind: "service",
	id: "cd-service-test",
} as PrincipalRef;
export const asCamp = (id: string) => id as CampId;
export const asReconciler = (id: string) => id as ReconcilerId;

// ── Journal ────────────────────────────────────────────────────────────────
export type FakeStore = DurableEventStore & {
	/** Simulate store loss (every call throws PersistenceUnavailableError). */
	lose(): void;
	restore(): void;
	push(streamId: string, type: string, data: unknown): EventPosition;
	readonly events: PositionedEvent[];
};

export function fakeStore(): FakeStore {
	const events: PositionedEvent[] = [];
	let lost = false;
	let next = 1n;
	const guard = () => {
		if (lost)
			throw new PersistenceUnavailableError("journal unreachable (test)");
	};
	const store = {
		events,
		lose() {
			lost = true;
		},
		restore() {
			lost = false;
		},
		push(streamId: string, type: string, data: unknown) {
			const position = next as EventPosition;
			next += 1n;
			const seq =
				events.filter((e) => e.event.streamId === streamId).length + 1;
			const event: EventEnvelope = {
				id: `evt-${position}`,
				type,
				v: 1,
				streamId,
				seq,
				ts: new Date(Number(position) * 1000).toISOString(),
				actor: principal,
				tenant: "t1",
				data,
			};
			events.push({ position, event });
			return position;
		},
		async *readAll(options?: ReadAllOptions): AsyncIterable<PositionedEvent> {
			guard();
			let yielded = 0;
			for (const e of events.slice()) {
				if (options?.after !== undefined && e.position <= options.after)
					continue;
				if (
					options?.filter?.streamId &&
					e.event.streamId !== options.filter.streamId
				)
					continue;
				if (options?.filter?.type && e.event.type !== options.filter.type)
					continue;
				if (options?.limit !== undefined && yielded >= options.limit) return;
				yielded += 1;
				yield e;
				guard();
			}
		},
		async *read(streamId: string): AsyncIterable<EventEnvelope> {
			guard();
			for (const e of events) if (e.event.streamId === streamId) yield e.event;
		},
	};
	return store as unknown as FakeStore;
}

// ── Telemetry ──────────────────────────────────────────────────────────────
export type RecordingSink = TelemetrySink & {
	readonly points: OtelMetricPoint[];
	readonly recorded: OtelSpan[];
};

export function recordingSink(): RecordingSink {
	const points: OtelMetricPoint[] = [];
	const recorded: OtelSpan[] = [];
	const sink: TelemetrySink = {
		async metrics(p) {
			points.push(...p);
		},
		async spans(s) {
			recorded.push(...s);
		},
	};
	return Object.assign(sink, { points, recorded }) as unknown as RecordingSink;
}

// ── Reconcilers ────────────────────────────────────────────────────────────
export type FakeReconciler = CampReconciler & {
	readonly leases: Set<string>;
	runs: number;
	/** Make the next run reject (crash) instead of waiting for abort. */
	crashNext(error: Error): void;
	/** Never return from run, even when aborted (a wedged reconciler). */
	wedge(): void;
};

export function fakeReconciler(
	id: string,
	campIds: readonly string[],
): FakeReconciler {
	const leases = new Set<string>();
	let crash: Error | undefined;
	let wedged = false;
	const r = {
		reconcilerId: asReconciler(id),
		mode: 1,
		leases,
		runs: 0,
		crashNext(error: Error) {
			crash = error;
		},
		wedge() {
			wedged = true;
		},
		async run(signal: AbortSignal) {
			r.runs += 1;
			if (crash) {
				const e = crash;
				crash = undefined;
				throw e;
			}
			for (const c of campIds) leases.add(`cd:camp:${c}`);
			if (wedged) return new Promise<void>(() => {});
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			leases.clear();
		},
		async reconcileOnce(): Promise<ReconcileObservationRecord> {
			throw new Error("not used");
		},
	};
	return r as unknown as FakeReconciler;
}

// ── Facade ─────────────────────────────────────────────────────────────────
export type FacadeState = {
	pipelines: PipelineRecord[];
	available: Record<string, FreightAvailabilityRecord[]>;
	freight: FreightRecord[];
	qualifications: FreightQualifiedRecord[];
	approvals: FreightApprovedRecord[];
	promotions: PromotionRecord[];
	current: Record<string, SetRecord>;
	status: Record<string, ReconcileObservationRecord>;
	camps: CampView[];
	decisions: PlacementDecisionRecord[];
	fanouts: FanoutStatusRecord[];
	failovers: FailoverRecord[];
	compliance: ComplianceRecord[];
	fanoutQualified: Record<string, { campIds: string[]; freightId?: string }>;
};

export type FakeFacade = ContinuousDelivery & {
	readonly calls: string[];
	readonly state: FacadeState;
	/** Make a step throw on its next N calls. */
	failStep(step: string, error: Error, times?: number): void;
	/** Make a step never settle. */
	hangStep(step: string): void;
	readonly retired: RetentionPolicyRecord[];
	readonly feedRequests: FeedRequest[];
};

export function emptyState(): FacadeState {
	return {
		pipelines: [],
		available: {},
		freight: [],
		qualifications: [],
		approvals: [],
		promotions: [],
		current: {},
		status: {},
		camps: [],
		decisions: [],
		fanouts: [],
		failovers: [],
		compliance: [],
		fanoutQualified: {},
	};
}

export function fakeFacade(state: FacadeState = emptyState()): FakeFacade {
	const calls: string[] = [];
	const failures = new Map<string, { error: Error; times: number }>();
	const hangs = new Set<string>();
	const retired: RetentionPolicyRecord[] = [];
	const feedRequests: FeedRequest[] = [];
	const step = (name: string) => async () => {
		calls.push(name);
		if (hangs.has(name)) return new Promise<never>(() => {});
		const f = failures.get(name);
		if (f && f.times > 0) {
			f.times -= 1;
			throw f.error;
		}
		return undefined;
	};
	const feed: DeliveryFeedHandler = {
		pathPrefix: "/v1/cd/",
		async handle(request: FeedRequest): Promise<FeedResponse> {
			feedRequests.push(request);
			return {
				status: 404,
				headers: { "content-type": "application/json" },
				body: new TextEncoder().encode(
					JSON.stringify({
						ok: false,
						reasons: [
							{
								code: "route-unknown",
								message: "feed",
								remediation: "x",
								subject: "",
							},
						],
					}),
				),
			};
		},
	};
	const facade = {
		calls,
		state,
		retired,
		feedRequests,
		failStep(name: string, error: Error, times = 1) {
			failures.set(name, { error, times });
		},
		hangStep(name: string) {
			hangs.add(name);
		},
		sources: { tick: step("sources") },
		inventory: {
			tick: step("inventory"),
			async list(query?: { campSets?: readonly string[] }) {
				calls.push("inventory.list");
				if (!query?.campSets?.length) return state.camps;
				return state.camps.filter((c) =>
					query.campSets?.includes(c.topology.labels.set ?? ""),
				);
			},
			async status(campId: CampId): Promise<CampStatusRecord | undefined> {
				return state.camps.find((c) => c.topology.campId === campId)?.status;
			},
		},
		pipelines: {
			tick: step("pipelines"),
			async get(name: string) {
				return state.pipelines.find((p) => p.name === name);
			},
			async available(input: { pipeline: string; node: string }) {
				return state.available[`${input.pipeline}/${input.node}`] ?? [];
			},
		},
		promotions: {
			tick: step("promotions"),
			async expirePreviews(): Promise<readonly PreviewEnvironmentRecord[]> {
				await step("previews")();
				return [];
			},
			async list(query?: { campId?: CampId; limit?: number }) {
				const rows = state.promotions.filter(
					(p) =>
						query?.campId === undefined ||
						p.targetCampIds.includes(query.campId),
				);
				return query?.limit === undefined ? rows : rows.slice(0, query.limit);
			},
		},
		verification: {
			async tick() {
				await step("verification")();
				return [];
			},
		},
		rollouts: { tick: step("rollouts") },
		fanout: {
			tick: step("fanout"),
			async get(id: string) {
				return state.fanouts.find((f) => f.fanoutId === id);
			},
			async qualified(input: { pipeline: string; node: string }) {
				const q = state.fanoutQualified[`${input.pipeline}/${input.node}`];
				return q
					? {
							qualifiedCampIds: q.campIds,
							...(q.freightId ? { stableFreightId: q.freightId } : {}),
						}
					: { qualifiedCampIds: [] };
			},
		},
		failover: {
			tick: step("failover"),
			async list(query?: { state?: number; limit?: number }) {
				return state.failovers.filter(
					(f) => query?.state === undefined || f.state === query.state,
				);
			},
		},
		posture: {
			tick: step("posture"),
			async compliance(campId: CampId) {
				return state.compliance.filter((c) => c.campId === campId);
			},
		},
		placement: {
			async decision(id: string) {
				return state.decisions.find((d) => d.decisionId === id);
			},
		},
		freight: {
			async retire(policy: RetentionPolicyRecord) {
				await step("retention")();
				retired.push(policy);
				return [];
			},
			async get(id: string) {
				return state.freight.find((f) => f.freightId === id);
			},
			async getByAlias(alias: string) {
				return state.freight.find((f) => f.alias === alias);
			},
			async qualifications(id: string) {
				return state.qualifications.filter((q) => q.freightId === id);
			},
			async approvals(id: string) {
				return state.approvals.filter((a) => a.freightId === id);
			},
		},
		desired: {
			async current(campId: CampId) {
				return state.current[campId];
			},
			async status(campId: CampId) {
				return state.status[campId];
			},
		},
		feed,
	};
	return facade as unknown as FakeFacade;
}

export function topologyOf(camps: readonly CampView[]): TopologyReader {
	return {
		async camps(): Promise<readonly CampTopology[]> {
			return camps.map((c) => c.topology);
		},
		async camp(campId: CampId) {
			return camps.find((c) => c.topology.campId === campId)?.topology;
		},
	};
}

export { create };
