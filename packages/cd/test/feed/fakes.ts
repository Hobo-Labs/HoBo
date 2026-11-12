/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: test fakes brand ids they mint and read controlled fixtures at the test boundary. */
// Test fakes owned by WP11 (plan 0024 §7.3): an indexed in-memory
// DurableEventStore with the SQLite journal's per-stream idempotency, CAS,
// owner-epoch fencing and subscription lease/checkpoint semantics on an
// injected clock; a DesiredStateReader over the spec stream that tails like
// WP4's; a memory ArtifactStore; and recording doubles for the inventory,
// Rails, authorizer, posture, topology and telemetry ports.
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
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
	type CampClaimRecord,
	type CampConditionRecord,
	CampManagement,
	type CampSetRecord,
	type CampStatusRecord,
	CampStatusRecordSchema,
	type ComplianceRecord,
	type PostureFindingRecord,
	type PostureRemediationRecord,
	type RailDeliveryRecord,
	RailDeliveryRecordSchema,
	RailEnrollmentRecordSchema,
	SetOrigin,
	type SetRecord,
	SetRecordSchema,
	type SignalSource,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type {
	ArtifactStore,
	CampId,
	CampInventory,
	CampTopology,
	CampView,
	CdAction,
	CdAuthorizer,
	CdContext,
	DesiredStateChange,
	DesiredStateReader,
	Digest,
	OtelMetricPoint,
	OtelSpan,
	PostureService,
	RailDeliveryReader,
	ReconcilerId,
	TelemetrySink,
	TopologyReader,
} from "../../src/ports.js";

export const T0 = Date.parse("2026-11-12T00:00:00.000Z");
export const TENANT = "acme";

export type Clock = { ms: number; now: () => number; advance: (ms: number) => void };

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

export const asCamp = (id: string): CampId => id as CampId;
export const asReconciler = (id: string): ReconcilerId => id as ReconcilerId;

export function ctxAt(
	clock: Clock,
	principal: CdContext["principal"] = { kind: "user", id: "alice" },
): CdContext {
	return { tenant: TENANT, principal, now: clock.now };
}

// ── Event store ────────────────────────────────────────────────────────────

export type FakeStore = DurableEventStore & {
	readonly log: readonly PositionedEvent[];
	appends: number;
};

type Lease = { holderId: string; fence: bigint; expiresAtMs: number };

export function createFakeStore(clock: Clock): FakeStore {
	const log: PositionedEvent[] = [];
	const byStream = new Map<string, PositionedEvent[]>();
	const byKey = new Map<string, EventEnvelope>();
	const heads = new Map<string, { revision: number; ownerEpoch: bigint }>();
	const handlers = new Set<{ filter: StreamFilter; handler: (event: EventEnvelope) => void | Promise<void> }>();
	const leases = new Map<string, Lease>();
	const checkpoints = new Map<string, SubscriptionCheckpoint>();
	let position = 0n;
	let ids = 0;
	const key = (s: string, p: string) => `${s}\u0000${p}`;
	const iso = (ms: number) => new Date(ms).toISOString();

	const store: FakeStore = {
		log,
		appends: 0,
		async append(streamId: string, events: EventInput[], opts: AppendOptions): Promise<AppendResult> {
			store.appends += 1;
			const deduped: EventEnvelope[] = [];
			const pending: EventInput[] = [];
			const seen = new Set<string>();
			for (const input of events) {
				const k = idempotencyKeyOf(input.meta);
				const existing = k === undefined ? undefined : byKey.get(`${streamId}\u0000${k}`);
				if (existing) deduped.push(existing);
				else if (k !== undefined && seen.has(k)) continue;
				else {
					if (k !== undefined) seen.add(k);
					pending.push(input);
				}
			}
			const head = heads.get(streamId) ?? { revision: 0, ownerEpoch: 0n };
			let nextEpoch = head.ownerEpoch;
			if (head.ownerEpoch > 0n) {
				if (opts.fenceToken === undefined) throw new StaleFenceError(streamId, 0n, head.ownerEpoch);
				if (opts.fenceToken < head.ownerEpoch) throw new StaleFenceError(streamId, opts.fenceToken, head.ownerEpoch);
				nextEpoch = opts.fenceToken;
			} else if (opts.fenceToken !== undefined && opts.fenceToken > 0n) nextEpoch = opts.fenceToken;
			if (pending.length === 0) return { streamId, appended: [], deduped };
			if (head.revision !== opts.expectedSeq)
				throw new OptimisticSequenceConflictError(streamId, opts.expectedSeq, head.revision);
			const appended: EventEnvelope[] = [];
			let first: EventPosition | undefined;
			let last: EventPosition | undefined;
			let seq = head.revision;
			const list = byStream.get(streamId) ?? [];
			byStream.set(streamId, list);
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
				const entry = { position: at, event: envelope };
				log.push(entry);
				list.push(entry);
				const k = idempotencyKeyOf(input.meta);
				if (k !== undefined) byKey.set(`${streamId}\u0000${k}`, envelope);
				appended.push(envelope);
				first ??= at;
				last = at;
			}
			heads.set(streamId, { revision: seq, ownerEpoch: nextEpoch });
			for (const entry of handlers)
				for (const event of appended) if (matches(entry.filter, event)) void entry.handler(event);
			const result: AppendResult = { streamId, appended, deduped };
			if (first !== undefined) result.firstPosition = first;
			if (last !== undefined) result.lastPosition = last;
			return result;
		},
		async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			for (const entry of (byStream.get(streamId) ?? []).slice()) if (entry.event.seq >= fromSeq) yield entry.event;
		},
		subscribe(filter, handler) {
			const entry = { filter, handler };
			handlers.add(entry);
			return { unsubscribe: () => handlers.delete(entry) };
		},
		async snapshot(streamId, state, seq): Promise<SnapshotRecord> {
			return { streamId, state, seq, savedAt: iso(clock.now()) };
		},
		async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
			const source = options.filter?.streamId !== undefined ? (byStream.get(options.filter.streamId) ?? []) : log;
			let count = 0;
			for (const entry of source.slice()) {
				if (options.after !== undefined && entry.position <= options.after) continue;
				if (options.filter && !matches(options.filter, entry.event)) continue;
				if (options.limit !== undefined && count >= options.limit) return;
				count += 1;
				yield entry;
			}
		},
		async commit(request: DurableCommitRequest): Promise<DurableCommitResult> {
			const result = await store.append(request.streamId, [...request.events], request.append);
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
			if (existing && existing.expiresAtMs > now && existing.holderId !== options.holderId)
				throw new StaleFenceError(k, 0n, existing.fence);
			const fence = (existing?.fence ?? 0n) + 1n;
			const lease = { holderId: options.holderId, fence, expiresAtMs: now + (options.leaseTtlMs ?? 30_000) };
			leases.set(k, lease);
			return leaseOf(options.subscriptionId, options.partitionId, lease);
		},
		async renewSubscription(options): Promise<SubscriptionLease> {
			const k = key(options.subscriptionId, options.partitionId);
			const existing = leases.get(k);
			if (
				!existing ||
				existing.holderId !== options.holderId ||
				existing.fence !== options.fenceToken ||
				existing.expiresAtMs <= clock.now()
			)
				throw new StaleFenceError(k, options.fenceToken, existing?.fence ?? 0n);
			existing.expiresAtMs = clock.now() + (options.leaseTtlMs ?? 30_000);
			return leaseOf(options.subscriptionId, options.partitionId, existing);
		},
		async releaseSubscription(options) {
			const existing = leases.get(key(options.subscriptionId, options.partitionId));
			if (existing && existing.holderId === options.holderId && existing.fence === options.fenceToken)
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
				throw new CheckpointRegressionError(options.subscriptionId, options.partitionId, options.position, current.position);
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
	function leaseOf(subscriptionId: string, partitionId: string, lease: Lease): SubscriptionLease {
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
	if (filter.streamId !== undefined && filter.streamId !== event.streamId) return false;
	if (filter.type !== undefined && filter.type !== event.type) return false;
	return true;
}

// ── Artifacts, Sets and desired state ──────────────────────────────────────

export function createMemoryArtifacts(): ArtifactStore & { readonly blobs: Map<string, Uint8Array> } {
	const blobs = new Map<string, Uint8Array>();
	return {
		backend: "memory",
		blobs,
		async put(bytes, meta) {
			const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			blobs.set(digest, bytes);
			return { name: meta.name, kind: meta.kind, mediaType: meta.mediaType, digest, size: BigInt(bytes.byteLength) } as never;
		},
		async get(digest) {
			return blobs.get(digest);
		},
		async has(digest) {
			return blobs.has(digest);
		},
		async *list() {
			for (const digest of blobs.keys()) yield digest as Digest;
		},
		async delete(digest) {
			blobs.delete(digest);
		},
	};
}

export function resolvedFor(campId: string, resources: readonly string[] = ["api"], padding = 0): ResolvedDeploymentSet {
	const plan: DeploymentPlan = {
		schema: "hobo.deployment-plan/v1",
		resources: resources.map((name) => ({
			name,
			port: "compute",
			provider: "fake",
			deps: [],
			realizationParameters: { version: "1", ...(padding > 0 ? { padding: "x".repeat(padding) } : {}) },
		})),
		dependencyOrder: [...resources],
		objective: "test",
	} as DeploymentPlan;
	return createResolvedDeploymentSet({
		tenant: TENANT,
		environment: "prod",
		campId,
		plan,
		matches: [],
		gatekeeper: { decision: "allow", gatekeeperDecisionId: "gate-1", obligations: [], decidedAt: new Date(T0).toISOString() },
		secretRefs: ["secretref://target/db-password"],
	});
}

export function blobOf(resolved: ResolvedDeploymentSet): Uint8Array {
	return new TextEncoder().encode(canonical(resolved));
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.filter((k) => object[k] !== undefined)
		.sort()
		.map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
		.join(",")}}`;
}

export type FakeDesired = DesiredStateReader & {
	publish(campId: string, resolved: ResolvedDeploymentSet, opts?: { storeBlob?: boolean; management?: CampManagement }): Promise<SetRecord>;
};

export function createFakeDesired(store: FakeStore, artifacts: ReturnType<typeof createMemoryArtifacts>): FakeDesired {
	const sets = new Map<string, SetRecord>();
	let n = 0;
	function changeOf(position: EventPosition, event: EventEnvelope): DesiredStateChange {
		const data = event.data as { setId: string; management?: number };
		const set = sets.get(data.setId);
		if (!set) throw new Error(`unknown set ${data.setId}`);
		return { position, set, observeFields: [], management: data.management ?? CampManagement.MANAGED };
	}
	const reader: FakeDesired = {
		async publish(campId, resolved, opts = {}) {
			n += 1;
			const bytes = blobOf(resolved);
			const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			if (opts.storeBlob !== false) artifacts.blobs.set(digest, bytes);
			const set = create(SetRecordSchema, {
				schemaVersion: "hobo.cd.set/v1",
				setId: `set_${campId}_${n}`,
				tenant: TENANT,
				environment: "prod",
				campId,
				planHash: resolved.planHash,
				contentHash: resolved.contentHash,
				gateDecisionId: `gate-${n}`,
				origin: SetOrigin.PROMOTION,
				resolvedSetDigest: digest,
				resolvedSetBytes: BigInt(bytes.byteLength),
				createdAt: new Date(T0 + n).toISOString(),
			});
			sets.set(set.setId, set);
			const stream = CD_STREAMS.campSpec(campId);
			await store.append(
				stream,
				[{ type: CD_EVENTS.SetCreated, data: { setId: set.setId, management: opts.management ?? CampManagement.MANAGED } }],
				{ expectedSeq: store.getStreamHead?.(stream)?.revision ?? 0, actor: { kind: "system", id: "test" }, tenant: TENANT },
			);
			return set;
		},
		async current(campId) {
			return [...(await reader.history(campId))].at(0);
		},
		async get(setId) {
			return sets.get(setId);
		},
		async history(campId, limit = 50) {
			const out: SetRecord[] = [];
			for await (const { event } of store.readAll({ filter: { streamId: CD_STREAMS.campSpec(campId) } })) {
				const set = sets.get((event.data as { setId: string }).setId);
				if (set) out.unshift(set);
			}
			return out.slice(0, limit);
		},
		async resolved() {
			throw new Error("not used by the feed");
		},
		async status() {
			return undefined;
		},
		async *changes(input) {
			let after = input.after;
			for (;;) {
				for (const campId of input.campIds)
					for await (const { position, event } of store.readAll({
						filter: { streamId: CD_STREAMS.campSpec(campId) },
						...(after !== undefined ? { after } : {}),
					})) {
						after = position;
						yield changeOf(position, event);
					}
				if (input.signal.aborted) return;
				await new Promise<void>((resolve) => {
					const subs = input.campIds.map((campId) =>
						store.subscribe({ streamId: CD_STREAMS.campSpec(campId) }, () => done()),
					);
					const done = () => {
						for (const s of subs) s.unsubscribe();
						input.signal.removeEventListener("abort", done);
						resolve();
					};
					input.signal.addEventListener("abort", done, { once: true });
				});
				if (input.signal.aborted) return;
			}
		},
	};
	return reader;
}

// ── Inventory, Rails, authorizer, posture, topology, telemetry ────────────

export type Observed = Readonly<{
	campId: string;
	source: SignalSource;
	conditions: readonly CampConditionRecord[];
	claims: readonly CampClaimRecord[];
	principal: string;
}>;

export function createFakeInventory(sets: Readonly<Record<string, readonly string[]>>): CampInventory & {
	readonly observed: Observed[];
} {
	const observed: Observed[] = [];
	const view = (campId: string): CampView => ({
		topology: {
			campId: asCamp(campId),
			yardId: "yard-1",
			stationId: "station-1",
			provider: "fake",
			regions: ["eu-west-1"],
			envType: "prod",
			labels: {},
			management: CampManagement.MANAGED,
		},
		status: create(CampStatusRecordSchema, { campId, management: CampManagement.MANAGED }),
	});
	return {
		observed,
		async status(campId) {
			return create(CampStatusRecordSchema, { campId });
		},
		async list(query) {
			const names = query?.campSets ?? Object.keys(sets);
			const ids = new Set(names.flatMap((name) => sets[name] ?? []));
			return [...ids].sort().map(view);
		},
		async observe(input, ctx) {
			observed.push({ ...input, principal: `${ctx.principal.kind}:${ctx.principal.id}` });
			return { ok: true, value: create(CampStatusRecordSchema, { campId: input.campId }) };
		},
		async taint() {
			throw new Error("not used");
		},
		async untaint() {
			throw new Error("not used");
		},
		async manage() {
			throw new Error("not used");
		},
		async defineSet(set: CampSetRecord) {
			return { ok: true, value: set };
		},
		async sets() {
			return [];
		},
		async snapshot() {
			throw new Error("not used");
		},
		async tick() {},
	} satisfies CampInventory & { observed: Observed[] };
}

export function railWith(enrollment?: { separateApprovers: boolean; autoAcceptScopes?: readonly string[] }): RailDeliveryRecord {
	return create(RailDeliveryRecordSchema, {
		railDigest: `sha256:${"a".repeat(64)}`,
		...(enrollment
			? {
					enrollment: create(RailEnrollmentRecordSchema, {
						separateApprovers: enrollment.separateApprovers,
						autoAcceptScopes: [...(enrollment.autoAcceptScopes ?? [])],
					}),
				}
			: {}),
	});
}

export function createFakeRails(rail?: RailDeliveryRecord): RailDeliveryReader {
	return {
		async forStation() {
			return rail;
		},
		async forCamp() {
			return rail;
		},
	};
}

export type Decision = Readonly<{ action: CdAction; principal: string; subject: JsonObject }>;

export function createFakeAuthorizer(deny: readonly CdAction[] = []): CdAuthorizer & { readonly decisions: Decision[] } {
	const decisions: Decision[] = [];
	return {
		decisions,
		async authorize(action, subject, ctx) {
			decisions.push({ action, principal: `${ctx.principal.kind}:${ctx.principal.id}`, subject });
			if (deny.includes(action))
				return { ok: false, reasons: [{ code: "policy-denied", message: `${action} denied`, remediation: "ask", subject: action } as never] };
			return {
				ok: true,
				value: { decisionId: `dec-${decisions.length}`, proposalOnly: ctx.principal.kind === "agent" },
			};
		},
	};
}

export function createFakePosture(fields: readonly string[] = []): PostureService {
	return {
		async compliance(): Promise<readonly ComplianceRecord[]> {
			return [];
		},
		async observeFields() {
			return fields;
		},
		async conflicts(): Promise<readonly PostureFindingRecord[]> {
			return [];
		},
		async remediations(): Promise<readonly PostureRemediationRecord[]> {
			return [];
		},
		async tick() {},
	};
}

export function createFakeTopology(campIds: readonly string[], observeOnly: readonly string[] = []): TopologyReader {
	const camp = (campId: string): CampTopology => ({
		campId: asCamp(campId),
		yardId: "yard-1",
		stationId: "station-1",
		provider: "fake",
		regions: ["eu-west-1"],
		envType: "prod",
		labels: {},
		management: observeOnly.includes(campId) ? CampManagement.OBSERVE_ONLY : CampManagement.MANAGED,
	});
	return {
		async camps() {
			return campIds.map(camp);
		},
		async camp(campId) {
			return campIds.includes(campId) ? camp(campId) : undefined;
		},
	};
}

export function createRecordingTelemetry(): TelemetrySink & { readonly points: OtelMetricPoint[]; readonly spanLog: OtelSpan[] } {
	const points: OtelMetricPoint[] = [];
	const spanLog: OtelSpan[] = [];
	return {
		points,
		spanLog,
		async spans(spans) {
			spanLog.push(...spans);
		},
		async metrics(batch) {
			points.push(...batch);
		},
	};
}

export function statusOf(campId: string): CampStatusRecord {
	return create(CampStatusRecordSchema, { campId });
}
