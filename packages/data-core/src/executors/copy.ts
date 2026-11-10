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
 */
import type { DatasetSchema } from "../canonical.js";
import {
	compareDigests,
	type DatasetDigest,
	DEFAULT_DIGEST_BUCKETS,
} from "../digest.js";
import type { Position, RecordMutation } from "../envelope.js";
import { MIGRATION_EVENTS } from "../facts.js";
import type { JsonObject } from "../json.js";
import type { MigrationPhase, RollbackPosture } from "../patterns.js";
import {
	type Awaitable,
	type ChangeApplyPort,
	type ChangeCapturePort,
	type DatasetScope,
	type EngineBinding,
	requirePort,
} from "../spi.js";
import {
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
	/** Tail rounds before a still-lagging converge holds instead of spinning. */
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
	readonly plan?: PlannedDetails;
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
	readonly applied: number;
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

async function open(
	options: CopyMigrationOptions,
	pattern: "snapshot-and-tail" | "offline-copy",
): Promise<CopyContext> {
	const run = await MigrationRun.open(options.runtime, pattern, {
		source: options.source.declaration.engine,
		target: options.target.declaration.engine,
		dataset: options.schema.name,
		...options.plan,
	});
	const id = options.runtime.migrationId;
	return {
		options,
		run,
		targetScope: options.targetScope ?? options.scope,
		forward: `hobo_migration_${id}_forward`,
		reverse: `hobo_migration_${id}_reverse`,
		buckets: options.buckets ?? DEFAULT_DIGEST_BUCKETS,
		tailBatch: options.tailBatch ?? 500,
		maxTailRounds: options.maxTailRounds ?? 1000,
		reverseTail: hasReverseTail(options),
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
		fenceToken,
		count: equal.count,
		digest: equal.digest,
		reverseTail,
		...(reversePosition === undefined ? undefined : { reversePosition }),
		cutOverAt: options.runtime.clock(),
	};
	await run.emit(MIGRATION_EVENTS.CutOver, decision);
	await options.flipAuthority({ direction: "to-target", fenceToken });
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
	await context.options.flipAuthority({
		direction: "to-target",
		fenceToken: String(decision.fenceToken),
	});
	return decision;
}

async function soak(context: CopyContext): Promise<JsonObject> {
	const { options, run, reverseTail, tailBatch, maxTailRounds } = context;
	const fenceToken = run.checkpointText("fence-and-flip", "fenceToken");
	const decision = (await options.soakDecision?.()) ?? "finalize";
	if (reverseTail) {
		const reversePosition = run.checkpointText(
			"fence-and-flip",
			"reversePosition",
		);
		await drain(
			reverseLeg(context, fenceToken),
			reversePosition,
			tailBatch,
			maxTailRounds,
		);
	}
	if (decision === "hold") {
		throw new MigrationHold("soak", "soak window left open");
	}
	if (decision === "rollback") {
		await rollbackFromSoak(context, fenceToken);
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
	await options.flipAuthority({ direction: "to-source", fenceToken });
	await fence.release({ scope: options.scope, fenceToken });
	throw new MigrationRollback(
		`rolled back from soak without a reverse tail; writes since ${cutOverAt} are lost, ${erased.length} erasure(s) re-applied`,
		false,
	);
}

async function finalize(context: CopyContext): Promise<JsonObject> {
	const { options, run, reverseTail, buckets } = context;
	const fenceToken = run.checkpointText("fence-and-flip", "fenceToken");
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
	const receipt = await requirePort(options.source, "retire").retire({
		scope: options.scope,
		fenceToken,
		expected,
	});
	await options.source.capture?.stop(context.forward);
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
	const { run, forward, tailBatch, maxTailRounds } = context;
	return run.drive(async () => {
		await run.phase("gate", async () => ({}));
		const prepared = await run.phase("prepare", async () => {
			await options.target.datasets.ensureDataset(options.schema);
			// Position first, scan second: this ordering is the correctness
			// argument for a fuzzy seed.
			const startPosition = await requirePort(options.source, "capture").start({
				scope: options.scope,
				subscription: forward,
			});
			return { startPosition };
		});
		const startPosition = String(prepared.startPosition);
		await run.phase("seed", async () => ({
			seeded: await seed(context, startPosition, forward),
		}));
		await run.phase("converge", async () => {
			const outcome = await drain(
				forwardLeg(context),
				startPosition,
				tailBatch,
				maxTailRounds,
			);
			if (!outcome.caughtUp) {
				throw new MigrationHold(
					"seed",
					"lag did not fall within bound; converge will resume",
				);
			}
			return { position: outcome.position, applied: outcome.applied };
		});
		await run.phase("verify", async () => {
			const attempts = (options.verifyRechecks ?? 3) + 1;
			for (let attempt = 0; attempt < attempts; attempt += 1) {
				await drain(
					forwardLeg(context),
					startPosition,
					tailBatch,
					maxTailRounds,
				);
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
			const drained = await drain(
				forwardLeg(context),
				startPosition,
				tailBatch,
				maxTailRounds,
			);
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
			const seeded = await seed(context, "offline-copy", context.forward);
			const pair = await digests(context);
			if (!compareDigests(pair.source, pair.target).equal) {
				await fence.release({
					scope: options.scope,
					fenceToken: grant.fenceToken,
				});
				throw new MigrationHold(
					"prepare",
					"copy verification failed; the source remains the authority",
				);
			}
			return {
				...(await flip(context, grant.fenceToken, pair.target)),
				seeded,
			};
		});
		await run.phase("soak", async () => soak(context));
		await run.phase("finalize", async () => finalize(context));
		return "none";
	}, rollbackAt(context));
}
