// Test doubles for the WP2 Freight-source tests. Each models the frozen port it
// stands in for (ports.ts, @hobo/core); none is reachable from production code.
import { createHash } from "node:crypto";
import { create, toJson } from "@bufbuild/protobuf";
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
import {
	type FreightManifestRecord,
	FreightManifestRecordSchema,
	FreightOrigin,
	type FreightRecord,
	FreightRecordSchema,
	type ProvenanceRef,
	ProvenanceRefSchema,
	ReasonRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { FREIGHT_SCHEMA } from "../../src/events.js";
import type {
	CdAction,
	CdAuthorizer,
	CdContext,
	CredentialResolver,
	Digest,
	FreightId,
	FreightLedger,
	OtelMetricPoint,
	OtelSpan,
	Outcome,
	ProvenanceVerifier,
	RailEventReader,
	TelemetrySink,
} from "../../src/ports.js";
import { canonical, isText } from "../../src/sources/json.js";

export const TENANT = "acme";
export const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@acme" };

export function digestOf(seed: string | Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
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

export const signal = new AbortController().signal;

// ── HTTP fixtures ──────────────────────────────────────────────────────────

export type Exchange = Readonly<{
	method?: string;
	url: string;
	/** Request headers that must be present with these values. */
	headers?: Readonly<Record<string, string>>;
	/** Exact request body, when the exchange has one. */
	body?: string;
	status?: number;
	responseHeaders?: Readonly<Record<string, string>>;
	response?: string;
}>;

/** A recorded-fixture transport: every request must match one exchange. */
export class FixtureTransport {
	readonly requests: TransportRequest[] = [];
	readonly unmatched: TransportRequest[] = [];
	constructor(private readonly exchanges: readonly Exchange[]) {}

	readonly http: HttpTransport = async (request) => {
		this.requests.push(request);
		const found = this.exchanges.find(
			(item) =>
				item.url === request.url &&
				(item.method ?? "GET") === request.method &&
				(item.body === undefined || item.body === request.body) &&
				Object.entries(item.headers ?? {}).every(([key, value]) => request.headers[key] === value),
		);
		if (!found) {
			this.unmatched.push(request);
			return { status: 599, headers: {}, body: `no fixture for ${request.method} ${request.url}` };
		}
		const response: TransportResponse = {
			status: found.status ?? 200,
			headers: found.responseHeaders ?? {},
			body: found.response ?? "",
		};
		return response;
	};
}

export function json<T>(value: T): string {
	return JSON.stringify(value);
}

/** JSON text of any test value, bigint-safe (protobuf uint64 fields). */
export function dump<T>(value: T): string {
	return JSON.stringify(value, (_key, item) =>
		Object.prototype.toString.call(item) === "[object BigInt]" ? String(item) : item,
	);
}

export class StaticCredentials implements CredentialResolver {
	readonly calls: Array<Readonly<{ ref: string; scope: string }>> = [];
	constructor(private readonly values: Readonly<Record<string, Readonly<Record<string, string>>>>) {}
	async resolve(ref: string, scope: string): Promise<Readonly<Record<string, string>>> {
		this.calls.push({ ref, scope });
		const found = this.values[ref];
		if (!found) throw new Error(`no credential ${ref}`);
		return found;
	}
}

// ── Event store ────────────────────────────────────────────────────────────

/** In-memory DurableEventStore: expected-seq CAS and idempotency-key dedup. */
export class MemoryEventStore implements DurableEventStore {
	private readonly streams = new Map<string, EventEnvelope[]>();
	private readonly all: PositionedEvent[] = [];
	private nextId = 1;

	async append(streamId: string, events: EventInput[], opts: AppendOptions): Promise<AppendResult> {
		const stream = this.streams.get(streamId) ?? [];
		const deduped: EventEnvelope[] = [];
		const fresh: EventInput[] = [];
		for (const input of events) {
			const key = input.meta?.idempotencyKey;
			const existing = isText(key) ? stream.find((event) => event.meta?.idempotencyKey === key) : undefined;
			if (existing) deduped.push(existing);
			else fresh.push(input);
		}
		if (fresh.length === 0) return { streamId, appended: [], deduped };
		if (opts.expectedSeq !== stream.length) {
			throw new Error(`expected seq ${opts.expectedSeq} but stream ${streamId} is at ${stream.length}`);
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
			// SAFETY: test double; positions are minted from a monotonic counter.
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
		let yielded = 0;
		for (const entry of this.all) {
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

	events(streamId: string): readonly EventEnvelope[] {
		return this.streams.get(streamId) ?? [];
	}
}

// ── Ports ──────────────────────────────────────────────────────────────────

export class FakeAuthorizer implements CdAuthorizer {
	readonly calls: CdAction[] = [];
	constructor(private readonly denied: ReadonlySet<CdAction> = new Set()) {}
	async authorize(action: CdAction): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>> {
		this.calls.push(action);
		if (this.denied.has(action)) {
			return {
				ok: false,
				reasons: [create(ReasonRecordSchema, { code: "denied", message: `${action} denied`, remediation: "ask an owner" })],
			};
		}
		return { ok: true, value: { decisionId: `decision-${this.calls.length}`, proposalOnly: false } };
	}
}

export class RecordingTelemetry implements TelemetrySink {
	readonly points: OtelMetricPoint[] = [];
	async spans(_spans: readonly OtelSpan[]): Promise<void> {}
	async metrics(points: readonly OtelMetricPoint[]): Promise<void> {
		this.points.push(...points);
	}
	count(name: string, attributes: Readonly<Record<string, string>> = {}): number {
		return this.points
			.filter((point) => point.name === name)
			.filter((point) => Object.entries(attributes).every(([key, value]) => point.attributes[key] === value))
			.reduce((sum, point) => sum + point.value, 0);
	}
}

/** Content-addressed fake ledger: identical manifests record once. */
export class FakeLedger implements Pick<FreightLedger, "record"> {
	readonly recorded = new Map<string, FreightRecord>();
	readonly calls: FreightManifestRecord[] = [];
	refuseWhen?: (manifest: FreightManifestRecord) => boolean;

	async record(
		input: Readonly<{ manifest: FreightManifestRecord; origin: FreightOrigin; sourceName?: string }>,
		ctx: CdContext,
	): Promise<Outcome<FreightRecord>> {
		this.calls.push(input.manifest);
		if (this.refuseWhen?.(input.manifest)) {
			return {
				ok: false,
				reasons: [create(ReasonRecordSchema, { code: "freight-artifact-unverified", message: "digest mismatch", remediation: "republish" })],
			};
		}
		const id = digestOf(canonical(toJson(FreightManifestRecordSchema, input.manifest)));
		const existing = this.recorded.get(id);
		if (existing) return { ok: true, value: existing };
		const record = create(FreightRecordSchema, {
			schemaVersion: FREIGHT_SCHEMA,
			freightId: id,
			alias: `alias-${this.recorded.size + 1}`,
			manifest: input.manifest,
			origin: input.origin ?? FreightOrigin.SOURCE_DISCOVERY,
			sourceName: input.sourceName ?? "",
			recordedBy: ctx.principal.id,
			recordedAt: new Date(ctx.now()).toISOString(),
		});
		this.recorded.set(id, record);
		return { ok: true, value: record };
	}
}

export function asLedger(fake: FakeLedger): FreightLedger {
	const unused = async () => {
		throw new Error("not used by FreightSources");
	};
	return {
		record: (input, ctx) => fake.record(input, ctx),
		yank: unused,
		approve: unused,
		qualify: unused,
		get: unused,
		getByAlias: unused,
		isUsable: unused,
		qualifications: unused,
		approvals: unused,
		list: unused,
		retire: unused,
	};
}

export function freightId(record: FreightRecord): FreightId {
	// SAFETY: ids come from the fake ledger's content address.
	return record.freightId as FreightId;
}

/** Accepts only statements whose builder is trusted and whose subjects match. */
export class FakeProvenance implements ProvenanceVerifier {
	readonly calls: Array<Readonly<{ statement: string; subjects: readonly string[]; builders: readonly string[] }>> = [];
	async verify(
		input: Parameters<ProvenanceVerifier["verify"]>[0],
	): Promise<Outcome<readonly ProvenanceRef[]>> {
		const statement = new TextDecoder().decode(input.statement);
		this.calls.push({ statement, subjects: input.subjects.map((item) => item.digest), builders: input.trustedBuilderIds });
		let parsed: { builder?: string; subjects?: string[]; signer?: string };
		try {
			parsed = JSON.parse(statement);
		} catch {
			return { ok: false, reasons: [create(ReasonRecordSchema, { code: "provenance-invalid", message: "not json", remediation: "re-sign" })] };
		}
		const builderOk = input.trustedBuilderIds.length === 0 || input.trustedBuilderIds.includes(parsed.builder ?? "");
		const signerOk = input.trustedSignerIdentities.length === 0 || input.trustedSignerIdentities.includes(parsed.signer ?? "");
		const subjectsOk = input.subjects.every((subject) => parsed.subjects?.includes(subject.digest));
		if (!builderOk || !signerOk || !subjectsOk) {
			return { ok: false, reasons: [create(ReasonRecordSchema, { code: "provenance-untrusted", message: "untrusted", remediation: "pin the builder" })] };
		}
		return {
			ok: true,
			value: [
				create(ProvenanceRefSchema, {
					statementDigest: digestOf(statement),
					predicateType: "https://slsa.dev/provenance/v1",
					builderId: parsed.builder ?? "",
					signerIdentity: parsed.signer ?? "",
					verified: true,
					verifier: input.bundle ? "sigstore" : "hobo-jwt",
					subjectDigests: input.subjects.map((item) => item.digest),
				}),
			],
		};
	}
}

// ── Event readers ──────────────────────────────────────────────────────────

export type RailEvent = Readonly<{ cursor: string; railId: string; railDigest: Digest; status: "approved" | "active" | "retired"; stationId: string }>;

export function railReader(events: readonly RailEvent[]): RailEventReader {
	return async function* (after) {
		const start = after === undefined ? 0 : events.findIndex((event) => event.cursor === after) + 1;
		for (const event of events.slice(start)) yield event;
	};
}

