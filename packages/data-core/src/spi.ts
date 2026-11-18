
import type {
	FenceOperationClaim as FenceOperationClaimWire,
	FenceOperationObservation as FenceOperationObservationWire,
	FenceOperationReceipt as FenceOperationReceiptWire,
} from "./_generated/data_core_pb.js";
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

export const CAPTURE_ORDERINGS = ["global", "per-key", "none"] as const;
export type CaptureOrdering = (typeof CAPTURE_ORDERINGS)[number];

export const FENCE_ENFORCEMENTS = ["store", "entry-point", "none"] as const;
export type FenceEnforcement = (typeof FENCE_ENFORCEMENTS)[number];

export const SNAPSHOT_CONSISTENCIES = ["consistent", "fuzzy", "none"] as const;
export type SnapshotConsistency = (typeof SNAPSHOT_CONSISTENCIES)[number];

export interface NativeMigrationProfile {
	readonly profile: string;
	readonly pattern: string;
}

export interface EngineDeclaration {
	readonly contract: typeof ENGINE_DECLARATION_CONTRACT;
	readonly engine: string;
	readonly profile: string;
	readonly paradigm: EngineParadigm;
	readonly ports: readonly SpiPortName[];
	readonly captureOrdering: CaptureOrdering;
	readonly fenceEnforcement: FenceEnforcement;
	readonly snapshotConsistency: SnapshotConsistency;
	readonly ddlTransactional: boolean;
	readonly nativeProfiles: readonly NativeMigrationProfile[];
	readonly typeMapping: TypeMappingAnnex;
	readonly impedance: readonly string[];
	readonly maxRecordBytes?: number;
}

export interface DatasetScope {
	readonly dataset: string;
	readonly tenant: string;
}

export function scopeOf(dataset: string, tenant = ""): DatasetScope {
	return Object.freeze({ dataset, tenant });
}


export interface DatasetProvision {
	readonly dataset: string;
	readonly created: boolean;
}

export interface DatasetPort {
	ensureDataset(schema: DatasetSchema): Awaitable<DatasetProvision>;
	describeDataset(name: string): Awaitable<DatasetSchema | undefined>;
}


export interface WriteRequest {
	readonly dataset: string;
	readonly mutations: readonly RecordMutation[];
	readonly fenceToken?: string;
}

export interface WriteReceipt {
	readonly position?: Position;
	readonly applied: number;
}

export interface ReadRequest {
	readonly dataset: string;
	readonly tenant: string;
	readonly key: string;
}

export interface RecordPort {
	write(request: WriteRequest): Awaitable<WriteReceipt>;
	read(request: ReadRequest): Awaitable<CanonicalRecord | undefined>;
}


export interface SnapshotRequest {
	readonly scope: DatasetScope;
	readonly chunkSize: number;
}

export interface SnapshotCursor {
	next(): Awaitable<readonly RecordMutation[] | undefined>;
	close(): Awaitable<void>;
}

export interface SnapshotPort {
	openSnapshot(request: SnapshotRequest): Awaitable<SnapshotCursor>;
}


export interface CaptureStartRequest {
	readonly scope: DatasetScope;
	readonly subscription: string;
}

export interface CaptureReadRequest extends CaptureStartRequest {
	readonly after: Position;
	readonly limit: number;
}

export interface CaptureBatch {
	readonly changes: readonly ChangeEnvelope[];
	readonly position: Position;
	readonly caughtUp: boolean;
}

export interface CaptureAckRequest {
	readonly subscription: string;
	readonly position: Position;
}

export interface ChangeCapturePort {
	start(request: CaptureStartRequest): Awaitable<Position>;
	read(request: CaptureReadRequest): Awaitable<CaptureBatch>;
	acknowledge(request: CaptureAckRequest): Awaitable<void>;
	stop(subscription: string): Awaitable<void>;
}


export interface ApplyRequest {
	readonly dataset: string;
	readonly changes: readonly RecordMutation[];
	readonly source: string;
	readonly position: Position;
	readonly fenceToken?: string;
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
	apply(request: ApplyRequest): Awaitable<ApplyReceipt>;
	watermark(request: WatermarkRequest): Awaitable<Position | undefined>;
}


export interface DigestRequest {
	readonly scope: DatasetScope;
	readonly buckets: number;
}

export interface VerifyPort {
	digest(request: DigestRequest): Awaitable<DatasetDigest>;
}


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

export type FenceOperationClaim = Readonly<
	Omit<FenceOperationClaimWire, "$typeName" | "$unknown" | "scope"> & {
		readonly scope: DatasetScope;
	}
>;
export type FenceOperationReceipt = Readonly<
	Omit<
		FenceOperationReceiptWire,
		"$typeName" | "$unknown" | "scope" | "contract" | "outcome"
	> & {
		readonly scope: DatasetScope;
		readonly contract: "hobo.fence-operation-receipt/v1";
		readonly outcome: "committed";
	}
>;
export type FenceOperationObservation = Readonly<
	Omit<
		FenceOperationObservationWire,
		"$typeName" | "$unknown" | "claim" | "status"
	> & {
		readonly claim: FenceOperationClaim;
		readonly status: "held" | "completed";
	}
>;
export interface FenceOperationPort {
	claim(
		input: Readonly<{
			scope: DatasetScope;
			fenceToken: string;
			operationId: string;
			routeDigest: string;
			receiverKeyId: string;
		}>,
	): Awaitable<FenceOperationClaim>;
	complete(receipt: FenceOperationReceipt): Awaitable<void>;
	inspect(
		scope: DatasetScope,
		operationId?: string,
	): Awaitable<FenceOperationObservation | undefined>;
}

export interface WriteFencePort {
	readonly operation?: FenceOperationPort;
	raise(request: FenceRaiseRequest): Awaitable<FenceGrant>;
	release(request: FenceReleaseRequest): Awaitable<void>;
	status(scope: DatasetScope): Awaitable<FenceStatus>;
}


export interface RetireRequest {
	readonly scope: DatasetScope;
	readonly fenceToken: string;
	readonly expected: DatasetDigest;
}

export interface RetireReceipt {
	readonly removed: number;
}

export interface RetirePort {
	retire(request: RetireRequest): Awaitable<RetireReceipt>;
}


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
	applyPhase(
		phase: SchemaPhase,
		statements: readonly string[],
	): Awaitable<SchemaPhaseResult>;
	verify(violationsQuery: string): Awaitable<readonly JsonObject[]>;
	restore(ref: SchemaSnapshotRef): Awaitable<void>;
}


export interface NativeTransferRef {
	readonly profile: string;
	readonly transfer: string;
	readonly scope: DatasetScope;
}

export interface NativeSubscribeRequest extends NativeTransferRef {
	readonly ticket: JsonObject;
}

export interface NativeReachedRequest extends NativeTransferRef {
	readonly mark: Position;
}

export interface NativeTransferPort {
	readonly profiles: readonly string[];
	publish(request: NativeTransferRef): Awaitable<JsonObject>;
	subscribe(request: NativeSubscribeRequest): Awaitable<void>;
	seeded(request: NativeTransferRef): Awaitable<boolean>;
	mark(request: NativeTransferRef): Awaitable<Position>;
	reached(request: NativeReachedRequest): Awaitable<boolean>;
	pause(request: NativeTransferRef): Awaitable<void>;
	resume(request: NativeTransferRef): Awaitable<void>;
	stop(request: NativeTransferRef): Awaitable<void>;
}


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
	if (!isJsonString(value) || !(allowed as readonly string[]).includes(value)) {
		return invalid(`${field} must be one of ${allowed.join(", ")}`, field);
	}
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
	return found as NonNullable<EngineBinding[K]>;
}
