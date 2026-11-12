// Test doubles for the WP1 Freight ledger and ingest tests. Each one models
// the frozen port it stands in for (ports.ts, @hobo/core eventstore); none of
// them is reachable from production code.
import { createHash } from "node:crypto";
import type {
	AppendOptions,
	AppendResult,
	DurableCommitRequest,
	DurableCommitResult,
	DurableEventStore,
	EventEnvelope,
	EventInput,
	EventPosition,
	PositionedEvent,
	PrincipalRef,
	ReadAllOptions,
	SnapshotRecord,
	StreamFilter,
	Subscription,
} from "@hobo/core";
import type { FreightManifestRecord, FreightSourceRecord, ReasonRecord } from "../../src/_generated/cd_pb.js";
import type {
	ArtifactVerifier,
	CdAction,
	CdAuthorizer,
	CdContext,
	FeedRequest,
	FeedResponse,
	FreightSources,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	TelemetrySink,
} from "../../src/ports.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function hex64(seed: string): string {
	return createHash("sha256").update(seed).digest("hex");
}

export function digestOf(seed: string): `sha256:${string}` {
	return `sha256:${hex64(seed)}`;
}

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };
export const AGENT: PrincipalRef = { kind: "agent", id: "agent-7" };

export function clock(start = T0): { now: () => number; advance: (ms: number) => void } {
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

/**
 * In-memory DurableEventStore with the conformance-suite semantics the ledger
 * relies on: per-stream expected-seq CAS (a stale expectedSeq throws), and
 * per-stream idempotency-key dedup checked before the CAS.
 */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	private readonly all: PositionedEvent[] = [];
	private nextId = 1;
	appendCalls = 0;

	async append(streamId: string, events: EventInput[], opts: AppendOptions): Promise<AppendResult> {
		this.appendCalls += 1;
		const stream = this.streams.get(streamId) ?? [];
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing =
				typeof key === "string" ? stream.find((event) => event.meta?.idempotencyKey === key) : undefined;
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length) {
			throw new Error(`expected seq ${opts.expectedSeq} but stream ${streamId} is at ${stream.length}`);
		}
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
				ts: new Date(T0).toISOString(),
				actor: opts.actor,
				tenant: opts.tenant,
				data: structuredClone(input.data),
				...(input.meta ? { meta: input.meta } : {}),
			};
			// SAFETY: test double; positions are minted here from a monotonic counter.
			const position = BigInt(this.nextId) as EventPosition;
			this.nextId += 1;
			stream.push(envelope);
			this.all.push({ position, event: envelope });
			appended.push(envelope);
			firstPosition ??= position;
			lastPosition = position;
		}
		this.streams.set(streamId, stream);
		return {
			streamId,
			appended,
			deduped,
			...(firstPosition !== undefined ? { firstPosition } : {}),
			...(lastPosition !== undefined ? { lastPosition } : {}),
		};
	}

	async *read(streamId: string, fromSeq = 0): AsyncIterable<EventEnvelope> {
		for (const event of this.streams.get(streamId) ?? []) {
			if (event.seq > fromSeq) yield event;
		}
	}

	async *readAll(options: ReadAllOptions = {}): AsyncIterable<PositionedEvent> {
		let yielded = 0;
		for (const entry of [...this.all]) {
			if (options.after !== undefined && entry.position <= options.after) continue;
			if (options.tenant !== undefined && entry.event.tenant !== options.tenant) continue;
			if (options.filter?.type !== undefined && entry.event.type !== options.filter.type) continue;
			if (options.filter?.streamId !== undefined && entry.event.streamId !== options.filter.streamId) continue;
			if (options.limit !== undefined && yielded >= options.limit) return;
			yielded += 1;
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

	/** Test helper: raw events of one stream. */
	events(streamId: string): readonly EventEnvelope[] {
		return this.streams.get(streamId) ?? [];
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
		return this.points.filter((point) => point.name === name).reduce((sum, point) => sum + point.value, 0);
	}
}

/** Verifies every artifact digest against bytes the test registered as "at the coordinate". */
export class MapArtifactVerifier implements ArtifactVerifier {
	readonly known = new Map<string, string>();
	calls = 0;
	register(coordinate: string, digest: string): void {
		this.known.set(coordinate, digest);
	}
	async verify(manifest: FreightManifestRecord): Promise<Outcome<FreightManifestRecord>> {
		this.calls += 1;
		const reasons: ReasonRecord[] = [];
		for (const artifact of manifest.artifacts) {
			const actual = this.known.get(artifact.coordinate);
			if (actual === undefined) {
				reasons.push(reason("artifact-unverified", `no bytes at ${artifact.coordinate}`, artifact.name));
			} else if (actual !== artifact.digest) {
				reasons.push(reason("artifact-digest-mismatch", `digest at ${artifact.coordinate} is ${actual}`, artifact.name));
			}
		}
		return reasons.length === 0 ? { ok: true, value: manifest } : { ok: false, reasons };
	}
}

function reason(code: string, message: string, subject: string): ReasonRecord {
	// SAFETY: test double; a plain object with the generated message's shape.
	return { $typeName: "hobo.cd.v1.ReasonRecord", code, message, remediation: "fix the fixture", subject } as ReasonRecord;
}

export type AuthorizerCall = Readonly<{ action: CdAction; principal: PrincipalRef }>;

/** Allows users and services; agents get proposal-only; listed actions are denied. */
export class FakeAuthorizer implements CdAuthorizer {
	readonly calls: AuthorizerCall[] = [];
	readonly denied = new Set<CdAction>();
	async authorize(
		action: CdAction,
		_subject: unknown,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>> {
		this.calls.push({ action, principal: ctx.principal });
		if (this.denied.has(action)) return { ok: false, reasons: [reason("policy-denied", `${action} denied`, action)] };
		return {
			ok: true,
			value: { decisionId: `dec-${this.calls.length}`, proposalOnly: ctx.principal.kind === "agent" },
		};
	}
}

/** Records nudges; never creates Freight (the real one polls with a verified read). */
export class FakeSources implements FreightSources {
	readonly scheduled: string[][] = [];
	constructor(private readonly sources: readonly FreightSourceRecord[] = []) {}
	async define(source: FreightSourceRecord): Promise<Outcome<FreightSourceRecord>> {
		return { ok: true, value: source };
	}
	async list(): Promise<readonly FreightSourceRecord[]> {
		return this.sources;
	}
	async poll(): Promise<Outcome<readonly never[]>> {
		return { ok: true, value: [] };
	}
	async nudge(_request: FeedRequest): Promise<FeedResponse> {
		return { status: 202, headers: {}, body: new Uint8Array() };
	}
	async schedule(names: readonly string[]): Promise<void> {
		this.scheduled.push([...names]);
	}
	async tick(): Promise<void> {}
}
