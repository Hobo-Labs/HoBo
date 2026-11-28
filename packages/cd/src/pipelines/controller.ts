// `createPipelineController`: the PipelineController port (D4, D21, D24).
// Commands append to `cd-pipeline-<name>`; queries read one catch-up
// projection over pipeline, availability, source and promotion facts. `tick`
// is safe to repeat: every request carries an idempotency key, and keys the
// journal already holds are not requested again.
import { clone, create, type JsonValue } from "@bufbuild/protobuf";
import {
	AutoPromotion,
	DepartureAction,
	type FanoutRecord,
	FanoutRecordSchema,
	FanoutState,
	type FanoutStatusRecord,
	FanoutStrategy,
	type FreightAvailabilityRecord,
	FreightAvailabilityRecordSchema,
	type FreightRecord,
	type PipelineNodeRecord,
	type PipelineRecord,
	PipelineRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	RolloutStrategy,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../events.js";
import { fanoutIdFor } from "../fanout/controller.js";
import { parseHalted, parseStarted, parseStatusFact } from "../fanout/facts.js";
import type {
	AutoPromotionHold,
	CampId,
	CdAuthorizer,
	CdBase,
	CdContext,
	ChangeWindows,
	FanoutController,
	FreightId,
	FreightLedger,
	Outcome,
	PipelineController,
	PlacementEngine,
	PlacementSubject,
	PromoteByOriginRequest,
	PromoteRequest,
	PromotionService,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";
import {
	appendOnce,
	body,
	decode,
	digestOf,
	emitCounter,
	isJsonObject,
	isJsonString,
	iso,
	jsonOf,
	principalName,
} from "../windows/journal.js";
import { CatchUpProjection } from "../windows/projection.js";
import { refuse } from "../windows/reasons.js";
import { autoPromotionFreightId } from "./auto-promotion.js";
import {
	type FreightFacts,
	freightAvailability,
	type NodeAvailability,
	type PlacedView,
} from "./availability.js";
import {
	isPlaced,
	isPreview,
	normalizePipeline,
	subjectOf,
	topologicalOrder,
	validatePipeline,
} from "./graph.js";
import { ORIGIN_SOURCES, PIPELINE_METRIC, PIPELINE_REASON } from "./reasons.js";

/** Station and data subject a placed node's Placement decides for (composed by WP18). */
export type PlacementContextResolver = (
	input: Readonly<{ pipeline: PipelineRecord; node: PipelineNodeRecord }>,
) => Promise<
	Readonly<{ stationId: string; subject: PlacementSubject }> | undefined
>;

export type PipelineControllerDeps = CdBase & {
	readonly freight: FreightLedger;
	readonly promotions: PromotionService;
	readonly placement: PlacementEngine;
	readonly fanout: FanoutController;
	readonly topology: TopologyReader;
	readonly authorizer: CdAuthorizer;
	/**
	 * Optional: windows read at request time, so a freeze that begins during a
	 * tick blocks the requests after it. Without it the promotion gate (which
	 * always evaluates windows, D10) is the only check.
	 */
	readonly windows?: ChangeWindows | undefined;
	/** Optional: metrics. Telemetry is advisory; the journal is the record. */
	readonly telemetry?: TelemetrySink | undefined;
	/** Required to start fan-outs; without it placed nodes never auto-promote (fail closed). */
	readonly placementContext?: PlacementContextResolver | undefined;
};

// public-contract: the idempotency key of an auto-promotion request.
export function pipelineKey(
	pipeline: string,
	node: string,
	freightId: string,
): string {
	return `pipeline:${pipeline}:${node}:${freightId}`;
}

function legacyFailoverKey(key: string): boolean {
	return /^failover:[^:]+:(?:promote|purge)$/.test(key);
}

const TERMINAL = new Set<PromotionState>([
	PromotionState.PROMOTED,
	PromotionState.ROLLED_BACK,
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.SUPERSEDED,
]);

const FANOUT_SETTLED = new Set<FanoutState>([
	FanoutState.HALTED,
	FanoutState.COMPLETED,
	FanoutState.ROLLED_BACK,
	FanoutState.SUPERSEDED,
]);

const PIPELINE_STREAM = /^cd-pipeline-(.+)$/;
const SOURCE_STREAM = /^cd-source-(.+)$/;

/** Digest of what a pipeline says, independent of who applied it. */
function pipelineDigest(record: PipelineRecord): string {
	const copy = clone(PipelineRecordSchema, record);
	copy.definedBy = "";
	return digestOf(body(PipelineRecordSchema, copy));
}

/** An idempotency key carried by a promotion body owned by WP6, read structurally. */
function idempotencyKeyIn(data: JsonValue | undefined): string | undefined {
	if (!isJsonObject(data)) return undefined;
	const direct = data.idempotencyKey ?? data.idempotency_key;
	if (isJsonString(direct)) return direct;
	for (const value of Object.values(data)) {
		const nested = idempotencyKeyIn(isJsonObject(value) ? value : undefined);
		if (nested) return nested;
	}
	return undefined;
}

function msOf(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(a: FreightRecord, b: FreightRecord): number {
	const byTime = msOf(b.recordedAt) - msOf(a.recordedAt);
	if (byTime !== 0) return byTime;
	return a.freightId < b.freightId ? 1 : a.freightId > b.freightId ? -1 : 0;
}

/** The node's fan-out with every unset field at its CD_DEFAULTS value. */
export function fanoutWithDefaults(node: PipelineNodeRecord): FanoutRecord {
	const declared = node.fanout;
	const out = create(FanoutRecordSchema, declared ?? {});
	if (out.strategy === FanoutStrategy.UNSPECIFIED)
		out.strategy = FanoutStrategy.PROGRESSIVE_PER_GROUP;
	if (out.minSuccessMs === 0n)
		out.minSuccessMs = BigInt(CD_DEFAULTS.fanoutMinSuccessMs);
	if (out.progressDeadlineMs === 0n)
		out.progressDeadlineMs = BigInt(CD_DEFAULTS.fanoutProgressDeadlineMs);
	if (out.maxFailures === 0 && out.maxFailuresPercent === 0)
		out.maxFailuresPercent = CD_DEFAULTS.fanoutMaxFailuresPercent;
	// proto3 cannot tell an unset bool from false; the safe default (D21) applies.
	out.rollbackOnHalt = out.rollbackOnHalt || CD_DEFAULTS.fanoutRollbackOnHalt;
	return out;
}

type Candidate = Readonly<{
	freight: FreightRecord;
	availability: NodeAvailability;
}>;

export function createPipelineController(
	deps: PipelineControllerDeps,
): PipelineController {
	const pipelines = new Map<string, PipelineRecord>();
	const unreadable = new Set<string>();
	const recordedAvailability = new Set<string>();
	const sources = new Set<string>();
	const requestedKeys = new Map<string, "automatic" | "manual" | undefined>();
	/** Freight id → Camp id → latest env.Promoted time. */
	const promotedAt = new Map<string, Map<string, number>>();
	/** `${pipeline}|${node}` → Freight of the latest env.Promoted. */
	const currentByNode = new Map<string, string>();
	const holdByNode = new Map<string, AutoPromotionHold>();
	type ManualPromotion = {
		freightId: string;
		heldAtMs: number;
		fanoutId?: string;
		pending: Map<string, Set<string>>;
	};
	const manualPromoteByNode = new Map<string, ManualPromotion>();
	const fanoutModeById = new Map<string, "automatic" | "manual">();
	type QueuedFanout = {
		freightId: string;
		heldAtMs: number;
		fanoutId: string;
	};
	const queuedFanouts = new Map<string, QueuedFanout[]>();

	function enqueueFanout(
		nodeKey: string,
		freightId: string,
		heldAtMs: number,
		fanoutId: string,
	): void {
		if (
			fanoutId === "" ||
			manualPromoteByNode.get(nodeKey)?.fanoutId === fanoutId
		)
			return;
		const queued = queuedFanouts.get(nodeKey) ?? [];
		if (queued.some((item) => item.fanoutId === fanoutId)) return;
		queued.push({ freightId, heldAtMs, fanoutId });
		queuedFanouts.set(nodeKey, queued);
	}

	function dropQueuedFanout(nodeKey: string, fanoutId: string): void {
		const queued = queuedFanouts.get(nodeKey);
		if (!queued) return;
		const rest = queued.filter((item) => item.fanoutId !== fanoutId);
		if (rest.length === 0) queuedFanouts.delete(nodeKey);
		else queuedFanouts.set(nodeKey, rest);
	}

	function installQueuedFanout(nodeKey: string): void {
		const queued = queuedFanouts.get(nodeKey);
		const next = queued?.shift();
		if (!queued || next === undefined) return;
		if (queued.length === 0) queuedFanouts.delete(nodeKey);
		manualPromoteByNode.set(nodeKey, {
			freightId: next.freightId,
			heldAtMs: next.heldAtMs,
			fanoutId: next.fanoutId,
			pending: new Map(),
		});
	}

	function rememberFanoutMode(
		fanoutId: string,
		mode: "automatic" | "manual" | undefined,
	): void {
		if (fanoutId === "" || mode === undefined) return;
		fanoutModeById.set(fanoutId, mode);
	}

	function endManualPin(nodeKey: string): void {
		manualPromoteByNode.delete(nodeKey);
		holdByNode.delete(nodeKey);
		installQueuedFanout(nodeKey);
	}

	function clearManualFanout(
		status: FanoutStatusRecord | undefined,
		state: FanoutState | undefined = status?.state,
	): void {
		if (
			!status ||
			state === undefined ||
			!FANOUT_SETTLED.has(state) ||
			status.fanoutId === "" ||
			status.pipeline === "" ||
			status.node === ""
		)
			return;
		const nodeKey = `${status.pipeline}|${status.node}`;
		dropQueuedFanout(nodeKey, status.fanoutId);
		if (manualPromoteByNode.get(nodeKey)?.fanoutId !== status.fanoutId) return;
		endManualPin(nodeKey);
	}

	function forgetManualPromotion(record: PromotionRecord): void {
		if (
			record.promotionId === "" ||
			record.pipeline === "" ||
			record.node === ""
		)
			return;
		const nodeKey = `${record.pipeline}|${record.node}`;
		const manual = manualPromoteByNode.get(nodeKey);
		if (!manual || manual.fanoutId) return;
		if (!manual.pending.delete(record.promotionId)) return;
		if (manual.pending.size === 0) endManualPin(nodeKey);
	}

	function releasePromotedCamps(
		nodeKey: string,
		freightId: string,
		campIds: readonly string[],
	): void {
		const manual = manualPromoteByNode.get(nodeKey);
		if (!manual || manual.fanoutId || manual.freightId !== freightId) return;
		for (const remaining of manual.pending.values()) {
			for (const campId of campIds) remaining.delete(campId);
		}
		for (const [promotionId, remaining] of manual.pending) {
			if (remaining.size === 0) manual.pending.delete(promotionId);
		}
		if (manual.pending.size === 0) endManualPin(nodeKey);
	}

	const metric = (
		name: string,
		atMs: number,
		attributes: Readonly<Record<string, string>>,
	) =>
		emitCounter(deps.telemetry, {
			name,
			atMs,
			attributes: { tenant: deps.tenant, ...attributes },
		});

	const projection = new CatchUpProjection(deps.store, deps.tenant, {
		[CD_EVENTS.PipelineApplied]: (event) => {
			const name = PIPELINE_STREAM.exec(event.streamId)?.[1] ?? event.streamId;
			const record = decode(PipelineRecordSchema, event.data);
			if (record && record.name === name) {
				pipelines.set(name, record);
				unreadable.delete(name);
				return;
			}
			pipelines.delete(name);
			unreadable.add(name);
			metric(PIPELINE_METRIC.unreadable, deps.now(), { pipeline: name });
		},
		[CD_EVENTS.PipelineFreightAvailable]: (event) => {
			const record = decode(FreightAvailabilityRecordSchema, event.data);
			if (record)
				recordedAvailability.add(
					`${record.pipeline}|${record.node}|${record.freightId}`,
				);
		},
		[CD_EVENTS.SourceDefined]: (event) => {
			const name = SOURCE_STREAM.exec(event.streamId)?.[1];
			if (name) sources.add(name);
		},
		[CD_EVENTS.FanoutStarted]: (event) => {
			const started = parseStarted(event.data);
			if (!started?.pipeline || !started.node || !started.freightId) return;
			const mode = event.meta?.promotionRequestMode;
			const legacyAutomatic =
				mode === undefined &&
				started.idempotencyKey ===
					pipelineKey(started.pipeline, started.node, started.freightId);
			if (mode === "automatic" || legacyAutomatic) {
				rememberFanoutMode(started.fanoutId, "automatic");
				return;
			}
			if (mode === "manual") rememberFanoutMode(started.fanoutId, "manual");
			const nodeKey = `${started.pipeline}|${started.node}`;
			const prior = manualPromoteByNode.get(nodeKey);
			if (prior?.fanoutId === started.fanoutId) return;
			if (prior) {
				enqueueFanout(
					nodeKey,
					started.freightId,
					msOf(event.ts),
					started.fanoutId,
				);
				return;
			}
			if (
				queuedFanouts
					.get(nodeKey)
					?.some((item) => item.fanoutId === started.fanoutId)
			)
				return;
			manualPromoteByNode.set(nodeKey, {
				freightId: started.freightId,
				heldAtMs: msOf(event.ts),
				fanoutId: started.fanoutId,
				pending: new Map(),
			});
		},
		[CD_EVENTS.FanoutHalted]: (event) => {
			clearManualFanout(parseHalted(event.data)?.status, FanoutState.HALTED);
		},
		[CD_EVENTS.FanoutCompleted]: (event) => {
			clearManualFanout(parseStatusFact(event.data).status);
		},
		[CD_EVENTS.FanoutRolledBack]: (event) => {
			clearManualFanout(
				parseStatusFact(event.data).status,
				FanoutState.ROLLED_BACK,
			);
		},
		[CD_EVENTS.EnvPromoteRequested]: (event) => {
			const key = idempotencyKeyIn(jsonOf(event.data));
			const storedMode = event.meta?.promotionRequestMode;
			if (key)
				requestedKeys.set(
					key,
					storedMode === "automatic" || storedMode === "manual"
						? storedMode
						: undefined,
				);
			const record = decode(PromotionRecordSchema, event.data);
			if (!record || record.pipeline === "" || record.node === "") return;
			if (record.freightId === "" || record.promotionId === "") return;
			const nodeKey = `${record.pipeline}|${record.node}`;
			const current = manualPromoteByNode.get(nodeKey);
			const mode = event.meta?.promotionRequestMode;
			const autoKey = pipelineKey(
				record.pipeline,
				record.node,
				record.freightId,
			);
			const legacyAuto =
				mode === undefined &&
				(record.idempotencyKey === autoKey ||
					record.idempotencyKey.startsWith(`${autoKey}:approval:`) ||
					record.idempotencyKey.startsWith(`${autoKey}:match:`) ||
					(record.fanoutId !== "" && current?.fanoutId !== record.fanoutId) ||
					legacyFailoverKey(record.idempotencyKey));
			if (mode === "automatic" || legacyAuto) return;
			if (record.fanoutId !== "" && current) return;
			if (
				!current ||
				current.freightId !== record.freightId ||
				current.fanoutId !== (record.fanoutId || undefined)
			) {
				holdByNode.delete(nodeKey);
				const manual: ManualPromotion = {
					freightId: record.freightId,
					heldAtMs: msOf(event.ts),
					pending: new Map(),
				};
				if (record.fanoutId) manual.fanoutId = record.fanoutId;
				manualPromoteByNode.set(nodeKey, manual);
			}
			manualPromoteByNode
				.get(nodeKey)
				?.pending.set(record.promotionId, new Set(record.targetCampIds));
		},
		[CD_EVENTS.EnvPromoted]: (event) => {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record || record.freightId === "") return;
			const at = msOf(event.ts);
			const byCamp =
				promotedAt.get(record.freightId) ?? new Map<string, number>();
			for (const campId of record.targetCampIds)
				byCamp.set(campId, Math.max(byCamp.get(campId) ?? 0, at));
			promotedAt.set(record.freightId, byCamp);
			if (record.pipeline !== "" && record.node !== "") {
				const nodeKey = `${record.pipeline}|${record.node}`;
				currentByNode.set(nodeKey, record.freightId);
				releasePromotedCamps(nodeKey, record.freightId, record.targetCampIds);
			}
		},
		[CD_EVENTS.EnvPromoteRejected]: (event) => {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record) return;
			forgetManualPromotion(record);
		},
		[CD_EVENTS.EnvPromoteSuperseded]: (event) => {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record) return;
			forgetManualPromotion(record);
		},
		[CD_EVENTS.EnvPromoteRolledBack]: (event) => {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record) return;
			forgetManualPromotion(record);
		},
	});

	async function placedViews(
		pipeline: PipelineRecord,
	): Promise<Map<string, PlacedView>> {
		const out = new Map<string, PlacedView>();
		for (const node of pipeline.nodes) {
			if (!isPlaced(node)) continue;
			const qualified = await deps.fanout.qualified({
				pipeline: pipeline.name,
				node: node.name,
			});
			const decision = qualified.decision;
			if (!decision) continue;
			const declared = new Set(node.fanout?.mandatoryGroups ?? []);
			const campIds =
				decision.groups.length > 0
					? decision.groups.flatMap((group) => group.campIds)
					: decision.candidates.filter((c) => c.selected).map((c) => c.campId);
			const mandatoryCampIds = decision.groups
				.filter((group) => group.mandatory || declared.has(group.name))
				.flatMap((group) => group.campIds);
			out.set(node.name, {
				campIds: [...new Set(campIds)].sort(),
				mandatoryCampIds: [...new Set(mandatoryCampIds)].sort(),
			});
		}
		return out;
	}

	async function freightFacts(
		pipeline: PipelineRecord,
	): Promise<FreightFacts[]> {
		const all = await deps.freight.list({ bindle: pipeline.bindle });
		const subject = subjectOf(pipeline.subject);
		const out: FreightFacts[] = [];
		for (const freight of [...all].sort(newestFirst)) {
			if (
				freight.manifest?.bindle !== pipeline.bindle ||
				subjectOf(freight.manifest.subject) !== subject
			)
				continue;
			// SAFETY: ids in FreightRecord are recorded `sha256:` Freight ids (FreightLedger).
			const id = freight.freightId as FreightId;
			const promoted = new Map(promotedAt.get(freight.freightId) ?? []);
			out.push({
				freight,
				usable: await deps.freight.isUsable(id),
				qualifications: await deps.freight.qualifications(id),
				approvals: await deps.freight.approvals(id),
				promotedAt: promoted,
			});
		}
		return out;
	}

	function candidates(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		facts: readonly FreightFacts[],
		placed: ReadonlyMap<string, PlacedView>,
		nowMs: number,
	): Candidate[] {
		const nodes = new Map(pipeline.nodes.map((n) => [n.name, n]));
		const out: Candidate[] = [];
		for (const fact of facts) {
			const availability = freightAvailability({
				pipeline,
				nodes,
				node,
				nowMs,
				facts: fact,
				placed,
			});
			if (availability) out.push({ freight: fact.freight, availability });
		}
		return out;
	}

	function availabilityRecord(
		pipeline: string,
		node: string,
		candidate: Candidate,
	): FreightAvailabilityRecord {
		return create(FreightAvailabilityRecordSchema, {
			pipeline,
			node,
			freightId: candidate.freight.freightId,
			via: [...candidate.availability.via],
			availableAt: iso(candidate.availability.availableAtMs),
		});
	}

	async function windowsOpen(
		node: PipelineNodeRecord,
		targets: readonly string[],
		ctx: CdContext,
	): Promise<boolean> {
		if (!deps.windows) return true;
		for (const target of targets) {
			// SAFETY: targets are Camp ids from the applied pipeline or a placement decision.
			const campId = target as CampId;
			const topology = await deps.topology.camp(campId);
			const evaluation = await deps.windows.evaluate({
				campId,
				labels: topology?.labels ?? {},
				envType: topology?.envType ?? "",
				windowNames: node.windows,
				atMs: ctx.now(),
				intent: "promote",
			});
			if (!evaluation.open) return false;
		}
		return true;
	}

	async function request(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		freightId: string,
		targets: readonly string[],
		key: string,
		ctx: CdContext,
		requestMode: "automatic" | "manual" = "automatic",
	): Promise<Outcome<void>> {
		const wasRequested = requestedKeys.has(key);
		if (wasRequested) {
			const priorMode = requestedKeys.get(key);
			if (requestMode === "manual" && priorMode === undefined)
				return refuse(
					PIPELINE_REASON.conflict,
					`promotion key ${key} predates recorded request modes`,
					"Use a new idempotency key for the manual promotion.",
					key,
				);
			if (priorMode !== undefined && priorMode !== requestMode)
				return refuse(
					PIPELINE_REASON.conflict,
					`promotion key ${key} already uses a different request mode`,
					"Use a new idempotency key for the manual promotion.",
					key,
				);
			if (requestMode === "automatic") return { ok: true, value: undefined };
		}
		if (targets.length === 0)
			return refuse(
				PIPELINE_REASON.targets,
				`pipeline ${pipeline.name}/${node.name} has no promotion targets`,
				"Configure at least one target Camp before requesting a promotion.",
				node.name,
			);
		const attributes = { pipeline: pipeline.name, node: node.name };
		if (!wasRequested && !(await windowsOpen(node, targets, ctx))) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: "window-closed",
			});
			return refuse(
				PIPELINE_REASON.promotionBlocked,
				`the change window for ${pipeline.name}/${node.name} is closed`,
				"Wait for the window to open or obtain a valid override.",
				node.name,
			);
		}
		const promote: PromoteRequest = {
			// SAFETY: freightId comes from a FreightRecord the ledger returned.
			freightId: freightId as FreightId,
			// SAFETY: targets are Camp ids from the applied pipeline or a placement decision.
			targets: targets.map((target) => target as CampId),
			idempotencyKey: key,
			requestMode,
			pipeline: pipeline.name,
			node: node.name,
			intent: "promote",
		};
		const withStrategy: PromoteRequest =
			node.strategy === RolloutStrategy.UNSPECIFIED
				? promote
				: { ...promote, strategy: node.strategy };
		const result = await deps.promotions.promote(withStrategy, ctx);
		if (result.ok) {
			requestedKeys.set(key, requestMode);
			metric(PIPELINE_METRIC.promotionRequested, ctx.now(), attributes);
			return { ok: true, value: undefined };
		}
		metric(PIPELINE_METRIC.promotionRefused, ctx.now(), {
			...attributes,
			code: result.reasons[0]?.code ?? "",
		});
		return result;
	}

	async function startFanout(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		freightId: string,
		ctx: CdContext,
		requestMode: "automatic" | "manual" = "automatic",
		idempotencyKey = pipelineKey(pipeline.name, node.name, freightId),
	): Promise<Outcome<void>> {
		const attributes = { pipeline: pipeline.name, node: node.name };
		const minted = fanoutIdFor(
			deps.tenant,
			pipeline.name,
			node.name,
			idempotencyKey,
		);
		const existing = await deps.fanout.list({
			pipeline: pipeline.name,
			node: node.name,
		});
		const prior = existing.find((status) => status.freightId === freightId);
		if (prior) {
			const priorMode = fanoutModeById.get(prior.fanoutId);
			if (
				prior.fanoutId === minted &&
				prior.state === FanoutState.RUNNING &&
				(priorMode === undefined || priorMode === requestMode)
			)
				return { ok: true, value: undefined };
			if (
				prior.state === FanoutState.HALTED ||
				prior.state === FanoutState.ROLLED_BACK ||
				prior.state === FanoutState.SUPERSEDED ||
				(requestMode === "manual" && prior.state === FanoutState.RUNNING)
			)
				return refuse(
					PIPELINE_REASON.promotionBlocked,
					`fan-out for ${pipeline.name}/${node.name} cannot proceed`,
					"Resolve the fan-out state before requesting this Freight again.",
					prior.fanoutId,
				);
			return { ok: true, value: undefined };
		}
		const context = await deps.placementContext?.({ pipeline, node });
		if (!context) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: "placement-context-missing",
			});
			return refuse(
				PIPELINE_REASON.promotionBlocked,
				`placement context for ${pipeline.name}/${node.name} is unavailable`,
				"Configure placement context before requesting the fan-out.",
				node.name,
			);
		}
		const decision = await deps.placement.decide(
			{
				placement: node.placement,
				pipeline: pipeline.name,
				node: node.name,
				stationId: context.stationId,
				subject: context.subject,
			},
			ctx,
		);
		if (!decision.ok) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: decision.reasons[0]?.code ?? "placement-refused",
			});
			return decision;
		}
		const started = await deps.fanout.start(
			{
				pipeline: pipeline.name,
				node: node.name,
				// SAFETY: freightId comes from a FreightRecord the ledger returned.
				freightId: freightId as FreightId,
				decision: decision.value,
				fanout: fanoutWithDefaults(node),
				departure:
					node.departure === DepartureAction.UNSPECIFIED
						? DepartureAction.ORPHAN_DATA
						: node.departure,
				idempotencyKey,
				requestMode,
			},
			ctx,
		);
		if (started.ok) {
			rememberFanoutMode(minted, requestMode);
			rememberFanoutMode(started.value.fanoutId, requestMode);
			metric(PIPELINE_METRIC.fanoutStarted, ctx.now(), attributes);
			return { ok: true, value: undefined };
		}
		metric(PIPELINE_METRIC.blocked, ctx.now(), {
			...attributes,
			reason: started.reasons[0]?.code ?? "fanout-refused",
		});
		return started;
	}

	async function promoteCandidate(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		candidate: Candidate,
		ctx: CdContext,
	): Promise<void> {
		const freightId = candidate.freight.freightId;
		const key = pipelineKey(pipeline.name, node.name, freightId);
		if (candidate.availability.lineage) {
			if (isPlaced(node)) await startFanout(pipeline, node, freightId, ctx);
			else await request(pipeline, node, freightId, node.campIds, key, ctx);
			return;
		}
		// Approval only: the bypass covers each approved Camp, one request per Camp.
		for (const campId of candidate.availability.approvedCampIds)
			await request(
				pipeline,
				node,
				freightId,
				[campId],
				`${key}:approval:${campId}`,
				ctx,
			);
	}

	async function matchNode(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		facts: readonly FreightFacts[],
		ctx: CdContext,
	): Promise<void> {
		const attributes = { pipeline: pipeline.name, node: node.name };
		let stable: string | undefined;
		let domain: readonly string[];
		let settled: ReadonlySet<string>;
		if (isPlaced(node)) {
			const qualified = await deps.fanout.qualified({
				pipeline: pipeline.name,
				node: node.name,
			});
			stable = qualified.stableFreightId;
			const decision = qualified.decision;
			domain = decision
				? decision.groups.length > 0
					? decision.groups.flatMap((group) => group.campIds)
					: decision.candidates.filter((c) => c.selected).map((c) => c.campId)
				: [];
			settled = new Set<string>(qualified.qualifiedCampIds);
		} else {
			const newest = facts.find(
				(fact) =>
					fact.usable &&
					fact.qualifications.some(
						(q) => q.pipeline === pipeline.name && q.node === node.name,
					),
			);
			stable = newest?.freight.freightId;
			domain = node.campIds;
			settled = new Set(
				newest?.qualifications
					.filter((q) => q.pipeline === pipeline.name && q.node === node.name)
					.map((q) => q.campId) ?? [],
			);
		}
		if (!stable) return;
		// SAFETY: stable is a Freight id the ledger or fan-out controller recorded.
		if (!(await deps.freight.isUsable(stable as FreightId))) return;
		const fanouts = isPlaced(node)
			? await deps.fanout.list({ pipeline: pipeline.name, node: node.name })
			: [];
		if (fanouts.some((status) => status.state === FanoutState.HALTED)) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: "fanout-halted",
			});
			return;
		}
		const running = fanouts.filter(
			(status) => status.state === FanoutState.RUNNING,
		);
		// Never converge late entrants onto Freight that is still rolling out.
		if (running.some((status) => status.freightId === stable)) return;
		const busy = new Set(
			running.flatMap((status) => [...status.pending, ...status.inFlight]),
		);
		for (const campId of [...new Set(domain)].sort()) {
			if (settled.has(campId) || busy.has(campId)) continue;
			// SAFETY: campId comes from the applied pipeline or a recorded placement decision.
			const history = await deps.promotions.list({ campId: campId as CampId });
			if (history.some((promotion) => !TERMINAL.has(promotion.state))) continue;
			if (
				history.some(
					(promotion) =>
						promotion.freightId === stable &&
						promotion.state !== PromotionState.SUPERSEDED,
				)
			)
				continue;
			await request(
				pipeline,
				node,
				stable,
				[campId],
				`${pipelineKey(pipeline.name, node.name, stable)}:match:${campId}`,
				ctx,
			);
		}
	}

	async function stableFreightForMatchNode(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		facts: readonly FreightFacts[],
	): Promise<string | undefined> {
		if (node.autoPromotion !== AutoPromotion.MATCH_NODE) return undefined;
		if (!isPlaced(node))
			return facts.find(
				(fact) =>
					fact.usable &&
					fact.qualifications.some(
						(qualification) =>
							qualification.pipeline === pipeline.name &&
							qualification.node === node.name,
					),
			)?.freight.freightId;
		return (
			await deps.fanout.qualified({
				pipeline: pipeline.name,
				node: node.name,
			})
		).stableFreightId;
	}

	async function refreshAutoPromotionHolds(ctx: CdContext): Promise<void> {
		for (const [nodeKey, manual] of manualPromoteByNode) {
			const split = nodeKey.indexOf("|");
			if (split <= 0) continue;
			const pipelineName = nodeKey.slice(0, split);
			const nodeName = nodeKey.slice(split + 1);
			const pipeline = pipelines.get(pipelineName);
			const node = pipeline?.nodes.find((n) => n.name === nodeName);
			if (!pipeline || !node) continue;
			if (
				node.autoPromotion === AutoPromotion.DISABLED ||
				node.autoPromotion === AutoPromotion.UNSPECIFIED
			)
				continue;
			const facts = await freightFacts(pipeline);
			const placed = await placedViews(pipeline);
			const list = candidates(pipeline, node, facts, placed, ctx.now());
			const stable = await stableFreightForMatchNode(pipeline, node, facts);
			const autoId = autoPromotionFreightId(
				pipeline,
				node,
				list,
				currentByNode,
				stable,
			);
			if (autoId === undefined || manual.freightId === autoId) continue;
			if (holdByNode.has(nodeKey)) continue;
			const hold: AutoPromotionHold = Object.freeze({
				pipeline: pipeline.name,
				node: node.name,
				freightId: manual.freightId,
				heldAtMs: manual.heldAtMs,
			});
			holdByNode.set(nodeKey, hold);
			metric(PIPELINE_METRIC.autoPromotionHeld, ctx.now(), {
				pipeline: pipeline.name,
				node: node.name,
				freightId: manual.freightId,
			});
		}
	}

	function freightMatchesOrigin(
		freight: FreightRecord,
		origin: string,
	): boolean {
		const mapped = ORIGIN_SOURCES.get(origin);
		if (mapped !== undefined) return freight.origin === mapped;
		return freight.sourceName === origin;
	}

	async function recordAvailable(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		list: readonly Candidate[],
		ctx: CdContext,
	): Promise<void> {
		for (const candidate of list) {
			const marker = `${pipeline.name}|${node.name}|${candidate.freight.freightId}`;
			if (recordedAvailability.has(marker)) continue;
			const event = await appendOnce({
				store: deps.store,
				streamId: CD_STREAMS.pipeline(pipeline.name),
				type: CD_EVENTS.PipelineFreightAvailable,
				data: body(
					FreightAvailabilityRecordSchema,
					availabilityRecord(pipeline.name, node.name, candidate),
				),
				idempotencyKey: `available:${node.name}:${candidate.freight.freightId}`,
				tenant: deps.tenant,
				actor: ctx.principal,
			});
			if (event) {
				recordedAvailability.add(marker);
				metric(PIPELINE_METRIC.freightAvailable, ctx.now(), {
					pipeline: pipeline.name,
					node: node.name,
					via: candidate.availability.via.join(","),
				});
			}
		}
	}

	return {
		async apply(record, ctx) {
			const atMs = ctx.now();
			const refused = (outcome: Extract<Outcome<never>, { ok: false }>) => {
				metric(PIPELINE_METRIC.refused, atMs, {
					pipeline: record.name,
					code: outcome.reasons[0]?.code ?? "",
				});
				return outcome;
			};
			await projection.catchUp();
			const camps = new Map(
				(await deps.topology.camps()).map((camp) => [
					String(camp.campId),
					camp,
				]),
			);
			const placements = new Map();
			for (const node of record.nodes) {
				if (!isPlaced(node)) continue;
				const placement = await deps.placement.get(node.placement);
				if (placement) placements.set(node.placement, placement);
			}
			const subject = subjectOf(record.subject);
			const owner = [...pipelines.values()].find(
				(p) =>
					p.bindle === record.bindle &&
					subjectOf(p.subject) === subject &&
					p.name !== record.name,
			);
			const problems = validatePipeline(record, {
				camps,
				sources,
				placements,
				bindleOwner: owner?.name,
			});
			if (problems.length > 0) return refused({ ok: false, reasons: problems });

			const decision = await deps.authorizer.authorize(
				"pipeline.apply",
				{ pipeline: record.name, bindle: record.bindle },
				ctx,
			);
			if (!decision.ok)
				return refused({
					ok: false,
					reasons: [
						...refuse(
							PIPELINE_REASON.unauthorized,
							"pipeline.apply was not authorized",
							"Ask a principal holding pipeline.apply, or adjust the delivery policy pack.",
							record.name,
						).reasons,
						...decision.reasons,
					],
				});
			if (decision.value.proposalOnly)
				return refused(
					refuse(
						PIPELINE_REASON.proposalOnly,
						`${principalName(ctx.principal)} may only propose pipeline.apply`,
						"A granted principal must apply the proposal (ADR-0094).",
						record.name,
					),
				);

			const normalized = normalizePipeline(
				record,
				principalName(ctx.principal),
			);
			const digest = pipelineDigest(normalized);
			const current = pipelines.get(record.name);
			if (current && pipelineDigest(current) === digest)
				return { ok: true, value: current };
			const event = await appendOnce({
				store: deps.store,
				streamId: CD_STREAMS.pipeline(record.name),
				type: CD_EVENTS.PipelineApplied,
				data: body(PipelineRecordSchema, normalized),
				idempotencyKey: `applied:${digest}`,
				tenant: deps.tenant,
				actor: ctx.principal,
			});
			if (!event)
				return refused(
					refuse(
						PIPELINE_REASON.conflict,
						`could not append to ${CD_STREAMS.pipeline(record.name)} (concurrent writer or store unavailable)`,
						"Retry the command; it is idempotent.",
						record.name,
					),
				);
			await projection.catchUp();
			metric(PIPELINE_METRIC.applied, atMs, { pipeline: record.name });
			return { ok: true, value: pipelines.get(record.name) ?? normalized };
		},

		async get(name) {
			await projection.catchUp();
			return pipelines.get(name);
		},

		async list() {
			await projection.catchUp();
			return [...pipelines.values()].sort((a, b) =>
				a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
			);
		},

		async available(input) {
			await projection.catchUp();
			const pipeline = pipelines.get(input.pipeline);
			const node = pipeline?.nodes.find((n) => n.name === input.node);
			if (!pipeline || !node) return [];
			const facts = await freightFacts(pipeline);
			const placed = await placedViews(pipeline);
			return candidates(pipeline, node, facts, placed, deps.now()).map(
				(candidate) => availabilityRecord(pipeline.name, node.name, candidate),
			);
		},

		async autoPromotionHolds() {
			await projection.catchUp();
			return [...holdByNode.values()].sort((a, b) => {
				const byPipe =
					a.pipeline < b.pipeline ? -1 : a.pipeline > b.pipeline ? 1 : 0;
				if (byPipe !== 0) return byPipe;
				return a.node < b.node ? -1 : a.node > b.node ? 1 : 0;
			});
		},

		async promoteByOrigin(input: PromoteByOriginRequest, ctx) {
			await projection.catchUp();
			await refreshAutoPromotionHolds(ctx);
			const pipeline = pipelines.get(input.pipeline);
			const node = pipeline?.nodes.find((n) => n.name === input.node);
			if (!pipeline || !node)
				return {
					ok: false,
					reasons: refuse(
						PIPELINE_REASON.unknownUpstream,
						`pipeline ${input.pipeline} has no node ${input.node}`,
						"Apply the pipeline first, or name an existing node.",
						input.pipeline,
					).reasons,
				};
			const facts = await freightFacts(pipeline);
			const placed = await placedViews(pipeline);
			const list = candidates(pipeline, node, facts, placed, ctx.now());
			const match = list.find((candidate) =>
				freightMatchesOrigin(candidate.freight, input.origin),
			);
			if (!match)
				return {
					ok: false,
					reasons: refuse(
						PIPELINE_REASON.originFreightUnavailable,
						`no Freight available to ${input.pipeline}/${input.node} via ${input.origin}`,
						"Wait for ingest from that source, or use origin: manifest and related pseudo-sources for pushed Freight.",
						input.origin,
					).reasons,
				};
			const freightId = match.freight.freightId;
			const key =
				input.idempotencyKey ||
				`origin:${pipeline.name}:${node.name}:${freightId}`;
			if (match.availability.lineage) {
				const result = isPlaced(node)
					? await startFanout(pipeline, node, freightId, ctx, "manual", key)
					: await request(
							pipeline,
							node,
							freightId,
							node.campIds,
							key,
							ctx,
							"manual",
						);
				if (!result.ok) return result;
			} else {
				if (match.availability.approvedCampIds.length === 0)
					return refuse(
						PIPELINE_REASON.originFreightUnavailable,
						`no approved Camps can receive ${freightId}`,
						"Wait for a qualifying approval or choose another Freight.",
						freightId,
					);
				for (const campId of match.availability.approvedCampIds) {
					const result = await request(
						pipeline,
						node,
						freightId,
						[campId],
						`${key}:approval:${campId}`,
						ctx,
						"manual",
					);
					if (!result.ok) return result;
				}
			}
			return { ok: true, value: { freightId } };
		},

		async tick(ctx) {
			await projection.catchUp();
			await refreshAutoPromotionHolds(ctx);
			for (const name of [...pipelines.keys()].sort()) {
				const pipeline = pipelines.get(name);
				const order = pipeline ? topologicalOrder(pipeline) : undefined;
				if (!pipeline || !order) continue;
				const facts = await freightFacts(pipeline);
				const placed = await placedViews(pipeline);
				for (const nodeName of order) {
					const node = pipeline.nodes.find((n) => n.name === nodeName);
					if (!node) continue;
					const list = candidates(pipeline, node, facts, placed, ctx.now());
					await recordAvailable(pipeline, node, list, ctx);
					if (isPreview(node)) continue;
					if (holdByNode.has(`${pipeline.name}|${node.name}`)) continue;
					switch (node.autoPromotion) {
						case AutoPromotion.NEWEST: {
							const newest = list[0];
							if (newest) await promoteCandidate(pipeline, node, newest, ctx);
							break;
						}
						case AutoPromotion.MATCH_UPSTREAM: {
							const upstream = node.fromNodes[0];
							const current = upstream
								? currentByNode.get(`${pipeline.name}|${upstream}`)
								: undefined;
							const match = list.find(
								(candidate) =>
									candidate.freight.freightId === current &&
									candidate.availability.lineage,
							);
							if (match) await promoteCandidate(pipeline, node, match, ctx);
							break;
						}
						case AutoPromotion.MATCH_NODE:
							await matchNode(pipeline, node, facts, ctx);
							break;
						default:
							break;
					}
				}
			}
		},
	};
}
