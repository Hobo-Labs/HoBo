import {
	type DurableEventStore,
	type EventEnvelope,
	isEventStoreOptimisticConflict,
	type PrincipalRef,
	parseEventPosition,
} from "@hobo/core";
import type { CanonicalRecord, DatasetSchema } from "../canonical.js";
import { schemaDigest } from "../canonical.js";
import { compareDigests, DEFAULT_DIGEST_BUCKETS } from "../digest.js";
import {
	type ChangeEnvelope,
	envelopeOf,
	type Position,
	type RecordMutation,
} from "../envelope.js";
import { DataCoreError } from "../errors.js";
import { fenceTokenDigest, MIGRATION_EVENTS } from "../facts.js";
import {
	canonicalEncode,
	type JsonObject,
	type JsonValue,
	sha256Hex,
} from "../json.js";
import type { MigrationPhase, RollbackPosture } from "../patterns.js";
import {
	type Awaitable,
	type DatasetScope,
	type EngineBinding,
	requirePort,
} from "../spi.js";
import type { SoakDecision } from "./copy.js";
import {
	type AuthorityHandover,
	decidedFenceToken,
	MigrationHold,
	MigrationRollback,
	MigrationRun,
	type MigrationRunResult,
	type MigrationRuntime,
	type PlannedDetails,
} from "./runtime.js";

export type SinkReader = (
	tenant: string,
	key: string,
) => Promise<CanonicalRecord | undefined>;

export interface ProjectionFold {
	readonly name: string;
	project(
		event: EventEnvelope,
		read: SinkReader,
	): Awaitable<readonly RecordMutation[]>;
}

type LogReader = Pick<DurableEventStore, "readAll">;

interface ProjectOutcome {
	readonly position: Position;
	readonly events: number;
	readonly caughtUp: boolean;
}

const OVERLAY_SEPARATOR = "\u0000";

async function projectBatch(
	log: LogReader,
	fold: ProjectionFold,
	sink: EngineBinding,
	scope: DatasetScope,
	known: Position | null,
	limit: number,
): Promise<ProjectOutcome> {
	const after = known ?? "0";
	const overlay = new Map<string, CanonicalRecord | undefined>();
	const read: SinkReader = async (tenant, key) => {
		const slot = `${tenant}${OVERLAY_SEPARATOR}${key}`;
		if (overlay.has(slot)) return overlay.get(slot);
		return sink.records.read({ dataset: scope.dataset, tenant, key });
	};
	const mutations: RecordMutation[] = [];
	let position = after;
	let events = 0;
	for await (const item of log.readAll({
		after: parseEventPosition(after),
		limit,
	})) {
		for (const mutation of await fold.project(item.event, read)) {
			overlay.set(
				`${mutation.tenant}${OVERLAY_SEPARATOR}${mutation.key}`,
				mutation.op === "upsert" ? mutation.record : undefined,
			);
			mutations.push(mutation);
		}
		position = item.position.toString();
		events += 1;
	}
	if (events > 0) {
		await requirePort(sink, "apply").apply({
			dataset: scope.dataset,
			changes: mutations,
			source: fold.name,
			position,
			expectedWatermark: known,
		});
	}
	return { position, events, caughtUp: events < limit };
}

async function projectToHead(
	log: LogReader,
	fold: ProjectionFold,
	sink: EngineBinding,
	scope: DatasetScope,
	limit: number,
	rounds: number,
): Promise<ProjectOutcome> {
	let known: Position | null =
		(await requirePort(sink, "apply").watermark({
			dataset: scope.dataset,
			source: fold.name,
		})) ?? null;
	let events = 0;
	for (let round = 0; round < rounds; round += 1) {
		const outcome = await projectBatch(log, fold, sink, scope, known, limit);
		if (outcome.events > 0) known = outcome.position;
		events += outcome.events;
		if (outcome.caughtUp) {
			return { position: known ?? "0", events, caughtUp: true };
		}
	}
	return { position: known ?? "0", events, caughtUp: false };
}


export interface RebuildAndSwapOptions {
	readonly runtime: MigrationRuntime;
	readonly log: LogReader;
	readonly fold: ProjectionFold;
	readonly target: EngineBinding;
	readonly schema: DatasetSchema;
	readonly scope: DatasetScope;
	readonly previous?: EngineBinding;
	readonly previousScope?: DatasetScope;
	readonly batch?: number;
	readonly maxRounds?: number;
	readonly buckets?: number;
	readonly verifyRechecks?: number;
	readonly rampSteps?: readonly number[];
	readonly shiftReads?: (percent: number) => Awaitable<void>;
	readonly soakDecision?: () => Awaitable<SoakDecision>;
	readonly retirePrevious?: () => Awaitable<void>;
	readonly plan?: PlannedDetails;
}

export async function runRebuildAndSwap(
	options: RebuildAndSwapOptions,
): Promise<MigrationRunResult> {
	const run = await MigrationRun.open(options.runtime, "rebuild-and-swap", {
		target: options.target.declaration.engine,
		dataset: options.schema.name,
		...options.plan,
	});
	const batch = options.batch ?? 500;
	const rounds = options.maxRounds ?? 1000;
	const buckets = options.buckets ?? DEFAULT_DIGEST_BUCKETS;
	const toHead = () =>
		projectToHead(
			options.log,
			options.fold,
			options.target,
			options.scope,
			batch,
			rounds,
		);
	const rollbackAt = (phase: MigrationPhase): RollbackPosture =>
		phase === "finalize" ? "none" : "lossless";
	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		await run.phase("prepare", async () => {
			const provision = await options.target.datasets.ensureDataset(
				options.schema,
			);
			return { created: provision.created };
		});
		await run.phase("seed", async () => {
			const outcome = await toHead();
			return { position: outcome.position, events: outcome.events };
		});
		await run.phase("converge", async () => {
			const outcome = await toHead();
			if (!outcome.caughtUp) {
				throw new MigrationHold(
					"seed",
					"the log is still ahead of the new sink",
				);
			}
			return { position: outcome.position, events: outcome.events };
		});
		await run.phase("verify", async () => {
			const attempts = (options.verifyRechecks ?? 3) + 1;
			let behind = false;
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				const outcome = await toHead();
				const position = outcome.position;
				behind = !outcome.caughtUp;
				if (behind) continue;
				const target = await requirePort(options.target, "verify").digest({
					scope: options.scope,
					buckets,
				});
				if (options.previous === undefined) {
					return {
						position,
						count: target.count,
						digest: target.digest,
						compared: false,
					};
				}
				const previous = await requirePort(options.previous, "verify").digest({
					scope: options.previousScope ?? options.scope,
					buckets,
				});
				if (compareDigests(previous, target).equal) {
					await run.emit(MIGRATION_EVENTS.Verified, {
						migrationId: options.runtime.migrationId,
						point: "pre-swap",
						count: target.count,
						digest: target.digest,
						verifiedAt: options.runtime.clock(),
					});
					return {
						position,
						count: target.count,
						digest: target.digest,
						compared: true,
					};
				}
			}
			throw new MigrationHold(
				"converge",
				behind
					? "the log is still ahead of the new sink; nothing was verified"
					: "the rebuilt sink does not digest equal to the sink it replaces",
			);
		});
		await run.phase("shift-reads", async () => {
			const steps = options.rampSteps ?? [10, 50, 100];
			for (const percent of steps) await options.shiftReads?.(percent);
			return { percent: steps[steps.length - 1] ?? 100 };
		});
		await run.phase("soak", async () => {
			await toHead();
			const decision = (await options.soakDecision?.()) ?? "finalize";
			if (decision === "hold")
				throw new MigrationHold("soak", "soak window left open");
			if (decision === "rollback") {
				await options.shiftReads?.(0);
				throw new MigrationRollback(
					"reads returned to the previous sink",
					true,
				);
			}
			return { decision };
		});
		await run.phase("finalize", async () => {
			await options.retirePrevious?.();
			return { retiredPrevious: options.retirePrevious !== undefined };
		});
		return "none";
	}, rollbackAt);
}


export interface PivotEvent {
	readonly streamId: string;
	readonly type: string;
	readonly v?: number;
	readonly data: JsonObject;
}

export interface PivotAppendContext {
	readonly actor: PrincipalRef;
	readonly tenant: string;
}

type PivotLog = Pick<DurableEventStore, "readAll" | "append" | "read"> & {
	getStreamHead?: DurableEventStore["getStreamHead"];
};

export interface LogPivotOptions {
	readonly runtime: MigrationRuntime;
	readonly source: EngineBinding;
	readonly schema: DatasetSchema;
	readonly scope: DatasetScope;
	readonly log: PivotLog;
	readonly toEvents: (change: ChangeEnvelope) => readonly PivotEvent[];
	readonly append: PivotAppendContext;
	readonly fold: ProjectionFold;
	readonly target: EngineBinding;
	readonly targetSchema: DatasetSchema;
	readonly targetScope: DatasetScope;
	readonly flipAuthority: (flip: AuthorityHandover) => Awaitable<void>;
	readonly chunkSize?: number;
	readonly tailBatch?: number;
	readonly maxRounds?: number;
	readonly buckets?: number;
	readonly plan?: PlannedDetails;
}

interface PivotContext {
	readonly options: LogPivotOptions;
	readonly subscription: string;
	readonly heads: Map<string, number>;
	readonly batch: number;
	readonly rounds: number;
}

async function streamHead(
	context: PivotContext,
	streamId: string,
): Promise<number> {
	const cached = context.heads.get(streamId);
	if (cached !== undefined) return cached;
	const { log } = context.options;
	let head = log.getStreamHead?.(streamId)?.revision;
	if (head === undefined) {
		head = 0;
		for await (const event of log.read(streamId)) head = event.seq;
	}
	context.heads.set(streamId, head);
	return head;
}

async function appendChange(
	context: PivotContext,
	change: ChangeEnvelope,
): Promise<number> {
	const { options } = context;
	const events = options.toEvents(change);
	let appended = 0;
	for (const [index, event] of events.entries()) {
		const idempotencyKey = sha256Hex(
			canonicalEncode([
				options.runtime.migrationId,
				change.position,
				change.tenant,
				change.key,
				change.op,
				change.record ?? null,
				index,
			]),
		);
		for (let attempt = 0; ; attempt += 1) {
			const expectedSeq = await streamHead(context, event.streamId);
			try {
				const result = await options.log.append(
					event.streamId,
					[
						{
							type: event.type,
							...(event.v === undefined ? undefined : { v: event.v }),
							data: event.data,
							meta: { idempotencyKey },
						},
					],
					{
						expectedSeq,
						actor: options.append.actor,
						tenant: options.append.tenant,
					},
				);
				context.heads.set(event.streamId, expectedSeq + result.appended.length);
				appended += result.appended.length;
				break;
			} catch (error) {
				if (
					attempt === 0 &&
					error instanceof Error &&
					isEventStoreOptimisticConflict(error)
				) {
					context.heads.delete(event.streamId);
					continue;
				}
				throw error;
			}
		}
	}
	return appended;
}

async function captureToLog(
	context: PivotContext,
	start: Position,
): Promise<{ position: Position; caughtUp: boolean; changes: number }> {
	const { options, subscription, batch, rounds } = context;
	const capture = requirePort(options.source, "capture");
	const marker = requirePort(options.target, "apply");
	let known: Position | null =
		(await marker.watermark({
			dataset: options.targetScope.dataset,
			source: subscription,
		})) ?? null;
	let position = known ?? start;
	let changes = 0;
	for (let round = 0; round < rounds; round += 1) {
		const read = await capture.read({
			scope: options.scope,
			subscription,
			after: position,
			limit: batch,
		});
		for (const change of read.changes) await appendChange(context, change);
		changes += read.changes.length;
		position = read.position;
		await marker.apply({
			dataset: options.targetScope.dataset,
			changes: [],
			source: subscription,
			position,
			expectedWatermark: known,
		});
		known = position;
		await capture.acknowledge({ subscription, position });
		if (read.caughtUp) return { position, caughtUp: true, changes };
	}
	return { position, caughtUp: false, changes };
}

export async function runLogPivot(
	options: LogPivotOptions,
): Promise<MigrationRunResult> {
	const comparable =
		schemaDigest({ ...options.schema, name: "_" }) ===
		schemaDigest({ ...options.targetSchema, name: "_" });
	if (comparable) requirePort(options.source, "verify");
	const run = await MigrationRun.open(options.runtime, "log-pivot", {
		source: options.source.declaration.engine,
		target: options.target.declaration.engine,
		dataset: options.schema.name,
		...options.plan,
	});
	const context: PivotContext = {
		options,
		subscription: `hobo_migration_${options.runtime.migrationId}_pivot`,
		heads: new Map(),
		batch: options.tailBatch ?? 500,
		rounds: options.maxRounds ?? 1000,
	};
	const buckets = options.buckets ?? DEFAULT_DIGEST_BUCKETS;
	const project = () =>
		projectToHead(
			options.log,
			options.fold,
			options.target,
			options.targetScope,
			context.batch,
			context.rounds,
		);
	const equalDigests = async (): Promise<{
		equal: boolean;
		count: number;
		digest: string;
	}> => {
		const target = await requirePort(options.target, "verify").digest({
			scope: options.targetScope,
			buckets,
		});
		if (!comparable) {
			return { equal: true, count: target.count, digest: target.digest };
		}
		const source = await requirePort(options.source, "verify").digest({
			scope: options.scope,
			buckets,
		});
		return {
			equal: compareDigests(source, target).equal,
			count: target.count,
			digest: target.digest,
		};
	};
	const rollbackAt = (phase: MigrationPhase): RollbackPosture =>
		phase === "fence-and-flip" || phase === "finalize" || phase === "soak"
			? "none"
			: "lossless";
	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		const prepared = await run.phase("prepare", async () => {
			await options.target.datasets.ensureDataset(options.targetSchema);
			const startPosition = await requirePort(options.source, "capture").start({
				scope: options.scope,
				subscription: context.subscription,
			});
			return { startPosition, comparable };
		});
		const startPosition = String(prepared.startPosition);
		await run.phase("seed", async () => {
			const cursor = await requirePort(options.source, "snapshot").openSnapshot(
				{
					scope: options.scope,
					chunkSize: options.chunkSize ?? 500,
				},
			);
			let adopted = 0;
			try {
				for (;;) {
					const chunk = await cursor.next();
					if (chunk === undefined) break;
					for (const mutation of chunk) {
						await appendChange(
							context,
							envelopeOf(options.schema, mutation, startPosition),
						);
						adopted += 1;
					}
				}
			} finally {
				await cursor.close();
			}
			await project();
			return { adopted };
		});
		await run.phase("converge", async () => {
			const tail = await captureToLog(context, startPosition);
			const projected = await project();
			if (!tail.caughtUp || !projected.caughtUp) {
				throw new MigrationHold(
					"seed",
					"capture or projection is still behind",
				);
			}
			return { position: tail.position, logPosition: projected.position };
		});
		await run.phase("verify", async () => {
			await captureToLog(context, startPosition);
			await project();
			const verdict = await equalDigests();
			if (!verdict.equal) {
				throw new MigrationHold(
					"converge",
					"the projected sink does not digest equal to the adopted store",
				);
			}
			await run.emit(MIGRATION_EVENTS.Verified, {
				migrationId: options.runtime.migrationId,
				point: "pre-flip",
				count: verdict.count,
				digest: verdict.digest,
				compared: comparable,
				verifiedAt: options.runtime.clock(),
			});
			return {
				count: verdict.count,
				digest: verdict.digest,
				compared: comparable,
			};
		});
		await run.phase("fence-and-flip", async () => {
			const decided = run.cutOverDecision();
			const fence = requirePort(options.source, "fence");
			const raise = () =>
				fence.raise({
					scope: options.scope,
					reason: `migration ${options.runtime.migrationId}`,
				});
			if (decided !== undefined) {
				const held = await raise();
				await options.flipAuthority({
					migrationId: options.runtime.migrationId,
					head: run.decisionHead(MIGRATION_EVENTS.CutOver),
					fenceToken: decidedFenceToken(decided, held.fenceToken),
				});
				return decided;
			}
			await run.requestFence("source", "fence-and-flip");
			const grant = await raise();
			const tail = await captureToLog(context, startPosition);
			const projected = await project();
			const verdict = await equalDigests();
			if (!tail.caughtUp || !projected.caughtUp || !verdict.equal) {
				const hold = await run.recordHold(
					"verify",
					"exact verification under the fence failed; the store remains the authority",
					{ compensated: true },
				);
				await fence.release({
					scope: options.scope,
					fenceToken: grant.fenceToken,
				});
				throw hold;
			}
			const decision: JsonObject = {
				migrationId: options.runtime.migrationId,
				authority: "log",
				fenceTokenDigest: fenceTokenDigest(grant.fenceToken),
				count: verdict.count,
				digest: verdict.digest,
				logPosition: projected.position,
				cutOverAt: options.runtime.clock(),
			};
			await run.emit(MIGRATION_EVENTS.CutOver, decision);
			await options.flipAuthority({
				migrationId: options.runtime.migrationId,
				head: run.decisionHead(MIGRATION_EVENTS.CutOver),
				fenceToken: grant.fenceToken,
			});
			return decision;
		});
		await run.phase("finalize", async () => {
			await requirePort(options.source, "capture").stop(context.subscription);
			return {};
		});
		return "none";
	}, rollbackAt);
}


export const HANDOFF_IDENTITY_IMPEDANCE = "HANDOFF_EVENT_IDENTITY_REMINTED";

type HandoffTarget = Pick<DurableEventStore, "append" | "readAll" | "read"> & {
	getStreamHead?: DurableEventStore["getStreamHead"];
};

export interface StreamHandoffOptions {
	readonly runtime: MigrationRuntime;
	readonly source: LogReader;
	readonly target: HandoffTarget;
	readonly quiesce: () => Awaitable<{ readonly fenceToken: string }>;
	readonly unquiesce: (fenceToken: string) => Awaitable<void>;
	readonly flipWriter: (flip: AuthorityHandover) => Awaitable<void>;
	readonly batch?: number;
	readonly maxRounds?: number;
	readonly plan?: PlannedDetails;
}

function jsonOf(data: EventEnvelope["data"]): JsonValue {
	return JSON.parse(JSON.stringify(data ?? null)) as JsonValue;
}

const MODULUS = 2n ** 256n;

export async function eventLogDigest(
	log: LogReader,
	batch = 500,
): Promise<{ count: number; digest: string }> {
	let sum = 0n;
	let count = 0;
	let after = parseEventPosition(0);
	for (;;) {
		let read = 0;
		for await (const item of log.readAll({ after, limit: batch })) {
			const { event } = item;
			const meta = event.meta ?? {};
			const { handoff: _handoff, ...carried } = meta;
			sum =
				(sum +
					BigInt(
						`0x${sha256Hex(
							canonicalEncode([
								event.streamId,
								event.seq,
								event.type,
								event.v,
								jsonOf(event.data),
								event.actor.kind,
								event.actor.id,
								event.tenant,
								jsonOf(carried),
							]),
						)}`,
					)) %
				MODULUS;
			count += 1;
			read += 1;
			after = item.position;
		}
		if (read < batch) break;
	}
	return { count, digest: sum.toString(16).padStart(64, "0") };
}

export async function runStreamHandoff(
	options: StreamHandoffOptions,
): Promise<MigrationRunResult> {
	const run = await MigrationRun.open(
		options.runtime,
		"stream-handoff",
		options.plan,
	);
	run.noteImpedance(HANDOFF_IDENTITY_IMPEDANCE);
	const batch = options.batch ?? 500;
	const rounds = options.maxRounds ?? 1000;
	const heads = new Map<string, number>();
	let cursor = parseEventPosition(0);

	const targetHead = async (streamId: string): Promise<number> => {
		const cached = heads.get(streamId);
		if (cached !== undefined) return cached;
		let head = options.target.getStreamHead?.(streamId)?.revision;
		if (head === undefined) {
			head = 0;
			for await (const event of options.target.read(streamId)) head = event.seq;
		}
		heads.set(streamId, head);
		return head;
	};

	const copy = async (): Promise<{ copied: number; caughtUp: boolean }> => {
		let copied = 0;
		for (let round = 0; round < rounds; round += 1) {
			let read = 0;
			for await (const item of options.source.readAll({
				after: cursor,
				limit: batch,
			})) {
				const { event } = item;
				read += 1;
				cursor = item.position;
				const head = await targetHead(event.streamId);
				if (event.seq <= head) continue;
				if (event.seq !== head + 1) {
					throw new DataCoreError(
						"VERIFICATION_FAILED",
						`stream ${event.streamId} would skip from ${head} to ${event.seq}; refusing to hand off a gap`,
						{ detail: { streamId: event.streamId, head, seq: event.seq } },
					);
				}
				await options.target.append(
					event.streamId,
					[
						{
							type: event.type,
							v: event.v,
							data: event.data,
							meta: {
								...event.meta,
								handoff: {
									id: event.id,
									ts: event.ts,
									position: item.position.toString(),
								},
							},
						},
					],
					{
						expectedSeq: head,
						actor: event.actor,
						tenant: event.tenant,
						...(event.project === undefined
							? undefined
							: { project: event.project }),
						...(event.causationId === undefined
							? undefined
							: { causationId: event.causationId }),
						...(event.correlationId === undefined
							? undefined
							: { correlationId: event.correlationId }),
						...(event.lane === undefined ? undefined : { lane: event.lane }),
					},
				);
				heads.set(event.streamId, head + 1);
				copied += 1;
			}
			if (read < batch) return { copied, caughtUp: true };
		}
		return { copied, caughtUp: false };
	};

	const compare = async (): Promise<{
		equal: boolean;
		count: number;
		digest: string;
	}> => {
		const source = await eventLogDigest(options.source, batch);
		const target = await eventLogDigest(options.target, batch);
		return {
			equal: source.count === target.count && source.digest === target.digest,
			count: target.count,
			digest: target.digest,
		};
	};

	const rollbackAt = (phase: MigrationPhase): RollbackPosture =>
		phase === "finalize"
			? "none"
			: phase === "fence-and-flip"
				? "to-snapshot"
				: "lossless";

	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		await run.phase("prepare", async () => ({}));
		await run.phase("seed", async () => ({ copied: (await copy()).copied }));
		await run.phase("converge", async () => {
			const outcome = await copy();
			if (!outcome.caughtUp) {
				throw new MigrationHold(
					"seed",
					"the source log is still ahead of the copy",
				);
			}
			return { copied: outcome.copied, position: cursor.toString() };
		});
		await run.phase("verify", async () => {
			await copy();
			const verdict = await compare();
			return {
				count: verdict.count,
				digest: verdict.digest,
				equal: verdict.equal,
			};
		});
		await run.phase("fence-and-flip", async () => {
			const decided = run.cutOverDecision();
			if (decided !== undefined) {
				const held = await options.quiesce();
				await options.flipWriter({
					migrationId: options.runtime.migrationId,
					head: run.decisionHead(MIGRATION_EVENTS.CutOver),
					fenceToken: decidedFenceToken(decided, held.fenceToken),
				});
				return decided;
			}
			await run.requestFence("source", "fence-and-flip");
			const grant = await options.quiesce();
			const outcome = await copy();
			const verdict = await compare();
			if (!outcome.caughtUp || !verdict.equal) {
				const hold = await run.recordHold(
					"verify",
					"exact verification under quiescence failed; the source stays the writer",
					{ compensated: true },
				);
				await options.unquiesce(grant.fenceToken);
				throw hold;
			}
			const decision: JsonObject = {
				migrationId: options.runtime.migrationId,
				fenceTokenDigest: fenceTokenDigest(grant.fenceToken),
				count: verdict.count,
				digest: verdict.digest,
				cutOverAt: options.runtime.clock(),
			};
			await run.emit(MIGRATION_EVENTS.CutOver, decision);
			await options.flipWriter({
				migrationId: options.runtime.migrationId,
				head: run.decisionHead(MIGRATION_EVENTS.CutOver),
				fenceToken: grant.fenceToken,
			});
			return decision;
		});
		await run.phase("finalize", async () => ({}));
		return "none";
	}, rollbackAt);
}
