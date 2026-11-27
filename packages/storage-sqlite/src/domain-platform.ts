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
import {
	asInMemoryWorkflowHost,
	assertSqlitePersisted,
	type DomainOutbox,
	DomainPersistenceError,
	type DomainScheduleStore,
	initSqliteDomainDurableTables,
	makeDomainOutbox,
	makeDomainScheduleStore,
	makeSqliteBackedWorkflowEngine,
	type PersistedScheduleRecord,
	type SqliteWorkflowHost,
	scheduleDueMillis,
} from "./domain-platform-durable.js";
import { asNumber, asText, type SqliteDriver } from "./driver.js";

export { DomainPersistenceError };

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
	initSqliteDomainDurableTables(driver);
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

export class DomainAggregateVersionConflictError extends Error {
	readonly _tag = "DomainAggregateVersionConflictError";

	constructor(
		readonly modelName: string,
		readonly aggregateName: string,
		readonly instanceId: string,
		readonly expectedVersion: number,
		readonly actualVersion: number | undefined,
	) {
		super(
			`aggregate version conflict for ${aggregateName}/${instanceId}: expected ${expectedVersion}, observed ${actualVersion ?? "absent"}`,
		);
		this.name = "DomainAggregateVersionConflictError";
	}
}

export class DomainEventSequenceConflictError extends Error {
	readonly _tag = "DomainEventSequenceConflictError";

	constructor(
		readonly modelName: string,
		readonly aggregateName: string,
		readonly instanceId: string,
		readonly seq: number,
	) {
		super(
			`domain event seq collision for ${aggregateName}/${instanceId} at seq ${seq}`,
		);
		this.name = "DomainEventSequenceConflictError";
	}
}

function isSqlitePrimaryKeyConflict(cause: unknown): boolean {
	if (!(cause instanceof Error)) return false;
	const message = cause.message;
	return (
		message.includes("UNIQUE constraint failed") ||
		message.includes("PRIMARY KEY constraint failed")
	);
}

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
	const casUpdateAggregateStmt = driver.prepare(
		`UPDATE domain_aggregates
     SET state_json = ?, version = ?
     WHERE model_name = ? AND aggregate_name = ? AND instance_id = ? AND version = ?`,
	);
	const insertAggregateStmt = driver.prepare(
		"INSERT INTO domain_aggregates (model_name, aggregate_name, instance_id, state_json, version) VALUES (?, ?, ?, ?, ?)",
	);
	const insertEventStmt = driver.prepare(
		"INSERT INTO domain_events (model_name, aggregate_name, instance_id, seq, event_json, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
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
		"SELECT checkpoints_json, processed_position FROM domain_projections WHERE model_name = ? AND projection_name = ? AND projection_key = ?",
	);
	const saveProjectionStmt = driver.prepare(
		"INSERT OR REPLACE INTO domain_projections (model_name, projection_name, projection_key, checkpoints_json, processed_position) VALUES (?, ?, ?, ?, ?)",
	);
	const outbox: DomainOutbox = makeDomainOutbox(driver);
	const scheduleStore: DomainScheduleStore = makeDomainScheduleStore(driver);

	const workflowHostBase: SqliteWorkflowHost = {
		now,
		enqueue: (run, _key) => Effect.forkDetach(run).pipe(Effect.asVoid),
		acquire: (lock) => lock.take(1),
		timer: (_key, at, fire) =>
			Effect.forkDetach(
				Effect.sleep(Math.max(0, at - now())).pipe(Effect.andThen(fire)),
			).pipe(Effect.asVoid),
		failed: () => undefined,
		died: () => undefined,
	};

	const { engine: workflows, resumeDurableSideEffects } =
		makeSqliteBackedWorkflowEngine(
			"__hobo_platform__",
			driver,
			workflowHostBase,
			(host) => InMemoryWorkflows.make(asInMemoryWorkflowHost(host)),
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

	const makePersistAggregateTransaction = (modelName: string) => {
		const readAggregateVersion = (
			aggregateName: string,
			instanceId: string,
		): number | undefined => {
			const row = loadAggregateStmt.get(modelName, aggregateName, instanceId);
			if (row === undefined) return undefined;
			return asNumber(row.version, "version");
		};

		const refuseVersionConflict = (
			aggregateName: string,
			instanceId: string,
			expectedVersion: number,
		): never => {
			throw new DomainAggregateVersionConflictError(
				modelName,
				aggregateName,
				instanceId,
				expectedVersion,
				readAggregateVersion(aggregateName, instanceId),
			);
		};

		return (input: {
			aggregateName: string;
			instanceId: string;
			expectedVersion: number;
			state: unknown;
			newVersion: number;
			events: ReadonlyArray<StoredEvent>;
			receipt?: { commandId: string; accepted: SendResult } | undefined;
			deliveries?: ReadonlyArray<Delivery>;
		}) => {
			return inTransaction(() => {
				const updated = casUpdateAggregateStmt.run(
					JSON.stringify(input.state),
					input.newVersion,
					modelName,
					input.aggregateName,
					input.instanceId,
					input.expectedVersion,
				);
				if (updated.changes !== 1) {
					if (input.expectedVersion !== 0) {
						refuseVersionConflict(
							input.aggregateName,
							input.instanceId,
							input.expectedVersion,
						);
					}
					try {
						const inserted = insertAggregateStmt.run(
							modelName,
							input.aggregateName,
							input.instanceId,
							JSON.stringify(input.state),
							input.newVersion,
						);
						if (inserted.changes !== 1) {
							refuseVersionConflict(
								input.aggregateName,
								input.instanceId,
								input.expectedVersion,
							);
						}
					} catch (cause) {
						if (isSqlitePrimaryKeyConflict(cause)) {
							refuseVersionConflict(
								input.aggregateName,
								input.instanceId,
								input.expectedVersion,
							);
						}
						throw cause;
					}
				}
				for (const entry of input.events) {
					const written = insertEventStmt.run(
						modelName,
						input.aggregateName,
						input.instanceId,
						entry.envelope.seq,
						JSON.stringify(entry.event),
						JSON.stringify(entry.envelope),
					);
					if (written.changes !== 1) {
						throw new DomainEventSequenceConflictError(
							modelName,
							input.aggregateName,
							input.instanceId,
							entry.envelope.seq,
						);
					}
				}
				if (input.receipt !== undefined) {
					const saved = saveReceiptStmt.run(
						modelName,
						input.aggregateName,
						input.instanceId,
						input.receipt.commandId,
						JSON.stringify(input.receipt.accepted),
					);
					assertSqlitePersisted(saved, "domain_receipts.save");
				}
				if (input.deliveries !== undefined && input.deliveries.length > 0) {
					return outbox.stageWithinTransaction(modelName, input.deliveries);
				}
				return [] satisfies number[];
			});
		};
	};

	const platformLayer = Layer.succeed(Platform, {
		model: ({ modelName, id }) =>
			Effect.gen(function* () {
				yield* claim(modelName, id);
				yield* resumeDurableSideEffects;
				const persistAggregate = makePersistAggregateTransaction(modelName);
				let outboxBootDrained = false;
				const inFlightOutboxIds = new Set<number>();
				const pendingDeliveries: Array<{
					readonly delivery: Delivery;
					readonly outboxId: number | undefined;
					readonly deliver: (delivery: Delivery) => Effect.Effect<void>;
				}> = [];
				let drainingDeliveries = false;
				const drainDeliveryQueue: Effect.Effect<void> = Effect.suspend(() => {
					if (drainingDeliveries) {
						return Effect.void;
					}
					drainingDeliveries = true;
					return Effect.gen(function* () {
						while (pendingDeliveries.length > 0) {
							const next = pendingDeliveries.shift();
							if (next === undefined) break;
							yield* next.deliver(next.delivery).pipe(
								Effect.tap(() =>
									next.outboxId !== undefined
										? outbox.dropStaged(modelName, [next.outboxId])
										: Effect.void,
								),
								Effect.ensuring(
									Effect.sync(() => {
										if (next.outboxId !== undefined) {
											inFlightOutboxIds.delete(next.outboxId);
										}
									}),
								),
							);
						}
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								drainingDeliveries = false;
								while (pendingDeliveries.length > 0) {
									const leftover = pendingDeliveries.shift();
									if (leftover?.outboxId !== undefined) {
										inFlightOutboxIds.delete(leftover.outboxId);
									}
								}
							}),
						),
					);
				});
				const deliverStagedOutbox = (
					deliveries: ReadonlyArray<Delivery>,
					stagedOutbox: ReadonlyArray<number>,
					deliver: (delivery: Delivery) => Effect.Effect<void>,
				) =>
					Effect.suspend(() => {
						for (let index = 0; index < deliveries.length; index += 1) {
							const delivery = deliveries[index];
							if (delivery === undefined) continue;
							pendingDeliveries.push({
								delivery,
								outboxId: stagedOutbox[index],
								deliver,
							});
						}
						return drainDeliveryQueue;
					});
				const host: ModelHost = {
					aggregate: (_aggregate, kit) =>
						Effect.gen(function* () {
							const lock = Semaphore.makeUnsafe(1);
							const versions = new Map<
								string,
								SubscriptionRef.SubscriptionRef<number>
							>();
							const scheduleArms = new Map<
								string,
								Map<string, { cancelled: boolean }>
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
								Effect.gen(function* () {
									if (!outboxBootDrained) {
										outboxBootDrained = true;
										yield* outbox.drainPending(
											modelName,
											(delivery) => kit.deliver(delivery),
											inFlightOutboxIds,
										);
									}
									let ownedOutboxIds: ReadonlyArray<number> = [];
									let handedOff = false;
									return yield* Effect.gen(function* () {
										const committed = yield* lock.withPermits(1)(
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
															asText(
																existingReceiptRow.receipt_json,
																"receipt_json",
															),
														),
													);
													return {
														_tag: "Duplicate" as const,
														accepted: parsed,
													};
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
													return {
														_tag: "Rejected" as const,
														result,
													};
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
												const stagedOutbox = persistAggregate({
													aggregateName: kit.name,
													instanceId,
													expectedVersion: current.version,
													state: result.state,
													newVersion: result.version,
													events: result.events,
													receipt: {
														commandId: meta.commandId,
														accepted,
													},
													deliveries: result.deliveries,
												});
												ownedOutboxIds = stagedOutbox;
												for (const outboxId of stagedOutbox) {
													inFlightOutboxIds.add(outboxId);
												}
												yield* announce(instanceId, result.version);
												return {
													_tag: "Committed" as const,
													accepted,
													deliveries: result.deliveries,
													stagedOutbox,
												};
											}),
										);
										if (committed._tag === "Rejected") {
											return committed.result;
										}
										if (committed._tag === "Duplicate") {
											yield* outbox.drainPending(
												modelName,
												(delivery) => kit.deliver(delivery),
												inFlightOutboxIds,
											);
											return committed.accepted;
										}
										handedOff = true;
										yield* deliverStagedOutbox(
											committed.deliveries,
											committed.stagedOutbox,
											kit.deliver,
										);
										return committed.accepted;
									}).pipe(
										Effect.ensuring(
											Effect.sync(() => {
												if (handedOff) return;
												for (const outboxId of ownedOutboxIds) {
													inFlightOutboxIds.delete(outboxId);
												}
											}),
										),
									);
								});

							const armPersistedSchedule = (
								instanceId: string,
								scheduleName: string,
								record: PersistedScheduleRecord,
							) => {
								if (
									loadReceiptStmt.get(
										modelName,
										kit.name,
										instanceId,
										record.commandId,
									) !== undefined
								) {
									return Effect.void;
								}
								const command = JSON.parse(record.commandJson);
								const meta = JSON.parse(record.metaJson);
								let entries = scheduleArms.get(instanceId);
								if (entries === undefined) {
									entries = new Map();
									scheduleArms.set(instanceId, entries);
								}
								if (entries.has(scheduleName)) {
									return Effect.void;
								}
								const arm = { cancelled: false };
								entries.set(scheduleName, arm);
								return Effect.forkDetach(
									Effect.sleep(Math.max(0, record.dueAt - now())).pipe(
										Effect.andThen(
											Effect.suspend(() =>
												arm.cancelled
													? Effect.void
													: commit(instanceId, command, meta).pipe(
															Effect.asVoid,
														),
											),
										),
									),
								).pipe(Effect.asVoid);
							};

							for (const active of scheduleStore.listActive(
								modelName,
								kit.name,
							)) {
								yield* armPersistedSchedule(
									active.instanceId,
									active.scheduleName,
									active.record,
								);
							}

							const store: AggregateStore = {
								send: commit,
								schedule: (instanceId, name, command, meta, due) =>
									lock.withPermits(1)(
										Effect.suspend(() => {
											const existing = scheduleStore.load(
												modelName,
												kit.name,
												instanceId,
												name,
											);
											if (
												existing !== undefined &&
												existing.commandId === meta.commandId &&
												!existing.cancelled
											) {
												return Effect.succeed(existing.dueAt);
											}
											const at = scheduleDueMillis(now, due);
											inTransaction(() => {
												scheduleStore.upsert(
													modelName,
													kit.name,
													instanceId,
													name,
													{
														commandId: meta.commandId,
														dueAt: at,
														commandJson: JSON.stringify(command),
														metaJson: JSON.stringify(meta),
														cancelled: false,
													},
												);
											});
											let entries = scheduleArms.get(instanceId);
											if (entries === undefined) {
												entries = new Map();
												scheduleArms.set(instanceId, entries);
											}
											const arm = { cancelled: false };
											entries.set(name, arm);
											return Effect.forkDetach(
												Effect.sleep(Math.max(0, at - now())).pipe(
													Effect.andThen(
														Effect.suspend(() =>
															arm.cancelled
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
											const persisted = scheduleStore.load(
												modelName,
												kit.name,
												instanceId,
												name,
											);
											if (persisted === undefined) {
												return Effect.fail(new NotScheduled(fields));
											}
											if (
												loadReceiptStmt.get(
													modelName,
													kit.name,
													instanceId,
													persisted.commandId,
												) !== undefined
											) {
												return Effect.fail(new AlreadyExecuted(fields));
											}
											if (persisted.cancelled) {
												return Effect.fail(new AlreadyCancelled(fields));
											}
											inTransaction(() => {
												scheduleStore.markCancelled(
													modelName,
													kit.name,
													instanceId,
													name,
												);
											});
											const arm = scheduleArms.get(instanceId)?.get(name);
											if (arm !== undefined) arm.cancelled = true;
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
									Effect.gen(function* () {
										let ownedOutboxIds: ReadonlyArray<number> = [];
										let handedOff = false;
										yield* Effect.gen(function* () {
											const seeded = yield* lock.withPermits(1)(
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
													const stagedOutbox = persistAggregate({
														aggregateName: kit.name,
														instanceId,
														expectedVersion: current.version,
														state: result.state,
														newVersion: result.version,
														events: result.events,
														deliveries: result.deliveries,
													});
													ownedOutboxIds = stagedOutbox;
													for (const outboxId of stagedOutbox) {
														inFlightOutboxIds.add(outboxId);
													}
													yield* announce(instanceId, result.version);
													return {
														deliveries: result.deliveries,
														stagedOutbox,
													};
												}),
											);
											handedOff = true;
											yield* deliverStagedOutbox(
												seeded.deliveries,
												seeded.stagedOutbox,
												kit.deliver,
											);
										}).pipe(
											Effect.ensuring(
												Effect.sync(() => {
													if (handedOff) return;
													for (const outboxId of ownedOutboxIds) {
														inFlightOutboxIds.delete(outboxId);
													}
												}),
											),
										);
									}),
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
											const stagedOutbox = inTransaction(() => {
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
												return outbox.stageWithinTransaction(
													modelName,
													applied.downstream,
												);
											});
											const ref = refs.get(key);
											if (ref !== undefined) {
												yield* SubscriptionRef.set(ref, applied.snapshot);
											}
											for (const downstream of applied.downstream) {
												yield* kit.deliver(downstream);
											}
											yield* outbox.dropStaged(modelName, stagedOutbox);
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
							const readProcessedPosition = (key: string) => {
								const row = loadProjectionStmt.get(modelName, kit.name, key);
								if (row === undefined) return 0;
								return asNumber(row.processed_position, "processed_position");
							};
							const store: ProjectionStore = {
								receive: (delivery) =>
									lock.withPermits(1)(
										Effect.gen(function* () {
											const checkpoints = readCheckpoints(delivery.key);
											const prev = checkpoints[delivery.source] ?? 0;
											if (delivery.seq <= prev) return;
											const processedPosition = readProcessedPosition(
												delivery.key,
											);
											const nextPosition = processedPosition + 1;
											yield* kit.run(delivery.key, [
												{
													position: nextPosition,
													delivery,
													at: now(),
												},
											]);
											const nextCheckpoints = {
												...checkpoints,
												[delivery.source]: delivery.seq,
											};
											inTransaction(() => {
												saveProjectionStmt.run(
													modelName,
													kit.name,
													delivery.key,
													JSON.stringify(nextCheckpoints),
													nextPosition,
												);
											});
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
