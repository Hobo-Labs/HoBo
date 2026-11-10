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
 *
 * Three rules hold for both realizations, and together they are why a crash
 * or a second driver cannot leave two writable stores:
 *
 * - **Decide, record, then act.** Whatever moves or releases write authority —
 *   raising a fence, releasing one in a compensation, the flip in either
 *   direction — is preceded by a journaled fact, and every fact is a
 *   compare-and-set on the head the run read. A driver that is no longer the
 *   migration's driver loses the append and stops before it acts.
 * - **A decision binds.** A journaled cutover or rollback is finished by
 *   whichever run comes next; it is not put to the question again.
 * - **A superseded applier is refused by the store.** Every batch this module
 *   applies is conditional on the leg's watermark, and that watermark carries
 *   the journal head of the driver that wrote it. Before anything is compared
 *   under a fence, the driver stamps its own head on the leg; from then on a
 *   driver with an older view can neither apply over it nor mistake it for
 *   its own.
 *
 * Two more close what a fact in front of a side effect cannot: a driver that
 * won its append and then stalled *inside* the side effect.
 *
 * - **A late authority move is refused by the router.** Every move carries the
 *   journal head its decision was made at (`AuthorityMoveRef`). The router
 *   keeps the highest head it has applied and refuses a lower one, so a flip
 *   that lands after a later decision — a rollback — moves nothing.
 * - **A fence is used only by the migration that can prove it raised it.** The
 *   digest of every token a raise answers is journaled (`FenceRaised`). A
 *   fence found standing is written through, adopted or released only when
 *   its token's digest is one this migration journaled; otherwise the run
 *   holds. And nothing new is decided under a fence a hold was journaled
 *   against: it is released and raised afresh, so the release a stalled
 *   driver still has in flight names a token that opens nothing.
 */
import type { DatasetSchema } from "../canonical.js";
import {
	compareDigests,
	type DatasetDigest,
	DEFAULT_DIGEST_BUCKETS,
} from "../digest.js";
import type { Position, RecordMutation } from "../envelope.js";
import {
	DataCoreError,
	isSupersededError,
	StaleApplyError,
} from "../errors.js";
import {
	type FenceSide,
	fenceTokenDigest,
	MIGRATION_EVENTS,
	type MigrationRealization,
} from "../facts.js";
import { isJsonNumber, isJsonString, type JsonObject } from "../json.js";
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
	type AuthorityMoveRef,
	MigrationHold,
	MigrationRollback,
	MigrationRun,
	type MigrationRunResult,
	type MigrationRuntime,
	type PhaseDenial,
	type PlannedDetails,
} from "./runtime.js";

/** Erasures recorded since an instant, as the deletes that re-apply them. */
export interface ErasureLedger {
	since(instant: string): Awaitable<readonly RecordMutation[]>;
}

export const AUTHORITY_DIRECTIONS = ["to-target", "to-source"] as const;
export type AuthorityDirection = (typeof AUTHORITY_DIRECTIONS)[number];

/**
 * One move of write authority. `migrationId` and `head` are what the router
 * compares-and-sets on (see `AuthorityMoveRef`): the same decision always
 * carries the same head, whichever run delivers it, and a later decision a
 * higher one.
 */
export interface AuthorityFlip extends AuthorityMoveRef {
	readonly direction: AuthorityDirection;
	/** The token of the fence on the source — the old authority's. */
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
	 * Move write authority. The router's contract has two halves:
	 *
	 * - **Idempotent at a head.** A crash between the flip and its fact re-runs
	 *   it with the same `head`; applying it again changes nothing.
	 * - **Compare-and-set on the head.** Keep the highest `head` applied for
	 *   `migrationId`, in the same step that moves authority, and refuse a flip
	 *   that names a lower one by throwing `StaleAuthorityMoveError` —
	 *   `admitAuthorityMove(applied, flip)` does both. A driver that journaled
	 *   its cutover and then stalled in this call is otherwise free to land the
	 *   flip after the migration has been rolled back.
	 *
	 * A refusal is supersession: the run stops, records nothing and
	 * compensates nothing. A router that ignores `head` still works for a
	 * single driver; it does not protect against a late one.
	 */
	readonly flipAuthority: (flip: AuthorityFlip) => Awaitable<void>;
	/**
	 * Consulted in the soak window. Defaults to `finalize`. Once a rollback is
	 * journaled it is not consulted again: the decision binds.
	 */
	readonly soakDecision?: () => Awaitable<SoakDecision>;
	/**
	 * Required for a `to-snapshot` rollback, so that it cannot resurrect a
	 * subject. Without it such a rollback holds instead of proceeding: no
	 * ledger is not the same as no erasures.
	 */
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

type CopyPattern = "snapshot-and-tail" | "offline-copy";

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
	/**
	 * Take the channel for this driver, so that no driver with an older view
	 * of the migration can still write through it. A native transfer has
	 * nothing to take: the engine applies its own records, not this module.
	 */
	claim(): Promise<void>;
	/** Bring the target level with everything the source has committed. */
	drain(): Promise<DrainOutcome>;
	/**
	 * Drop the channel and the log it pinned. Idempotent. With
	 * `targetBestEffort`, a target that cannot be asked does not stop the
	 * source's half from being dropped; the answer is whether the target's was.
	 */
	close(options?: ChannelCloseOptions): Promise<boolean>;
}

interface ChannelCloseOptions {
	readonly targetBestEffort?: boolean;
}

interface CopyContext {
	readonly options: CopyMigrationOptions;
	readonly pattern: CopyPattern;
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

/** One direction of the copy, as far as applying to it goes. */
interface ApplyLeg {
	readonly apply: ChangeApplyPort;
	readonly into: string;
	readonly subscription: string;
	readonly fenceToken?: string;
	/** The journal head of the driver applying: its fencing epoch. */
	epoch(): number;
}

/** A leg that is also tailed from the other side's capture. */
interface TailLeg extends ApplyLeg {
	readonly capture: ChangeCapturePort;
	readonly from: DatasetScope;
}

interface DrainOutcome {
	readonly position: Position;
	/** Changes this module applied; absent when the engine applied them. */
	readonly applied?: number;
	readonly caughtUp: boolean;
}

/**
 * What a migration leg keeps as its watermark: the position it has applied
 * through, stamped with the journal head of the driver that wrote it —
 * `<head>@<position>`. The stamp is what a conditional apply compares, so two
 * drivers that both believe a leg is theirs cannot both write to it, and a
 * driver that finds a head newer than its own knows it has been superseded.
 */
interface LegMark {
	/** The watermark exactly as stored; what a conditional apply names. */
	readonly raw: Position | undefined;
	readonly epoch: number;
	readonly position: Position | undefined;
}

const LEG_MARK = /^(0|[1-9][0-9]{0,14})@(.*)$/su;

function stamp(epoch: number, position: Position): Position {
	return `${epoch}@${position}`;
}

function legMarkOf(raw: Position | undefined): LegMark {
	if (raw === undefined) return { raw, epoch: 0, position: undefined };
	const match = LEG_MARK.exec(raw);
	// A watermark written before legs were stamped is a bare position.
	if (match === null) return { raw, epoch: 0, position: raw };
	return { raw, epoch: Number(match[1]), position: match[2] ?? "" };
}

/** Read a leg's watermark; a head newer than this driver's ends the run. */
async function readLeg(leg: ApplyLeg): Promise<LegMark> {
	const mark = legMarkOf(
		await leg.apply.watermark({ dataset: leg.into, source: leg.subscription }),
	);
	if (mark.epoch > leg.epoch()) {
		throw new StaleApplyError(leg.into, leg.subscription);
	}
	return mark;
}

async function applyTo(
	leg: ApplyLeg,
	changes: readonly RecordMutation[],
	position: Position,
	mark: LegMark,
): Promise<LegMark> {
	const raw = stamp(leg.epoch(), position);
	await leg.apply.apply({
		dataset: leg.into,
		changes,
		source: leg.subscription,
		position: raw,
		// The store compares and writes in one transaction: see `ApplyRequest`.
		expectedWatermark: mark.raw ?? null,
		...(leg.fenceToken === undefined
			? undefined
			: { fenceToken: leg.fenceToken }),
	});
	return { raw, epoch: leg.epoch(), position };
}

const CLAIM_ATTEMPTS = 8;

/**
 * Stamp this driver's head on a leg without moving its position. After it, a
 * driver with an older view is refused by the store — its conditional apply
 * names a watermark that is gone — and one that reads the leg afresh sees a
 * head newer than its own and stops.
 */
async function claim(leg: ApplyLeg, start: Position): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		const mark = await readLeg(leg);
		if (mark.epoch === leg.epoch() && mark.raw !== undefined) return;
		try {
			await applyTo(leg, [], mark.position ?? start, mark);
			return;
		} catch (error) {
			// Someone applied between the read and the stamp. Look again: either
			// they outrank this driver, and the read says so, or the stamp lands.
			if (!(error instanceof StaleApplyError) || attempt >= CLAIM_ATTEMPTS) {
				throw error;
			}
		}
	}
}

/** Tail one leg until it is caught up or the round budget is spent. */
async function drain(
	leg: TailLeg,
	start: Position,
	limit: number,
	rounds: number,
): Promise<DrainOutcome> {
	let mark = await readLeg(leg);
	let position = mark.position ?? start;
	let applied = 0;
	for (let round = 0; round < rounds; round += 1) {
		const batch = await leg.capture.read({
			scope: leg.from,
			subscription: leg.subscription,
			after: position,
			limit,
		});
		// A batch with nothing in scope still moves the resume point. Recording
		// it keeps a quiet leg's durable position from falling out of the log
		// the engine retains — a leg that was never behind must not come back
		// from a long hold to a position that is gone.
		if (batch.changes.length > 0 || batch.position !== position) {
			mark = await applyTo(leg, batch.changes, batch.position, mark);
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

/** The forward leg as the seed and the stamp use it: no capture needed. */
function forwardApply(context: CopyContext): ApplyLeg {
	const { options, targetScope, forward, run } = context;
	return {
		apply: requirePort(options.target, "apply"),
		into: targetScope.dataset,
		subscription: forward,
		epoch: () => run.head,
	};
}

function forwardLeg(context: CopyContext): TailLeg {
	const { options } = context;
	return {
		...forwardApply(context),
		capture: requirePort(options.source, "capture"),
		from: options.scope,
	};
}

function reverseLeg(context: CopyContext, fenceToken: string): TailLeg {
	const { options, targetScope, reverse, run } = context;
	return {
		capture: requirePort(options.target, "capture"),
		apply: requirePort(options.source, "apply"),
		from: targetScope,
		into: options.scope.dataset,
		subscription: reverse,
		fenceToken,
		epoch: () => run.head,
	};
}

/**
 * A reverse tail keeps the old side current, and a rollback under one is
 * `lossless` — but only if the target can be fenced while authority goes
 * back. Without that fence the target can acknowledge a write between the
 * rollback's last digest and the flip, and that write is lost. So the target's
 * `fence` port is part of what a reverse tail needs; lacking it, the posture
 * is `to-snapshot` and says so.
 */
function hasReverseTail(options: CopyMigrationOptions): boolean {
	return (
		options.target.capture !== undefined &&
		options.target.fence !== undefined &&
		options.source.apply !== undefined
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
	pattern: CopyPattern,
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
	pattern: CopyPattern,
): Promise<CopyContext> {
	const targetScope = options.targetScope ?? options.scope;
	const native = resolveNative(options, pattern, targetScope);
	// A native transfer is torn down at the cutover and nothing tails back,
	// so the old side goes stale there: the posture is `to-snapshot`.
	const reverseTail = native === undefined && hasReverseTail(options);
	const run = await MigrationRun.open(options.runtime, pattern, {
		source: options.source.declaration.engine,
		target: options.target.declaration.engine,
		dataset: options.schema.name,
		...options.plan,
		realization: native === undefined ? "hub" : "native",
		...(native === undefined ? undefined : { profile: native.profile }),
		reverseTail,
	});
	const id = options.runtime.migrationId;
	return {
		options,
		pattern,
		run,
		targetScope,
		forward: `hobo_migration_${id}_forward`,
		reverse: `hobo_migration_${id}_reverse`,
		buckets: options.buckets ?? DEFAULT_DIGEST_BUCKETS,
		tailBatch: options.tailBatch ?? 500,
		maxTailRounds: options.maxTailRounds ?? 1000,
		reverseTail,
		...(native === undefined ? undefined : { native }),
	};
}

// public-contract: the forward leg's position for an offline copy, which has no capture position to start from.
export const OFFLINE_COPY_POSITION = "offline-copy";

/** Where the forward leg starts: what its watermark holds before any tail. */
function forwardStart(context: CopyContext): Position {
	return context.pattern === "offline-copy"
		? OFFLINE_COPY_POSITION
		: context.run.checkpointText("prepare", "startPosition");
}

/**
 * Copy the whole scope through the hub. Returns records applied.
 *
 * Every chunk is a conditional apply on the forward leg. The leg is read
 * *before* the scan opens, so whatever the scan returns is at least as new as
 * the watermark the chunks are conditional on — and once a tail has moved
 * that watermark, a chunk still in a slower driver's hands is refused instead
 * of landing on top of the changes that superseded it.
 */
async function seed(context: CopyContext): Promise<number> {
	const { options } = context;
	const leg = forwardApply(context);
	const position = forwardStart(context);
	let mark = await readLeg(leg);
	if (mark.position !== undefined && mark.position !== position) {
		// The tail has moved the leg on: this seed is another driver's past.
		throw new StaleApplyError(leg.into, leg.subscription);
	}
	const cursor = await requirePort(options.source, "snapshot").openSnapshot({
		scope: options.scope,
		chunkSize: options.chunkSize ?? 500,
	});
	let seeded = 0;
	try {
		for (;;) {
			const chunk = await cursor.next();
			if (chunk === undefined) break;
			if (chunk.length === 0) continue;
			mark = await applyTo(leg, chunk, position, mark);
			seeded += chunk.length;
		}
	} finally {
		await cursor.close();
	}
	return seeded;
}

/** The hub: scan, tail and apply canonical records over the ports. */
function hubChannel(context: CopyContext): ForwardChannel {
	const { options, forward, tailBatch, maxTailRounds } = context;
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
			return { seeded: await seed(context) };
		},
		claim: () => claim(forwardApply(context), forwardStart(context)),
		drain: () =>
			drain(
				forwardLeg(context),
				forwardStart(context),
				tailBatch,
				maxTailRounds,
			),
		async close() {
			await options.source.capture?.stop(forward);
			return true;
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
	let resumed = false;
	/**
	 * A transfer is paused whenever the run holds (see `pauseTransfer`), so the
	 * first thing a phase that needs it does is let it deliver again. Only a
	 * phase body calls this, and a phase body runs only behind a verdict.
	 */
	const resume = async (): Promise<void> => {
		if (resumed) return;
		await native.target.resume(native.targetRef);
		resumed = true;
	};
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
			await resume();
			for (let round = 0; round < rounds; round += 1) {
				if (await native.target.seeded(native.targetRef)) {
					return { copied: "native" };
				}
			}
			return undefined;
		},
		async claim() {},
		async drain() {
			// A mark, then the question "has the target applied up to it": the
			// engine's own equivalent of tailing until caught up.
			await resume();
			const mark = await native.source.mark(native.sourceRef);
			for (let round = 0; round < rounds; round += 1) {
				if (await native.source.reached({ ...native.sourceRef, mark })) {
					return { position: mark, caughtUp: true };
				}
			}
			return { position: mark, caughtUp: false };
		},
		async close(closing = {}) {
			// The target first: its side reads from what the source retains.
			let targetStopped = true;
			try {
				await native.target.stop(native.targetRef);
			} catch (error) {
				if (closing.targetBestEffort !== true) throw error;
				targetStopped = false;
			}
			// Always: with the source's half gone, a target that comes back has
			// nothing left to read from.
			await native.source.stop(native.sourceRef);
			return targetStopped;
		},
	};
}

/**
 * Stop a native transfer delivering while the run is held. A held migration
 * moves nothing: the hub is driven by this module and stops with it, and the
 * engine's own transport is told to. The one exception is a hold that only
 * says "the engine has not finished yet" (`MigrationHold.working`) — there the
 * transfer is the work, and it carries on under the verdict it started with.
 */
async function pauseTransfer(
	context: CopyContext,
	hold: MigrationHold,
): Promise<void> {
	const { native } = context;
	if (native === undefined || hold.working) return;
	await native.target.pause(native.targetRef);
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
 * whether that fence is still the one the decision was made under.
 *
 * The store is asked first whether the fence is up at all, and it is "raised"
 * only when it is. A fence that is down was lifted behind the migration's
 * back — or the migration has since been rolled back and this driver has not
 * noticed — and raising a fresh one would refuse writes on a store that may
 * be the authority. Either way the old side may have taken writes, and the
 * run holds for a person.
 */
async function cutOverFenceToken(
	context: CopyContext,
	recorded: JsonObject,
): Promise<string> {
	const { options } = context;
	// A journal written before tokens were kept out of it.
	const legacy = recorded.fenceToken;
	if (isJsonString(legacy)) return legacy;
	const fence = requirePort(options.source, "fence");
	const status = await fence.status(options.scope);
	if (!status.fenced) {
		throw new MigrationHold(
			"soak",
			"the fence the cutover was decided under is no longer raised on the old authority; it may have taken writes",
		);
	}
	const grant = await fence.raise({
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
 * Journal that the source is about to be fenced, then fence it. The fact is
 * first, and conditional: a driver that has been superseded loses it and
 * never refuses a write on a store it no longer has any business with. Its
 * instant is also where erasure replay is windowed from — an erasure that
 * arrives while the source is fenced is dated before the cutover, yet never
 * reached the source.
 */
async function fenceSource(
	context: CopyContext,
	holdAt: MigrationPhase,
): Promise<string> {
	return raiseOwnedFence(context, "source", "fence-and-flip", holdAt);
}

// public-contract: hold code for a fence this migration cannot prove it raised; it is neither adopted nor released.
export const FENCE_NOT_OWNED = "FENCE_NOT_OWNED";

// public-contract: impedance code of a rollback that could not fence, or stop the transfer on, an unreachable target.
export const ROLLBACK_TARGET_UNREACHABLE = "ROLLBACK_TARGET_UNREACHABLE";

/**
 * Raise this migration's fence on a side and answer its token — or hold,
 * when a fence is already standing there that the journal cannot show to be
 * this migration's own.
 *
 * The port cannot say who raised a fence; raising a raised one answers its
 * token to anyone. So ownership is proven from the journal: the digest of
 * every token a raise answered is recorded (`FenceRaised`), and a standing
 * fence is this migration's when its token digests to the last one recorded
 * for the side. Three cases follow from what the journal holds:
 *
 * - **No request on record** — the fence is somebody else's. Hold.
 * - **A request whose answer was never recorded** — the run died between the
 *   raise and its record. The fence went up after this migration's journaled
 *   request, so it is taken to be the one requested and its digest is recorded
 *   now. (A fence someone else raised in that same instant cannot be told
 *   apart; the port offers nothing to tell them apart with.)
 * - **A recorded digest** — a match is this migration's fence; anything else
 *   is somebody else's, and the run holds. A matching fence that a hold was
 *   journaled against is not decided under again: the driver that held may
 *   still have its release in flight. It is released and raised afresh, so
 *   that late release names a token that no longer opens anything.
 */
async function raiseOwnedFence(
	context: CopyContext,
	side: FenceSide,
	phase: MigrationPhase,
	holdAt: MigrationPhase,
): Promise<string> {
	const { options, run, targetScope } = context;
	const port = requirePort(
		side === "source" ? options.source : options.target,
		"fence",
	);
	const scope = side === "source" ? options.scope : targetScope;
	const reason = `migration ${options.runtime.migrationId}`;
	const status = await port.status(scope);
	if (status.fenced) {
		const claim = run.fenceClaim(side);
		const foreign = (): MigrationHold =>
			new MigrationHold(
				holdAt,
				`${FENCE_NOT_OWNED}: the ${side} is already fenced, and not by a fence this migration can prove it raised; it was neither adopted nor released`,
			);
		if (claim === undefined) throw foreign();
		// Raising a raised fence answers its token and changes nothing.
		const standing = await port.raise({ scope, reason });
		if (claim.pending) {
			await run.recordFence(side, phase, standing.fenceToken);
			return standing.fenceToken;
		}
		if (fenceTokenDigest(standing.fenceToken) !== claim.digest) throw foreign();
		if (!claim.abandoned) return standing.fenceToken;
		await port.release({ scope, fenceToken: standing.fenceToken });
	}
	await run.requestFence(side, phase);
	const grant = await port.raise({ scope, reason });
	await run.recordFence(side, phase, grant.fenceToken);
	return grant.fenceToken;
}

/**
 * Give write authority back to the source because verification under the
 * fence failed. The hold is journaled first — a compare-and-set, like every
 * fact — so a driver acting on a view that is no longer true stops here, with
 * the fence still up, instead of releasing it under a cutover another driver
 * has since completed.
 */
async function compensate(
	context: CopyContext,
	fenceToken: string,
	phase: MigrationPhase,
	reason: string,
	working = false,
): Promise<MigrationHold> {
	const { options, run } = context;
	const hold = await run.recordHold(
		phase,
		reason,
		{ compensated: true },
		working,
	);
	// Reads go home where a ramp moved them; an offline copy never did.
	if (context.pattern === "snapshot-and-tail") await options.shiftReads?.(0);
	await requirePort(options.source, "fence").release({
		scope: options.scope,
		fenceToken,
	});
	return hold;
}

/**
 * A compensation sends reads home, and the ramp that moved them is already
 * checkpointed, so nothing would move them back. Before a cutover is decided
 * they are put where the ramp left them: authority must not move to a store
 * that is serving no reads.
 */
async function restoreReads(context: CopyContext): Promise<void> {
	const { options, run } = context;
	if (!run.compensated()) return;
	const percent = run.checkpoint("shift-reads")?.percent;
	if (isJsonNumber(percent)) await options.shiftReads?.(percent);
}

/**
 * What follows a journaled cutover decision, the first time and on every
 * resume. A native transfer is closed — left open, it would carry the old
 * side's retirement to the new authority as deletes. A hub leg is stamped
 * with this driver's head, so no driver that has not seen the decision can
 * apply to the new authority. Then write authority moves.
 */
async function completeFlip(
	context: CopyContext,
	fenceToken: string,
): Promise<void> {
	const channel = channelOf(context);
	if (context.native === undefined) await channel.claim();
	else await channel.close();
	await context.options.flipAuthority({
		migrationId: context.options.runtime.migrationId,
		// The head of the journaled cutover: the same for the run that decided
		// it and for every run that finishes it.
		head: context.run.decisionHead(MIGRATION_EVENTS.CutOver),
		direction: "to-target",
		fenceToken,
	});
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
	await restoreReads(context);
	// The first time this run asked for the source's fence: nothing the source
	// refused since then can have reached it.
	const fencedFrom = run.firstText(
		MIGRATION_EVENTS.FenceRequested,
		"requestedAt",
		"source",
	);
	const decision: JsonObject = {
		migrationId: options.runtime.migrationId,
		// The digest, never the token: see `fenceTokenDigest`.
		fenceTokenDigest: fenceTokenDigest(fenceToken),
		count: equal.count,
		digest: equal.digest,
		reverseTail,
		...(reversePosition === undefined ? undefined : { reversePosition }),
		...(fencedFrom === undefined ? undefined : { fencedFrom }),
		cutOverAt: options.runtime.clock(),
	};
	await run.emit(MIGRATION_EVENTS.CutOver, decision);
	await completeFlip(context, fenceToken);
	return decision;
}

/**
 * Finish a cutover an earlier run decided but did not complete. The flip is
 * idempotent at its head by contract, so repeating it is safe whether or not
 * it landed — and it carries the head of the decision, so a router that has
 * since applied a later one refuses it.
 */
async function resumeFlip(
	context: CopyContext,
	decision: JsonObject,
): Promise<JsonObject> {
	await completeFlip(context, await cutOverFenceToken(context, decision));
	return decision;
}

/**
 * An interrupted rollback attempt can leave the target — the authority —
 * fenced with nothing journaled after the request. A run that is not going to
 * roll back must not carry on with the authority refusing writes, so it
 * journals a hold, releases that fence, and stops; the next run finds the
 * target writable.
 */
async function releaseStrandedTargetFence(context: CopyContext): Promise<void> {
	const { options, run, targetScope } = context;
	const fence = options.target.fence;
	// Only a fence this migration asked for can be one it stranded. With no
	// request on record a fence on the target is somebody else's business.
	const claim = run.fenceClaim("target");
	if (fence === undefined || claim === undefined) return;
	const status = await fence.status(targetScope);
	if (!status.fenced) return;
	// Raising a raised fence answers its token and changes nothing.
	const standing = await fence.raise({
		scope: targetScope,
		reason: `migration ${options.runtime.migrationId}`,
	});
	if (
		!claim.pending &&
		fenceTokenDigest(standing.fenceToken) !== claim.digest
	) {
		// Fenced, but not by the fence this migration recorded raising: it is
		// someone else's, and is left exactly as it stands.
		throw new MigrationHold(
			"soak",
			`${FENCE_NOT_OWNED}: the new authority is fenced, and not by a fence this migration can prove it raised; it was not released`,
		);
	}
	const hold = await run.recordHold(
		"soak",
		"an interrupted rollback attempt left the new authority fenced; its fence was released",
	);
	await fence.release({ scope: targetScope, fenceToken: standing.fenceToken });
	throw hold;
}

/** What the run loop learned before the soak phase's body runs. */
interface SoakEntry {
	/** The soak decision, when it was already asked for. */
	decision?: SoakDecision;
	/** The negative verdict the phase is running under, when it is. */
	denial?: PhaseDenial;
}

async function soak(
	context: CopyContext,
	entry: SoakEntry = {},
): Promise<JsonObject> {
	const { options, run, reverseTail, tailBatch, maxTailRounds } = context;
	// A rollback an earlier run decided is finished, not reconsidered: the
	// soak decision is not asked again.
	const decided = run.rollbackDecision();
	if (decided !== undefined) return finishRollback(context, decided);
	const decision =
		entry.decision ?? (await options.soakDecision?.()) ?? "finalize";
	if (decision !== "rollback") await releaseStrandedTargetFence(context);
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
	if (decision === "rollback") return rollbackFromSoak(context, entry.denial);
	return { decision };
}

/**
 * The soak phase, with the one thing a negative verdict does not stop: a
 * rollback. Going back moves write authority to the store the data already
 * lived in and ends the copy the verdict objects to, so a rollback that is
 * asked for runs — and the decision records the findings it ran under. Any
 * other answer holds as before, after a fence an interrupted rollback left on
 * the authority has been let go.
 */
function soakPhase(context: CopyContext): Promise<JsonObject> {
	const entry: SoakEntry = {};
	return context.run.phase("soak", async () => soak(context, entry), {
		underDenial: async (denial) => {
			entry.decision = (await context.options.soakDecision?.()) ?? "finalize";
			entry.denial = denial;
			if (entry.decision === "rollback") return true;
			await releaseStrandedTargetFence(context);
			return false;
		},
	});
}

/** Where erasure replay is windowed from: before the source was fenced. */
function erasureWindowStart(context: CopyContext): string {
	const { run } = context;
	const cutOver = cutOverCheckpoint(context);
	if (isJsonString(cutOver.fencedFrom)) return cutOver.fencedFrom;
	// A journal from before the fence request was a fact: the plan's instant
	// is earlier than any fence, so the window is wider than needed, never
	// narrower.
	return (
		run.firstText(MIGRATION_EVENTS.Planned, "plannedAt") ??
		run.checkpointText("fence-and-flip", "cutOverAt")
	);
}

/**
 * Decide a rollback: establish that it is safe, journal the decision, and
 * only then start moving authority. Everything before the decision can be
 * undone by a hold; everything after it is `finishRollback`, which any later
 * run repeats until it is done.
 */
async function rollbackFromSoak(
	context: CopyContext,
	denial?: PhaseDenial,
): Promise<never> {
	const { options, run, reverseTail, targetScope, tailBatch, maxTailRounds } =
		context;
	const fenceToken = await cutOverFenceToken(
		context,
		cutOverCheckpoint(context),
	);
	// The verdict the rollback was asked for under, when it was negative.
	const underVerdict =
		denial === undefined ? undefined : { policyFindings: [...denial.findings] };
	if (reverseTail) {
		// Quiesce the target, then prove the source is current before it
		// becomes the authority again. A lossless rollback needs the target
		// to answer: there is no proving the source current without it.
		const targetFence = requirePort(options.target, "fence");
		const targetToken = await raiseOwnedFence(
			context,
			"target",
			"soak",
			"soak",
		);
		const reversePosition = run.checkpointText(
			"fence-and-flip",
			"reversePosition",
		);
		const leg = reverseLeg(context, fenceToken);
		await claim(leg, reversePosition);
		const drained = await drain(leg, reversePosition, tailBatch, maxTailRounds);
		const pair = await digests(context);
		if (!drained.caughtUp || !compareDigests(pair.source, pair.target).equal) {
			// Not safe to hand authority back yet: let the target keep writing.
			// The hold is journaled before its fence is released.
			const hold = await run.recordHold(
				"soak",
				"reverse tail has not converged; the source is not yet current",
			);
			await targetFence.release({
				scope: targetScope,
				fenceToken: targetToken,
			});
			throw hold;
		}
		const decision: JsonObject = {
			migrationId: options.runtime.migrationId,
			lossless: true,
			targetFenced: true,
			count: pair.source.count,
			digest: pair.source.digest,
			...underVerdict,
			decidedAt: options.runtime.clock(),
		};
		await run.emit(MIGRATION_EVENTS.RollbackDecided, decision);
		return finishRollback(context, decision);
	}
	// No reverse tail: writes since the flip are lost, and the plan said so.
	// What must not happen is an erased subject coming back with the stale
	// source. That needs the ledger; without one the rollback does not start.
	if (options.erasures === undefined) {
		throw new MigrationHold(
			"soak",
			"a rollback to the stale source must re-apply the erasures recorded since the cutover, and no erasure ledger was supplied; nothing was rolled back",
		);
	}
	// Stop the target acknowledging writes that are about to be abandoned,
	// where the engine can — and where it answers. This rollback abandons the
	// target, and the usual reason to abandon it is that it has failed; a
	// rollback that waited for a dead store to be fenced would leave authority
	// on that store. So the target's side is best effort, and the decision
	// records whether it was fenced. A fence someone else holds there is not
	// "unreachable": that is a hold, like anywhere else.
	let targetFenced = false;
	if (options.target.fence !== undefined) {
		try {
			await raiseOwnedFence(context, "target", "soak", "soak");
			targetFenced = true;
		} catch (error) {
			if (
				error instanceof MigrationHold ||
				(error instanceof Error && isSupersededError(error))
			) {
				throw error;
			}
			run.noteImpedance(ROLLBACK_TARGET_UNREACHABLE);
		}
	}
	const decision: JsonObject = {
		migrationId: options.runtime.migrationId,
		lossless: false,
		targetFenced,
		erasuresFrom: erasureWindowStart(context),
		...underVerdict,
		decidedAt: options.runtime.clock(),
	};
	await run.emit(MIGRATION_EVENTS.RollbackDecided, decision);
	return finishRollback(context, decision);
}

/**
 * Re-apply to the fenced source every erasure the ledger holds since the
 * rollback's window opened. Deletes are idempotent, so reading and applying
 * the whole window twice is harmless. Returns how many the ledger held.
 */
async function replayErasures(
	context: CopyContext,
	decision: JsonObject,
	fenceToken: string,
): Promise<number> {
	const { options } = context;
	if (options.erasures === undefined) return 0;
	const from = isJsonString(decision.erasuresFrom)
		? decision.erasuresFrom
		: erasureWindowStart(context);
	const mutations = await options.erasures.since(from);
	if (mutations.length > 0) {
		await options.source.records.write({
			dataset: options.scope.dataset,
			mutations,
			fenceToken,
		});
	}
	return mutations.length;
}

/**
 * Carry out a journaled rollback, the first time and on every resume. Each
 * step is idempotent, and the source's fence is released last — so a run that
 * finds it down knows authority is already back and only the record is
 * missing. Until then the source is fenced and the target, where it can be,
 * is too: at no point are both writable.
 */
async function finishRollback(
	context: CopyContext,
	decision: JsonObject,
): Promise<never> {
	const { options, run } = context;
	const lossless = decision.lossless === true;
	const fence = requirePort(options.source, "fence");
	const cutOver = cutOverCheckpoint(context);
	let erased: number | undefined;
	const status = await fence.status(options.scope);
	if (status.fenced) {
		const fenceToken = await cutOverFenceToken(context, cutOver);
		if (lossless) {
			// Close the reverse leg before the source takes writes of its own:
			// a driver still tailing with an older view is refused from here.
			await claim(
				reverseLeg(context, fenceToken),
				run.checkpointText("fence-and-flip", "reversePosition"),
			);
		} else {
			if (options.erasures === undefined) {
				throw new MigrationHold(
					"soak",
					"the decided rollback must re-apply the erasures recorded since the cutover, and no erasure ledger was supplied; authority has not moved",
				);
			}
			erased = await replayErasures(context, decision, fenceToken);
		}
		// The forward channel ends with the migration: a native transfer left
		// open would start copying the restored authority's writes to the
		// abandoned target, and a hub subscription would pin the source's log
		// for ever. Dropped before authority moves. Going back to a stale
		// source does not wait for the target to answer; the source's half is
		// dropped regardless.
		const targetClosed = await channelOf(context).close({
			targetBestEffort: !lossless,
		});
		if (!targetClosed) run.noteImpedance(ROLLBACK_TARGET_UNREACHABLE);
		await options.flipAuthority({
			migrationId: options.runtime.migrationId,
			head: run.decisionHead(MIGRATION_EVENTS.RollbackDecided),
			direction: "to-source",
			fenceToken,
		});
		if (!lossless) {
			// Read the ledger again now that authority is back and the source
			// is still fenced. An erasure that reached the abandoned target
			// between the first read and the flip is in the ledger and not on
			// the source; from here on an erasure is sent to the source, which
			// refuses it until the fence is released and is asked again after.
			erased = Math.max(
				erased ?? 0,
				await replayErasures(context, decision, fenceToken),
			);
		}
		await fence.release({ scope: options.scope, fenceToken });
	}
	if (lossless) {
		await options.target.capture?.stop(context.reverse);
		throw new MigrationRollback(
			"rolled back from soak under a reverse tail",
			true,
		);
	}
	const since = run.checkpointText("fence-and-flip", "cutOverAt");
	throw new MigrationRollback(
		erased === undefined
			? `rolled back from soak without a reverse tail; writes since ${since} are lost, erasures were re-applied before authority returned`
			: `rolled back from soak without a reverse tail; writes since ${since} are lost, ${erased} erasure(s) re-applied`,
		false,
		erased === undefined ? {} : { erasuresReplayed: erased },
	);
}

async function finalize(context: CopyContext): Promise<JsonObject> {
	const { options, run, reverseTail, buckets } = context;
	const fenceToken = await cutOverFenceToken(
		context,
		cutOverCheckpoint(context),
	);
	// The reverse tail ends here: once the source is about to be retired there
	// is nothing left for it to keep current. Its leg is stamped first, so a
	// driver still tailing with an older view cannot write to a retired store.
	if (reverseTail) {
		await claim(
			reverseLeg(context, fenceToken),
			run.checkpointText("fence-and-flip", "reversePosition"),
		);
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
	// The forward channel is dropped before the source is emptied, never
	// after. An engine whose log records the retirement as deletes would
	// otherwise hand them to whatever still reads that channel — and what
	// reads it is the new authority.
	await channelOf(context).close();
	// An empty scope behind the migration's own fence was emptied by this
	// migration: nothing else writes through that fence. So a run that died
	// after the retire committed and before the phase was recorded finds the
	// work done, instead of mistaking it for a source that changed.
	const decided = cutOverCheckpoint(context).count;
	if (expected.count === 0 && isJsonNumber(decided) && decided > 0) {
		return { removed: 0, alreadyRetired: true };
	}
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
	return run.drive(
		async () => {
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
						{ working: true },
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
						{ working: true },
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
				const fenceToken = await fenceSource(context, "shift-reads");
				// This driver's head on the leg, before anything is compared: a
				// driver with an older view can no longer apply to the target.
				await channel.claim();
				const drained = await channel.drain();
				const pair = await digests(context);
				if (
					!drained.caughtUp ||
					!compareDigests(pair.source, pair.target).equal
				) {
					// Compensate: the source stays the authority and reads go home.
					throw await compensate(
						context,
						fenceToken,
						"shift-reads",
						"exact verification under the fence failed; the source remains the authority",
					);
				}
				return flip(context, fenceToken, pair.target);
			});
			await soakPhase(context);
			await run.phase("finalize", async () => finalize(context));
			return "none";
		},
		rollbackAt(context),
		{ held: (hold) => pauseTransfer(context, hold) },
	);
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
	return run.drive(
		async () => {
			await run.phase("gate", async () => ({}));
			await run.phase("prepare", async () => {
				await options.target.datasets.ensureDataset(options.schema);
				return {};
			});
			await run.phase("fence-and-flip", async () => {
				const decided = run.cutOverDecision();
				if (decided !== undefined) return resumeFlip(context, decided);
				const fenceToken = await fenceSource(context, "prepare");
				let seeded: number | undefined;
				if (context.native === undefined) {
					await channel.claim();
					seeded = await seed(context);
				} else {
					// Opening is idempotent, so an attempt that ran out of time is
					// continued by the next one rather than started again: the
					// transfer is left in place when the fence is released.
					await channel.open();
					const copied = await channel.seed();
					const level =
						copied === undefined ? undefined : await channel.drain();
					if (level?.caughtUp !== true) {
						throw await compensate(
							context,
							fenceToken,
							"prepare",
							"the native copy did not finish inside the fence window; the source remains the authority",
							true,
						);
					}
				}
				const pair = await digests(context);
				if (!compareDigests(pair.source, pair.target).equal) {
					throw await compensate(
						context,
						fenceToken,
						"prepare",
						"copy verification failed; the source remains the authority",
					);
				}
				return {
					...(await flip(context, fenceToken, pair.target)),
					...(seeded === undefined ? undefined : { seeded }),
				};
			});
			await soakPhase(context);
			await run.phase("finalize", async () => finalize(context));
			return "none";
		},
		rollbackAt(context),
		{ held: (hold) => pauseTransfer(context, hold) },
	);
}
