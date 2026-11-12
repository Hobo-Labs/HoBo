// FailoverController (WP23; C19, D23, I21). A NO_RUN taint the node does not
// tolerate becomes `failover.Proposed` per Camp × placed node. Each failover
// is a `defineSaga` over `cd-failover-<id>` under lease `cd:failover:<id>`:
//   PROPOSED → REPLACING → VERIFYING → SHIFTING → PURGING → COMPLETED
// or REFUSED (never started) / ABANDONED (started, source kept).
// It never runs without Rail `automatic` or an approval, never beyond the
// Rail's per-Station `max_concurrent`, never moves data (`failover-unsafe`),
// re-checks residency on the replacement, purges GRACEFUL only after the
// replacement qualified, and never fails back. `rebalance` records moves and
// runs them as GRACEFUL moves under the node's fan-out limit.
import { create, type JsonObject, type JsonValue } from "@bufbuild/protobuf";
import {
	type ActorLeaseHost,
	evaluateResidency,
	parseRoutingPlan,
	type RoutingPlan,
} from "@hobo/core";
import { defineSaga } from "@hobo/events";
import {
	type FailoverRecord,
	FailoverRecordSchema,
	FailoverState,
	type PipelineNodeRecord,
	PromotionState,
	PurgeMode,
	type RebalanceRecord,
	RebalanceRecordSchema,
	RebalanceMoveRecordSchema,
	type ReasonRecord,
	TaintEffect,
} from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_EVENTS, CD_STREAMS, CD_SUBSCRIPTIONS } from "../events.js";
import { dataResourcesOf } from "../fanout/data.js";
import { type FailoverFact, failoverBody, parseFailoverFact } from "../fanout/facts.js";
import {
	appendAt,
	counter,
	decode,
	emit,
	encode,
	isConflict,
	iso,
	jsonObject,
	leaseRunner,
	principalName,
	readStream,
	reason,
	refuse,
	sha256Hex,
	streamsWith,
} from "../fanout/journal.js";
import { parseFanoutPlan } from "../fanout/policy.js";
import type {
	CampId,
	CdAction,
	CdContext,
	CdFactories,
	FailoverController,
	FailoverId,
	FreightId,
	Outcome,
	PlacementSubject,
	PromotionId,
} from "../ports.js";
import {
	FAILOVER_REASON,
	failoverUnsafe,
	nodeFailover,
	noRunDue,
	railFailover,
	unreachableData,
} from "./policy.js";

export const FAILOVER_SAGA = "cd.failover" as const;

export const FAILOVER_METRIC = Object.freeze({
	proposed: "hobo.cd.failover.proposed",
	started: "hobo.cd.failover.started",
	transitions: "hobo.cd.failover.transitions",
	completed: "hobo.cd.failover.completed",
	refused: "hobo.cd.failover.refused",
	abandoned: "hobo.cd.failover.abandoned",
	active: "hobo.cd.failover.active",
	rebalances: "hobo.cd.rebalance.requested",
	stepError: "hobo.cd.failover.step_errors",
} as const);

export type PlacementContext = Readonly<{ stationId: string; subject: PlacementSubject }>;

export type FailoverControllerDeps = Parameters<CdFactories["createFailoverController"]>[0] & {
	/**
	 * The Station and residency subject a node places under (the same context
	 * the pipeline controller uses). Without it no replacement is chosen:
	 * failovers are refused `placement-context-missing` (fail closed).
	 */
	readonly placementContext?: (
		input: Readonly<{ pipeline: string; node: PipelineNodeRecord }>,
	) => Promise<PlacementContext | undefined>;
	/**
	 * Junction reachability from the replacement to the Bindle's data Camps.
	 * When present, `false` refuses the failover `failover-unsafe`.
	 */
	readonly junctions?: (
		input: Readonly<{ pipeline: string; node: string; fromCampId: string; toCampId: string }>,
	) => Promise<boolean>;
	/** Residency region catalog override (tests, private regions). */
	readonly regionCatalog?: Parameters<typeof evaluateResidency>[0]["catalog"];
	readonly holderId?: string;
	readonly leaseTtlMs?: number;
};

const NO_DISPATCH: ActorLeaseHost = {
	acquire() {
		throw new Error("the failover saga records its own facts and dispatches no aggregate commands");
	},
};

const TERMINAL: ReadonlySet<FailoverState> = new Set([
	FailoverState.COMPLETED,
	FailoverState.REFUSED,
	FailoverState.ABANDONED,
]);

const ACTIVE: ReadonlySet<FailoverState> = new Set([
	FailoverState.REPLACING,
	FailoverState.VERIFYING,
	FailoverState.SHIFTING,
	FailoverState.PURGING,
]);

const FAILED_PROMOTION: ReadonlySet<PromotionState> = new Set([
	PromotionState.REJECTED,
	PromotionState.FAILED,
	PromotionState.ROLLED_BACK,
	PromotionState.SUPERSEDED,
]);

type View = { fact: FailoverFact; seq: number };

export function failoverIdFor(tenant: string, campId: string, pipeline: string, node: string, key: string): FailoverId {
	// SAFETY: a FailoverId is minted only here, from a deterministic digest.
	return `failover-${sha256Hex(tenant, campId, pipeline, node, key).slice(0, 32)}` as FailoverId;
}

function rebalanceStream(rebalanceId: string): string {
	return CD_STREAMS.failover(`rebalance-${rebalanceId}`);
}

function asCamp(id: string): CampId {
	// SAFETY: Camp ids in failover records come from inventory or a placement decision.
	return id as CampId;
}

function members(decision: Readonly<{ groups: readonly Readonly<{ campIds: readonly string[] }>[]; candidates: readonly Readonly<{ campId: string; selected: boolean }>[] }>): string[] {
	const grouped = decision.groups.flatMap((group) => group.campIds);
	return grouped.length > 0 ? grouped : decision.candidates.filter((c) => c.selected).map((c) => c.campId);
}

export function createFailoverController(d: FailoverControllerDeps): FailoverController {
	const holderId = d.holderId ?? `failover-${process.pid}-${sha256Hex(String(d.now())).slice(0, 8)}`;
	const withLease = leaseRunner(d.store, d.tenant, holderId, d.leaseTtlMs ?? CD_DEFAULTS.leaseTtlMs);
	const metric = (name: string, atMs: number, attributes: Readonly<Record<string, string>>, value = 1) =>
		emit(d.telemetry, [counter(name, atMs, { tenant: d.tenant, ...attributes }, value)]);

	async function authorize(action: CdAction, subject: JsonObject, ctx: CdContext): Promise<readonly ReasonRecord[] | undefined> {
		const decision = await d.authorizer.authorize(action, subject, ctx);
		if (!decision.ok) return decision.reasons;
		if (decision.value.proposalOnly)
			return [
				reason(FAILOVER_REASON.proposalOnly, `${action} by ${principalName(ctx.principal)} is proposal-only`, "have an operator or a granted service principal run the command", action),
			];
		return undefined;
	}

	async function load(failoverId: string): Promise<View | undefined> {
		let view: View | undefined;
		for (const event of await readStream(d.store, CD_STREAMS.failover(failoverId))) {
			const fact = parseFailoverFact(event.data);
			if (fact !== undefined) view = { fact, seq: event.seq };
			else if (view !== undefined) view.seq = event.seq;
		}
		return view;
	}

	async function all(): Promise<View[]> {
		const out: View[] = [];
		for (const streamId of await streamsWith(d.store, CD_EVENTS.FailoverProposed, d.tenant)) {
			const id = streamId.slice(CD_STREAMS.failover("").length);
			const view = await load(id);
			if (view !== undefined) out.push(view);
		}
		return out;
	}

	async function write(view: View, type: string, next: Partial<Omit<FailoverFact, "failover">> & { failover?: Partial<FailoverRecord> }, ctx: CdContext): Promise<void> {
		const atMs = ctx.now();
		const failover = create(FailoverRecordSchema, { ...view.fact.failover, ...next.failover, updatedAt: iso(atMs) });
		const fact: FailoverFact = { ...view.fact, ...next, failover, atMs };
		await appendAt({
			store: d.store,
			streamId: CD_STREAMS.failover(failover.failoverId),
			expectedSeq: view.seq,
			events: [{ type, data: failoverBody(fact) }],
			actor: ctx.principal,
			tenant: d.tenant,
		});
		view.fact = fact;
		view.seq += 1;
		metric(FAILOVER_METRIC.transitions, atMs, { pipeline: failover.pipeline, node: failover.node, state: FailoverState[failover.state] ?? "" });
	}

	async function terminal(view: View, state: FailoverState, reasons: readonly ReasonRecord[], ctx: CdContext): Promise<void> {
		const type =
			state === FailoverState.COMPLETED
				? CD_EVENTS.FailoverCompleted
				: state === FailoverState.REFUSED
					? CD_EVENTS.FailoverRefused
					: CD_EVENTS.FailoverProgressed;
		await write(view, type, { failover: { state, reasons: [...view.fact.failover.reasons, ...reasons] } }, ctx);
		const name = state === FailoverState.COMPLETED ? FAILOVER_METRIC.completed : state === FailoverState.REFUSED ? FAILOVER_METRIC.refused : FAILOVER_METRIC.abandoned;
		metric(name, ctx.now(), { pipeline: view.fact.failover.pipeline, node: view.fact.failover.node, reason: reasons[0]?.code ?? "" });
	}

	async function nodeOf(pipeline: string, node: string): Promise<PipelineNodeRecord | undefined> {
		return (await d.pipelines.get(pipeline))?.nodes.find((n) => n.name === node);
	}

	/** Placed nodes whose effective decision includes the Camp. */
	async function placedNodesOf(campId: string): Promise<{ pipeline: string; node: PipelineNodeRecord }[]> {
		const out: { pipeline: string; node: PipelineNodeRecord }[] = [];
		for (const pipeline of await d.pipelines.list()) {
			for (const node of pipeline.nodes) {
				if (node.placement === "") continue;
				const qualified = await d.fanout.qualified({ pipeline: pipeline.name, node: node.name });
				if (qualified.decision !== undefined && members(qualified.decision).includes(campId)) out.push({ pipeline: pipeline.name, node });
			}
		}
		return out;
	}

	async function railFor(campId: string) {
		const topology = await d.topology.camp(asCamp(campId));
		const rail = (await d.rails.forCamp(asCamp(campId))) ?? (topology === undefined ? undefined : await d.rails.forStation(topology.stationId));
		return { rail: railFailover(rail), stationId: topology?.stationId ?? "" };
	}

	async function record(
		input: Readonly<{ campId: string; pipeline: string; node: PipelineNodeRecord; key: string; taint: string; reasonText: string; rebalanceId?: string; toCampId?: string; decisionId?: string; limit?: number }>,
		ctx: CdContext,
	): Promise<FailoverRecord> {
		const failoverId = failoverIdFor(d.tenant, input.campId, input.pipeline, input.node.name, input.key);
		const existing = await load(failoverId);
		if (existing !== undefined) return existing.fact.failover;
		const policy = nodeFailover(input.node.failover);
		const { stationId } = await railFor(input.campId);
		const atMs = ctx.now();
		const failover = create(FailoverRecordSchema, {
			failoverId,
			pipeline: input.pipeline,
			node: input.node.name,
			fromCampId: input.campId,
			toCampId: input.toCampId ?? "",
			state: FailoverState.PROPOSED,
			// Rebalance moves are always GRACEFUL (D23).
			purge: input.rebalanceId !== undefined ? PurgeMode.GRACEFUL : policy.purge,
			triggerTaint: input.taint,
			decisionId: input.decisionId ?? "",
			reasons: [reason(input.rebalanceId !== undefined ? "rebalance" : "failover-proposed", input.reasonText, "approve the failover, or let a Rail with automatic failover run it", input.campId)],
			updatedAt: iso(atMs),
		});
		const fact: FailoverFact = {
			failover,
			stationId,
			rebalanceId: input.rebalanceId ?? "",
			approved: input.rebalanceId !== undefined,
			approvedBy: input.rebalanceId !== undefined ? principalName(ctx.principal) : "",
			decisionId: input.decisionId ?? "",
			routingPlanId: "",
			purged: false,
			limit: input.limit ?? 0,
			startedAtMs: 0,
			atMs,
		};
		try {
			await d.store.append(CD_STREAMS.failover(failoverId), [{ type: CD_EVENTS.FailoverProposed, data: failoverBody(fact), meta: { idempotencyKey: input.key } }], { expectedSeq: 0, actor: ctx.principal, tenant: d.tenant });
		} catch (error) {
			if (!isConflict(error)) throw error;
			const raced = await load(failoverId);
			if (raced !== undefined) return raced.fact.failover;
			throw error;
		}
		metric(FAILOVER_METRIC.proposed, atMs, { pipeline: input.pipeline, node: input.node.name, trigger: input.rebalanceId !== undefined ? "rebalance" : "taint" });
		return failover;
	}

	async function plannedReplacement(view: View, node: PipelineNodeRecord, ctx: CdContext): Promise<Outcome<{ toCampId: string; decisionId: string }>> {
		const f = view.fact.failover;
		if (f.toCampId !== "") return { ok: true, value: { toCampId: f.toCampId, decisionId: view.fact.decisionId } };
		const context = await d.placementContext?.({ pipeline: f.pipeline, node });
		if (context === undefined)
			return refuse(reason(FAILOVER_REASON.placementContextMissing, `no placement context for ${f.pipeline}/${f.node}`, "compose the failover controller with the pipeline's placement context", f.failoverId));
		const current = await d.fanout.qualified({ pipeline: f.pipeline, node: f.node });
		const exclude = [...new Set([f.fromCampId, ...(current.decision ? members(current.decision) : [])])].sort().map(asCamp);
		const decided = await d.placement.decide({ placement: node.placement, pipeline: f.pipeline, node: f.node, stationId: context.stationId, subject: context.subject, exclude, count: 1 }, ctx);
		if (!decided.ok) return decided;
		const chosen = members(decided.value).find((campId) => !exclude.includes(asCamp(campId)));
		if (chosen === undefined)
			return refuse(reason(FAILOVER_REASON.noReplacement, `placement ${node.placement} has no eligible replacement for Camp ${f.fromCampId}`, "bind more Camp sets to the Rail or relax spread; the source stays in place", f.fromCampId));
		const residency = await residencyHolds(chosen, context.subject);
		if (residency !== undefined) return refuse(...residency);
		return { ok: true, value: { toCampId: chosen, decisionId: decided.value.decisionId } };
	}

	/** Defense in depth: the replacement's declared regions satisfy every residency constraint (I21). */
	async function residencyHolds(campId: string, subject: PlacementSubject): Promise<readonly ReasonRecord[] | undefined> {
		if (subject.residency.length === 0) return undefined;
		const topology = await d.topology.camp(asCamp(campId));
		const regions = topology?.regions ?? [];
		if (regions.length === 0)
			return [reason(FAILOVER_REASON.residency, `replacement Camp ${campId} declares no region`, "declare the Camp's Yard regions", campId)];
		for (const constraint of subject.residency)
			for (const region of regions) {
				const result = evaluateResidency({ constraint, region, ...(d.regionCatalog === undefined ? {} : { catalog: d.regionCatalog }) });
				if (!result.ok) return [reason(FAILOVER_REASON.residency, `replacement Camp ${campId} region ${region} fails residency (${result.code})`, result.remediation, campId)];
			}
		return undefined;
	}

	async function handover(view: View, node: PipelineNodeRecord): Promise<Outcome<Record<string, string>>> {
		const declared = nodeFailover(node.failover).handoverOutputs;
		if (declared.length === 0) return { ok: true, value: {} };
		const observed = (await d.desired.status(asCamp(view.fact.failover.fromCampId)))?.handover ?? {};
		const missing = declared.filter((name) => observed[name] === undefined);
		if (missing.length > 0)
			return refuse(reason(FAILOVER_REASON.handoverMissing, `the source's last observation lacks handover outputs ${missing.join(", ")}`, "have the source's reconciler report the declared handover outputs, or remove them from the node", view.fact.failover.fromCampId));
		return { ok: true, value: Object.fromEntries(declared.map((name) => [name, observed[name] ?? ""])) };
	}

	async function dataIn(campId: string): Promise<string[]> {
		const current = await d.desired.current(asCamp(campId));
		const resolved = current === undefined ? undefined : await d.desired.resolved(current);
		return dataResourcesOf(resolved, await d.desired.status(asCamp(campId)));
	}

	/** PROPOSED → REPLACING, or REFUSED. Caller holds the Station admission lease. */
	async function admit(view: View, node: PipelineNodeRecord, ctx: CdContext): Promise<void> {
		const f = view.fact.failover;
		const unsafe = failoverUnsafe({ fromCampId: f.fromCampId, dataResources: await dataIn(f.fromCampId) });
		if (unsafe !== undefined) return terminal(view, FailoverState.REFUSED, unsafe, ctx);
		const qualified = await d.fanout.qualified({ pipeline: f.pipeline, node: f.node });
		const freightId = qualified.stableFreightId;
		if (freightId === undefined)
			return terminal(view, FailoverState.REFUSED, [reason(FAILOVER_REASON.noQualifiedFreight, `${f.pipeline}/${f.node} has no qualified Freight`, "complete a fan-out on the node first", f.failoverId)], ctx);
		const outputs = await handover(view, node);
		if (!outputs.ok) return terminal(view, FailoverState.REFUSED, outputs.reasons, ctx);
		const replacement = await plannedReplacement(view, node, ctx);
		if (!replacement.ok) return terminal(view, FailoverState.REFUSED, replacement.reasons, ctx);
		const { toCampId, decisionId } = replacement.value;
		if (d.junctions !== undefined && !(await d.junctions({ pipeline: f.pipeline, node: f.node, fromCampId: f.fromCampId, toCampId })))
			return terminal(view, FailoverState.REFUSED, unreachableData(f.fromCampId, toCampId), ctx);
		const promoted = await d.promotions.promote(
			{ freightId, targets: [asCamp(toCampId)], idempotencyKey: `failover:${f.failoverId}:promote`, pipeline: f.pipeline, node: f.node, sourceCampId: asCamp(f.fromCampId), intent: "failover" },
			ctx,
		);
		if (!promoted.ok) return terminal(view, FailoverState.REFUSED, promoted.reasons.length > 0 ? promoted.reasons : [reason(FAILOVER_REASON.promotionRefused, "the replacement promotion was refused", "inspect the gate decision", toCampId)], ctx);
		const atMs = ctx.now();
		await write(
			view,
			CD_EVENTS.FailoverStarted,
			{ decisionId, startedAtMs: atMs, failover: { state: FailoverState.REPLACING, toCampId, freightId, decisionId, promotionId: promoted.value.promotionId, handover: outputs.value } },
			ctx,
		);
		metric(FAILOVER_METRIC.started, atMs, { pipeline: f.pipeline, node: f.node, purge: PurgeMode[f.purge] ?? "" });
		if (f.purge === PurgeMode.IMMEDIATE) {
			const { rail } = await railFor(f.fromCampId);
			if (rail.allowImmediatePurge) await purge(view, ctx);
			else
				await write(view, CD_EVENTS.FailoverProgressed, { failover: { purge: PurgeMode.GRACEFUL, reasons: [...view.fact.failover.reasons, reason(FAILOVER_REASON.immediatePurgeNotPermitted, "the Rail does not allow immediate purge; purging GRACEFUL", "set delivery.failover.allow_immediate_purge on the Rail to purge immediately", f.failoverId)] } }, ctx);
		}
	}

	async function purge(view: View, ctx: CdContext): Promise<boolean> {
		const f = view.fact.failover;
		if (view.fact.purged || f.purge === PurgeMode.NEVER) return true;
		const result = await d.promotions.promote(
			{
				// SAFETY: the Freight id was recorded from the node's qualified Freight.
				freightId: f.freightId as FreightId,
				targets: [asCamp(f.fromCampId)],
				idempotencyKey: `failover:${f.failoverId}:purge`,
				pipeline: f.pipeline,
				node: f.node,
				intent: "depart",
			},
			ctx,
		);
		if (!result.ok) {
			await write(view, CD_EVENTS.FailoverProgressed, { failover: { reasons: [...f.reasons, ...result.reasons, reason(FAILOVER_REASON.purgeRefused, `purging Camp ${f.fromCampId} was refused`, "the source stays in place; purge it with an approved depart", f.fromCampId)] } }, ctx);
			return false;
		}
		await write(view, CD_EVENTS.FailoverProgressed, { purged: true }, ctx);
		return true;
	}

	function cutoverPlan(view: View, service: string): RoutingPlan {
		const f = view.fact.failover;
		const backend = { id: f.toCampId, service };
		const json: JsonValue = {
			planId: `failover-${f.failoverId}`,
			intent: { service, tenantId: d.tenant, rules: [{ backends: [backend], weightStrategy: "static" }] },
			backends: [backend],
			...(view.fact.stationId === "" ? {} : { stationId: view.fact.stationId }),
			createdAt: iso(view.fact.startedAtMs),
			notes: [`failover from ${f.fromCampId} to ${f.toCampId}`],
		};
		return parseRoutingPlan(json);
	}

	async function graceExpired(view: View, node: PipelineNodeRecord, ctx: CdContext): Promise<boolean> {
		if (ctx.now() <= view.fact.startedAtMs + nodeFailover(node.failover).graceMs) return false;
		await terminal(view, FailoverState.ABANDONED, [reason(FAILOVER_REASON.graceExpired, `the replacement did not take over within the grace period; both Camps are kept`, "escalate: inspect the replacement's promotion and verification; the source was not purged", view.fact.failover.failoverId)], ctx);
		return true;
	}

	/** Advance an admitted failover one or more phases. Caller holds `cd:failover:<id>`. */
	async function progress(view: View, node: PipelineNodeRecord, ctx: CdContext): Promise<void> {
		const f = view.fact.failover;
		const promotion = f.promotionId === "" ? undefined : await d.promotions.get(f.promotionId as PromotionId);
		if (f.state === FailoverState.REPLACING || f.state === FailoverState.VERIFYING) {
			if (promotion !== undefined && FAILED_PROMOTION.has(promotion.state)) {
				await terminal(view, FailoverState.ABANDONED, [reason(FAILOVER_REASON.replacementFailed, `the replacement promotion ended ${PromotionState[promotion.state] ?? "?"}; the source is kept`, "inspect the replacement Camp; propose again or rebalance later", f.toCampId)], ctx);
				return;
			}
			if (f.state === FailoverState.REPLACING && promotion !== undefined && promotion.state >= PromotionState.ROLLING_OUT)
				await write(view, CD_EVENTS.FailoverProgressed, { failover: { state: FailoverState.VERIFYING } }, ctx);
			if (promotion?.state !== PromotionState.PROMOTED) {
				await graceExpired(view, node, ctx);
				return;
			}
			// PROMOTED means verification PASS and the Freight qualified here.
			if (view.fact.failover.state === FailoverState.REPLACING)
				await write(view, CD_EVENTS.FailoverProgressed, { failover: { state: FailoverState.VERIFYING } }, ctx);
			await write(view, CD_EVENTS.FailoverProgressed, { failover: { state: FailoverState.SHIFTING } }, ctx);
		}
		if (view.fact.failover.state === FailoverState.SHIFTING) {
			const service = (await d.pipelines.get(f.pipeline))?.bindle ?? f.pipeline;
			const plan = cutoverPlan(view, service);
			const controller = new AbortController();
			if (view.fact.routingPlanId === "") {
				const applied = await d.traffic.shift({ campId: asCamp(view.fact.failover.toCampId), plan, signal: controller.signal }, ctx);
				await write(view, CD_EVENTS.FailoverProgressed, { routingPlanId: applied.planId }, ctx);
			}
			const status = await d.traffic.status(asCamp(view.fact.failover.toCampId), plan.planId);
			if (status === null || !status.active || status.realized !== "full") {
				// Not yet realized: hold in SHIFTING; past the grace, keep both and escalate.
				await graceExpired(view, node, ctx);
				return;
			}
			await write(view, CD_EVENTS.FailoverProgressed, { failover: { state: FailoverState.PURGING } }, ctx);
		}
		if (view.fact.failover.state === FailoverState.PURGING) {
			if (!(await purge(view, ctx))) return;
			await terminal(view, FailoverState.COMPLETED, [], ctx);
		}
	}

	async function admissionBudget(view: View, everyone: readonly View[]): Promise<boolean> {
		const f = view.fact;
		if (f.rebalanceId !== "") {
			const active = everyone.filter((o) => o.fact.rebalanceId === f.rebalanceId && ACTIVE.has(o.fact.failover.state)).length;
			return active < Math.max(1, f.limit);
		}
		const { rail } = await railFor(f.failover.fromCampId);
		const active = everyone.filter((o) => o.fact.rebalanceId === "" && o.fact.stationId === f.stationId && ACTIVE.has(o.fact.failover.state)).length;
		return active < rail.maxConcurrent;
	}

	async function advance(failoverId: string, ctx: CdContext): Promise<void> {
		const view = await load(failoverId);
		if (view === undefined || TERMINAL.has(view.fact.failover.state)) return;
		const f = view.fact.failover;
		const node = await nodeOf(f.pipeline, f.node);
		if (node === undefined) return;
		const trigger = (await readStream(d.store, CD_STREAMS.failover(failoverId)))[0];
		if (trigger === undefined) return;
		const saga = defineSaga({
			name: FAILOVER_SAGA,
			trigger: CD_EVENTS.FailoverProposed,
			step: async () => {
				if (view.fact.failover.state === FailoverState.PROPOSED) {
					const { rail } = await railFor(f.fromCampId);
					if (!view.fact.approved && !rail.automatic) return;
					// Admission is serialized per Station so `max_concurrent` holds across replicas.
					const scope = view.fact.rebalanceId !== "" ? `rebalance-${view.fact.rebalanceId}` : `station-${view.fact.stationId}`;
					const admitted = await withLease(CD_SUBSCRIPTIONS.failover(scope), async () => {
						const everyone = await all();
						if (!(await admissionBudget(view, everyone))) return false;
						const fresh = await load(failoverId);
						if (fresh === undefined || fresh.fact.failover.state !== FailoverState.PROPOSED) return false;
						view.fact = fresh.fact;
						view.seq = fresh.seq;
						await admit(view, node, ctx);
						return true;
					});
					if (!admitted.held || !admitted.value) return;
				}
				if (ACTIVE.has(view.fact.failover.state)) await progress(view, node, ctx);
			},
			compensate: async (_event, _sagaCtx, cause) => {
				// Nothing to unwind: every step is recorded before its effect and
				// the source is never touched before the replacement qualified.
				throw cause;
			},
		});
		await saga.run(trigger, { store: d.store, actorHost: NO_DISPATCH });
	}

	async function drive(failoverId: string, ctx: CdContext): Promise<void> {
		await withLease(CD_SUBSCRIPTIONS.failover(failoverId), async () => {
			try {
				await advance(failoverId, ctx);
			} catch (error) {
				if (isConflict(error)) return;
				metric(FAILOVER_METRIC.stepError, ctx.now(), { failover: failoverId });
			}
		});
	}

	const controller: FailoverController = {
		async propose(input, ctx) {
			const denied = await authorize("failover.propose", { campId: input.campId }, ctx);
			if (denied !== undefined) return refuse(...denied);
			const status = await d.inventory.status(input.campId);
			const taint = status?.taints.find((t) => t.effect === TaintEffect.NO_RUN);
			if (taint === undefined)
				return refuse(reason(FAILOVER_REASON.notTainted, `Camp ${input.campId} carries no NO_RUN taint`, "taint the Camp NO_RUN (operator or Rail-permitted rule), or use rebalance to move work deliberately", input.campId));
			const nodes = await placedNodesOf(input.campId);
			const out: FailoverRecord[] = [];
			for (const { pipeline, node } of nodes)
				out.push(await record({ campId: input.campId, pipeline, node, key: input.idempotencyKey, taint: taint.key, reasonText: input.reason }, ctx));
			return { ok: true, value: out };
		},

		async approve(failoverId, ctx) {
			const denied = await authorize("failover.approve", { failoverId }, ctx);
			if (denied !== undefined) return refuse(...denied);
			const held = await withLease(CD_SUBSCRIPTIONS.failover(failoverId), async (): Promise<Outcome<FailoverRecord>> => {
				const view = await load(failoverId);
				if (view === undefined) return refuse(reason(FAILOVER_REASON.notFound, `failover ${failoverId} does not exist`, "list failovers", failoverId));
				if (view.fact.failover.state !== FailoverState.PROPOSED)
					return refuse(reason(FAILOVER_REASON.wrongState, `failover ${failoverId} is ${FailoverState[view.fact.failover.state] ?? "?"}`, "only a PROPOSED failover can be approved", failoverId));
				if (!view.fact.approved) await write(view, CD_EVENTS.FailoverProgressed, { approved: true, approvedBy: principalName(ctx.principal) }, ctx);
				return { ok: true, value: view.fact.failover };
			});
			if (!held.held) return refuse(reason(FAILOVER_REASON.wrongState, `failover ${failoverId} is being advanced`, "retry", failoverId));
			return held.value;
		},

		async get(failoverId) {
			return (await load(failoverId))?.fact.failover;
		},

		async list(query) {
			const views = (await all())
				.map((v) => v.fact.failover)
				.filter((f) => (query?.campId === undefined || f.fromCampId === query.campId || f.toCampId === query.campId) && (query?.state === undefined || f.state === query.state));
			return query?.limit === undefined ? views : views.slice(0, query.limit);
		},

		async rebalance(input, ctx) {
			const denied = await authorize("rebalance", { pipeline: input.pipeline, node: input.node }, ctx);
			if (denied !== undefined) return refuse(...denied);
			const node = await nodeOf(input.pipeline, input.node);
			if (node === undefined || node.placement === "")
				return refuse(reason(FAILOVER_REASON.rebalanceNoPlacement, `${input.pipeline}/${input.node} is not a placed node`, "rebalance applies to nodes with a placement", input.node));
			const rebalanceId = sha256Hex(d.tenant, input.pipeline, input.node, input.idempotencyKey).slice(0, 32);
			for (const event of await readStream(d.store, rebalanceStream(rebalanceId))) {
				const existing = decode(RebalanceRecordSchema, jsonObject(event.data).rebalance as JsonValue);
				if (existing !== undefined) return { ok: true, value: existing };
			}
			const context = await d.placementContext?.({ pipeline: input.pipeline, node });
			if (context === undefined)
				return refuse(reason(FAILOVER_REASON.placementContextMissing, `no placement context for ${input.pipeline}/${input.node}`, "compose the controller with the pipeline's placement context", input.node));
			const decided = await d.placement.decide({ placement: node.placement, pipeline: input.pipeline, node: input.node, stationId: context.stationId, subject: context.subject }, ctx);
			if (!decided.ok) return decided;
			const current = await d.fanout.qualified({ pipeline: input.pipeline, node: input.node });
			const before = new Set(current.decision ? members(current.decision) : []);
			const after = new Set(members(decided.value));
			const leaving = [...before].filter((c) => !after.has(c)).sort();
			const entering = [...after].filter((c) => !before.has(c)).sort();
			const moves = leaving.slice(0, entering.length).map((from, i) => create(RebalanceMoveRecordSchema, { fromCampId: from, toCampId: entering[i] ?? "" }));
			const atMs = ctx.now();
			const rebalance: RebalanceRecord = create(RebalanceRecordSchema, {
				rebalanceId,
				pipeline: input.pipeline,
				node: input.node,
				decisionId: decided.value.decisionId,
				moves,
				reason: input.reason,
				requestedBy: principalName(ctx.principal),
				requestedAt: iso(atMs),
			});
			const decision = current.decision;
			const limit =
				node.fanout !== undefined && decision !== undefined
					? (() => {
							const parsed = parseFanoutPlan({ pipeline: input.pipeline, node: input.node, decision, fanout: node.fanout });
							return parsed.ok ? parsed.value.maxConcurrency : 1;
						})()
					: 1;
			await d.store.append(rebalanceStream(rebalanceId), [{ type: CD_EVENTS.RebalanceRequested, data: { rebalance: encode(RebalanceRecordSchema, rebalance), limit }, meta: { idempotencyKey: input.idempotencyKey } }], { expectedSeq: 0, actor: ctx.principal, tenant: d.tenant });
			for (const move of moves)
				await record({ campId: move.fromCampId, pipeline: input.pipeline, node, key: `rebalance:${rebalanceId}`, taint: "", reasonText: input.reason, rebalanceId, toCampId: move.toCampId, decisionId: decided.value.decisionId, limit }, ctx);
			metric(FAILOVER_METRIC.rebalances, atMs, { pipeline: input.pipeline, node: input.node }, 1);
			return { ok: true, value: rebalance };
		},

		async tick(ctx) {
			const nowMs = ctx.now();
			// 1. Propose for NO_RUN taints the node does not tolerate (D23 trigger).
			for (const view of await d.inventory.list()) {
				for (const taint of view.status.taints) {
					if (taint.effect !== TaintEffect.NO_RUN) continue;
					for (const { pipeline, node } of await placedNodesOf(view.topology.campId)) {
						const placement = await d.placement.get(node.placement);
						if (!noRunDue(taint, placement?.tolerations ?? [], nowMs)) continue;
						const denied = await authorize("failover.propose", { campId: view.topology.campId, taint: taint.key }, ctx);
						if (denied !== undefined) continue;
						await record({ campId: view.topology.campId, pipeline, node, key: `taint:${taint.key}:${taint.addedAt}`, taint: taint.key, reasonText: `NO_RUN taint ${taint.key} outlived its toleration` }, ctx);
					}
				}
			}
			// 2. Advance every open failover, oldest first.
			let active = 0;
			for (const view of await all()) {
				if (TERMINAL.has(view.fact.failover.state)) continue;
				await drive(view.fact.failover.failoverId, ctx);
				const after = await load(view.fact.failover.failoverId);
				if (after !== undefined && ACTIVE.has(after.fact.failover.state)) active += 1;
			}
			emit(d.telemetry, [{ name: FAILOVER_METRIC.active, kind: "gauge", value: active, unit: "{failover}", atMs: ctx.now(), attributes: { tenant: d.tenant } }]);
		},
	};
	return controller;
}
