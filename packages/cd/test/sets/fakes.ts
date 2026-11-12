// Test fakes owned by WP4 (plan 0024 §7.3): an in-memory DurableEventStore with
// the SQLite journal's CAS/idempotency semantics, an in-memory ArtifactStore
// that can corrupt bytes at rest, a recording TelemetrySink and fixtures.
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
	type DurableCommitRequest,
	type DurableCommitResult,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventPosition,
	type JsonObject,
	type JsonValue,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	type PrincipalRef,
	type ReadAllOptions,
	type SnapshotRecord,
	type StreamFilter,
	type Subscription,
} from "@hobo/core";
import {
	type ArtifactKind,
	type ArtifactRef,
	ArtifactRefSchema,
	type ReasonRecord,
	ReasonRecordSchema,
} from "../../src/_generated/cd_pb.js";
import type {
	ArtifactStore,
	CampId,
	CdContext,
	DeltaId,
	Digest,
	OtelMetricPoint,
	SetId,
	TelemetrySink,
} from "../../src/ports.js";
import { DesiredStateError } from "../../src/sets/index.js";

export type FakeStore = DurableEventStore & {
	/** Called inside append before the CAS check; lets a test interleave writers. */
	beforeAppend?: ((streamId: string) => Promise<void> | void) | undefined;
	readonly log: readonly PositionedEvent[];
	conflicts: number;
};

export function createFakeEventStore(): FakeStore {
	const log: PositionedEvent[] = [];
	const heads = new Map<string, number>();
	const handlers = new Set<{
		filter: StreamFilter;
		handler: (event: EventEnvelope) => void | Promise<void>;
	}>();
	let position = 0n;
	let ids = 0;

	const store: FakeStore = {
		log,
		conflicts: 0,
		async append(
			streamId: string,
			events: EventInput[],
			opts: AppendOptions,
		): Promise<AppendResult> {
			if (store.beforeAppend) await store.beforeAppend(streamId);
			const deduped: EventEnvelope[] = [];
			const pending: EventInput[] = [];
			for (const input of events) {
				const key = idempotencyKeyOf(input);
				const existing =
					key === undefined
						? undefined
						: log.find(
								(entry) =>
									entry.event.streamId === streamId &&
									idempotencyKeyOf(entry.event) === key,
							);
				if (existing) deduped.push(existing.event);
				else pending.push(input);
			}
			if (pending.length === 0) return { streamId, appended: [], deduped };
			const revision = heads.get(streamId) ?? 0;
			if (revision !== opts.expectedSeq) {
				store.conflicts += 1;
				throw new OptimisticSequenceConflictError(
					streamId,
					opts.expectedSeq,
					revision,
				);
			}
			const appended: EventEnvelope[] = [];
			let first: EventPosition | undefined;
			let last: EventPosition | undefined;
			let seq = revision;
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
					ts: new Date(0).toISOString(),
					actor: opts.actor,
					tenant: opts.tenant,
					data: structuredClone(input.data ?? {}),
				};
				if (input.meta !== undefined) envelope.meta = input.meta;
				// SAFETY: test fake mints monotonically increasing positions.
				const at = position as EventPosition;
				log.push({ position: at, event: envelope });
				appended.push(envelope);
				first ??= at;
				last = at;
			}
			heads.set(streamId, seq);
			for (const entry of handlers) {
				for (const event of appended) {
					if (matches(entry.filter, event)) void entry.handler(event);
				}
			}
			const result: AppendResult = { streamId, appended, deduped };
			if (first !== undefined) result.firstPosition = first;
			if (last !== undefined) result.lastPosition = last;
			return result;
		},
		async *read(streamId: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
			for (const entry of log.slice()) {
				if (entry.event.streamId === streamId && entry.event.seq >= fromSeq)
					yield entry.event;
			}
		},
		subscribe(
			filter: StreamFilter,
			handler: (event: EventEnvelope) => void | Promise<void>,
		): Subscription {
			const entry = { filter, handler };
			handlers.add(entry);
			return { unsubscribe: () => handlers.delete(entry) };
		},
		async snapshot(streamId: string, state, seq): Promise<SnapshotRecord> {
			return { streamId, state, seq, savedAt: new Date(0).toISOString() };
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
			return { streamId, revision: heads.get(streamId) ?? 0, ownerEpoch: 0n };
		},
	};
	return store;
}

function idempotencyKeyOf(input: { meta?: JsonObject }): string | undefined {
	const key = input.meta?.idempotencyKey;
	return Object.prototype.toString.call(key) === "[object String]" && key !== ""
		? String(key)
		: undefined;
}

function matches(filter: StreamFilter, event: EventEnvelope): boolean {
	if (filter.streamId !== undefined && filter.streamId !== event.streamId)
		return false;
	if (filter.type !== undefined && filter.type !== event.type) return false;
	return true;
}

export type FakeArtifactStore = ArtifactStore & {
	readonly blobs: Map<string, Uint8Array>;
	readonly puts: Array<{
		name: string;
		kind: ArtifactKind;
		mediaType: string;
		digest: string;
		size: number;
	}>;
	corrupt(digest: string): void;
	/** When set, put() reports this digest instead of the real one. */
	lieAboutDigest?: string;
	/** When set, put() reports this size instead of the real one. */
	lieAboutSize?: bigint;
};

export function createFakeArtifactStore(): FakeArtifactStore {
	const blobs = new Map<string, Uint8Array>();
	const puts: FakeArtifactStore["puts"] = [];
	const artifacts: FakeArtifactStore = {
		backend: "memory",
		blobs,
		puts,
		async put(bytes, meta): Promise<ArtifactRef> {
			const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
			blobs.set(digest, new Uint8Array(bytes));
			puts.push({ ...meta, digest, size: bytes.byteLength });
			return create(ArtifactRefSchema, {
				name: meta.name,
				kind: meta.kind,
				digest: artifacts.lieAboutDigest ?? digest,
				coordinate: `store:${digest}`,
				sizeBytes: artifacts.lieAboutSize ?? BigInt(bytes.byteLength),
				mediaType: meta.mediaType,
				ecosystem: "store",
			});
		},
		async get(digest: Digest) {
			const bytes = blobs.get(digest);
			return bytes === undefined ? undefined : new Uint8Array(bytes);
		},
		async has(digest: Digest) {
			return blobs.has(digest);
		},
		async *list() {
			for (const digest of blobs.keys()) {
				// SAFETY: blob keys are sha256 digests minted by put().
				yield digest as Digest;
			}
		},
		async delete(digest: Digest) {
			blobs.delete(digest);
		},
		corrupt(digest: string) {
			const bytes = blobs.get(digest);
			if (!bytes) throw new Error(`no blob ${digest}`);
			const copy = new Uint8Array(bytes);
			copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 0x01;
			blobs.set(digest, copy);
		},
	};
	return artifacts;
}

export type RecordingTelemetry = TelemetrySink & {
	readonly points: OtelMetricPoint[];
};

export function createRecordingTelemetry(): RecordingTelemetry {
	const points: OtelMetricPoint[] = [];
	return {
		points,
		async spans() {},
		async metrics(batch) {
			points.push(...batch);
		},
	};
}

export function deltaId(id: string): DeltaId {
	// SAFETY: test Delta ids are opaque strings; the ledger parses them.
	return id as DeltaId;
}

export function setId(id: string): SetId {
	// SAFETY: test Set ids are opaque strings; the reader looks them up.
	return id as SetId;
}

export function reasonOf(
	code: string,
	message = "",
	remediation = "",
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, { code, message, remediation, subject });
}

/** Narrow a caught value to the module's typed error, failing the test otherwise. */
export function asDesiredStateError(
	value: Error | DesiredStateError | undefined,
): DesiredStateError {
	if (value instanceof DesiredStateError) return value;
	throw new Error(`expected DesiredStateError, got ${String(value)}`);
}

/** The same resolved set with its top-level keys in reverse insertion order. */
export function reverseTopLevelKeys(
	resolved: ResolvedDeploymentSet,
): ResolvedDeploymentSet {
	// SAFETY: only key order changes; every member keeps its value and type.
	return Object.fromEntries(
		Object.entries(resolved).reverse(),
	) as ResolvedDeploymentSet;
}

function reverseKeys(value: JsonValue, insideArray: boolean): JsonValue {
	if (Array.isArray(value)) return value.map((item) => reverseKeys(item, true));
	if (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	) {
		const entries = Object.entries(value).map(
			([key, child]) => [key, reverseKeys(child, false)] as const,
		);
		return Object.fromEntries(insideArray ? entries : entries.reverse());
	}
	return value;
}

/**
 * Reverse the keys of every object that is not an array member (the producer
 * hash in @hobo/cloud sorts object keys, not array members').
 */
export function reverseObjectKeys(
	resolved: ResolvedDeploymentSet,
): ResolvedDeploymentSet {
	const document: JsonValue = JSON.parse(JSON.stringify(resolved));
	// SAFETY: only key order changes; the JSON round trip keeps every value.
	const reordered: ResolvedDeploymentSet = JSON.parse(
		JSON.stringify(reverseKeys(document, false)),
	);
	return reordered;
}

export const OPERATOR: PrincipalRef = { kind: "user", id: "ops@example.test" };

export function ctxAt(
	nowMs: number,
	principal: PrincipalRef = OPERATOR,
): CdContext {
	return { tenant: "acme", principal, now: () => nowMs };
}

export const T0 = Date.parse("2026-11-12T00:00:00.000Z");

export function camp(id: string): CampId {
	// SAFETY: test Camp ids are opaque strings.
	return id as CampId;
}

export type ResourceSpec = Readonly<{
	name: string;
	deps?: readonly string[];
	provider?: string;
	image?: string;
}>;

export function planOf(resources: readonly ResourceSpec[]): DeploymentPlan {
	return {
		schema: "hobo.deployment-plan/v1",
		resources: resources.map((resource) => {
			const node = {
				name: resource.name,
				port: "hobo:runtime/workflow",
				provider: resource.provider ?? "aws",
				deps: [...(resource.deps ?? [])],
			};
			return resource.image === undefined
				? node
				: { ...node, realizationParameters: { image: resource.image } };
		}),
		dependencyOrder: resources.map((resource) => resource.name),
		objective: "cost",
	};
}

export function resolvedFor(
	campId: string,
	resources: readonly ResourceSpec[],
	options: Readonly<{
		tenant?: string;
		secretRefs?: readonly string[];
		decisionId?: string;
	}> = {},
): ResolvedDeploymentSet {
	return createResolvedDeploymentSet({
		tenant: options.tenant ?? "acme",
		environment: "production",
		campId,
		plan: planOf(resources),
		matches: resources.map((resource) => ({
			resource: resource.name,
			providerId: resource.provider ?? "aws",
			port: "hobo:runtime/workflow",
			rationale: "fixture",
		})),
		gatekeeper: {
			decision: "allow",
			gatekeeperDecisionId: options.decisionId ?? "gate-1",
			obligations: [],
			decidedAt: "2026-11-12T00:00:00.000Z",
		},
		secretRefs: options.secretRefs ?? [],
	});
}

export const SHOP_V1: readonly ResourceSpec[] = [
	{
		name: "shop.api",
		deps: ["shop.db", "shop.cache"],
		image: "registry.example/shop-api:v1",
	},
	{ name: "shop.cache" },
	{ name: "shop.db" },
];

export const SHOP_V2: readonly ResourceSpec[] = [
	{
		name: "shop.api",
		deps: ["shop.db", "shop.worker"],
		image: "registry.example/shop-api:v2",
	},
	{ name: "shop.db" },
	{ name: "shop.worker", deps: ["shop.db"] },
];

export async function collect<T>(
	iterable: AsyncIterable<T>,
	max: number,
): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iterable) {
		out.push(item);
		if (out.length >= max) break;
	}
	return out;
}
