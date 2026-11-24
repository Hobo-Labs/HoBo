import {
	AlreadyCancelled,
	AlreadyExecuted,
	NotScheduled,
} from "@alchemy.run/domain/Aggregate";
import * as InMemoryWorkflows from "@alchemy.run/domain/InMemoryWorkflows";
import {
	type AggregateStore,
	type Delivery,
	EnvelopeJson,
	emptySnapshot,
	emptyStreamMeta,
	hostedModels,
	inRange,
	type ModelHost,
	Platform,
	type PolicyStore,
	type ProjectionStore,
	type ReceiptJson,
	type SendResult,
	type StoredEvent,
	type StreamEntry,
	type StreamMeta,
	type StreamStore,
	type ViewEntry,
	type ViewSnapshot,
	type ViewStore,
} from "@alchemy.run/domain/Platform";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { WorkflowEngine } from "effect/workflow";
import { asNumber, asText, type SqliteDriver } from "./driver.js";

const SQLITE_DOMAIN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS domain_aggregates (
	model_name TEXT NOT NULL,
	aggregate_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	state_json TEXT NOT NULL,
	version INTEGER NOT NULL,
	PRIMARY KEY (model_name, aggregate_name, instance_id)
);

CREATE TABLE IF NOT EXISTS domain_events (
	model_name TEXT NOT NULL,
	aggregate_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	event_json TEXT NOT NULL,
	envelope_json TEXT NOT NULL,
	PRIMARY KEY (model_name, aggregate_name, instance_id, seq)
);

CREATE TABLE IF NOT EXISTS domain_receipts (
	model_name TEXT NOT NULL,
	aggregate_name TEXT NOT NULL,
	instance_id TEXT NOT NULL,
	command_id TEXT NOT NULL,
	receipt_json TEXT NOT NULL,
	PRIMARY KEY (model_name, aggregate_name, instance_id, command_id)
);

CREATE TABLE IF NOT EXISTS domain_views (
	model_name TEXT NOT NULL,
	view_name TEXT NOT NULL,
	view_key TEXT NOT NULL,
	snapshot_json TEXT NOT NULL,
	PRIMARY KEY (model_name, view_name, view_key)
);

CREATE TABLE IF NOT EXISTS domain_view_entries (
	model_name TEXT NOT NULL,
	view_name TEXT NOT NULL,
	view_key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	entry_json TEXT NOT NULL,
	PRIMARY KEY (model_name, view_name, view_key, seq)
);

CREATE TABLE IF NOT EXISTS domain_streams (
	model_name TEXT NOT NULL,
	stream_name TEXT NOT NULL,
	stream_key TEXT NOT NULL,
	meta_json TEXT NOT NULL,
	PRIMARY KEY (model_name, stream_name, stream_key)
);

CREATE TABLE IF NOT EXISTS domain_stream_entries (
	model_name TEXT NOT NULL,
	stream_name TEXT NOT NULL,
	stream_key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	entry_json TEXT NOT NULL,
	PRIMARY KEY (model_name, stream_name, stream_key, seq)
);

CREATE TABLE IF NOT EXISTS domain_projections (
	model_name TEXT NOT NULL,
	projection_name TEXT NOT NULL,
	projection_key TEXT NOT NULL,
	checkpoints_json TEXT NOT NULL,
	PRIMARY KEY (model_name, projection_name, projection_key)
);
`;

export function initSqliteDomainTables(driver: SqliteDriver): void {
	driver.exec(SQLITE_DOMAIN_SCHEMA_SQL);
}

const ReceiptPayloadSchema = Schema.Struct({
	stream: Schema.String,
	version: Schema.Finite,
	events: Schema.Array(Schema.Any),
	reply: Schema.Any,
});

const AcceptedResultSchema = Schema.TaggedStruct("Accepted", {
	receipt: ReceiptPayloadSchema,
});

const ViewSnapshotSchema = Schema.Struct({
	state: Schema.Any,
	version: Schema.Finite,
	checkpoints: Schema.Record(Schema.String, Schema.Finite),
	seq: Schema.Finite,
	generation: Schema.optionalKey(Schema.Finite),
});

const ViewEntrySchema = Schema.Struct({
	seq: Schema.Finite,
	event: Schema.Any,
	envelope: EnvelopeJson,
	state: Schema.Any,
});

const StreamMetaSchema = Schema.Struct({
	seq: Schema.Finite,
	checkpoints: Schema.Record(Schema.String, Schema.Finite),
	origin: Schema.Tuple([Schema.Finite, Schema.Finite]),
});

const StreamEntrySchema = Schema.Struct({
	seq: Schema.Finite,
	event: Schema.Any,
	envelope: EnvelopeJson,
});

const CheckpointsSchema = Schema.Record(Schema.String, Schema.Finite);

const decodeEnvelope = Schema.decodeUnknownSync(EnvelopeJson);
const decodeAccepted = Schema.decodeUnknownSync(AcceptedResultSchema);
const decodeViewSnapshot = Schema.decodeUnknownSync(ViewSnapshotSchema);
const decodeViewEntry = Schema.decodeUnknownSync(ViewEntrySchema);
const decodeStreamMeta = Schema.decodeUnknownSync(StreamMetaSchema);
const decodeStreamEntry = Schema.decodeUnknownSync(StreamEntrySchema);
const decodeCheckpoints = Schema.decodeUnknownSync(CheckpointsSchema);

export interface SqliteDomainPlatformOptions {
	readonly now?: () => number;
}

export function createSqliteDomainPlatform(
	driver: SqliteDriver,
	options: SqliteDomainPlatformOptions = {},
): Layer.Layer<
	Platform | WorkflowEngine.WorkflowEngine | SecureRandom.SecureRandom
> {
	initSqliteDomainTables(driver);
	const now = options.now ?? (() => Date.now());
	const claim = hostedModels({ release: true });

	const loadAggregateStmt = driver.prepare(
		"SELECT state_json, version FROM domain_aggregates WHERE model_name = ? AND aggregate_name = ? AND instance_id = ?",
	);
	const saveAggregateStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_aggregates (model_name, aggregate_name, instance_id, state_json, version) VALUES (?, ?, ?, ?, ?)",
	);
	const insertEventStmt = driver.prepare(
		"INSERT OR IGNORE INTO domain_events (model_name, aggregate_name, instance_id, seq, event_json, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
	);
	const loadEventsStmt = driver.prepare(
		"SELECT event_json, envelope_json FROM domain_events WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? ORDER BY seq ASC",
	);
	const loadReceiptStmt = driver.prepare(
		"SELECT receipt_json FROM domain_receipts WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? AND command_id = ?",
	);
	const saveReceiptStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_receipts (model_name, aggregate_name, instance_id, command_id, receipt_json) VALUES (?, ?, ?, ?, ?)",
	);
	const loadViewStmt = driver.prepare(
		"SELECT snapshot_json FROM domain_views WHERE model_name = ? AND view_name = ? AND view_key = ?",
	);
	const saveViewStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_views (model_name, view_name, view_key, snapshot_json) VALUES (?, ?, ?, ?)",
	);
	const insertViewEntryStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_view_entries (model_name, view_name, view_key, seq, entry_json) VALUES (?, ?, ?, ?, ?)",
	);
	const loadViewEntriesStmt = driver.prepare(
		"SELECT entry_json FROM domain_view_entries WHERE model_name = ? AND view_name = ? AND view_key = ? ORDER BY seq ASC",
	);
	const loadStreamStmt = driver.prepare(
		"SELECT meta_json FROM domain_streams WHERE model_name = ? AND stream_name = ? AND stream_key = ?",
	);
	const saveStreamStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_streams (model_name, stream_name, stream_key, meta_json) VALUES (?, ?, ?, ?)",
	);
	const insertStreamEntryStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_stream_entries (model_name, stream_name, stream_key, seq, entry_json) VALUES (?, ?, ?, ?, ?)",
	);
	const loadStreamEntriesStmt = driver.prepare(
		"SELECT entry_json FROM domain_stream_entries WHERE model_name = ? AND stream_name = ? AND stream_key = ? ORDER BY seq ASC",
	);
	const loadProjectionStmt = driver.prepare(
		"SELECT checkpoints_json FROM domain_projections WHERE model_name = ? AND projection_name = ? AND projection_key = ?",
	);
	const saveProjectionStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_projections (model_name, projection_name, projection_key, checkpoints_json) VALUES (?, ?, ?, ?)",
	);

	function inTransaction<A>(fn: () => A): A {
		driver.beginImmediate();
		try {
			const value = fn();
			driver.commit();
			return value;
		} catch (cause) {
			driver.rollback();
			throw cause;
		}
	}

	const workflows = InMemoryWorkflows.make({
		now,
		enqueue: (run) => Effect.forkDetach(run).pipe(Effect.asVoid),
		acquire: (lock) => lock.take(1),
		timer: (_key, at, fire) =>
			Effect.forkDetach(
				Effect.sleep(Math.max(0, at - now())).pipe(Effect.andThen(fire)),
			).pipe(Effect.asVoid),
		failed: () => undefined,
		died: () => undefined,
	});

	const platformLayer = Layer.succeed(Platform, {
		model: ({ modelName, id }) =>
			Effect.gen(function* () {
				yield* claim(modelName, id);
				const host: ModelHost = {
					aggregate: (_aggregate, kit) =>
						Effect.sync(() => {
							const lock = Semaphore.makeUnsafe(1);
							const versions = new Map<
								string,
								SubscriptionRef.SubscriptionRef<number>
							>();
							const scheduled = new Map<
								string,
								Map<
									string,
									{
										readonly commandId: string;
										readonly at: number;
										cancelled: boolean;
									}
								>
							>();

							const readAggregate = (instanceId: string) => {
								const row = loadAggregateStmt.get(
									modelName,
									kit.name,
									instanceId,
								);
								if (row === undefined) {
									return { state: null, version: 0 };
								}
								return {
									state: JSON.parse(asText(row.state_json, "state_json")),
									version: asNumber(row.version, "version"),
								};
							};

							const readEvents = (instanceId: string): StoredEvent[] => {
								const rows = loadEventsStmt.all(
									modelName,
									kit.name,
									instanceId,
								);
								return rows.map((row) => ({
									event: JSON.parse(asText(row.event_json, "event_json")),
									envelope: decodeEnvelope(
										JSON.parse(asText(row.envelope_json, "envelope_json")),
									),
								}));
							};

							const versionRefOf = (instanceId: string) =>
								Effect.suspend(() => {
									const existing = versions.get(instanceId);
									if (existing !== undefined) {
										return Effect.succeed(existing);
									}
									return SubscriptionRef.make(
										readAggregate(instanceId).version,
									).pipe(
										Effect.tap((ref) =>
											Effect.sync(() => {
												versions.set(instanceId, ref);
											}),
										),
									);
								});

							const announce = (instanceId: string, version: number) =>
								Effect.suspend(() => {
									const ref = versions.get(instanceId);
									return ref !== undefined
										? SubscriptionRef.set(ref, version)
										: Effect.void;
								});

							const commit: AggregateStore["send"] = (
								instanceId,
								command,
								meta,
							) =>
								lock.withPermits(1)(
									Effect.gen(function* () {
										const existingReceiptRow = loadReceiptStmt.get(
											modelName,
											kit.name,
											instanceId,
											meta.commandId,
										);
										if (existingReceiptRow !== undefined) {
											const parsed: SendResult = decodeAccepted(
												JSON.parse(
													asText(existingReceiptRow.receipt_json, "receipt_json"),
												),
											);
											return parsed;
										}
										const current = readAggregate(instanceId);
										const result = yield* kit.handle({
											id: instanceId,
											state: current.state,
											version: current.version,
											command,
											commandId: meta.commandId,
											context: meta.context,
											now: now(),
											...(meta.correlationId !== undefined
												? { correlationId: meta.correlationId }
												: undefined),
											...(meta.trace !== undefined
												? { trace: meta.trace }
												: undefined),
											...(meta.link !== undefined
												? { link: meta.link }
												: undefined),
										});
										if (result._tag === "Rejected") {
											return result;
										}
										const receipt: ReceiptJson = {
											stream: `${kit.name}/${instanceId}`,
											version: result.version,
											events: result.events.map((entry) => entry.event),
											reply: result.reply,
										};
										const accepted: SendResult = {
											_tag: "Accepted",
											receipt,
										};
										inTransaction(() => {
											saveAggregateStmt.run(
												modelName,
												kit.name,
												instanceId,
												JSON.stringify(result.state),
												result.version,
											);
											for (const entry of result.events) {
												insertEventStmt.run(
													modelName,
													kit.name,
													instanceId,
													entry.envelope.seq,
													JSON.stringify(entry.event),
													JSON.stringify(entry.envelope),
												);
											}
											saveReceiptStmt.run(
												modelName,
												kit.name,
												instanceId,
												meta.commandId,
												JSON.stringify(accepted),
											);
										});
										yield* announce(instanceId, result.version);
										for (const delivery of result.deliveries) {
											yield* kit.deliver(delivery);
										}
										return accepted;
									}),
								);

							const store: AggregateStore = {
								send: commit,
								schedule: (instanceId, name, command, meta, due) =>
									lock.withPermits(1)(
										Effect.suspend(() => {
											let entries = scheduled.get(instanceId);
											if (entries === undefined) {
												entries = new Map();
												scheduled.set(instanceId, entries);
											}
											const existing = entries.get(name);
											if (existing?.commandId === meta.commandId) {
												return Effect.succeed(existing.at);
											}
											const at =
												"at" in due ? due.at : now() + due.afterMillis;
											const record = {
												commandId: meta.commandId,
												at,
												cancelled: false,
											};
											entries.set(name, record);
											return Effect.forkDetach(
												Effect.sleep(Math.max(0, at - now())).pipe(
													Effect.andThen(
														Effect.suspend(() =>
															record.cancelled
																? Effect.void
																: commit(instanceId, command, meta).pipe(
																		Effect.asVoid,
																	),
														),
													),
												),
											).pipe(Effect.as(at));
										}),
									),
								unschedule: (instanceId, name) =>
									lock.withPermits(1)(
										Effect.suspend<
											void,
											AlreadyExecuted | AlreadyCancelled | NotScheduled,
											never
										>(() => {
											const fields = {
												aggregate: kit.name,
												id: instanceId,
												commandId: name,
											};
											const record = scheduled.get(instanceId)?.get(name);
											if (record === undefined) {
												return Effect.fail(new NotScheduled(fields));
											}
											if (
												loadReceiptStmt.get(
													modelName,
													kit.name,
													instanceId,
													record.commandId,
												) !== undefined
											) {
												return Effect.fail(new AlreadyExecuted(fields));
											}
											if (record.cancelled) {
												return Effect.fail(new AlreadyCancelled(fields));
											}
											record.cancelled = true;
											return Effect.void;
										}),
									),
								state: (instanceId) =>
									Effect.sync(() => readAggregate(instanceId)),
								events: (instanceId) =>
									Effect.sync(() => readEvents(instanceId)),
								changes: (instanceId) =>
									Stream.unwrap(
										versionRefOf(instanceId).pipe(
											Effect.map((ref) =>
												SubscriptionRef.changes(ref).pipe(
													Stream.map(() => readAggregate(instanceId)),
												),
											),
										),
									),
								tail: (instanceId, after) =>
									Stream.unwrap(
										versionRefOf(instanceId).pipe(
											Effect.map((ref) => {
												let last = after;
												return SubscriptionRef.changes(ref).pipe(
													Stream.flatMap(() => {
														const fresh = readEvents(instanceId).filter(
															(entry) => entry.envelope.seq > last,
														);
														const lastFresh = fresh[fresh.length - 1];
														if (lastFresh !== undefined) {
															last = lastFresh.envelope.seq;
														}
														return Stream.fromIterable(fresh);
													}),
												);
											}),
										),
									),
								seed: (instanceId, events) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const current = readAggregate(instanceId);
											const result = yield* kit.seed({
												id: instanceId,
												state: current.state,
												version: current.version,
												events,
												commandId: `seed:${instanceId}:${current.version}`,
												now: now(),
											});
											inTransaction(() => {
												saveAggregateStmt.run(
													modelName,
													kit.name,
													instanceId,
													JSON.stringify(result.state),
													result.version,
												);
												for (const entry of result.events) {
													insertEventStmt.run(
														modelName,
														kit.name,
														instanceId,
														entry.envelope.seq,
														JSON.stringify(entry.event),
														JSON.stringify(entry.envelope),
													);
												}
											});
											yield* announce(instanceId, result.version);
											for (const delivery of result.deliveries) {
												yield* kit.deliver(delivery);
											}
										}),
									),
							};
							return store;
						}),

					view: (_view, kit) =>
						Effect.sync(() => {
							const lock = Semaphore.makeUnsafe(1);
							const refs = new Map<
								string,
								SubscriptionRef.SubscriptionRef<ViewSnapshot>
							>();

							const readSnapshot = (key: string): ViewSnapshot => {
								const row = loadViewStmt.get(modelName, kit.name, key);
								if (row === undefined) return emptySnapshot;
								return decodeViewSnapshot(
									JSON.parse(asText(row.snapshot_json, "snapshot_json")),
								);
							};

							const readEntries = (key: string): ViewEntry[] =>
								loadViewEntriesStmt
									.all(modelName, kit.name, key)
									.map((row) =>
										decodeViewEntry(
											JSON.parse(asText(row.entry_json, "entry_json")),
										),
									);

							const snapshotRefOf = (key: string) =>
								Effect.suspend(() => {
									const existing = refs.get(key);
									if (existing !== undefined) return Effect.succeed(existing);
									return SubscriptionRef.make(readSnapshot(key)).pipe(
										Effect.tap((ref) =>
											Effect.sync(() => {
												refs.set(key, ref);
											}),
										),
									);
								});

							const store: ViewStore = {
								receive: (key, deliveries) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const current = readSnapshot(key);
											const applied = yield* kit.apply(
												key,
												current,
												deliveries,
											);
											if (!applied.changed) return;
											inTransaction(() => {
												saveViewStmt.run(
													modelName,
													kit.name,
													key,
													JSON.stringify(applied.snapshot),
												);
												for (const entry of applied.entries) {
													insertViewEntryStmt.run(
														modelName,
														kit.name,
														key,
														entry.seq,
														JSON.stringify(entry),
													);
												}
											});
											const ref = refs.get(key);
											if (ref !== undefined) {
												yield* SubscriptionRef.set(ref, applied.snapshot);
											}
											for (const downstream of applied.downstream) {
												yield* kit.deliver(downstream);
											}
										}),
									),
								read: (key) => Effect.sync(() => readSnapshot(key)),
								changes: (key) =>
									Stream.unwrap(
										snapshotRefOf(key).pipe(
											Effect.map((ref) => SubscriptionRef.changes(ref)),
										),
									),
								list: (key, range) =>
									Effect.sync(() => inRange(readEntries(key), range)),
								tail: (key, after) =>
									Stream.unwrap(
										snapshotRefOf(key).pipe(
											Effect.map((ref) => {
												let last = after;
												return SubscriptionRef.changes(ref).pipe(
													Stream.flatMap(() => {
														const fresh = readEntries(key).filter(
															(entry) => entry.seq > last,
														);
														const lastFresh = fresh[fresh.length - 1];
														if (lastFresh !== undefined) last = lastFresh.seq;
														return Stream.fromIterable(fresh);
													}),
												);
											}),
										),
									),
							};
							return store;
						}),

					policy: (_policy, kit) =>
						Effect.sync(() => {
							const lock = Semaphore.makeUnsafe(1);
							const store: PolicyStore = {
								receive: (delivery: Delivery) =>
									lock.withPermits(1)(kit.run(delivery)),
							};
							return store;
						}),

					projection: (_projection, kit) =>
						Effect.sync(() => {
							const lock = Semaphore.makeUnsafe(1);
							const readCheckpoints = (key: string) => {
								const row = loadProjectionStmt.get(modelName, kit.name, key);
								if (row === undefined) {
									return decodeCheckpoints({});
								}
								return decodeCheckpoints(
									JSON.parse(asText(row.checkpoints_json, "checkpoints_json")),
								);
							};
							let position = 0;
							const store: ProjectionStore = {
								receive: (delivery) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const checkpoints = readCheckpoints(delivery.key);
											const prev = checkpoints[delivery.source] ?? 0;
											if (delivery.seq <= prev) return;
											position += 1;
											yield* kit.run(delivery.key, [
												{ position, delivery, at: now() },
											]);
											const nextCheckpoints = {
												...checkpoints,
												[delivery.source]: delivery.seq,
											};
											saveProjectionStmt.run(
												modelName,
												kit.name,
												delivery.key,
												JSON.stringify(nextCheckpoints),
											);
										}),
									),
								checkpoints: (key) => Effect.sync(() => readCheckpoints(key)),
							};
							return store;
						}),

					stream: (_stream, kit) =>
						Effect.sync(() => {
							const lock = Semaphore.makeUnsafe(1);
							const refs = new Map<
								string,
								SubscriptionRef.SubscriptionRef<StreamMeta>
							>();

							const readMeta = (key: string): StreamMeta => {
								const row = loadStreamStmt.get(modelName, kit.name, key);
								if (row === undefined) return emptyStreamMeta;
								return decodeStreamMeta(
									JSON.parse(asText(row.meta_json, "meta_json")),
								);
							};

							const readEntries = (key: string): StreamEntry[] =>
								loadStreamEntriesStmt
									.all(modelName, kit.name, key)
									.map((row) =>
										decodeStreamEntry(
											JSON.parse(asText(row.entry_json, "entry_json")),
										),
									);

							const metaRefOf = (key: string) =>
								Effect.suspend(() => {
									const existing = refs.get(key);
									if (existing !== undefined) return Effect.succeed(existing);
									return SubscriptionRef.make(readMeta(key)).pipe(
										Effect.tap((ref) =>
											Effect.sync(() => {
												refs.set(key, ref);
											}),
										),
									);
								});

							const store: StreamStore = {
								append: (key, write) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const current = readMeta(key);
											if (
												write.origin[0] < current.origin[0] ||
												(write.origin[0] === current.origin[0] &&
													write.origin[1] <= current.origin[1])
											) {
												return;
											}
											let seq = current.seq;
											const entries: StreamEntry[] = write.events.map(
												(event) => {
													seq += 1;
													return {
														seq,
														event,
														envelope: {
															id: `${kit.name}/${key}/${seq}`,
															stream: `${kit.name}/${key}`,
															seq,
															commandId: write.commandId,
															at: write.at,
														},
													};
												},
											);
											const nextMeta: StreamMeta = {
												seq,
												checkpoints: {
													...current.checkpoints,
													[write.source]: write.sourceSeq,
												},
												origin: write.origin,
											};
											inTransaction(() => {
												saveStreamStmt.run(
													modelName,
													kit.name,
													key,
													JSON.stringify(nextMeta),
												);
												for (const entry of entries) {
													insertStreamEntryStmt.run(
														modelName,
														kit.name,
														key,
														entry.seq,
														JSON.stringify(entry),
													);
												}
											});
											const ref = refs.get(key);
											if (ref !== undefined) {
												yield* SubscriptionRef.set(ref, nextMeta);
											}
										}),
									),
								advance: (key, checkpoints) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const current = readMeta(key);
											const nextMeta: StreamMeta = {
												...current,
												checkpoints: { ...current.checkpoints, ...checkpoints },
											};
											saveStreamStmt.run(
												modelName,
												kit.name,
												key,
												JSON.stringify(nextMeta),
											);
											const ref = refs.get(key);
											if (ref !== undefined) {
												yield* SubscriptionRef.set(ref, nextMeta);
											}
										}),
									),
								read: (key) => Effect.sync(() => readMeta(key)),
								changes: (key) =>
									Stream.unwrap(
										metaRefOf(key).pipe(
											Effect.map((ref) => SubscriptionRef.changes(ref)),
										),
									),
								list: (key, range) =>
									Effect.sync(() => inRange(readEntries(key), range)),
								tail: (key, after) =>
									Stream.unwrap(
										metaRefOf(key).pipe(
											Effect.map((ref) => {
												let last = after;
												return SubscriptionRef.changes(ref).pipe(
													Stream.flatMap(() => {
														const fresh = readEntries(key).filter(
															(entry) => entry.seq > last,
														);
														const lastFresh = fresh[fresh.length - 1];
														if (lastFresh !== undefined) last = lastFresh.seq;
														return Stream.fromIterable(fresh);
													}),
												);
											}),
										),
									),
							};
							return store;
						}),
				};
				return host;
			}),
	});

	return Layer.mergeAll(
		platformLayer,
		Layer.succeed(WorkflowEngine.WorkflowEngine, workflows),
		SecureRandom.layerWebCrypto,
	);
}
