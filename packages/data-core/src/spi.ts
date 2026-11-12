/**
 * The engine SPI — the ports a `@hobo/data-<engine>` package implements
 * (ADR-0177 decision 2).
 *
 * Every port is optional except `datasets` and `records`. Absence is a
 * declaration, not a missing export: a port an engine cannot provide is what
 * makes a migration pattern ineligible, and the selector says so by name.
 *
 * Every method may be synchronous or asynchronous (`Awaitable`). An embedded
 * engine answers synchronously, a networked one does not, and the executors
 * await both the same way.
 */
import type { CanonicalRecord, DatasetSchema } from "./canonical.js";
import type { DatasetDigest } from "./digest.js";
import type { ChangeEnvelope, Position, RecordMutation } from "./envelope.js";
import { DataCoreError } from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	parseTypeMappingAnnex,
	type TypeMappingAnnex,
	typeMappingToJson,
} from "./type-mapping.js";

export type Awaitable<T> = T | Promise<T>;

// public-contract: the schema id an engine declaration is published under.
export const ENGINE_DECLARATION_CONTRACT = "hobo.data-engine/v1";

export const SPI_PORTS = [
	"datasets",
	"records",
	"snapshot",
	"capture",
	"apply",
	"verify",
	"fence",
	"retire",
	"schema",
] as const;

export type SpiPortName = (typeof SPI_PORTS)[number];

export const ENGINE_PARADIGMS = [
	"relational",
	"document",
	"key-value",
	"reference",
] as const;
export type EngineParadigm = (typeof ENGINE_PARADIGMS)[number];

/** How far apart two captured changes may be reordered. */
export const CAPTURE_ORDERINGS = ["global", "per-key", "none"] as const;
export type CaptureOrdering = (typeof CAPTURE_ORDERINGS)[number];

/**
 * Where a write fence is enforced. `store` means the engine itself refuses a
 * fenced writer; `entry-point` means only writes through HoBo's write entry
 * point are refused, so a client with its own connection can still write.
 * The difference is a real limit and it is declared, not hidden.
 */
export const FENCE_ENFORCEMENTS = ["store", "entry-point", "none"] as const;
export type FenceEnforcement = (typeof FENCE_ENFORCEMENTS)[number];

export const SNAPSHOT_CONSISTENCIES = ["consistent", "fuzzy", "none"] as const;
export type SnapshotConsistency = (typeof SNAPSHOT_CONSISTENCIES)[number];

/**
 * An engine-native fast path, named by the pattern it realizes. Declaring one
 * is a promise that the binding's `nativeTransfer` port can run it.
 */
// domain-view: parsed profile reference; wire form is NativeMigrationProfile in data-models/data_core.proto.
export interface NativeMigrationProfile {
	readonly profile: string;
	readonly pattern: string;
}

// domain-view: parsed declaration, constructible only through parseEngineDeclaration; wire form is EngineDeclaration in data-models/data_core.proto.
export interface EngineDeclaration {
	readonly contract: typeof ENGINE_DECLARATION_CONTRACT;
	/** Engine id, e.g. `sqlite`, `postgres`, `mongodb`. */
	readonly engine: string;
	/** The engine-level capability profile node, e.g. `data.postgres/v1`. */
	readonly profile: string;
	readonly paradigm: EngineParadigm;
	readonly ports: readonly SpiPortName[];
	readonly captureOrdering: CaptureOrdering;
	readonly fenceEnforcement: FenceEnforcement;
	readonly snapshotConsistency: SnapshotConsistency;
	/** Whether a failed DDL statement rolls back with its phase. */
	readonly ddlTransactional: boolean;
	readonly nativeProfiles: readonly NativeMigrationProfile[];
	readonly typeMapping: TypeMappingAnnex;
	/** Closed list of impedance codes this engine can report (ADR-0144). */
	readonly impedance: readonly string[];
	/**
	 * The largest record the engine stores, in bytes of its canonical encoding,
	 * when the engine has such a bound. A batch carrying a larger record is
	 * refused whole. Absent means the engine states no bound — not that it has
	 * none.
	 */
	readonly maxRecordBytes?: number;
}

/** A dataset, optionally narrowed to one tenant of a pooled store. */
export interface DatasetScope {
	readonly dataset: string;
	/** Empty string spans every tenant. */
	readonly tenant: string;
}

export function scopeOf(dataset: string, tenant = ""): DatasetScope {
	return Object.freeze({ dataset, tenant });
}

// ── datasets ────────────────────────────────────────────────────────────────

export interface DatasetProvision {
	readonly dataset: string;
	/** False when the dataset already existed with a compatible schema. */
	readonly created: boolean;
}

export interface DatasetPort {
	/**
	 * Create the dataset if absent. Additive and idempotent: an existing
	 * dataset whose schema matches is left alone, one that differs is refused.
	 */
	ensureDataset(schema: DatasetSchema): Awaitable<DatasetProvision>;
	describeDataset(name: string): Awaitable<DatasetSchema | undefined>;
}

// ── records: the single write entry point, and point reads ──────────────────

export interface WriteRequest {
	readonly dataset: string;
	readonly mutations: readonly RecordMutation[];
	/** Presented by the migration authority to write through its own fence. */
	readonly fenceToken?: string;
}

export interface WriteReceipt {
	/** Log position after the write, when the engine captures changes. */
	readonly position?: Position;
	readonly applied: number;
}

export interface ReadRequest {
	readonly dataset: string;
	readonly tenant: string;
	readonly key: string;
}

export interface RecordPort {
	/**
	 * Atomic. Refuses with `FencedWriteError` when a fence covers a mutation's
	 * tenant — the tenant's own fence or a dataset-wide one — unless the write
	 * presents that fence's token. A token of any other fence, or of a fence
	 * since released, is no token.
	 *
	 * A mutation's key is the canonical key of its record; a key in any other
	 * spelling is refused (or, for an upsert, stored under the canonical key),
	 * and a delete naming a non-canonical key is refused.
	 */
	write(request: WriteRequest): Awaitable<WriteReceipt>;
	read(request: ReadRequest): Awaitable<CanonicalRecord | undefined>;
}

// ── snapshot ────────────────────────────────────────────────────────────────

export interface SnapshotRequest {
	readonly scope: DatasetScope;
	readonly chunkSize: number;
}

export interface SnapshotCursor {
	/** Upserts for the next chunk, or `undefined` when the scan is done. */
	next(): Awaitable<readonly RecordMutation[] | undefined>;
	close(): Awaitable<void>;
}

export interface SnapshotPort {
	/**
	 * Open a scan of the scope. The scan may be fuzzy: an executor always takes
	 * a capture position *before* opening it and replays from that position
	 * afterwards, which converges whether or not the scan was consistent.
	 */
	openSnapshot(request: SnapshotRequest): Awaitable<SnapshotCursor>;
}

// ── change capture ──────────────────────────────────────────────────────────

export interface CaptureStartRequest {
	readonly scope: DatasetScope;
	/** Durable name for this reader; a slot, a journal cursor, a resume token. */
	readonly subscription: string;
}

export interface CaptureReadRequest extends CaptureStartRequest {
	readonly after: Position;
	readonly limit: number;
}

export interface CaptureBatch {
	readonly changes: readonly ChangeEnvelope[];
	/** Resume point: every change at or before it has been returned. */
	readonly position: Position;
	/** True when nothing further was available at read time. */
	readonly caughtUp: boolean;
}

export interface CaptureAckRequest {
	readonly subscription: string;
	readonly position: Position;
}

export interface ChangeCapturePort {
	/**
	 * Establish the subscription and return the position every not-yet-captured
	 * change sits after. Idempotent for an existing subscription on the same
	 * scope. A name already bound to another scope is refused, or names an
	 * independent subscription; it never answers the other scope's position.
	 */
	start(request: CaptureStartRequest): Awaitable<Position>;
	/**
	 * Ordered changes strictly after `after`. Does not consume them.
	 *
	 * A batch never splits a source transaction: an engine may return more than
	 * `limit` changes to keep one whole. `caughtUp` must be accurate regardless.
	 */
	read(request: CaptureReadRequest): Awaitable<CaptureBatch>;
	/**
	 * Let the engine release log it retained up to `position`. The position
	 * must be one the engine minted and not past its head; anything else is
	 * refused. Once acknowledged, a read from before the position is an error.
	 */
	acknowledge(request: CaptureAckRequest): Awaitable<void>;
	/** Drop the subscription and whatever log it pinned. Idempotent. */
	stop(subscription: string): Awaitable<void>;
}

// ── change apply ────────────────────────────────────────────────────────────

export interface ApplyRequest {
	readonly dataset: string;
	readonly changes: readonly RecordMutation[];
	/** Names the stream the changes came from; one watermark per source. */
	readonly source: string;
	/** Source position after the last change in this batch. */
	readonly position: Position;
	readonly fenceToken?: string;
	/**
	 * A conditional watermark. When present, the batch lands only if the
	 * watermark recorded for `source` is exactly this — `null` meaning none
	 * has been recorded yet. Anything else is refused with `StaleApplyError`,
	 * and nothing of the batch lands. Absent, the apply is unconditional.
	 *
	 * The comparison and the write are one transaction: of two appliers that
	 * name the same watermark, exactly one lands. That is what lets a
	 * migration keep a driver that has been superseded from writing over the
	 * one that superseded it.
	 */
	readonly expectedWatermark?: Position | null;
}

export interface ApplyReceipt {
	readonly applied: number;
}

export interface WatermarkRequest {
	readonly dataset: string;
	readonly source: string;
}

export interface ChangeApplyPort {
	/**
	 * Apply the changes and record the watermark in one transaction. Redelivery
	 * of a batch is harmless: upserts and deletes are idempotent in order.
	 *
	 * An apply is a write: into a fenced scope it is refused with
	 * `FencedWriteError` unless it presents the fence's token.
	 *
	 * With `expectedWatermark`, the same transaction first checks that the
	 * recorded watermark is the one named, and refuses the whole batch with
	 * `StaleApplyError` when it is not.
	 */
	apply(request: ApplyRequest): Awaitable<ApplyReceipt>;
	watermark(request: WatermarkRequest): Awaitable<Position | undefined>;
}

// ── verify ──────────────────────────────────────────────────────────────────

export interface DigestRequest {
	readonly scope: DatasetScope;
	readonly buckets: number;
}

export interface VerifyPort {
	/** Counts and digests only. A record never crosses this port. */
	digest(request: DigestRequest): Awaitable<DatasetDigest>;
}

// ── write fence ─────────────────────────────────────────────────────────────

export interface FenceRaiseRequest {
	readonly scope: DatasetScope;
	readonly reason: string;
}

export interface FenceGrant {
	readonly fenceToken: string;
}

export interface FenceReleaseRequest {
	readonly scope: DatasetScope;
	readonly fenceToken: string;
}

export interface FenceStatus {
	readonly fenced: boolean;
}

export interface WriteFencePort {
	/**
	 * Idempotent: raising a raised fence returns its existing token. A fence
	 * raised after a release is a new fence with a new token; the old token
	 * opens nothing.
	 *
	 * `raise` returns only once no write that began before it can still land:
	 * an in-flight write either commits before `raise` returns or is refused.
	 * A fence that let a straggler land afterwards would not be a fence.
	 */
	raise(request: FenceRaiseRequest): Awaitable<FenceGrant>;
	/** Only the token holder may release. */
	release(request: FenceReleaseRequest): Awaitable<void>;
	status(scope: DatasetScope): Awaitable<FenceStatus>;
}

// ── retire ──────────────────────────────────────────────────────────────────

export interface RetireRequest {
	readonly scope: DatasetScope;
	readonly fenceToken: string;
	/** The digest the source must still have; anything else means it moved. */
	readonly expected: DatasetDigest;
}

export interface RetireReceipt {
	readonly removed: number;
}

export interface RetirePort {
	/**
	 * Destructive. Refused without the token of the fence raised on exactly
	 * this scope, and without a matching digest. Redelivery after it committed
	 * is harmless: retiring a scope that is already empty, with the fence's
	 * token, removes nothing and succeeds. What it removed is not replayed to
	 * a capture subscription started afterwards.
	 */
	retire(request: RetireRequest): Awaitable<RetireReceipt>;
}

// ── schema apply (in-place-evolve) ──────────────────────────────────────────

export type SchemaPhase = "expand" | "backfill" | "contract";

export interface SchemaSnapshotRef {
	readonly ref: string;
	readonly takenAt: string;
}

export interface SchemaPhaseResult {
	readonly phase: SchemaPhase;
	readonly statements: number;
	readonly changes: number;
}

export interface SchemaApplyPort {
	snapshot(): Awaitable<SchemaSnapshotRef>;
	/**
	 * Run a phase's statements. An executor journals its intent first, so a
	 * call that committed and was never heard back from is not blindly made
	 * again: the resumed run asks `verify` with the plan's probe for the phase
	 * whether the statements took effect, and holds when it cannot tell.
	 */
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): Awaitable<SchemaPhaseResult>;
	/**
	 * Run a violations query; an empty result verifies. The query should select
	 * keys, not payload — what it returns is recorded as evidence.
	 */
	verify(violationsQuery: string): Awaitable<readonly JsonObject[]>;
	restore(ref: SchemaSnapshotRef): Awaitable<void>;
}

// ── native transfer (an engine's own bulk transport) ────────────────────────

/** One native transfer, as either side of it is asked about it. */
// domain-view: port request; wire form is NativeTransferRef in data-models/data_core.proto.
export interface NativeTransferRef {
	/** The native migration profile being realized. */
	readonly profile: string;
	/** Durable name of the transfer; an executor derives it from the migration id. */
	readonly transfer: string;
	/** The scope on the side being asked. */
	readonly scope: DatasetScope;
}

export interface NativeSubscribeRequest extends NativeTransferRef {
	/** What the source side's `publish` answered. */
	readonly ticket: JsonObject;
}

export interface NativeReachedRequest extends NativeTransferRef {
	/** A position `mark` minted. */
	readonly mark: Position;
}

/**
 * An engine moving its own records: the transport of a `native` realization.
 *
 * The port replaces exactly two things the hub does — the seed and the tail —
 * and nothing else. An executor still owns the phase model, the policy verdict
 * before every phase, digest verification through `verify`, the fence, the
 * cutover decision and the flip, the soak posture, and the journal. So the
 * port never decides that a copy is correct; it only moves records and says
 * how far it got.
 *
 * One port serves both roles. `publish`, `mark` and `reached` are asked of the
 * source; `subscribe`, `seeded`, `pause` and `resume` of the target; `stop` of
 * each.
 *
 * Nothing that crosses the port may carry a credential or a record: the ticket
 * is journaled. How the target reaches the source — a connection string, a
 * network path — is given to the binding when it is constructed.
 */
export interface NativeTransferPort {
	/** The native migration profiles this port runs; exactly the declared ones. */
	readonly profiles: readonly string[];
	/**
	 * Source. Start retaining every change to the scope for this transfer and
	 * answer the ticket the target subscribes with. Idempotent: publishing a
	 * published transfer answers the same ticket.
	 */
	publish(request: NativeTransferRef): Awaitable<JsonObject>;
	/**
	 * Target. Begin the engine's own copy of what was published: everything in
	 * the scope, then every change after it. Idempotent for a transfer already
	 * subscribed. Refused, never approximated, when the engine cannot copy this
	 * scope faithfully.
	 */
	subscribe(request: NativeSubscribeRequest): Awaitable<void>;
	/**
	 * Target. True once the initial copy is complete. May wait a bounded time
	 * before answering false; an executor polls and never sleeps itself.
	 */
	seeded(request: NativeTransferRef): Awaitable<boolean>;
	/** Source. A position every change committed so far sits at or before. */
	mark(request: NativeTransferRef): Awaitable<Position>;
	/**
	 * Source. True once the target has durably applied every change at or
	 * before `mark`. May wait a bounded time before answering false.
	 */
	reached(request: NativeReachedRequest): Awaitable<boolean>;
	/**
	 * Target. Stop delivering: once it returns, no further change — and no
	 * further part of an initial copy — reaches the target until `resume`. The
	 * source keeps retaining what was not delivered. An executor calls it when
	 * a migration holds, so that nothing moves while nobody has approved it
	 * moving. Idempotent, and harmless for a transfer that never started or was
	 * stopped. An engine may have to start an unfinished initial copy again
	 * after a pause; it must not deliver while paused.
	 */
	pause(request: NativeTransferRef): Awaitable<void>;
	/**
	 * Target. Deliver again from where `pause` stopped. Idempotent, and
	 * harmless for a transfer that is not paused, never started, or was
	 * stopped.
	 */
	resume(request: NativeTransferRef): Awaitable<void>;
	/**
	 * Either side. Drop whatever this side holds for the transfer, and the log
	 * it pinned. Idempotent, and harmless for a transfer that never started.
	 */
	stop(request: NativeTransferRef): Awaitable<void>;
}

// ── the binding ─────────────────────────────────────────────────────────────

export interface EngineBinding {
	readonly declaration: EngineDeclaration;
	readonly datasets: DatasetPort;
	readonly records: RecordPort;
	readonly snapshot?: SnapshotPort;
	readonly capture?: ChangeCapturePort;
	readonly apply?: ChangeApplyPort;
	readonly verify?: VerifyPort;
	readonly fence?: WriteFencePort;
	readonly retire?: RetirePort;
	readonly schema?: SchemaApplyPort;
	/** Present exactly when the declaration lists a native profile. */
	readonly nativeTransfer?: NativeTransferPort;
	close(): Awaitable<void>;
}

function invalid(message: string, field: string): never {
	throw new DataCoreError("INVALID_ENGINE_DECLARATION", message, {
		detail: { field },
	});
}

function member<T extends string>(
	value: JsonValue | undefined,
	allowed: readonly T[],
	field: string,
): T {
	// SAFETY: membership test against the closed tuple passed by the caller.
	if (!isJsonString(value) || !(allowed as readonly string[]).includes(value)) {
		return invalid(`${field} must be one of ${allowed.join(", ")}`, field);
	}
	// SAFETY: the includes check above proves the value is a member of T.
	return value as T;
}

function stringList(value: JsonValue | undefined, field: string): string[] {
	if (!isJsonArray(value)) return invalid(`${field} must be an array`, field);
	return value.map((entry) =>
		isJsonString(entry)
			? entry
			: invalid(`${field} entries must be strings`, field),
	);
}

/** The one constructor for an `EngineDeclaration`. Invalid input throws. */
export function parseEngineDeclaration(
	value: JsonValue | undefined,
): EngineDeclaration {
	if (!isJsonObject(value))
		invalid("declaration must be an object", "declaration");
	const { engine, profile } = value;
	if (!isJsonString(engine) || !/^[a-z][a-z0-9-]{0,31}$/u.test(engine)) {
		invalid("engine must be a short lowercase id", "engine");
	}
	if (!isJsonString(profile) || !/^[a-z][a-z0-9.-]*\/v[0-9]+$/u.test(profile)) {
		invalid(
			"profile must be a capability profile id such as data.postgres/v1",
			"profile",
		);
	}
	const ports = stringList(value.ports, "ports").map((entry) =>
		member(entry, SPI_PORTS, "ports"),
	);
	for (const required of ["datasets", "records"] as const) {
		if (!ports.includes(required)) {
			invalid(`every engine provides the ${required} port`, "ports");
		}
	}
	if (new Set(ports).size !== ports.length)
		invalid("ports has duplicates", "ports");
	const captureOrdering = member(
		value.captureOrdering,
		CAPTURE_ORDERINGS,
		"captureOrdering",
	);
	if (ports.includes("capture") === (captureOrdering === "none")) {
		invalid(
			"captureOrdering is none exactly when the capture port is absent",
			"captureOrdering",
		);
	}
	const fenceEnforcement = member(
		value.fenceEnforcement,
		FENCE_ENFORCEMENTS,
		"fenceEnforcement",
	);
	if (ports.includes("fence") === (fenceEnforcement === "none")) {
		invalid(
			"fenceEnforcement is none exactly when the fence port is absent",
			"fenceEnforcement",
		);
	}
	const snapshotConsistency = member(
		value.snapshotConsistency,
		SNAPSHOT_CONSISTENCIES,
		"snapshotConsistency",
	);
	if (ports.includes("snapshot") === (snapshotConsistency === "none")) {
		invalid(
			"snapshotConsistency is none exactly when the snapshot port is absent",
			"snapshotConsistency",
		);
	}
	const ddlTransactional = value.ddlTransactional;
	if (!isJsonBoolean(ddlTransactional)) {
		invalid("ddlTransactional must be a boolean", "ddlTransactional");
	}
	const rawProfiles = value.nativeProfiles ?? [];
	if (!isJsonArray(rawProfiles))
		invalid("nativeProfiles must be an array", "nativeProfiles");
	const nativeProfiles = rawProfiles.map((entry, index) => {
		if (
			!isJsonObject(entry) ||
			!isJsonString(entry.profile) ||
			!isJsonString(entry.pattern)
		) {
			return invalid(
				"nativeProfiles entries are { profile, pattern }",
				`nativeProfiles[${index}]`,
			);
		}
		return Object.freeze({ profile: entry.profile, pattern: entry.pattern });
	});
	const maxRecordBytes = value.maxRecordBytes;
	if (
		maxRecordBytes !== undefined &&
		(!isJsonNumber(maxRecordBytes) ||
			!Number.isSafeInteger(maxRecordBytes) ||
			maxRecordBytes < 1)
	) {
		invalid("maxRecordBytes must be a positive integer", "maxRecordBytes");
	}
	return Object.freeze({
		contract: ENGINE_DECLARATION_CONTRACT,
		engine,
		profile,
		paradigm: member(value.paradigm, ENGINE_PARADIGMS, "paradigm"),
		ports: Object.freeze(ports),
		captureOrdering,
		fenceEnforcement,
		snapshotConsistency,
		ddlTransactional,
		nativeProfiles: Object.freeze(nativeProfiles),
		typeMapping: parseTypeMappingAnnex(value.typeMapping),
		impedance: Object.freeze(stringList(value.impedance ?? [], "impedance")),
		...(maxRecordBytes === undefined ? undefined : { maxRecordBytes }),
	});
}

export function engineDeclarationToJson(
	declaration: EngineDeclaration,
): JsonObject {
	return {
		contract: declaration.contract,
		engine: declaration.engine,
		profile: declaration.profile,
		paradigm: declaration.paradigm,
		ports: [...declaration.ports],
		captureOrdering: declaration.captureOrdering,
		fenceEnforcement: declaration.fenceEnforcement,
		snapshotConsistency: declaration.snapshotConsistency,
		ddlTransactional: declaration.ddlTransactional,
		nativeProfiles: declaration.nativeProfiles.map((entry) => ({
			profile: entry.profile,
			pattern: entry.pattern,
		})),
		typeMapping: typeMappingToJson(declaration.typeMapping),
		impedance: [...declaration.impedance],
		...(declaration.maxRecordBytes === undefined
			? undefined
			: { maxRecordBytes: declaration.maxRecordBytes }),
	};
}

const PORT_OF: Readonly<
	Record<SpiPortName, (binding: EngineBinding) => boolean>
> = Object.freeze({
	datasets: (binding) => binding.datasets !== undefined,
	records: (binding) => binding.records !== undefined,
	snapshot: (binding) => binding.snapshot !== undefined,
	capture: (binding) => binding.capture !== undefined,
	apply: (binding) => binding.apply !== undefined,
	verify: (binding) => binding.verify !== undefined,
	fence: (binding) => binding.fence !== undefined,
	retire: (binding) => binding.retire !== undefined,
	schema: (binding) => binding.schema !== undefined,
});

/**
 * A binding must provide exactly the ports its declaration lists. A declared
 * port that is absent would make the selector pick a pattern the engine
 * cannot run; an undeclared port that is present is a capability nobody
 * proved. Both are refused.
 *
 * Native profiles follow the same rule, profile by profile: every declared
 * profile is one the `nativeTransfer` port runs, and the port runs none that
 * is not declared. A declared fast path with nothing behind it is how a
 * decision comes to say `native` while nothing can execute it.
 */
export function assertBindingMatchesDeclaration(binding: EngineBinding): void {
	const { engine } = binding.declaration;
	for (const port of SPI_PORTS) {
		const declared = binding.declaration.ports.includes(port);
		const present = PORT_OF[port](binding);
		if (declared !== present) {
			throw new DataCoreError(
				"INVALID_ENGINE_DECLARATION",
				`${engine} ${declared ? "declares" : "provides"} the ${port} port but does not ${declared ? "provide" : "declare"} it`,
				{ detail: { engine, port } },
			);
		}
	}
	const declared = new Set(
		binding.declaration.nativeProfiles.map((entry) => entry.profile),
	);
	const runnable = new Set(binding.nativeTransfer?.profiles ?? []);
	for (const profile of declared) {
		if (!runnable.has(profile)) {
			throw new DataCoreError(
				"INVALID_ENGINE_DECLARATION",
				`${engine} declares the native profile ${profile} but its nativeTransfer port does not run it`,
				{ detail: { engine, port: "nativeTransfer", profile } },
			);
		}
	}
	for (const profile of runnable) {
		if (!declared.has(profile)) {
			throw new DataCoreError(
				"INVALID_ENGINE_DECLARATION",
				`${engine} provides a nativeTransfer port that runs ${profile} but does not declare that profile`,
				{ detail: { engine, port: "nativeTransfer", profile } },
			);
		}
	}
	if (binding.nativeTransfer !== undefined && declared.size === 0) {
		throw new DataCoreError(
			"INVALID_ENGINE_DECLARATION",
			`${engine} provides the nativeTransfer port but declares no native profile`,
			{ detail: { engine, port: "nativeTransfer" } },
		);
	}
}

/**
 * The native profile two declarations share for a pattern, if any. A native
 * fast path is an engine's own, so it exists only between two stores of the
 * same engine that both declare it for that pattern.
 */
export function sharedNativeProfile(
	source: EngineDeclaration | undefined,
	target: EngineDeclaration | undefined,
	pattern: string,
): string | undefined {
	if (source === undefined || target === undefined) return undefined;
	if (source.engine !== target.engine) return undefined;
	const offered = source.nativeProfiles.find(
		(entry) =>
			entry.pattern === pattern &&
			target.nativeProfiles.some(
				(other) => other.pattern === pattern && other.profile === entry.profile,
			),
	);
	return offered?.profile;
}

/** Fetch a port an executor needs, or fail naming the engine and the port. */
export function requirePort<K extends SpiPortName>(
	binding: EngineBinding,
	port: K,
): NonNullable<EngineBinding[K]> {
	const found = binding[port];
	if (found === undefined) {
		throw new DataCoreError(
			"PORT_MISSING",
			`${binding.declaration.engine} does not provide the ${port} port`,
			{ detail: { engine: binding.declaration.engine, port } },
		);
	}
	// SAFETY: undefined was excluded above; the property type is the port type.
	return found as NonNullable<EngineBinding[K]>;
}
