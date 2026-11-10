/**
 * The three patterns that move data through the event log (ADR-0177
 * decision 5): `rebuild-and-swap` for projected data, `log-pivot` for an
 * authoritative store whose authority is moving into the log, and
 * `stream-handoff` for the journal itself.
 *
 * `rebuild-and-swap` is where the event-sourced design pays off. A projected
 * store was never the truth, so moving it — to another product, another
 * engine, another paradigm — is a replay into a new sink. There is no capture
 * leg, no fence, and no translation of stored bytes.
 */
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
import { MIGRATION_EVENTS } from "../facts.js";
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
	decidedFenceToken,
	fenceTokenDigest,
	MigrationHold,
	MigrationRollback,
	MigrationRun,
	type MigrationRunResult,
	type MigrationRuntime,
	type PlannedDetails,
} from "./runtime.js";

/** Reads the sink's current record for a key, including this batch's writes. */
export type SinkReader = (
	tenant: string,
	key: string,
) => Promise<CanonicalRecord | undefined>;

/**
 * A projection as the executor needs it: a deterministic mapping from one
 * event to the record mutations it causes. It may read the sink's current
 * state for the keys it touches, and must do nothing else — no clock, no
 * randomness, no I/O — so a replay from zero reproduces the sink exactly.
 */
export interface ProjectionFold {
	/** Names the watermark; one projection, one name. */
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

/**
 * Fold one batch of the log into the sink. The batch's mutations and its
 * watermark land in one `apply`, so a redelivered batch is harmless and a
 * crash never leaves the sink ahead of its recorded position.
 */
async function projectBatch(
	log: LogReader,
	fold: ProjectionFold,
	sink: EngineBinding,
	scope: DatasetScope,
	after: Position,
	limit: number,
): Promise<ProjectOutcome> {
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
	let position =
		(await requirePort(sink, "apply").watermark({
			dataset: scope.dataset,
			source: fold.name,
		})) ?? "0";
	let events = 0;
	for (let round = 0; round < rounds; round += 1) {
		const outcome = await projectBatch(log, fold, sink, scope, position, limit);
		position = outcome.position;
		events += outcome.events;
		if (outcome.caughtUp) return { position, events, caughtUp: true };
	}
	return { position, events, caughtUp: false };
}

// ── rebuild-and-swap ────────────────────────────────────────────────────────

export interface RebuildAndSwapOptions {
	readonly runtime: MigrationRuntime;
	readonly log: LogReader;
	readonly fold: ProjectionFold;
	/** The new sink. */
	readonly target: EngineBinding;
	readonly schema: DatasetSchema;
	readonly scope: DatasetScope;
	/**
	 * The sink being replaced. When given — and fed by the same fold — the two
	 * are compared by digest before reads move.
	 */
	readonly previous?: EngineBinding;
	readonly previousScope?: DatasetScope;
	readonly batch?: number;
	readonly maxRounds?: number;
	readonly buckets?: number;
	readonly verifyRechecks?: number;
	readonly rampSteps?: readonly number[];
	readonly shiftReads?: (percent: number) => Awaitable<void>;
	readonly soakDecision?: () => Awaitable<SoakDecision>;
	/** Reap the old sink. Runs only at finalize. */
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
	// The old sink stays valid until it is reaped, so every phase before
	// finalize can go back without losing anything.
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
			let position = "0";
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				position = (await toHead()).position;
				const target = await requirePort(options.target, "verify").digest({
					scope: options.scope,
					buckets,
				});
				if (options.previous === undefined) {
					// Nothing to compare against: the evidence is that the sink is
					// at the log head, and its digest is recorded for later drift checks.
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
				"the rebuilt sink does not digest equal to the sink it replaces",
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

// ── log-pivot ───────────────────────────────────────────────────────────────

/** A domain event a captured change is turned into. */
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
	/** The authoritative store being adopted. */
	readonly source: EngineBinding;
	readonly schema: DatasetSchema;
	readonly scope: DatasetScope;
	readonly log: PivotLog;
	/**
	 * The authored re-model: what each captured change means as domain events.
	 * This is where a cross-paradigm move is written down and reviewed.
	 */
	readonly toEvents: (change: ChangeEnvelope) => readonly PivotEvent[];
	readonly append: PivotAppendContext;
	readonly fold: ProjectionFold;
	readonly target: EngineBinding;
	readonly targetSchema: DatasetSchema;
	readonly targetScope: DatasetScope;
	readonly flipAuthority: (flip: {
		readonly fenceToken: string;
	}) => Awaitable<void>;
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

/**
 * Append the events one change means. Each carries an idempotency key built
 * from the change's own identity, so redelivering a change — after a crash,
 * or because a seed re-ran — appends nothing twice.
 */
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
				// Another writer advanced the stream: re-read the head once.
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

/** Tail the source's capture into the log until caught up. */
async function captureToLog(
	context: PivotContext,
	start: Position,
): Promise<{ position: Position; caughtUp: boolean; changes: number }> {
	const { options, subscription, batch, rounds } = context;
	const capture = requirePort(options.source, "capture");
	const marker = requirePort(options.target, "apply");
	// The capture leg's progress is recorded beside the sink's own watermark,
	// under the subscription's name, so both survive together.
	let position =
		(await marker.watermark({
			dataset: options.targetScope.dataset,
			source: subscription,
		})) ?? start;
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
		});
		await capture.acknowledge({ subscription, position });
		if (read.caughtUp) return { position, caughtUp: true, changes };
	}
	return { position, caughtUp: false, changes };
}

export async function runLogPivot(
	options: LogPivotOptions,
): Promise<MigrationRunResult> {
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
	// Digests are comparable only when the sink keeps the source's own schema;
	// a re-model changes the records, and then the evidence is positional.
	const comparable =
		schemaDigest({ ...options.schema, name: "_" }) ===
		schemaDigest({ ...options.targetSchema, name: "_" });
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
		if (!comparable || options.source.verify === undefined) {
			return { equal: true, count: target.count, digest: target.digest };
		}
		const source = await options.source.verify.digest({
			scope: options.scope,
			buckets,
		});
		// Compare bucket sums over the records themselves; the dataset name
		// differs by design and is not part of a record digest.
		return {
			equal: compareDigests(source, target).equal,
			count: target.count,
			digest: target.digest,
		};
	};
	// Authority moves into the log at the flip and does not move back.
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
			// A cutover an earlier run decided is finished, not re-verified.
			const decided = run.cutOverDecision();
			const fence = requirePort(options.source, "fence");
			// Raising a raised fence answers its token, so a resumed run gets
			// the token back from the store rather than from the journal.
			const grant = await fence.raise({
				scope: options.scope,
				reason: `migration ${options.runtime.migrationId}`,
			});
			if (decided !== undefined) {
				await options.flipAuthority({
					fenceToken: decidedFenceToken(decided, grant.fenceToken),
				});
				return decided;
			}
			const tail = await captureToLog(context, startPosition);
			const projected = await project();
			const verdict = await equalDigests();
			if (!tail.caughtUp || !projected.caughtUp || !verdict.equal) {
				await fence.release({
					scope: options.scope,
					fenceToken: grant.fenceToken,
				});
				throw new MigrationHold(
					"verify",
					"exact verification under the fence failed; the store remains the authority",
				);
			}
			// Decide, record, then act — see the copy executors for why.
			const decision: JsonObject = {
				migrationId: options.runtime.migrationId,
				authority: "log",
				// The digest, never the token: a journal is evidence.
				fenceTokenDigest: fenceTokenDigest(grant.fenceToken),
				count: verdict.count,
				digest: verdict.digest,
				logPosition: projected.position,
				cutOverAt: options.runtime.clock(),
			};
			await run.emit(MIGRATION_EVENTS.CutOver, decision);
			await options.flipAuthority({ fenceToken: grant.fenceToken });
			return decision;
		});
		await run.phase("finalize", async () => {
			await requirePort(options.source, "capture").stop(context.subscription);
			return {};
		});
		return "none";
	}, rollbackAt);
}

// ── stream-handoff ──────────────────────────────────────────────────────────

/**
 * The event store port has no identity-preserving import, so a handed-off
 * event keeps its stream, sequence, type, version, payload, actor, and
 * tenant, and is given a new id and timestamp by the target store. The
 * originals travel in `meta.handoff`. This is a real limit, reported on every
 * handoff rather than discovered later.
 */
// public-contract: impedance code reported by every stream handoff.
export const HANDOFF_IDENTITY_IMPEDANCE = "HANDOFF_EVENT_IDENTITY_REMINTED";

type HandoffTarget = Pick<DurableEventStore, "append" | "readAll" | "read"> & {
	getStreamHead?: DurableEventStore["getStreamHead"];
};

export interface StreamHandoffOptions {
	readonly runtime: MigrationRuntime;
	readonly source: LogReader;
	readonly target: HandoffTarget;
	/**
	 * Stop the single writer of the source partition. Partition ownership is
	 * the runtime's to hand over; this executor only asks for it.
	 *
	 * Idempotent: quiescing a quiesced partition answers the same token. The
	 * journal records only the token's digest, so a resumed run asks again.
	 */
	readonly quiesce: () => Awaitable<{ readonly fenceToken: string }>;
	readonly unquiesce: (fenceToken: string) => Awaitable<void>;
	readonly flipWriter: (flip: {
		readonly fenceToken: string;
	}) => Awaitable<void>;
	readonly batch?: number;
	readonly maxRounds?: number;
	readonly plan?: PlannedDetails;
}

function jsonOf(data: EventEnvelope["data"]): JsonValue {
	// SAFETY: event payloads are JSON documents; this is the document boundary.
	return JSON.parse(JSON.stringify(data ?? null)) as JsonValue;
}

const MODULUS = 2n ** 256n;

/**
 * Digest of a log's content, independent of which store holds it: stream,
 * sequence, type, version, payload, actor, and tenant — everything a handoff
 * preserves, and nothing it does not.
 */
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

	/** Copy forward until the source has nothing further. */
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
				// Already handed off: an earlier run, or a retry after a crash.
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
			// Under live writes the source can be a few events ahead here; the
			// exact comparison is the one made under quiescence below.
			return {
				count: verdict.count,
				digest: verdict.digest,
				equal: verdict.equal,
			};
		});
		await run.phase("fence-and-flip", async () => {
			const decided = run.cutOverDecision();
			const grant = await options.quiesce();
			if (decided !== undefined) {
				await options.flipWriter({
					fenceToken: decidedFenceToken(decided, grant.fenceToken),
				});
				return decided;
			}
			const outcome = await copy();
			const verdict = await compare();
			if (!outcome.caughtUp || !verdict.equal) {
				await options.unquiesce(grant.fenceToken);
				throw new MigrationHold(
					"verify",
					"exact verification under quiescence failed; the source stays the writer",
				);
			}
			const decision: JsonObject = {
				migrationId: options.runtime.migrationId,
				// The digest, never the token: a journal is evidence.
				fenceTokenDigest: fenceTokenDigest(grant.fenceToken),
				count: verdict.count,
				digest: verdict.digest,
				cutOverAt: options.runtime.clock(),
			};
			await run.emit(MIGRATION_EVENTS.CutOver, decision);
			await options.flipWriter({ fenceToken: grant.fenceToken });
			return decision;
		});
		await run.phase("finalize", async () => ({}));
		return "none";
	}, rollbackAt);
}
