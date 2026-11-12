// Test doubles for the WP24 posture tests. Each models the frozen port it
// stands in for (src/ports.ts, @hobo/core eventstore); none is reachable from
// production code.
import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import { createResolvedDeploymentSet } from "@hobo/cloud";
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
	type StreamHead,
	type Subscription,
} from "@hobo/core";
import {
	CampManagement,
	type CampStatusRecord,
	CampStatusRecordSchema,
	type DeltaRecord,
	type FreightRecord,
	FreightRecordSchema,
	FreightSubject,
	type RailDeliveryRecord,
	RailDeliveryRecordSchema,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	RemediationMode,
	type SetRecord,
	SetRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type {
	CampId,
	CampInventory,
	CampTopology,
	CampView,
	CdAction,
	CdAuthorizer,
	CdContext,
	DeltaLedger,
	DesiredStateReader,
	Digest,
	FreightId,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	PromotionId,
	RailDeliveryReader,
	SetId,
	TelemetrySink,
} from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const STATION: PrincipalRef = { kind: "service", id: "station-eu" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

export function camp(id: string): CampId {
	// SAFETY: test fixture ids are literal Camp ids.
	return id as CampId;
}

export function promotion(id: string): PromotionId {
	// SAFETY: test fixture ids are literal promotion ids.
	return id as PromotionId;
}

export function digest(char: string): Digest {
	return `sha256:${char.repeat(64)}`;
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

const tagOf = Object.prototype.toString;

/**
 * In-memory DurableEventStore with conformance-suite semantics: per-stream
 * expected-seq CAS (a stale expectedSeq throws the core conflict error),
 * per-stream idempotency-key dedup checked before the CAS, and monotonic
 * positions for readAll.
 */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	readonly all: PositionedEvent[] = [];
	private nextId = 1;
	/** Test hook: runs before the CAS check of the next append (a concurrent writer). */
	beforeAppend: (() => Promise<void>) | undefined;

	async append(
		streamId: string,
		events: EventInput[],
		opts: AppendOptions,
	): Promise<AppendResult> {
		const hook = this.beforeAppend;
		this.beforeAppend = undefined;
		if (hook) await hook();
		const stream = this.streams.get(streamId) ?? [];
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing =
				tagOf.call(key) === "[object String]"
					? stream.find((event) => event.meta?.idempotencyKey === key)
					: undefined;
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
				ts: new Date(T0).toISOString(),
				actor: opts.actor,
				tenant: opts.tenant,
				data: structuredClone(input.data),
			};
			if (input.meta) envelope.meta = structuredClone(input.meta);
			// SAFETY: test double; positions are minted from a monotonic counter.
			const position = BigInt(this.nextId) as EventPosition;
			this.nextId += 1;
			stream.push(envelope);
			this.all.push({ position, event: envelope });
			appended.push(envelope);
		}
		this.streams.set(streamId, stream);
		return {
			streamId,
			appended,
			deduped,
			firstPosition: this.all[this.all.length - appended.length]?.position,
			lastPosition: this.all[this.all.length - 1]?.position,
		};
	}

	async *read(streamId: string, fromSeq = 0): AsyncIterable<EventEnvelope> {
		for (const event of this.streams.get(streamId) ?? [])
			if (event.seq > fromSeq) yield event;
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

	getStreamHead(streamId: string): StreamHead | undefined {
		const stream = this.streams.get(streamId);
		return { streamId, revision: stream?.length ?? 0, ownerEpoch: 0n };
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

	ofType(type: string): readonly EventEnvelope[] {
		return this.all
			.map((entry) => entry.event)
			.filter((event) => event.type === type);
	}

	/** Append raw facts another module owns (freight, pipelines, status). */
	async put(
		streamId: string,
		type: string,
		data: JsonObject,
		actor: PrincipalRef = STATION,
	): Promise<EventPosition> {
		const result = await this.append(streamId, [{ type, data }], {
			expectedSeq: this.events(streamId).length,
			actor,
			tenant: TENANT,
		});
		const position = result.lastPosition;
		if (position === undefined) throw new Error("no position");
		return position;
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

export type AuthorizerCall = Readonly<{
	action: CdAction;
	subject: JsonObject;
	principal: PrincipalRef;
}>;

export class RecordingAuthorizer implements CdAuthorizer {
	readonly calls: AuthorizerCall[] = [];
	readonly deny = new Set<CdAction>();
	readonly proposalOnly = new Set<CdAction>();
	async authorize(action: CdAction, subject: JsonObject, ctx: CdContext) {
		this.calls.push({ action, subject, principal: ctx.principal });
		if (this.deny.has(action))
			return {
				ok: false as const,
				reasons: [
					{
						$typeName: "hobo.cd.v1.ReasonRecord" as const,
						code: "authz-denied",
						message: `${action} denied`,
						remediation: "ask an administrator for the grant",
						subject: action,
					},
				],
			};
		return {
			ok: true as const,
			value: {
				decisionId: `dec-${this.calls.length}`,
				proposalOnly: this.proposalOnly.has(action),
			},
		};
	}
}

/** A Rail Freight record (subject RAIL; bindle = Rail id, declaration hash = Rail digest). */
export function railFreight(
	railDigest: Digest,
	id = `sha256:${railDigest.slice(7, 15).padEnd(64, "0")}`,
): FreightRecord {
	return create(FreightRecordSchema, {
		schemaVersion: "hobo.cd.freight/v1",
		freightId: id,
		alias: "brave-otter",
		manifest: {
			schemaVersion: "hobo.freight-manifest/v1",
			bindle: "rail-eu",
			declarationHash: railDigest,
			subject: FreightSubject.RAIL,
		},
		recordedBy: "user:ops@acme",
		recordedAt: new Date(T0).toISOString(),
	});
}

export function freightId(record: FreightRecord): FreightId {
	// SAFETY: test fixture.
	return record.freightId as FreightId;
}

export function topology(
	id: string,
	management = CampManagement.MANAGED,
): CampTopology {
	return {
		campId: camp(id),
		yardId: "yard-eu",
		stationId: "station-eu",
		provider: "cloudflare",
		regions: ["eu-west-1"],
		envType: "prod",
		labels: {},
		management,
	};
}

export class FakeInventory implements Pick<CampInventory, "list" | "observe"> {
	readonly views: CampView[] = [];
	readonly observed: Parameters<CampInventory["observe"]>[0][] = [];
	add(id: string, management = CampManagement.MANAGED): void {
		this.views.push({
			topology: topology(id, management),
			status: create(CampStatusRecordSchema, { campId: id, management }),
		});
	}
	async list(): Promise<readonly CampView[]> {
		return this.views;
	}
	async observe(
		input: Parameters<CampInventory["observe"]>[0],
	): Promise<Outcome<CampStatusRecord>> {
		this.observed.push(input);
		return {
			ok: true,
			value: create(CampStatusRecordSchema, { campId: input.campId }),
		};
	}
}

export function railDelivery(
	railDigest: Digest,
	posture: readonly Readonly<{
		pack: string;
		remediation: RemediationMode;
		compliantMs?: number;
		noncompliantMs?: number;
	}>[],
): RailDeliveryRecord {
	return create(RailDeliveryRecordSchema, {
		railDigest,
		posture: posture.map((p) => ({
			pack: p.pack,
			remediation: p.remediation,
			compliantIntervalMs: BigInt(p.compliantMs ?? 0),
			noncompliantIntervalMs: BigInt(p.noncompliantMs ?? 0),
		})),
	});
}

export class FakeRails implements RailDeliveryReader {
	readonly byCamp = new Map<string, RailDeliveryRecord>();
	readonly byDigest = new Map<string, RailDeliveryRecord>();
	async forStation(): Promise<RailDeliveryRecord | undefined> {
		return undefined;
	}
	async forCamp(campId: CampId): Promise<RailDeliveryRecord | undefined> {
		return this.byCamp.get(campId);
	}
	async forDigest(railDigest: Digest): Promise<RailDeliveryRecord | undefined> {
		return this.byDigest.get(railDigest);
	}
}

/** One plan resource in a test Set: name, provider and realization parameters. */
export type PlanResource = Readonly<{ name: string; parameters?: JsonObject }>;

export function resolvedSet(
	campId: string,
	resources: readonly PlanResource[],
	setId = "set_base",
): ResolvedDeploymentSet {
	return createResolvedDeploymentSet({
		tenant: TENANT,
		environment: "prod",
		campId,
		setId,
		plan: {
			schema: "hobo.deployment-plan/v1",
			resources: resources.map((r) => ({
				name: r.name,
				port: "hosting",
				provider: "cloudflare",
				deps: [],
				productId: "cloudflare.workers",
				...(r.parameters ? { realizationParameters: r.parameters } : {}),
			})),
			dependencyOrder: resources.map((r) => r.name),
			objective: "balanced",
		},
		matches: [],
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: "gk-1",
			obligations: [],
			decidedAt: new Date(T0).toISOString(),
		},
	});
}

/** DesiredStateReader & DeltaLedger: Sets per Camp and a record of every Delta call. */
export class FakeDesired implements DesiredStateReader, DeltaLedger {
	readonly sets = new Map<
		string,
		{ record: SetRecord; resolved: ResolvedDeploymentSet }
	>();
	readonly opened: DeltaRecord[] = [];
	readonly applied: unknown[] = [];
	refuseOpen = false;
	seed(
		campId: string,
		resolved: ResolvedDeploymentSet,
		freight = "sha256:feed",
	): SetRecord {
		const record = create(SetRecordSchema, {
			schemaVersion: "hobo.cd.set/v1",
			setId: resolved.setId,
			tenant: TENANT,
			environment: "prod",
			campId,
			freightId: freight,
			planHash: resolved.planHash,
			contentHash: resolved.contentHash,
		});
		this.sets.set(campId, { record, resolved });
		return record;
	}
	async current(campId: CampId) {
		return this.sets.get(campId)?.record;
	}
	async get(setId: SetId) {
		return [...this.sets.values()].find((s) => s.record.setId === setId)
			?.record;
	}
	async history() {
		return [];
	}
	async resolved(set: SetRecord) {
		const found = [...this.sets.values()].find(
			(s) => s.record.setId === set.setId,
		);
		if (!found) throw new Error("blob missing");
		return found.resolved;
	}
	async status() {
		return undefined;
	}
	// biome-ignore lint/correctness/useYield: the posture service never reads changes.
	async *changes() {
		return;
	}
	async open(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		if (this.refuseOpen)
			return {
				ok: false,
				reasons: [
					{
						$typeName: "hobo.cd.v1.ReasonRecord",
						code: "delta-open-conflict",
						message: "another Delta is open",
						remediation: "wait",
						subject: delta.campId,
					},
				],
			};
		if (!this.opened.some((d) => d.deltaId === delta.deltaId))
			this.opened.push(delta);
		return { ok: true, value: delta };
	}
	async update(delta: DeltaRecord): Promise<Outcome<DeltaRecord>> {
		return { ok: true, value: delta };
	}
	async apply(input: unknown): Promise<Outcome<SetRecord>> {
		this.applied.push(input);
		throw new Error("the posture service must never apply a Delta (I22)");
	}
	async reject(): Promise<void> {}
}

/** Append a reconcile observation to a Camp's status stream as WP7 does. */
export async function observe(
	store: MemoryEventStore,
	campId: string,
	resources: readonly Readonly<{
		resource: string;
		kind: string;
		classification: string;
		attributes: Record<string, string>;
		retained?: string[];
	}>[],
	setId = "set_base",
): Promise<EventPosition> {
	const record: ReconcileObservationRecord = create(
		ReconcileObservationRecordSchema,
		{
			campId,
			setId,
			reconcilerId: "rec-1",
			fenceToken: "1",
			status: ReconcileStatus.CONVERGED,
			resources: resources.map((r) => ({ ...r, healthy: true })),
			observedAt: new Date(T0).toISOString(),
		},
	);
	const { toJson } = await import("@bufbuild/protobuf");
	const observation = toJson(ReconcileObservationRecordSchema, record);
	return store.put(CD_STREAMS.campStatus(campId), CD_EVENTS.StatusObserved, {
		schema: "hobo.cd.reconcile-status/v1",
		// SAFETY: toJson of a message is a JSON object.
		observation: observation as JsonObject,
	});
}

export { CampManagement, RemediationMode };
