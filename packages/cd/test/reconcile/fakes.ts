// Test fakes owned by WP7 (plan 0024 §7.3): an in-memory DurableEventStore with
// the SQLite journal's CAS, idempotency, owner-epoch fencing and subscription
// lease/checkpoint semantics on an injected clock; a DesiredStateReader over
// the spec stream; a target-modelling Realizer that counts mutating calls; and
// a recording TelemetrySink.
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	type DeploymentPlan,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import {
	type AppendOptions,
	type AppendResult,
	CheckpointRegressionError,
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	type FenceToken,
	type JsonObject,
	OptimisticSequenceConflictError,
	type PartitionId,
	type PositionedEvent,
	type ReadAllOptions,
	type SnapshotRecord,
	StaleFenceError,
	type StreamFilter,
	type SubscriptionCheckpoint,
	type SubscriptionId,
	type SubscriptionLease,
} from "@hobo/core";
import {
	CampManagement,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type ResourceObservation,
	ResourceObservationSchema,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type {
	CampId,
	CdContext,
	DesiredStateChange,
	DesiredStateReader,
	OtelMetricPoint,
	RealizeInput,
	Realizer,
	ReconcilerId,
	SetId,
	TelemetrySink,
} from "../../src/ports.js";

export const T0 = Date.parse("2026-11-12T00:00:00.000Z");
export const TENANT = "acme";

export type Clock = {
	ms: number;
	now: () => number;
	advance: (ms: number) => void;
};

export function createClock(start = T0): Clock {
	const clock: Clock = {
		ms: start,
		now: () => clock.ms,
		advance: (ms) => {
			clock.ms += ms;
		},
	};
	return clock;
}

export function ctxAt(clock: Clock, signal?: AbortSignal): CdContext {
	return {
		tenant: TENANT,
		principal: { kind: "service", id: "test" },
		now: clock.now,
		...(signal ? { signal } : {}),
	};
}

export const asCamp = (id: string): CampId => id as CampId;
export const asReconciler = (id: string): ReconcilerId => id as ReconcilerId;

export type FakeStore = DurableEventStore & {
	readonly log: readonly PositionedEvent[];
	/** Called before each append's CAS check; lets a test crash or interleave. */
	beforeAppend?:
		| ((
				streamId: string,
				events: readonly EventInput[],
		  ) => void | Promise<void>)
		| undefined;
};

type Lease = { holderId: string; fence: bigint; expiresAtMs: number };

export function createFakeStore(clock: Clock): FakeStore {
	const log: PositionedEvent[] = [];
	const heads = new Map<string, { revision: number; ownerEpoch: bigint }>();
	const handlers = new Set<{
		filter: StreamFilter;
		handler: (event: EventEnvelope) => void | Promise<void>;
	}>();
	const leases = new Map<string, Lease>();
	const checkpoints = new Map<string, SubscriptionCheckpoint>();
	let position = 0n;
	let ids = 0;
	const key = (s: string, p: string) => `${s}\u0000${p}`;
	const iso = (ms: number) => new Date(ms).toISOString();

	const store: FakeStore = {
		log,
		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			if (store.beforeAppend) await store.beforeAppend(streamId, events);
			const deduped: EventEnvelope[] = [];
			const pending: EventInput[] = [];
			for (const input of events) {
				const k = idempotencyKeyOf(input.meta);
				const existing =
					k === undefined
						? undefined
						: log.find(
								(e) =>
									e.event.streamId === streamId &&
									idempotencyKeyOf(e.event.meta) === k,
							);
				if (existing) deduped.push(existing.event);
				else pending.push(input);
			}
			const head = heads.get(streamId) ?? { revision: 0, ownerEpoch: 0n };
			let nextEpoch = head.ownerEpoch;
			if (head.ownerEpoch > 0n) {
				if (opts.fenceToken === undefined)
					throw new StaleFenceError(streamId, 0n, head.ownerEpoch);
				if (opts.fenceToken < head.ownerEpoch)
					throw new StaleFenceError(streamId, opts.fenceToken, head.ownerEpoch);
				nextEpoch = opts.fenceToken;
			} else if (opts.fenceToken !== undefined && opts.fenceToken > 0n)
				nextEpoch = opts.fenceToken;
			if (pending.length === 0) return { streamId, appended: [], deduped };
			if (head.revision !== opts.expectedSeq)
				throw new OptimisticSequenceConflictError(
					streamId,
					opts.expectedSeq,
					head.revision,
				);
			const appended: EventEnvelope[] = [];
			let first: EventPosition | undefined;
			let last: EventPosition | undefined;
			let seq = head.revision;
			for (const input of pending) {
				seq += 1;
				position += 1n;
				ids += 1;
				const envelope: EventEnvelope = {
					id: `evt-${ids}`,
					type: input.type,
					v: input.v ?? 1,
					streamId,
					seq,
					ts: iso(clock.now()),
					actor: opts.actor,
					tenant: opts.tenant,
					data: structuredClone(input.data ?? {}),
				};
				if (input.meta !== undefined) envelope.meta = input.meta;
				const at = position as EventPosition;
				log.push({ position: at, event: envelope });
				appended.push(envelope);
				first ??= at;
				last = at;
			}
			heads.set(streamId, { revision: seq, ownerEpoch: nextEpoch });
			for (const entry of handlers)
				for (const event of appended)
					if (matches(entry.filter, event)) void entry.handler(event);
			const result: AppendResult = { streamId, appended, deduped };
			if (first !== undefined) result.firstPosition = first;
			if (last !== undefined) result.lastPosition = last;
			return result;
		},
		async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			for (const entry of log.slice())
				if (entry.event.streamId === streamId && entry.event.seq >= fromSeq)
					yield entry.event;
		},
		subscribe(filter, handler) {
			const entry = { filter, handler };
			handlers.add(entry);
			return { unsubscribe: () => handlers.delete(entry) };
		},
		async snapshot(streamId, state, seq): Promise<SnapshotRecord> {
			return { streamId, state, seq, savedAt: iso(clock.now()) };
		},
		async *readAll(
			options: ReadAllOptions = {},
		): AsyncIterable<PositionedEvent> {
			let count = 0;
			for (const entry of log.slice()) {
				if (options.after !== undefined && entry.position <= options.after)
					continue;
				if (options.filter && !matches(options.filter, entry.event)) continue;
				if (options.limit !== undefined && count >= options.limit) return;
				count += 1;
				yield entry;
			}
		},
		async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
			const result = await store.append(
				request.streamId,
				[...request.events],
				request.append,
			);
			return { ...result, effects: [] };
		},
		getStreamHead(streamId: string) {
			const head = heads.get(streamId) ?? { revision: 0, ownerEpoch: 0n };
			return { streamId, revision: head.revision, ownerEpoch: head.ownerEpoch };
		},
		async claimSubscription(options): Promise<SubscriptionLease> {
			const k = key(options.subscriptionId, options.partitionId);
			const existing = leases.get(k);
			const now = clock.now();
			if (
				existing &&
				existing.expiresAtMs > now &&
				existing.holderId !== options.holderId
			)
				throw new StaleFenceError(k, 0n, existing.fence);
			const fence = (existing?.fence ?? 0n) + 1n;
			const lease = {
				holderId: options.holderId,
				fence,
				expiresAtMs: now + (options.leaseTtlMs ?? 30_000),
			};
			leases.set(k, lease);
			return leaseOf(options.subscriptionId, options.partitionId, lease);
		},
		async renewSubscription(options): Promise<SubscriptionLease> {
			const k = key(options.subscriptionId, options.partitionId);
			const existing = leases.get(k);
			if (
				!existing ||
				existing.holderId !== options.holderId ||
				existing.fence !== options.fenceToken
			)
				throw new StaleFenceError(k, options.fenceToken, existing?.fence ?? 0n);
			existing.expiresAtMs = clock.now() + (options.leaseTtlMs ?? 30_000);
			return leaseOf(options.subscriptionId, options.partitionId, existing);
		},
		async releaseSubscription(options) {
			const k = key(options.subscriptionId, options.partitionId);
			const existing = leases.get(k);
			if (
				existing &&
				existing.holderId === options.holderId &&
				existing.fence === options.fenceToken
			)
				existing.expiresAtMs = 0;
		},
		async loadCheckpoint(options) {
			return checkpoints.get(key(options.subscriptionId, options.partitionId));
		},
		async commitCheckpoint(options) {
			const k = key(options.subscriptionId, options.partitionId);
			const lease = leases.get(k);
			if (!lease || lease.fence !== options.fenceToken)
				throw new StaleFenceError(k, options.fenceToken, lease?.fence ?? 0n);
			const current = checkpoints.get(k);
			if (current && options.position < current.position)
				throw new CheckpointRegressionError(
					options.subscriptionId,
					options.partitionId,
					options.position,
					current.position,
				);
			const checkpoint: SubscriptionCheckpoint = {
				subscriptionId: options.subscriptionId as SubscriptionId,
				partitionId: options.partitionId as PartitionId,
				position: options.position as EventPosition,
				fenceToken: options.fenceToken as FenceToken,
				updatedAt: iso(clock.now()),
			};
			checkpoints.set(k, checkpoint);
			return checkpoint;
		},
	};
	function leaseOf(
		subscriptionId: string,
		partitionId: string,
		lease: Lease,
	): SubscriptionLease {
		return {
			subscriptionId: subscriptionId as SubscriptionId,
			partitionId: partitionId as PartitionId,
			holderId: lease.holderId,
			fenceToken: lease.fence as FenceToken,
			expiresAt: iso(lease.expiresAtMs),
		};
	}
	return store;
}

function idempotencyKeyOf(meta: JsonObject | undefined): string | undefined {
	const k = meta?.idempotencyKey;
	return typeof k === "string" && k !== "" ? k : undefined;
}

function matches(filter: StreamFilter, event: EventEnvelope): boolean {
	if (filter.streamId !== undefined && filter.streamId !== event.streamId)
		return false;
	if (filter.type !== undefined && filter.type !== event.type) return false;
	return true;
}

// ── Sets and resolved sets ─────────────────────────────────────────────────

export type ResourceSpec = Readonly<{
	name: string;
	port?: string;
	provider?: string;
	deps?: readonly string[];
	version?: string;
	retain?: string;
}>;

export function resolvedFor(
	campId: string,
	resources: readonly ResourceSpec[],
): ResolvedDeploymentSet {
	const plan: DeploymentPlan = {
		schema: "hobo.deployment-plan/v1",
		resources: resources.map((r) => ({
			name: r.name,
			port: r.port ?? "compute",
			provider: r.provider ?? "fake",
			deps: [...(r.deps ?? [])],
			realizationParameters: {
				version: r.version ?? "1",
				...(r.retain ? { "hobo.cd/retain": r.retain } : {}),
			},
		})),
		dependencyOrder: resources.map((r) => r.name),
		objective: "test",
	};
	return createResolvedDeploymentSet({
		tenant: TENANT,
		environment: "prod",
		campId,
		plan,
		matches: [],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "gate-1",
			obligations: [],
			decidedAt: new Date(T0).toISOString(),
		},
	});
}

export function setFor(
	campId: string,
	resolved: ResolvedDeploymentSet,
	n: number,
	origin: SetOrigin = SetOrigin.PROMOTION,
): SetRecord {
	return create(SetRecordSchema, {
		schemaVersion: "hobo.cd.set/v1",
		setId: `set_${campId.replace(/[^a-z0-9]/g, "")}${String(n).padStart(8, "0")}`,
		tenant: TENANT,
		environment: "prod",
		campId,
		planHash: resolved.planHash,
		contentHash: resolved.contentHash,
		gateDecisionId: `gate-${n}`,
		origin,
		resolvedSetDigest: resolved.contentHash,
		resolvedSetBytes: 1n,
		createdAt: new Date(T0 + n).toISOString(),
	});
}

/** A DesiredStateReader over set.Created events on the spec stream (tails like WP4). */
export type FakeDesired = DesiredStateReader & {
	readonly blobs: Map<string, ResolvedDeploymentSet>;
	publish(
		set: SetRecord,
		resolved: ResolvedDeploymentSet | undefined,
		management?: CampManagement,
	): Promise<void>;
};

export function createFakeDesired(
	store: FakeStore,
	observeFields: readonly string[] = [],
): FakeDesired {
	const blobs = new Map<string, ResolvedDeploymentSet>();
	const sets = new Map<string, SetRecord>();
	async function publish(
		set: SetRecord,
		resolved: ResolvedDeploymentSet | undefined,
		management = CampManagement.MANAGED,
	) {
		if (resolved) blobs.set(set.resolvedSetDigest, resolved);
		sets.set(set.setId, set);
		const stream = CD_STREAMS.campSpec(set.campId);
		const head = store.getStreamHead?.(stream);
		await store.append(
			stream,
			[
				{
					type: CD_EVENTS.SetCreated,
					data: { set: toJson(SetRecordSchema, set) as JsonObject, management },
				},
			],
			{
				expectedSeq: head?.revision ?? 0,
				actor: { kind: "service", id: "promotion" },
				tenant: TENANT,
			},
		);
	}
	const reader: FakeDesired = {
		blobs,
		publish,
		async current(campId) {
			let out: SetRecord | undefined;
			for await (const e of store.read(CD_STREAMS.campSpec(campId)))
				out = fromJson(SetRecordSchema, (e.data as JsonObject).set ?? null);
			return out;
		},
		async get(setId: SetId) {
			return sets.get(setId);
		},
		async history() {
			return [];
		},
		async resolved(set) {
			const blob = blobs.get(set.resolvedSetDigest);
			if (!blob)
				throw new Error(
					`resolved-set-missing: no blob ${set.resolvedSetDigest}`,
				);
			return blob;
		},
		async status() {
			return undefined;
		},
		async *changes(input): AsyncIterable<DesiredStateChange> {
			let cursor: EventPosition | undefined;
			while (!input.signal.aborted) {
				for await (const { position, event } of store.readAll(
					cursor === undefined ? {} : { after: cursor },
				)) {
					cursor = position;
					if (event.type !== CD_EVENTS.SetCreated) continue;
					const campId = input.campIds.find(
						(c) => CD_STREAMS.campSpec(c) === event.streamId,
					);
					if (campId === undefined) continue;
					if (input.after !== undefined && position <= input.after) continue;
					const data = event.data as JsonObject;
					yield {
						position,
						set: fromJson(SetRecordSchema, data.set ?? null),
						observeFields,
						management:
							(data.management as CampManagement | undefined) ??
							CampManagement.MANAGED,
					};
					if (input.signal.aborted) return;
				}
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5);
					input.signal.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true },
					);
				});
			}
		},
	};
	return reader;
}

// ── Realizer modelling a target ────────────────────────────────────────────

export type TargetResource = {
	hash: string;
	kind: string;
	classification: string;
	attributes: Record<string, string>;
	driftKind: string;
	retained: string[];
};

export type FakeRealizer = Realizer & {
	readonly target: Map<string, TargetResource>;
	appliedSetId: string;
	converges: number;
	observes: number;
	mutatingCalls: string[];
	lastKeep: readonly string[];
	/** Resources whose converge leaves drift in place (flapping). */
	stuck: Set<string>;
	/** Make the next converge throw after applying (crash between execute and observe). */
	crashAfterApply: boolean;
	failConverge?: string | undefined;
	ignoreKeep: boolean;
};

function resourceHash(
	r: ResolvedDeploymentSet["plan"]["resources"][number],
): string {
	return `${r.port}:${String(r.realizationParameters?.version ?? "")}`;
}

export function createFakeRealizer(
	opts: { classification?: Readonly<Record<string, string>> } = {},
): FakeRealizer {
	const realizer: FakeRealizer = {
		target: new Map(),
		appliedSetId: "",
		converges: 0,
		observes: 0,
		mutatingCalls: [],
		lastKeep: [],
		stuck: new Set(),
		crashAfterApply: false,
		ignoreKeep: false,
		async converge(input: RealizeInput, _ctx: CdContext) {
			realizer.converges += 1;
			if (realizer.failConverge) throw new Error(realizer.failConverge);
			const keep = new Set(
				(input as RealizeInput & { keep?: readonly string[] }).keep ?? [],
			);
			realizer.lastKeep = [...keep];
			const declared = new Set(
				input.resolved.plan.resources.map((r) => r.name),
			);
			for (const r of input.resolved.plan.resources) {
				const existing = realizer.target.get(r.name);
				const hash = resourceHash(r);
				if (realizer.stuck.has(r.name) && existing) continue;
				if (existing && existing.hash === hash && existing.driftKind === "")
					continue;
				realizer.mutatingCalls.push(`apply:${r.name}`);
				realizer.target.set(r.name, {
					hash,
					kind: r.port,
					classification: opts.classification?.[r.name] ?? "",
					attributes: existing?.attributes ?? {},
					driftKind: "",
					retained: [],
				});
			}
			for (const name of [...realizer.target.keys()]) {
				if (declared.has(name)) continue;
				if (keep.has(name) && !realizer.ignoreKeep) continue;
				realizer.mutatingCalls.push(`delete:${name}`);
				realizer.target.delete(name);
			}
			realizer.appliedSetId = input.desired.setId;
			if (realizer.crashAfterApply) {
				realizer.crashAfterApply = false;
				throw new Error("process crashed after execute");
			}
			return realizer.observe(input, _ctx);
		},
		async observe(input: RealizeInput) {
			realizer.observes += 1;
			const resources: ResourceObservation[] = [];
			let converged = realizer.appliedSetId === input.desired.setId;
			for (const r of input.resolved.plan.resources) {
				const t = realizer.target.get(r.name);
				if (!t || t.hash !== resourceHash(r)) {
					converged = false;
				}
			}
			for (const [name, t] of realizer.target) {
				resources.push(
					create(ResourceObservationSchema, {
						resource: name,
						physicalId: `phys-${name}`,
						outputsHash: t.hash,
						healthy: true,
						driftKind: t.driftKind,
						kind: t.kind,
						classification: t.classification,
						attributes: { ...t.attributes },
						retained: [...t.retained],
					}),
				);
			}
			const drifted = resources.some((r) => r.driftKind !== "");
			return create(ReconcileObservationRecordSchema, {
				setId: realizer.appliedSetId,
				status: converged
					? drifted
						? ReconcileStatus.DRIFTED
						: ReconcileStatus.CONVERGED
					: ReconcileStatus.CONVERGING,
				resources,
			});
		},
	};
	return realizer;
}

export type RecordingSink = TelemetrySink & {
	readonly points: OtelMetricPoint[];
};

export function createRecordingSink(): RecordingSink {
	const points: OtelMetricPoint[] = [];
	return {
		points,
		async spans() {},
		async metrics(batch) {
			points.push(...batch);
		},
	};
}

export function statusEvents(
	store: FakeStore,
	campId: string,
): readonly EventEnvelope[] {
	return store.log
		.filter((e) => e.event.streamId === CD_STREAMS.campStatus(campId))
		.map((e) => e.event);
}

export function observationOf(
	event: EventEnvelope,
): ReconcileObservationRecord {
	return fromJson(
		ReconcileObservationRecordSchema,
		(event.data as JsonObject).observation ?? null,
	);
}
