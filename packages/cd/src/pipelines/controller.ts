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
	FanoutStrategy,
	type FreightAvailabilityRecord,
	FreightAvailabilityRecordSchema,
	type FreightRecord,
	type PipelineNodeRecord,
	type PipelineRecord,
	PipelineRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	RolloutStrategy,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS } from "../events.js";
import type {
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
import { PIPELINE_METRIC, PIPELINE_REASON } from "./reasons.js";

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

const TERMINAL = new Set<PromotionState>([
	PromotionState.PROMOTED,
	PromotionState.ROLLED_BACK,
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.SUPERSEDED,
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
	const requestedKeys = new Set<string>();
	/** `${freight}|${camp}` → latest env.Promoted time. */
	const promotedAt = new Map<string, number>();
	/** `${pipeline}|${node}` → Freight of the latest env.Promoted. */
	const currentByNode = new Map<string, string>();

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
		[CD_EVENTS.EnvPromoteRequested]: (event) => {
			const key = idempotencyKeyIn(jsonOf(event.data));
			if (key) requestedKeys.add(key);
		},
		[CD_EVENTS.EnvPromoted]: (event) => {
			const record = decode(PromotionRecordSchema, event.data);
			if (!record || record.freightId === "") return;
			const at = msOf(event.ts);
			for (const campId of record.targetCampIds) {
				const key = `${record.freightId}|${campId}`;
				promotedAt.set(key, Math.max(promotedAt.get(key) ?? 0, at));
			}
			if (record.pipeline !== "" && record.node !== "")
				currentByNode.set(
					`${record.pipeline}|${record.node}`,
					record.freightId,
				);
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
			const promoted = new Map<string, number>();
			for (const [key, at] of promotedAt) {
				const [freightId, campId] = key.split("|");
				if (freightId === freight.freightId && campId !== undefined)
					promoted.set(campId, at);
			}
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
	): Promise<void> {
		if (requestedKeys.has(key) || targets.length === 0) return;
		const attributes = { pipeline: pipeline.name, node: node.name };
		if (!(await windowsOpen(node, targets, ctx))) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: "window-closed",
			});
			return;
		}
		const promote: PromoteRequest = {
			// SAFETY: freightId comes from a FreightRecord the ledger returned.
			freightId: freightId as FreightId,
			// SAFETY: targets are Camp ids from the applied pipeline or a placement decision.
			targets: targets.map((target) => target as CampId),
			idempotencyKey: key,
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
			requestedKeys.add(key);
			metric(PIPELINE_METRIC.promotionRequested, ctx.now(), attributes);
		} else {
			metric(PIPELINE_METRIC.promotionRefused, ctx.now(), {
				...attributes,
				code: result.reasons[0]?.code ?? "",
			});
		}
	}

	async function startFanout(
		pipeline: PipelineRecord,
		node: PipelineNodeRecord,
		freightId: string,
		ctx: CdContext,
	): Promise<void> {
		const attributes = { pipeline: pipeline.name, node: node.name };
		const existing = await deps.fanout.list({
			pipeline: pipeline.name,
			node: node.name,
		});
		if (existing.some((status) => status.freightId === freightId)) return;
		const context = await deps.placementContext?.({ pipeline, node });
		if (!context) {
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: "placement-context-missing",
			});
			return;
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
			return;
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
				idempotencyKey: pipelineKey(pipeline.name, node.name, freightId),
			},
			ctx,
		);
		if (started.ok)
			metric(PIPELINE_METRIC.fanoutStarted, ctx.now(), attributes);
		else
			metric(PIPELINE_METRIC.blocked, ctx.now(), {
				...attributes,
				reason: started.reasons[0]?.code ?? "fanout-refused",
			});
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

		async tick(ctx) {
			await projection.catchUp();
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
