/**
 * The two copy patterns for authoritative stores: `snapshot-and-tail` and
 * `offline-copy` (ADR-0177 decision 5).
 *
 * Both keep exactly one write authority at every log position. The second
 * store is fed by capture — never by an application writing twice — and
 * authority changes hands once, under a fence token.
 *
 * The seed is deliberately allowed to be fuzzy. The capture position is taken
 * *before* the scan opens and the tail replays from it afterwards, so every
 * change the scan could have missed or seen half-applied is re-applied in
 * order. That converges whether or not the engine can give a consistent
 * snapshot, which is why no engine is required to.
 *
 * Records travel one of two ways, and the plan says which. Through the `hub`,
 * this module scans, tails and applies canonical records over the ports. With
 * a `native` realization the engine moves its own records through its
 * `nativeTransfer` port, and this module does everything else exactly as
 * before: every phase, the policy verdict in front of each, the digests, the
 * fence, the cutover decision, the soak. A native realization that cannot run
 * is an error. It is never answered by running the hub instead.
 */
import type { DatasetSchema } from "../canonical.js";
import {
	compareDigests,
	type DatasetDigest,
	DEFAULT_DIGEST_BUCKETS,
} from "../digest.js";
import type { Position, RecordMutation } from "../envelope.js";
import { DataCoreError } from "../errors.js";
import { MIGRATION_EVENTS, type MigrationRealization } from "../facts.js";
import { isJsonString, type JsonObject } from "../json.js";
import type { MigrationPhase, RollbackPosture } from "../patterns.js";
import {
	type Awaitable,
	type ChangeApplyPort,
	type ChangeCapturePort,
	type DatasetScope,
	type EngineBinding,
	type NativeTransferPort,
	type NativeTransferRef,
	requirePort,
} from "../spi.js";
import {
	fenceTokenDigest,
	MigrationHold,
	MigrationRollback,
	MigrationRun,
	type MigrationRunResult,
	type MigrationRuntime,
	type PlannedDetails,
} from "./runtime.js";

/** Erasures recorded since an instant, as the deletes that re-apply them. */
export interface ErasureLedger {
	since(instant: string): Awaitable<readonly RecordMutation[]>;
}

export const AUTHORITY_DIRECTIONS = ["to-target", "to-source"] as const;
export type AuthorityDirection = (typeof AUTHORITY_DIRECTIONS)[number];

export interface AuthorityFlip {
	readonly direction: AuthorityDirection;
	/** The token guarding the side that just lost write authority. */
	readonly fenceToken: string;
}

export const SOAK_DECISIONS = ["finalize", "rollback", "hold"] as const;
export type SoakDecision = (typeof SOAK_DECISIONS)[number];

export interface CopyMigrationOptions {
	readonly runtime: MigrationRuntime;
	readonly source: EngineBinding;
	readonly target: EngineBinding;
	readonly schema: DatasetSchema;
	readonly scope: DatasetScope;
	/** Defaults to `scope`. */
	readonly targetScope?: DatasetScope;
	readonly chunkSize?: number;
	readonly tailBatch?: number;
	/**
	 * Tail rounds — or, natively, progress polls — before a still-lagging
	 * converge holds instead of spinning.
	 */
	readonly maxTailRounds?: number;
	readonly buckets?: number;
	readonly verifyRechecks?: number;
	readonly rampSteps?: readonly number[];
	/** Move a share of reads to the target. Reversible at any percentage. */
	readonly shiftReads?: (percent: number) => Awaitable<void>;
	/**
	 * Move write authority. Called once per direction and must be idempotent:
	 * a crash between the flip and its fact re-runs it.
	 */
	readonly flipAuthority: (flip: AuthorityFlip) => Awaitable<void>;
	/** Consulted in the soak window. Defaults to `finalize`. */
	readonly soakDecision?: () => Awaitable<SoakDecision>;
	/** Needed for a `to-snapshot` rollback so it cannot resurrect a subject. */
	readonly erasures?: ErasureLedger;
	/**
	 * How records travel: `hub` (the default) or `native`. Take it from the
	 * selected candidate. It is recorded in the plan, and a run planned one
	 * way cannot be resumed the other.
	 */
	readonly realization?: MigrationRealization;
	/** The native migration profile to run; required when `realization` is `native`. */
	readonly profile?: string;
	readonly plan?: PlannedDetails;
}

/** The two halves of a native transfer, as this run addresses them. */
interface NativeLeg {
	readonly profile: string;
	readonly source: NativeTransferPort;
	readonly target: NativeTransferPort;
	readonly sourceRef: NativeTransferRef;
	readonly targetRef: NativeTransferRef;
}

/**
 * The forward channel: how the target is brought level with the source. The
 * one seam between the two realizations — everything outside it is shared.
 */
interface ForwardChannel {
	/** `prepare`: open the channel. The answer is the phase checkpoint. */
	open(): Promise<JsonObject>;
	/** The initial copy: its checkpoint, or `undefined` while it still runs. */
	seed(): Promise<JsonObject | undefined>;
	/** Bring the target level with everything the source has committed. */
	drain(): Promise<DrainOutcome>;
	/** Drop the channel and the log it pinned. Idempotent. */
	close(): Promise<void>;
}

interface CopyContext {
	readonly options: CopyMigrationOptions;
	readonly run: MigrationRun;
	readonly targetScope: DatasetScope;
	readonly forward: string;
	readonly reverse: string;
	readonly buckets: number;
	readonly tailBatch: number;
	readonly maxTailRounds: number;
	readonly reverseTail: boolean;
	/** Present exactly when the run's realization is `native`. */
	readonly native?: NativeLeg;
}

interface TailLeg {
	readonly capture: ChangeCapturePort;
	readonly apply: ChangeApplyPort;
	readonly from: DatasetScope;
	readonly into: string;
	readonly subscription: string;
	readonly fenceToken?: string;
}

interface DrainOutcome {
	readonly position: Position;
	/** Changes this module applied; absent when the engine applied them. */
	readonly applied?: number;
	readonly caughtUp: boolean;
}

/** Tail one leg until it is caught up or the round budget is spent. */
async function drain(
	leg: TailLeg,
	start: Position,
	limit: number,
	rounds: number,
): Promise<DrainOutcome> {
	let position =
		(await leg.apply.watermark({
			dataset: leg.into,
			source: leg.subscription,
		})) ?? start;
	let applied = 0;
	for (let round = 0; round < rounds; round += 1) {
		const batch = await leg.capture.read({
			scope: leg.from,
			subscription: leg.subscription,
			after: position,
			limit,
		});
		if (batch.changes.length > 0) {
			await leg.apply.apply({
				dataset: leg.into,
				changes: batch.changes,
				source: leg.subscription,
				position: batch.position,
				...(leg.fenceToken === undefined
					? undefined
					: { fenceToken: leg.fenceToken }),
			});
			await leg.capture.acknowledge({
				subscription: leg.subscription,
				position: batch.position,
			});
			applied += batch.changes.length;
		}
		position = batch.position;
		if (batch.caughtUp) return { position, applied, caughtUp: true };
	}
	return { position, applied, caughtUp: false };
}

async function digests(
	context: CopyContext,
): Promise<{ source: DatasetDigest; target: DatasetDigest }> {
	const { options, buckets, targetScope } = context;
	const source = await requirePort(options.source, "verify").digest({
		scope: options.scope,
		buckets,
	});
	const target = await requirePort(options.target, "verify").digest({
		scope: targetScope,
		buckets,
	});
	return { source, target };
}

function forwardLeg(context: CopyContext): TailLeg {
	const { options, targetScope, forward } = context;
	return {
		capture: requirePort(options.source, "capture"),
		apply: requirePort(options.target, "apply"),
		from: options.scope,
		into: targetScope.dataset,
		subscription: forward,
	};
}

function reverseLeg(context: CopyContext, fenceToken: string): TailLeg {
	const { options, targetScope, reverse } = context;
	return {
		capture: requirePort(options.target, "capture"),
		apply: requirePort(options.source, "apply"),
		from: targetScope,
		into: options.scope.dataset,
		subscription: reverse,
		fenceToken,
	};
}

function hasReverseTail(options: CopyMigrationOptions): boolean {
	return (
		options.target.capture !== undefined && options.source.apply !== undefined
	);
}

// public-contract: the durable name a migration's native transfer is published and subscribed under.
export const NATIVE_TRANSFER_SUFFIX = "_native";

/**
 * The name a migration's native transfer goes by on both engines. Exported so
 * an operator abandoning a migration can `stop` its transfer by name.
 */
export function nativeTransferName(migrationId: string): string {
	return `hobo_migration_${migrationId}${NATIVE_TRANSFER_SUFFIX}`;
}

/**
 * Resolve the realization before anything is journaled. `hub` needs nothing.
 * `native` needs a named profile both engines declare for this pattern, the
 * port on both bindings, and the ports this module still drives itself. When
 * any of that is missing the run does not start: falling back to the hub would
 * carry out a different plan from the one that was decided and recorded.
 */
function resolveNative(
	options: CopyMigrationOptions,
	pattern: "snapshot-and-tail" | "offline-copy",
	targetScope: DatasetScope,
): NativeLeg | undefined {
	const { source, target, profile } = options;
	if ((options.realization ?? "hub") === "hub") {
		if (profile !== undefined) {
			throw new DataCoreError(
				"INVALID_MIGRATION_PLAN",
				`a native profile (${profile}) was named for a hub realization; name the realization the decision selected`,
				{ detail: { pattern, profile } },
			);
		}
		return undefined;
	}
	const unavailable = (why: string): DataCoreError =>
		new DataCoreError(
			"NATIVE_REALIZATION_UNAVAILABLE",
			`${pattern} cannot run natively from ${source.declaration.engine} to ${target.declaration.engine}: ${why}. The hub realization is not substituted; select it explicitly`,
			{
				detail: {
					pattern,
					source: source.declaration.engine,
					target: target.declaration.engine,
					profile: profile ?? "",
				},
			},
		);
	if (profile === undefined) throw unavailable("no native profile was named");
	if (source.declaration.engine !== target.declaration.engine) {
		throw unavailable("a native fast path exists only within one engine");
	}
	for (const side of [source, target]) {
		const declared = side.declaration.nativeProfiles.some(
			(entry) => entry.profile === profile && entry.pattern === pattern,
		);
		if (!declared) {
			throw unavailable(
				`${side === source ? "the source" : "the target"} does not declare ${profile} for ${pattern}`,
			);
		}
		if (side.nativeTransfer?.profiles.includes(profile) !== true) {
			throw unavailable(
				`${side === source ? "the source" : "the target"} binding provides no nativeTransfer port that runs ${profile}`,
			);
		}
	}
	const sourcePort = source.nativeTransfer;
	const targetPort = target.nativeTransfer;
	if (sourcePort === undefined || targetPort === undefined) {
		throw unavailable("a binding provides no nativeTransfer port");
	}
	// What this module still drives itself, whoever carries the records.
	requirePort(source, "verify");
	requirePort(source, "fence");
	requirePort(source, "retire");
	requirePort(target, "verify");
	const transfer = nativeTransferName(options.runtime.migrationId);
	return {
		profile,
		source: sourcePort,
		target: targetPort,
		sourceRef: { profile, transfer, scope: options.scope },
		targetRef: { profile, transfer, scope: targetScope },
	};
}

async function open(
	options: CopyMigrationOptions,
	pattern: "snapshot-and-tail" | "offline-copy",
): Promise<CopyContext> {
	const targetScope = options.targetScope ?? options.scope;
	const native = resolveNative(options, pattern, targetScope);
	const run = await MigrationRun.open(options.runtime, pattern, {
		source: options.source.declaration.engine,
		target: options.target.declaration.engine,
		dataset: options.schema.name,
		...options.plan,
		realization: native === undefined ? "hub" : "native",
		...(native === undefined ? undefined : { profile: native.profile }),
	});
	const id = options.runtime.migrationId;
	return {
		options,
		run,
		targetScope,
		forward: `hobo_migration_${id}_forward`,
		reverse: `hobo_migration_${id}_reverse`,
		buckets: options.buckets ?? DEFAULT_DIGEST_BUCKETS,
		tailBatch: options.tailBatch ?? 500,
		maxTailRounds: options.maxTailRounds ?? 1000,
		// A native transfer is torn down at the cutover and nothing tails back,
		// so the old side goes stale there: the posture is `to-snapshot`.
		reverseTail: native === undefined && hasReverseTail(options),
		...(native === undefined ? undefined : { native }),
	};
}

/** Copy the whole scope through the hub. Returns records applied. */
async function seed(
	context: CopyContext,
	position: Position,
	subscription: string,
): Promise<number> {
	const { options, targetScope } = context;
	const cursor = await requirePort(options.source, "snapshot").openSnapshot({
		scope: options.scope,
		chunkSize: options.chunkSize ?? 500,
	});
	const apply = requirePort(options.target, "apply");
	let seeded = 0;
	try {
		for (;;) {
			const chunk = await cursor.next();
			if (chunk === undefined) break;
			if (chunk.length === 0) continue;
			await apply.apply({
				dataset: targetScope.dataset,
				changes: chunk,
				source: subscription,
				position,
			});
			seeded += chunk.length;
		}
	} finally {
		await cursor.close();
	}
	return seeded;
}

/** The hub: scan, tail and apply canonical records over the ports. */
function hubChannel(context: CopyContext): ForwardChannel {
	const { options, run, forward, tailBatch, maxTailRounds } = context;
	const start = (): Position => run.checkpointText("prepare", "startPosition");
	return {
		async open() {
			// Position first, scan second: this ordering is the correctness
			// argument for a fuzzy seed.
			const startPosition = await requirePort(options.source, "capture").start({
				scope: options.scope,
				subscription: forward,
			});
			return { startPosition };
		},
		async seed() {
			return { seeded: await seed(context, start(), forward) };
		},
		drain: () => drain(forwardLeg(context), start(), tailBatch, maxTailRounds),
		async close() {
			await options.source.capture?.stop(forward);
		},
	};
}

/**
 * A native realization: the engine copies and tails its own records. This
 * module only opens the transfer, asks how far it has got, and closes it. It
 * never sleeps — each question may wait a bounded time inside the engine — and
 * it asks a bounded number of times before reporting that the copy lags.
 */
function nativeChannel(
	context: CopyContext,
	native: NativeLeg,
): ForwardChannel {
	const rounds = context.maxTailRounds;
	return {
		async open() {
			const ticket = await native.source.publish(native.sourceRef);
			await native.target.subscribe({ ...native.targetRef, ticket });
			// The ticket is journaled. By the port's contract it carries no
			// credential and no record.
			return {
				realization: "native",
				profile: native.profile,
				transfer: native.sourceRef.transfer,
				ticket,
			};
		},
		async seed() {
			for (let round = 0; round < rounds; round += 1) {
				if (await native.target.seeded(native.targetRef)) {
					return { copied: "native" };
				}
			}
			return undefined;
		},
		async drain() {
			// A mark, then the question "has the target applied up to it": the
			// engine's own equivalent of tailing until caught up.
			const mark = await native.source.mark(native.sourceRef);
			for (let round = 0; round < rounds; round += 1) {
				if (await native.source.reached({ ...native.sourceRef, mark })) {
					return { position: mark, caughtUp: true };
				}
			}
			return { position: mark, caughtUp: false };
		},
		async close() {
			// The target first: its side reads from what the source retains.
			await native.target.stop(native.targetRef);
			await native.source.stop(native.sourceRef);
		},
	};
}

function channelOf(context: CopyContext): ForwardChannel {
	return context.native === undefined
		? hubChannel(context)
		: nativeChannel(context, context.native);
}

/**
 * The token of the fence a cutover was decided under.
 *
 * The journal holds only the token's digest — a fence token is a credential
 * and a journal is evidence. So a later phase, or a resumed run, asks the
 * store again: raising a raised fence answers its token. The digest then says
 * whether that fence is still the one the decision was made under. If it is
 * not, the fence was lifted and raised again behind the migration's back, and
 * the old authority may have taken writes; the run holds for a person.
 */
async function cutOverFenceToken(
	context: CopyContext,
	recorded: JsonObject,
): Promise<string> {
	const { options } = context;
	// A journal written before tokens were kept out of it.
	const legacy = recorded.fenceToken;
	if (isJsonString(legacy)) return legacy;
	const grant = await requirePort(options.source, "fence").raise({
		scope: options.scope,
		reason: `migration ${options.runtime.migrationId}`,
	});
	if (fenceTokenDigest(grant.fenceToken) !== recorded.fenceTokenDigest) {
		throw new MigrationHold(
			"soak",
			"the fence on the old authority is not the one the cutover was decided under; it was lifted and raised again, and the old side may have taken writes",
		);
	}
	return grant.fenceToken;
}

function cutOverCheckpoint(context: CopyContext): JsonObject {
	const recorded = context.run.checkpoint("fence-and-flip");
	if (recorded === undefined) {
		throw new DataCoreError(
			"ILLEGAL_PHASE_TRANSITION",
			"fence-and-flip recorded no cutover; it must complete before a later phase reads it",
			{ detail: { phase: "fence-and-flip" } },
		);
	}
	return recorded;
}

/**
 * What follows a journaled cutover decision, the first time and on every
 * resume: a native transfer is closed, then write authority moves. Closing
 * first matters — a transfer left open would carry the old side's retirement
 * to the new authority as deletes.
 */
async function completeFlip(
	context: CopyContext,
	fenceToken: string,
): Promise<void> {
	if (context.native !== undefined) await channelOf(context).close();
	await context.options.flipAuthority({ direction: "to-target", fenceToken });
}

/**
 * The step both patterns share once the two sides are equal under a fence:
 * start the reverse tail at this quiesced point (so nothing is echoed back),
 * record the cutover, and only then move write authority.
 *
 * The order is the safety argument. The decision is journaled first, so a
 * crash after authority moved but before the phase completed is resumed by
 * finishing the move — never by re-verifying against a target that has since
 * taken writes, failing, and releasing the source's fence into a split brain.
 */
async function flip(
	context: CopyContext,
	fenceToken: string,
	equal: DatasetDigest,
): Promise<JsonObject> {
	const { options, run, reverseTail, targetScope, reverse } = context;
	let reversePosition: Position | undefined;
	if (reverseTail) {
		reversePosition = await requirePort(options.target, "capture").start({
			scope: targetScope,
			subscription: reverse,
		});
	}
	const decision: JsonObject = {
		migrationId: options.runtime.migrationId,
		// The digest, never the token: see `fenceTokenDigest`.
		fenceTokenDigest: fenceTokenDigest(fenceToken),
		count: equal.count,
		digest: equal.digest,
		reverseTail,
		...(reversePosition === undefined ? undefined : { reversePosition }),
		cutOverAt: options.runtime.clock(),
	};
	await run.emit(MIGRATION_EVENTS.CutOver, decision);
	await completeFlip(context, fenceToken);
	return decision;
}

/**
 * Finish a cutover an earlier run decided but did not complete. The flip is
 * idempotent by contract, so repeating it is safe whether or not it landed.
 */
async function resumeFlip(
	context: CopyContext,
	decision: JsonObject,
): Promise<JsonObject> {
	await completeFlip(context, await cutOverFenceToken(context, decision));
	return decision;
}

async function soak(context: CopyContext): Promise<JsonObject> {
	const { options, run, reverseTail, tailBatch, maxTailRounds } = context;
	const decision = (await options.soakDecision?.()) ?? "finalize";
	if (reverseTail) {
		const reversePosition = run.checkpointText(
			"fence-and-flip",
			"reversePosition",
		);
		await drain(
			reverseLeg(
				context,
				await cutOverFenceToken(context, cutOverCheckpoint(context)),
			),
			reversePosition,
			tailBatch,
			maxTailRounds,
		);
	}
	if (decision === "hold") {
		throw new MigrationHold("soak", "soak window left open");
	}
	if (decision === "rollback") {
		await rollbackFromSoak(
			context,
			await cutOverFenceToken(context, cutOverCheckpoint(context)),
		);
	}
	return { decision };
}

async function rollbackFromSoak(
	context: CopyContext,
	fenceToken: string,
): Promise<never> {
	const { options, run, reverseTail, targetScope, tailBatch, maxTailRounds } =
		context;
	const fence = requirePort(options.source, "fence");
	if (reverseTail) {
		// Quiesce the target where the engine can, then prove the source is
		// current before it becomes the authority again.
		const targetFence = options.target.fence;
		const targetGrant =
			targetFence === undefined
				? undefined
				: await targetFence.raise({ scope: targetScope, reason: "rollback" });
		const reversePosition = run.checkpointText(
			"fence-and-flip",
			"reversePosition",
		);
		const drained = await drain(
			reverseLeg(context, fenceToken),
			reversePosition,
			tailBatch,
			maxTailRounds,
		);
		const pair = await digests(context);
		if (!drained.caughtUp || !compareDigests(pair.source, pair.target).equal) {
			// Not safe to hand authority back yet: let the target keep writing.
			if (targetFence !== undefined && targetGrant !== undefined) {
				await targetFence.release({
					scope: targetScope,
					fenceToken: targetGrant.fenceToken,
				});
			}
			throw new MigrationHold(
				"soak",
				"reverse tail has not converged; the source is not yet current",
			);
		}
		// The forward channel ends with the migration. Dropped before authority
		// moves, so a failure here leaves nothing half-done.
		await channelOf(context).close();
		await options.flipAuthority({ direction: "to-source", fenceToken });
		await fence.release({ scope: options.scope, fenceToken });
		await requirePort(options.target, "capture").stop(context.reverse);
		throw new MigrationRollback(
			"rolled back from soak under a reverse tail",
			true,
		);
	}
	// No reverse tail: writes since the flip are lost, and the plan said so.
	// What must not happen is an erased subject coming back with the stale
	// source, so erasures recorded since the cutover are re-applied first.
	const cutOverAt = run.checkpointText("fence-and-flip", "cutOverAt");
	const erased = (await options.erasures?.since(cutOverAt)) ?? [];
	if (erased.length > 0) {
		await options.source.records.write({
			dataset: options.scope.dataset,
			mutations: erased,
			fenceToken,
		});
	}
	// The forward channel ends with the migration: a native transfer left open
	// would start copying the restored authority's writes to the abandoned
	// target, and a hub subscription would pin the source's log for ever.
	await channelOf(context).close();
	await options.flipAuthority({ direction: "to-source", fenceToken });
	await fence.release({ scope: options.scope, fenceToken });
	throw new MigrationRollback(
		`rolled back from soak without a reverse tail; writes since ${cutOverAt} are lost, ${erased.length} erasure(s) re-applied`,
		false,
	);
}

async function finalize(context: CopyContext): Promise<JsonObject> {
	const { options, run, reverseTail, buckets } = context;
	const fenceToken = await cutOverFenceToken(
		context,
		cutOverCheckpoint(context),
	);
	// The reverse tail ends here: once the source is about to be retired there
	// is nothing left for it to keep current.
	if (reverseTail) {
		await requirePort(options.target, "capture").stop(context.reverse);
	}
	// The safety of deleting the source was proven at cutover, when both sides
	// digested equal under the fence. What the retire port checks is narrower
	// and still necessary: that the caller holds the fence, and that the source
	// has not changed between this digest and the delete.
	const expected = await requirePort(options.source, "verify").digest({
		scope: options.scope,
		buckets,
	});
	if (
		!reverseTail &&
		expected.digest !== run.checkpointText("fence-and-flip", "digest")
	) {
		throw new MigrationHold(
			"soak",
			"the fenced source changed after cutover; refusing to retire it",
		);
	}
	// The forward channel is dropped before the source is emptied, never
	// after. An engine whose log records the retirement as deletes would
	// otherwise hand them to whatever still reads that channel — and what
	// reads it is the new authority.
	await channelOf(context).close();
	const receipt = await requirePort(options.source, "retire").retire({
		scope: options.scope,
		fenceToken,
		expected,
	});
	return { removed: receipt.removed };
}

function rollbackAt(
	context: CopyContext,
): (phase: MigrationPhase) => RollbackPosture {
	return (phase) => {
		if (phase === "finalize") return "none";
		if (phase === "soak" || phase === "fence-and-flip") {
			return context.reverseTail ? "lossless" : "to-snapshot";
		}
		return "lossless";
	};
}

/**
 * `snapshot-and-tail`: online copy. Writes are refused only for the
 * fence-and-flip step.
 */
export async function runSnapshotAndTail(
	options: CopyMigrationOptions,
): Promise<MigrationRunResult> {
	const context = await open(options, "snapshot-and-tail");
	const { run } = context;
	const channel = channelOf(context);
	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		await run.phase("prepare", async () => {
			await options.target.datasets.ensureDataset(options.schema);
			return channel.open();
		});
		await run.phase("seed", async () => {
			const seeded = await channel.seed();
			if (seeded === undefined) {
				throw new MigrationHold(
					"prepare",
					"the native initial copy has not finished; seed will resume",
				);
			}
			return seeded;
		});
		await run.phase("converge", async () => {
			const outcome = await channel.drain();
			if (!outcome.caughtUp) {
				throw new MigrationHold(
					"seed",
					"lag did not fall within bound; converge will resume",
				);
			}
			return {
				position: outcome.position,
				...(outcome.applied === undefined
					? undefined
					: { applied: outcome.applied }),
			};
		});
		await run.phase("verify", async () => {
			const attempts = (options.verifyRechecks ?? 3) + 1;
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				await channel.drain();
				const pair = await digests(context);
				if (compareDigests(pair.source, pair.target).equal) {
					await run.emit(MIGRATION_EVENTS.Verified, {
						migrationId: options.runtime.migrationId,
						point: "pre-flip",
						count: pair.target.count,
						digest: pair.target.digest,
						verifiedAt: options.runtime.clock(),
					});
					return { count: pair.target.count, digest: pair.target.digest };
				}
			}
			throw new MigrationHold(
				"converge",
				"source and target digests did not agree after re-checks",
			);
		});
		await run.phase("shift-reads", async () => {
			const steps = options.rampSteps ?? [10, 50, 100];
			for (const percent of steps) await options.shiftReads?.(percent);
			return { percent: steps[steps.length - 1] ?? 100 };
		});
		await run.phase("fence-and-flip", async () => {
			const decided = run.cutOverDecision();
			if (decided !== undefined) return resumeFlip(context, decided);
			const fence = requirePort(options.source, "fence");
			const grant = await fence.raise({
				scope: options.scope,
				reason: `migration ${options.runtime.migrationId}`,
			});
			const drained = await channel.drain();
			const pair = await digests(context);
			if (
				!drained.caughtUp ||
				!compareDigests(pair.source, pair.target).equal
			) {
				// Compensate: the source stays the authority and reads go home.
				await options.shiftReads?.(0);
				await fence.release({
					scope: options.scope,
					fenceToken: grant.fenceToken,
				});
				throw new MigrationHold(
					"shift-reads",
					"exact verification under the fence failed; the source remains the authority",
				);
			}
			return flip(context, grant.fenceToken, pair.target);
		});
		await run.phase("soak", async () => soak(context));
		await run.phase("finalize", async () => finalize(context));
		return "none";
	}, rollbackAt(context));
}

/**
 * `offline-copy`: fence, copy, verify, flip. Exact and simple, at the price of
 * refusing writes for the whole copy — which is why the selector only picks
 * it when the declared freeze budget covers the copy.
 */
export async function runOfflineCopy(
	options: CopyMigrationOptions,
): Promise<MigrationRunResult> {
	const context = await open(options, "offline-copy");
	const { run } = context;
	const channel = channelOf(context);
	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		await run.phase("prepare", async () => {
			await options.target.datasets.ensureDataset(options.schema);
			return {};
		});
		await run.phase("fence-and-flip", async () => {
			const decided = run.cutOverDecision();
			if (decided !== undefined) return resumeFlip(context, decided);
			const fence = requirePort(options.source, "fence");
			const grant = await fence.raise({
				scope: options.scope,
				reason: `migration ${options.runtime.migrationId}`,
			});
			const release = (): Awaitable<void> =>
				fence.release({ scope: options.scope, fenceToken: grant.fenceToken });
			let seeded: number | undefined;
			if (context.native === undefined) {
				seeded = await seed(context, "offline-copy", context.forward);
			} else {
				// Opening is idempotent, so an attempt that ran out of time is
				// continued by the next one rather than started again: the
				// transfer is left in place when the fence is released.
				await channel.open();
				const copied = await channel.seed();
				const level = copied === undefined ? undefined : await channel.drain();
				if (level?.caughtUp !== true) {
					await release();
					throw new MigrationHold(
						"prepare",
						"the native copy did not finish inside the fence window; the source remains the authority",
					);
				}
			}
			const pair = await digests(context);
			if (!compareDigests(pair.source, pair.target).equal) {
				await release();
				throw new MigrationHold(
					"prepare",
					"copy verification failed; the source remains the authority",
				);
			}
			return {
				...(await flip(context, grant.fenceToken, pair.target)),
				...(seeded === undefined ? undefined : { seeded }),
			};
		});
		await run.phase("soak", async () => soak(context));
		await run.phase("finalize", async () => finalize(context));
		return "none";
	}, rollbackAt(context));
}
