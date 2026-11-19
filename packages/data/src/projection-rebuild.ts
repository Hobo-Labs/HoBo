import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import {
	EVENTSTORE_LIMITS,
	type DurableEventStore,
	type EventEnvelope,
	type EventInput,
	type EventStore,
	parseEventPosition,
	type PrincipalRef,
	stableDigest,
} from "@hobo/core";
import {
	ProjectionRebuildCheckpointRecordSchema,
	ProjectionRebuildRowRecordSchema,
	ProjectionRebuildSeedRecordSchema,
	ProjectionSinkReboundDataSchema,
} from "./_generated/data_pb.js";
import { isOptimisticConflict } from "./errors.js";
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type Inspectable,
	type JsonObject,
	type JsonValue,
} from "./json.js";

const ROW = "projection.RebuildRowChanged";
const CHECKPOINT = "projection.RebuildCheckpointed";
const SEED = "projection.RebuildInitialized";
const CUTOVER = "projection.SinkRebound";

export interface ProjectionRebuildOptions<Row extends JsonObject> {
	readonly source: DurableEventStore;
	readonly journal: EventStore;
	readonly sourceId: string;
	readonly sourceStreamId?: string;
	readonly journalPrefix: string;
	readonly cutoverStreamId: string;
	readonly projection: string;
	readonly schemaVersion: string;
	readonly targetSinkId: string;
	readonly tenant: string;
	readonly actor: PrincipalRef;
	readonly shardCount: number;
	readonly eventTypes: readonly string[];
	readonly mode: "deterministic" | "recorded-output";
	readonly determinism: "deterministic" | "nondeterministic";
	readonly key: (event: EventEnvelope) => string;
	readonly apply: (
		row: Row | undefined,
		event: EventEnvelope,
	) => Row | undefined;
	readonly parseRow: (value: JsonValue) => Row;
	readonly seed?: {
		readonly position: bigint;
		readonly rows: Readonly<Record<string, Row>>;
	};
	readonly batchSize?: number;
}

export interface ProjectionRebuildShardResult {
	readonly shard: number;
	readonly sourcePosition: string;
	readonly scanned: number;
	readonly changed: number;
	readonly caughtUp: boolean;
}

interface ShardState<Row> {
	readonly revision: number;
	readonly position: bigint;
	readonly rows: Map<string, Row>;
}

interface SeedState<Row> {
	readonly seeded: boolean;
	readonly position: bigint;
	readonly rows: Readonly<Record<string, Row>>;
}

function shardFor(key: string, count: number): number {
	let hash = 2166136261;
	for (let index = 0; index < key.length; index += 1) {
		hash ^= key.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) % count;
}

function integer(value: number, name: string, max: number): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > max)
		throw new RangeError(`${name} must be an integer between 1 and ${max}`);
}

function validJson(value: Inspectable, parents: Set<object>): boolean {
	if (value === null || isJsonString(value) || isJsonBoolean(value))
		return true;
	if (isJsonNumber(value)) return Number.isFinite(value);
	if (!isJsonArray(value) && !isJsonObject(value)) return false;
	if (parents.has(value)) return false;
	parents.add(value);
	let valid = true;
	if (isJsonArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			if (!Object.hasOwn(value, index) || !validJson(value[index], parents)) {
				valid = false;
				break;
			}
		}
	} else
		valid = Object.values(value).every((entry) => validJson(entry, parents));
	parents.delete(value);
	return valid;
}

export function createProjectionRebuild<Row extends JsonObject>(
	options: ProjectionRebuildOptions<Row>,
) {
	const {
		source,
		journal,
		sourceId,
		sourceStreamId,
		journalPrefix,
		cutoverStreamId,
		projection,
		schemaVersion,
		targetSinkId,
		tenant,
		shardCount,
		mode,
		determinism,
		key,
		apply,
		parseRow,
	} = options;
	const actor = structuredClone(options.actor);
	for (const [name, value] of [
		["sourceId", sourceId],
		["journalPrefix", journalPrefix],
		["cutoverStreamId", cutoverStreamId],
		["projection", projection],
		["schemaVersion", schemaVersion],
		["targetSinkId", targetSinkId],
		["tenant", tenant],
	] as const)
		if (!value.trim()) throw new TypeError(`${name} must not be empty`);
	if (sourceStreamId !== undefined && !sourceStreamId.trim())
		throw new TypeError("sourceStreamId must not be empty");
	if (source === journal)
		throw new TypeError("source and rebuild journals must differ");
	integer(shardCount, "shardCount", 256);
	if (
		cutoverStreamId === `${journalPrefix}/config` ||
		Array.from(
			{ length: shardCount },
			(_, shard) => `${journalPrefix}/shard/${shard}`,
		).includes(cutoverStreamId)
	)
		throw new TypeError("cutover stream must differ from rebuild shards");
	const batchSize = options.batchSize ?? 128;
	integer(batchSize, "batchSize", EVENTSTORE_LIMITS.maxBatchEvents - 1);
	if (mode !== "deterministic" && mode !== "recorded-output")
		throw new TypeError("invalid rebuild mode");
	if (determinism !== "deterministic" && determinism !== "nondeterministic")
		throw new TypeError("invalid projection determinism");
	if ((determinism === "nondeterministic") !== (mode === "recorded-output"))
		throw new TypeError(
			"nondeterministic projections require recorded-output mode",
		);
	const eventTypes = [...new Set(options.eventTypes)].sort();
	if (eventTypes.length === 0 || eventTypes.some((type) => !type.trim()))
		throw new TypeError("eventTypes must contain non-empty event types");
	const acceptedTypes = new Set(eventTypes);
	const configHash = stableDigest({
		sourceId,
		sourceStreamId: sourceStreamId ?? null,
		projection,
		schemaVersion,
		targetSinkId,
		tenant,
		shardCount,
		mode,
		determinism,
		eventTypes,
	});
	const requestedSeed = options.seed
		? {
				position: parseEventPosition(options.seed.position),
				rows: structuredClone(options.seed.rows),
			}
		: undefined;

	function streamId(shard: number) {
		return `${journalPrefix}/shard/${shard}`;
	}

	function sourceReadOptions(position: bigint, limit: number) {
		const base = { after: parseEventPosition(position), limit, tenant };
		return sourceStreamId === undefined
			? base
			: { ...base, filter: { streamId: sourceStreamId } };
	}

	function validatedRow(value: JsonValue): Row {
		const row = parseRow(value);
		if (!isJsonObject(row) || !validJson(row, new Set()))
			throw new TypeError("projection row must be finite JSON");
		return row;
	}

	function rowData(row: Row): string {
		if (!validJson(row, new Set()))
			throw new TypeError("projection row must be finite JSON");
		const encoded = JSON.stringify(row);
		if (encoded === undefined)
			throw new TypeError("projection row must be JSON");
		const value: JsonValue = JSON.parse(encoded);
		if (!isJsonObject(value))
			throw new TypeError("projection row must be an object");
		validatedRow(value);
		return encoded;
	}

	function seedState(
		position: bigint,
		seeded: boolean,
		value: JsonValue,
	): SeedState<Row> {
		if (!isJsonObject(value))
			throw new TypeError("snapshot rows must be an object");
		const counts = new Map<number, number>();
		const rows = new Map<string, Row>();
		for (const [rowKey, entry] of Object.entries(value)) {
			if (!rowKey.trim())
				throw new TypeError("snapshot row key must not be empty");
			const shard = shardFor(rowKey, shardCount);
			const count = (counts.get(shard) ?? 0) + 1;
			if (count >= EVENTSTORE_LIMITS.maxBatchEvents)
				throw new RangeError("snapshot shard exceeds the atomic seed limit");
			counts.set(shard, count);
			rows.set(rowKey, structuredClone(validatedRow(entry)));
		}
		if (!seeded && (position !== 0n || rows.size > 0))
			throw new TypeError("unseeded rebuild cannot contain a snapshot");
		return { position, seeded, rows: Object.fromEntries(rows) };
	}

	function requestedSeedState(): SeedState<Row> {
		if (requestedSeed)
			for (const row of Object.values(requestedSeed.rows)) rowData(row);
		const text = JSON.stringify(requestedSeed?.rows ?? {});
		const value: JsonValue = JSON.parse(text);
		return seedState(
			requestedSeed?.position ?? 0n,
			requestedSeed !== undefined,
			value,
		);
	}

	function seedDigest(seed: SeedState<Row>): string {
		const value: JsonValue = JSON.parse(
			JSON.stringify({
				position: seed.position.toString(),
				seeded: seed.seeded,
				rows: seed.rows,
			}),
		);
		return stableDigest(value);
	}

	async function loadSeed(): Promise<SeedState<Row>> {
		const configStreamId = `${journalPrefix}/config`;
		for (let attempt = 0; attempt < 8; attempt += 1) {
			let found: SeedState<Row> | undefined;
			for await (const event of journal.read(configStreamId)) {
				if (
					found ||
					event.seq !== 1 ||
					event.tenant !== tenant ||
					event.type !== SEED
				)
					throw new Error("invalid rebuild configuration journal");
				const saved = fromJsonString(
					ProjectionRebuildSeedRecordSchema,
					JSON.stringify(event.data),
				);
				if (saved.configHash !== configHash || !saved.rowsJson)
					throw new Error("invalid rebuild configuration");
				const value: JsonValue = JSON.parse(saved.rowsJson);
				found = seedState(saved.sourcePosition, saved.seeded, value);
			}
			if (found) {
				if (
					requestedSeed &&
					seedDigest(found) !== seedDigest(requestedSeedState())
				)
					throw new Error("snapshot does not match the recorded rebuild seed");
				return found;
			}
			const seed = requestedSeedState();
			const data = create(ProjectionRebuildSeedRecordSchema, {
				configHash,
				seeded: seed.seeded,
				sourcePosition: seed.position,
				rowsJson: JSON.stringify(seed.rows),
			});
			const payload = toJson(ProjectionRebuildSeedRecordSchema, data);
			if (
				Buffer.byteLength(JSON.stringify(payload)) >
				EVENTSTORE_LIMITS.maxPayloadBytes
			)
				throw new RangeError("snapshot exceeds the event-store payload limit");
			try {
				await journal.append(configStreamId, [{ type: SEED, data: payload }], {
					expectedSeq: 0,
					tenant,
					actor,
				});
				return seed;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!isOptimisticConflict(error) ||
					attempt === 7
				)
					throw error;
			}
		}
		throw new Error("rebuild configuration retries exhausted");
	}

	function rowEvent(rowKey: string, row: Row | undefined): EventInput {
		return {
			type: ROW,
			data: toJson(
				ProjectionRebuildRowRecordSchema,
				create(ProjectionRebuildRowRecordSchema, {
					configHash,
					key: rowKey,
					rowJson: row === undefined ? "" : rowData(row),
					deleted: row === undefined,
				}),
			),
		};
	}

	function checkpoint(position: bigint): EventInput {
		return {
			type: CHECKPOINT,
			data: toJson(
				ProjectionRebuildCheckpointRecordSchema,
				create(ProjectionRebuildCheckpointRecordSchema, {
					configHash,
					sourcePosition: position,
				}),
			),
		};
	}

	async function loadShard(shard: number): Promise<ShardState<Row>> {
		const rows = new Map<string, Row>();
		const pending = new Map<string, Row | undefined>();
		let revision = 0;
		let position = 0n;
		for await (const event of journal.read(streamId(shard))) {
			if (event.seq !== revision + 1 || event.tenant !== tenant)
				throw new Error("invalid rebuild journal sequence or tenant");
			revision = event.seq;
			if (event.type === ROW) {
				const row = fromJsonString(
					ProjectionRebuildRowRecordSchema,
					JSON.stringify(event.data),
				);
				if (
					row.configHash !== configHash ||
					!row.key ||
					shardFor(row.key, shardCount) !== shard ||
					(row.deleted && row.rowJson) ||
					(!row.deleted && !row.rowJson)
				)
					throw new Error("invalid rebuild row record");
				if (row.deleted) pending.set(row.key, undefined);
				else {
					const value: JsonValue = JSON.parse(row.rowJson);
					if (!isJsonObject(value))
						throw new TypeError("stored row must be an object");
					pending.set(row.key, structuredClone(validatedRow(value)));
				}
			} else if (event.type === CHECKPOINT) {
				const saved = fromJsonString(
					ProjectionRebuildCheckpointRecordSchema,
					JSON.stringify(event.data),
				);
				if (saved.configHash !== configHash || saved.sourcePosition < position)
					throw new Error("invalid rebuild checkpoint");
				position = saved.sourcePosition;
				for (const [rowKey, row] of pending) {
					if (row === undefined) rows.delete(rowKey);
					else rows.set(rowKey, row);
				}
				pending.clear();
			} else throw new Error(`unexpected rebuild journal event ${event.type}`);
		}
		if (pending.size) throw new Error("rebuild rows are missing a checkpoint");
		return { revision, position, rows };
	}

	async function initialize(shard: number): Promise<ShardState<Row>> {
		const seed = await loadSeed();
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const state = await loadShard(shard);
			if (state.revision || !seed.seeded) return state;
			const rows = Object.entries(seed.rows).filter(
				([rowKey]) => shardFor(rowKey, shardCount) === shard,
			);
			if (rows.length >= EVENTSTORE_LIMITS.maxBatchEvents)
				throw new RangeError("snapshot shard exceeds the atomic seed limit");
			const events = rows.map(([rowKey, row]) => {
				if (!rowKey.trim())
					throw new TypeError("snapshot row key must not be empty");
				return rowEvent(rowKey, row);
			});
			events.push(checkpoint(seed.position));
			try {
				await journal.append(streamId(shard), events, {
					expectedSeq: 0,
					tenant,
					actor,
				});
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!isOptimisticConflict(error) ||
					attempt === 7
				)
					throw error;
			}
		}
		return loadShard(shard);
	}

	async function runShard(
		shard: number,
	): Promise<ProjectionRebuildShardResult> {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const state = await initialize(shard);
			const changed = new Map<string, Row | undefined>();
			let position = state.position;
			let scanned = 0;
			for await (const item of source.readAll(
				sourceReadOptions(position, batchSize),
			)) {
				if (
					item.position <= position ||
					item.event.tenant !== tenant ||
					(sourceStreamId !== undefined &&
						item.event.streamId !== sourceStreamId)
				)
					throw new Error(
						"source returned events outside the ordered rebuild range",
					);
				position = item.position;
				scanned += 1;
				if (!acceptedTypes.has(item.event.type)) continue;
				const rowKey = key(item.event);
				if (!rowKey.trim())
					throw new TypeError("projection key must not be empty");
				if (shardFor(rowKey, shardCount) !== shard) continue;
				const next = apply(
					structuredClone(state.rows.get(rowKey)),
					structuredClone(item.event),
				);
				if (next === undefined) state.rows.delete(rowKey);
				else {
					const normalized: JsonValue = JSON.parse(rowData(next));
					state.rows.set(rowKey, structuredClone(validatedRow(normalized)));
				}
				changed.set(
					rowKey,
					next === undefined
						? undefined
						: structuredClone(state.rows.get(rowKey)),
				);
			}
			if (!scanned)
				return {
					shard,
					sourcePosition: position.toString(),
					scanned: 0,
					changed: 0,
					caughtUp: true,
				};
			const events = [...changed].map(([rowKey, row]) => rowEvent(rowKey, row));
			events.push(checkpoint(position));
			try {
				await journal.append(streamId(shard), events, {
					expectedSeq: state.revision,
					tenant,
					actor,
				});
				return {
					shard,
					sourcePosition: position.toString(),
					scanned,
					changed: changed.size,
					caughtUp: scanned < batchSize,
				};
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!isOptimisticConflict(error) ||
					attempt === 7
				)
					throw error;
			}
		}
		throw new Error("rebuild retries exhausted");
	}

	async function currentCutover() {
		let revision = 0;
		let activeSinkId: string | undefined;
		let activeConfigHash: string | undefined;
		let previousSinkId: string | undefined;
		let verifiedPosition: bigint | undefined;
		for await (const event of journal.read(cutoverStreamId)) {
			if (
				event.seq !== revision + 1 ||
				event.tenant !== tenant ||
				event.type !== CUTOVER
			)
				throw new Error("invalid projection cutover journal");
			const data = fromJsonString(
				ProjectionSinkReboundDataSchema,
				JSON.stringify(event.data),
			);
			if (
				data.projection !== projection ||
				!data.fromSinkId ||
				!data.toSinkId ||
				(activeSinkId !== undefined && activeSinkId !== data.fromSinkId)
			)
				throw new Error("invalid projection cutover record");
			activeSinkId = data.toSinkId;
			activeConfigHash = data.configHash;
			previousSinkId = data.fromSinkId;
			verifiedPosition = data.verifiedPosition;
			revision = event.seq;
		}
		return {
			revision,
			activeSinkId,
			activeConfigHash,
			previousSinkId,
			verifiedPosition,
		};
	}

	function matchesCutover(
		current: Awaited<ReturnType<typeof currentCutover>>,
		fromSinkId: string,
		barrier: bigint,
	) {
		if (current.activeSinkId !== targetSinkId) return false;
		if (
			current.activeConfigHash !== configHash ||
			current.previousSinkId !== fromSinkId ||
			current.verifiedPosition !== barrier
		)
			throw new Error("active projection sink has a different cutover");
		return true;
	}

	return {
		async runBatch(): Promise<readonly ProjectionRebuildShardResult[]> {
			return Promise.all(
				Array.from({ length: shardCount }, (_, shard) => runShard(shard)),
			);
		},
		async read() {
			const shards = await Promise.all(
				Array.from({ length: shardCount }, (_, shard) => initialize(shard)),
			);
			const rows = new Map<string, Row>();
			for (const shard of shards)
				for (const [rowKey, row] of shard.rows)
					rows.set(rowKey, structuredClone(row));
			return {
				rows: Object.fromEntries(rows),
				positions: shards.map((shard) => shard.position.toString()),
			};
		},
		async activeSink() {
			return (await currentCutover()).activeSinkId;
		},
		async cutover(fromSinkId: string, requiredPosition: bigint) {
			if (!fromSinkId.trim() || fromSinkId === targetSinkId)
				throw new TypeError("cutover requires a distinct source sink");
			const barrier = parseEventPosition(requiredPosition);
			const previous = await currentCutover();
			if (matchesCutover(previous, fromSinkId, barrier)) return targetSinkId;
			if (
				previous.activeSinkId !== undefined &&
				previous.activeSinkId !== fromSinkId
			)
				throw new Error("active projection sink changed before cutover");
			const shards = await Promise.all(
				Array.from({ length: shardCount }, (_, shard) => initialize(shard)),
			);
			if (shards.some((shard) => shard.position < barrier))
				throw new Error(
					"projection rebuild has not reached the cutover position",
				);
			for await (const item of source.readAll(sourceReadOptions(barrier, 1))) {
				if (item.position > barrier)
					throw new Error("source advanced beyond the cutover position");
				throw new Error("source returned an invalid cutover position");
			}
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const current = await currentCutover();
				if (matchesCutover(current, fromSinkId, barrier)) return targetSinkId;
				if (
					current.activeSinkId !== undefined &&
					current.activeSinkId !== fromSinkId
				)
					throw new Error("active projection sink changed before cutover");
				const data = create(ProjectionSinkReboundDataSchema, {
					projection,
					fromSinkId,
					toSinkId: targetSinkId,
					configHash,
					verifiedPosition: barrier,
				});
				try {
					await journal.append(
						cutoverStreamId,
						[
							{
								type: CUTOVER,
								data: toJson(ProjectionSinkReboundDataSchema, data),
							},
						],
						{ expectedSeq: current.revision, tenant, actor },
					);
					return targetSinkId;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						!isOptimisticConflict(error) ||
						attempt === 7
					)
						throw error;
				}
			}
			throw new Error("projection cutover retries exhausted");
		},
	};
}
