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

export interface ErasureLedger {
	since(instant: string): Awaitable<readonly RecordMutation[]>;
}

export const AUTHORITY_DIRECTIONS = ["to-target", "to-source"] as const;
export type AuthorityDirection = (typeof AUTHORITY_DIRECTIONS)[number];

export interface AuthorityFlip extends AuthorityMoveRef {
	readonly direction: AuthorityDirection;
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
	readonly targetScope?: DatasetScope;
	readonly chunkSize?: number;
	readonly tailBatch?: number;
	readonly maxTailRounds?: number;
	readonly buckets?: number;
	readonly verifyRechecks?: number;
	readonly rampSteps?: readonly number[];
	readonly shiftReads?: (percent: number) => Awaitable<void>;
	readonly flipAuthority: (flip: AuthorityFlip) => Awaitable<void>;
	readonly soakDecision?: () => Awaitable<SoakDecision>;
	readonly erasures?: ErasureLedger;
	readonly realization?: MigrationRealization;
	readonly profile?: string;
	readonly plan?: PlannedDetails;
}

type CopyPattern = "snapshot-and-tail" | "offline-copy";

interface NativeLeg {
	readonly profile: string;
	readonly source: NativeTransferPort;
	readonly target: NativeTransferPort;
	readonly sourceRef: NativeTransferRef;
	readonly targetRef: NativeTransferRef;
}

interface ForwardChannel {
	open(): Promise<JsonObject>;
	seed(): Promise<JsonObject | undefined>;
	claim(): Promise<void>;
	drain(): Promise<DrainOutcome>;
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
	readonly native?: NativeLeg;
}

interface ApplyLeg {
	readonly apply: ChangeApplyPort;
	readonly into: string;
	readonly subscription: string;
	readonly fenceToken?: string;
	epoch(): number;
}

interface TailLeg extends ApplyLeg {
	readonly capture: ChangeCapturePort;
	readonly from: DatasetScope;
}

interface DrainOutcome {
	readonly position: Position;
	readonly applied?: number;
	readonly caughtUp: boolean;
}

interface LegMark {
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
	if (match === null) return { raw, epoch: 0, position: raw };
	return { raw, epoch: Number(match[1]), position: match[2] ?? "" };
}

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
		expectedWatermark: mark.raw ?? null,
		...(leg.fenceToken === undefined
			? undefined
			: { fenceToken: leg.fenceToken }),
	});
	return { raw, epoch: leg.epoch(), position };
}

const CLAIM_ATTEMPTS = 8;

async function claim(leg: ApplyLeg, start: Position): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		const mark = await readLeg(leg);
		if (mark.epoch === leg.epoch() && mark.raw !== undefined) return;
		try {
			await applyTo(leg, [], mark.position ?? start, mark);
			return;
		} catch (error) {
			if (!(error instanceof StaleApplyError) || attempt >= CLAIM_ATTEMPTS) {
				throw error;
			}
		}
	}
}

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

function hasReverseTail(options: CopyMigrationOptions): boolean {
	return (
		options.target.capture !== undefined &&
		options.target.fence !== undefined &&
		options.source.apply !== undefined
	);
}

export const NATIVE_TRANSFER_SUFFIX = "_native";

export function nativeTransferName(migrationId: string): string {
	return `hobo_migration_${migrationId}${NATIVE_TRANSFER_SUFFIX}`;
}

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

export const OFFLINE_COPY_POSITION = "offline-copy";

function forwardStart(context: CopyContext): Position {
	return context.pattern === "offline-copy"
		? OFFLINE_COPY_POSITION
		: context.run.checkpointText("prepare", "startPosition");
}

async function seed(context: CopyContext): Promise<number> {
	const { options } = context;
	const leg = forwardApply(context);
	const position = forwardStart(context);
	let mark = await readLeg(leg);
	if (mark.position !== undefined && mark.position !== position) {
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

function hubChannel(context: CopyContext): ForwardChannel {
	const { options, forward, tailBatch, maxTailRounds } = context;
	return {
		async open() {
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

function nativeChannel(
	context: CopyContext,
	native: NativeLeg,
): ForwardChannel {
	const rounds = context.maxTailRounds;
	let resumed = false;
	const resume = async (): Promise<void> => {
		if (resumed) return;
		await native.target.resume(native.targetRef);
		resumed = true;
	};
	return {
		async open() {
			const ticket = await native.source.publish(native.sourceRef);
			await native.target.subscribe({ ...native.targetRef, ticket });
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
			let targetStopped = true;
			try {
				await native.target.stop(native.targetRef);
			} catch (error) {
				if (closing.targetBestEffort !== true) throw error;
				targetStopped = false;
			}
			await native.source.stop(native.sourceRef);
			return targetStopped;
		},
	};
}

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

async function cutOverFenceToken(
	context: CopyContext,
	recorded: JsonObject,
): Promise<string> {
	const { options } = context;
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

async function fenceSource(
	context: CopyContext,
	holdAt: MigrationPhase,
): Promise<string> {
	return raiseOwnedFence(context, "source", "fence-and-flip", holdAt);
}

export const FENCE_NOT_OWNED = "FENCE_NOT_OWNED";

export const ROLLBACK_TARGET_UNREACHABLE = "ROLLBACK_TARGET_UNREACHABLE";

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
	if (context.pattern === "snapshot-and-tail") await options.shiftReads?.(0);
	await requirePort(options.source, "fence").release({
		scope: options.scope,
		fenceToken,
	});
	return hold;
}

async function restoreReads(context: CopyContext): Promise<void> {
	const { options, run } = context;
	if (!run.compensated()) return;
	const percent = run.checkpoint("shift-reads")?.percent;
	if (isJsonNumber(percent)) await options.shiftReads?.(percent);
}

async function completeFlip(
	context: CopyContext,
	fenceToken: string,
): Promise<void> {
	const channel = channelOf(context);
	if (context.native === undefined) await channel.claim();
	else await channel.close();
	await context.options.flipAuthority({
		migrationId: context.options.runtime.migrationId,
		head: context.run.decisionHead(MIGRATION_EVENTS.CutOver),
		direction: "to-target",
		fenceToken,
	});
}

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
	const fencedFrom = run.firstText(
		MIGRATION_EVENTS.FenceRequested,
		"requestedAt",
		"source",
	);
	const decision: JsonObject = {
		migrationId: options.runtime.migrationId,
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

async function resumeFlip(
	context: CopyContext,
	decision: JsonObject,
): Promise<JsonObject> {
	await completeFlip(context, await cutOverFenceToken(context, decision));
	return decision;
}

async function releaseStrandedTargetFence(context: CopyContext): Promise<void> {
	const { options, run, targetScope } = context;
	const fence = options.target.fence;
	const claim = run.fenceClaim("target");
	if (fence === undefined || claim === undefined) return;
	const status = await fence.status(targetScope);
	if (!status.fenced) return;
	const standing = await fence.raise({
		scope: targetScope,
		reason: `migration ${options.runtime.migrationId}`,
	});
	if (
		!claim.pending &&
		fenceTokenDigest(standing.fenceToken) !== claim.digest
	) {
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

interface SoakEntry {
	decision?: SoakDecision;
	denial?: PhaseDenial;
}

async function soak(
	context: CopyContext,
	entry: SoakEntry = {},
): Promise<JsonObject> {
	const { options, run, reverseTail, tailBatch, maxTailRounds } = context;
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

function erasureWindowStart(context: CopyContext): string {
	const { run } = context;
	const cutOver = cutOverCheckpoint(context);
	if (isJsonString(cutOver.fencedFrom)) return cutOver.fencedFrom;
	return (
		run.firstText(MIGRATION_EVENTS.Planned, "plannedAt") ??
		run.checkpointText("fence-and-flip", "cutOverAt")
	);
}

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
	const underVerdict =
		denial === undefined ? undefined : { policyFindings: [...denial.findings] };
	if (reverseTail) {
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
	if (options.erasures === undefined) {
		throw new MigrationHold(
			"soak",
			"a rollback to the stale source must re-apply the erasures recorded since the cutover, and no erasure ledger was supplied; nothing was rolled back",
		);
	}
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
	if (reverseTail) {
		await claim(
			reverseLeg(context, fenceToken),
			run.checkpointText("fence-and-flip", "reversePosition"),
		);
		await requirePort(options.target, "capture").stop(context.reverse);
	}
	const expected = await requirePort(options.source, "verify").digest({
		scope: options.scope,
		buckets,
	});
	await channelOf(context).close();
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
				await channel.claim();
				const drained = await channel.drain();
				const pair = await digests(context);
				if (
					!drained.caughtUp ||
					!compareDigests(pair.source, pair.target).equal
				) {
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
