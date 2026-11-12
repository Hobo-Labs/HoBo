// The promotion saga (WP6; C9, D2, D11, D12, I7, I13, I16). One saga per
// promotion on `cd-promotion-<id>`, defined with `@hobo/events` `defineSaga`:
// the forward path advances every target Camp as far as the journal and the
// ports allow; the compensation path runs ON_FAILURE hooks and rolls the
// environment group back (D12). Every step is a recorded fact, so `tick`
// resumes any promotion from its journal after a crash.
import { create } from "@bufbuild/protobuf";
import {
	createResolvedDeploymentSet,
	DEPLOYMENT_PLAN_SCHEMA,
	type ResolvedDeploymentSet,
} from "@hobo/cloud";
import type { ActorLeaseHost, EventEnvelope, EventPosition } from "@hobo/core";
import { defineSaga } from "@hobo/events";
import {
	type DeltaRecord,
	DeltaRecordSchema,
	type FreightRecord,
	FreightSubject,
	HookPoint,
	type PipelineNodeRecord,
	PolicyMode,
	type PreviewEnvironmentRecord,
	PreviewEnvironmentRecordSchema,
	type PromotionRecord,
	PromotionRecordSchema,
	PromotionState,
	type ReasonRecord,
	RolloutStrategy,
	SetOrigin,
	type SetRecord,
	VerificationSpecRecordSchema,
	type VerificationSpecRecord,
	VerificationVerdict,
} from "../_generated/cd_pb.js";
import {
	diffResolvedSets,
	deltaIdFor,
	sealResolved,
} from "../adapters/planning.js";
import { approvalSubject } from "../adapters/approval.js";
import { createHookRunner, type HookRunner } from "../adapters/hooks.js";
import type { TrailsMigrations } from "../adapters/trails.js";
import type { FanoutAggregateGate } from "../adapters/gatekeeper.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_RAMP_DEFAULTS,
	CD_STREAMS,
	DELTA_SCHEMA,
	PROMOTION_SCHEMA,
} from "../events.js";
import type {
	ApprovalStatus,
	CampId,
	CdContext,
	DeltaId,
	RolloutId,
	VerificationId,
	CdFactories,
	DeltaIntent,
	FreightId,
	GateVerdict,
	Outcome,
	PreviewEnvironments,
	PromotionId,
	PromotionService,
	PromoteRequest,
	SetId,
} from "../ports.js";
import {
	previewCampIdFor,
	previewPromotionIdFor,
	promotionIdFor,
	rollbackIdFor,
} from "./ids.js";
import {
	appendAll,
	appendOnce,
	body,
	canonicalJson,
	emitMetric,
	iso,
	msOf,
	principalName,
	readStream,
	sha256Hex,
	toJsonValue,
} from "./journal.js";
import { PROMOTION_METRIC, PROMOTION_REASON, reason } from "./reasons.js";
import {
	type CampProgress,
	completedFact,
	compensatedFact,
	foldPromotion,
	handleEffect,
	PROMOTION_SAGA,
	type PromotionView,
	recordOf,
	SAGA_FACT,
	STEP,
	type StepName,
	startedFact,
	stepFact,
} from "./state.js";

export type PromotionServiceDeps = Parameters<CdFactories["createPromotionService"]>[0] & {
	/** Trails sequencing (D11). Freight that names a migration is refused without it. */
	readonly trails?: TrailsMigrations;
	/** Fan-out aggregate gate (D20); required for requests that carry a fanoutId. */
	readonly aggregate?: FanoutAggregateGate;
	/** Defaults to the hook runner over `runbooks`, `suites` and `notify`. */
	readonly hooks?: HookRunner;
};

const ORIGIN: Readonly<Record<DeltaIntent, SetOrigin>> = {
	promote: SetOrigin.PROMOTION,
	rollback: SetOrigin.ROLLBACK,
	"drift-remediate": SetOrigin.DRIFT_ADOPTION,
	up: SetOrigin.UP,
	down: SetOrigin.TEARDOWN,
	preview: SetOrigin.PREVIEW,
	config: SetOrigin.CONFIG,
	topology: SetOrigin.TOPOLOGY,
	failover: SetOrigin.FAILOVER,
	depart: SetOrigin.DEPARTURE,
	"posture-remediate": SetOrigin.POSTURE_REMEDIATION,
};

/** Intents that never need lineage: they remove compute rather than carry Freight forward. */
const LINEAGE_FREE: ReadonlySet<DeltaIntent> = new Set(["down", "depart"]);

/** A Camp that failed: the saga throws it so compensation unwinds the group. */
class CampFailure extends Error {
	constructor(
		readonly campId: string,
		readonly reasons: readonly ReasonRecord[],
		readonly terminal: "rejected" | "failed",
	) {
		super(reasons[0]?.message ?? `Camp ${campId} failed`);
		this.name = "CampFailure";
	}
}

/** The saga never dispatches aggregate commands; a lease request is a programming error. */
const NO_DISPATCH: ActorLeaseHost = {
	acquire() {
		throw new Error("the promotion saga records its own facts and dispatches no aggregate commands");
	},
};

function defaultSpec(): VerificationSpecRecord {
	return create(VerificationSpecRecordSchema, {
		windowMs: BigInt(CD_DEFAULTS.verificationWindowMs),
		requiredObservations: CD_DEFAULTS.verificationRequiredObservations,
		progressDeadlineMs: BigInt(CD_DEFAULTS.verificationProgressDeadlineMs),
		failOnNoData: CD_DEFAULTS.verificationFailOnNoData,
	});
}

function stagesFor(strategy: RolloutStrategy, node: PipelineNodeRecord | undefined): number[] {
	if (node && node.stagePercents.length > 0) return [...node.stagePercents];
	switch (strategy) {
		case RolloutStrategy.CANARY:
			return [...CD_RAMP_DEFAULTS.canary];
		case RolloutStrategy.EXPERIMENT:
			return [...CD_RAMP_DEFAULTS.experiment];
		default:
			return [...CD_RAMP_DEFAULTS.blueGreen];
	}
}

function asCamp(id: string): CampId {
	// SAFETY: Camp ids in promotion records were parsed as Camp ids at request time.
	return id as CampId;
}

function asFreight(id: string): FreightId {
	// SAFETY: Freight ids in promotion records were checked against the ledger at request time.
	return id as FreightId;
}

function asDelta(id: string): DeltaId {
	// SAFETY: Delta ids in saga facts were minted by the SetResolver.
	return id as DeltaId;
}

function asRollout(id: string): RolloutId {
	// SAFETY: rollout ids in saga facts come from RolloutOrchestrator.plan.
	return id as RolloutId;
}

function asVerification(id: string): VerificationId {
	// SAFETY: verification ids in saga facts come from VerificationEngine.start.
	return id as VerificationId;
}

function asPromotion(id: string): PromotionId {
	// SAFETY: promotion ids are minted by ids.ts.
	return id as PromotionId;
}

function isRail(freight: FreightRecord): boolean {
	return freight.manifest?.subject === FreightSubject.RAIL;
}

export function createPromotionService(
	d: PromotionServiceDeps,
): PromotionService & PreviewEnvironments {
	const hooks =
		d.hooks ??
		createHookRunner({ runbooks: d.runbooks, suites: d.suites, notify: d.notify, telemetry: d.telemetry });
	/** Resolved candidates by Delta id; rebuilt deterministically after a restart. */
	const resolvedByDelta = new Map<string, ResolvedDeploymentSet>();
	/** Promotion ids in request order (catch-up index over the journal). */
	const order: string[] = [];
	const known = new Set<string>();
	let indexedThrough: EventPosition | undefined;

	const metric = (
		name: string,
		atMs: number,
		attributes: Readonly<Record<string, string>>,
		value?: number,
		kind?: "counter" | "histogram",
	) =>
		emitMetric(d.telemetry, {
			name,
			atMs,
			attributes: { tenant: d.tenant, ...attributes },
			...(value === undefined ? {} : { value }),
			...(kind === undefined ? {} : { kind, unit: "ms" }),
		});

	async function refreshIndex(): Promise<void> {
		for await (const positioned of d.store.readAll({
			...(indexedThrough === undefined ? {} : { after: indexedThrough }),
			tenant: d.tenant,
		})) {
			indexedThrough = positioned.position;
			const event = positioned.event;
			if (event.type !== CD_EVENTS.EnvPromoteRequested && event.type !== CD_EVENTS.EnvPromoteRolledBack)
				continue;
			if (!event.streamId.startsWith("cd-promotion-")) continue;
			const id = event.streamId.slice("cd-promotion-".length);
			if (known.has(id)) continue;
			known.add(id);
			order.push(id);
		}
	}

	async function load(promotionId: string): Promise<{ view: PromotionView; trigger: EventEnvelope } | undefined> {
		const events = await readStream(d.store, CD_STREAMS.promotion(promotionId));
		const view = foldPromotion(promotionId, events);
		const trigger = events.find(
			(e) => e.type === CD_EVENTS.EnvPromoteRequested || e.type === CD_EVENTS.EnvPromoteRolledBack,
		);
		return view && trigger ? { view, trigger } : undefined;
	}

	async function views(): Promise<PromotionView[]> {
		await refreshIndex();
		const out: PromotionView[] = [];
		for (const id of order) {
			const loaded = await load(id);
			if (loaded) out.push(loaded.view);
		}
		return out;
	}

	async function appendStep(
		view: PromotionView,
		campId: string,
		step: StepName,
		handle: string,
		ctx: CdContext,
	): Promise<void> {
		const progress = view.camps.get(campId);
		if (progress?.steps.has(step)) return;
		const fact = stepFact(view.promotionId, campId, step, handle);
		const event = await appendOnce({
			store: d.store,
			streamId: CD_STREAMS.promotion(view.promotionId),
			type: SAGA_FACT.stepEmitted,
			data: toJsonValue(fact.data),
			idempotencyKey: `step:${campId}:${step}`,
			tenant: d.tenant,
			actor: ctx.principal,
		});
		if (!event)
			throw new CampFailure(campId, [reason(PROMOTION_REASON.journalConflict, `step ${step} could not be journaled`, "Another writer holds the promotion stream; the next tick resumes.", campId)], "failed");
		progress?.steps.set(step, { handle: String(fact.data.emittedType), atMs: ctx.now() });
		metric(PROMOTION_METRIC.step, ctx.now(), { step, camp: campId });
	}

	function campRecord(view: PromotionView, campId: string, state: PromotionState, reasons: readonly ReasonRecord[]): PromotionRecord {
		return create(PromotionRecordSchema, {
			...view.request,
			targetCampIds: [campId],
			state,
			reasons: [...reasons],
			gateDecisionId: view.gateDecisionId,
		});
	}

	async function appendOutcome(
		view: PromotionView,
		campId: string,
		type: string,
		state: PromotionState,
		reasons: readonly ReasonRecord[],
		ctx: CdContext,
	): Promise<void> {
		await appendOnce({
			store: d.store,
			streamId: CD_STREAMS.promotion(view.promotionId),
			type,
			data: body(PromotionRecordSchema, campRecord(view, campId, state, reasons)),
			idempotencyKey: `outcome:${campId}:${type}`,
			tenant: d.tenant,
			actor: ctx.principal,
		});
		const progress = view.camps.get(campId);
		if (progress) {
			progress.terminal =
				type === CD_EVENTS.EnvPromoted
					? "promoted"
					: type === CD_EVENTS.EnvPromoteSuperseded
						? "superseded"
						: state === PromotionState.FAILED
							? "failed"
							: "rejected";
			progress.reasons = [...reasons];
			if (type === CD_EVENTS.EnvPromoted) progress.promotedAtMs = ctx.now();
		}
	}

	/** Mark `older` superseded at a Camp by `newer`, releasing its open Delta. */
	async function supersede(older: PromotionView, campId: CampId, newer: PromotionView, ctx: CdContext): Promise<void> {
		const progress = older.camps.get(campId);
		if (!progress || progress.terminal !== undefined) return;
		const deltaId = progress.steps.get(STEP.resolved)?.handle;
		if (deltaId && older.request.subject !== FreightSubject.RAIL) {
			const delta = await d.desired.get(asDelta(deltaId));
			if (delta) await d.desired.reject(asDelta(deltaId), [reason(PROMOTION_REASON.superseded, `superseded by ${newer.promotionId}`, "Nothing to do; the newer Freight proceeds.", campId)], ctx);
		}
		await appendOutcome(older, campId, CD_EVENTS.EnvPromoteSuperseded, PromotionState.SUPERSEDED, [reason(PROMOTION_REASON.superseded, `superseded by newer promotion ${newer.promotionId} of Freight ${newer.request.freightId}`, "Nothing to do; the newer Freight proceeds.", campId)], ctx);
		metric(PROMOTION_METRIC.superseded, ctx.now(), { camp: campId });
	}

	async function nodeOf(view: PromotionView): Promise<PipelineNodeRecord | undefined> {
		if (view.request.pipeline === "" || view.request.node === "") return undefined;
		const pipeline = await d.pipelines.get(view.request.pipeline);
		return pipeline?.nodes.find((n) => n.name === view.request.node);
	}

	// ── Lineage (I16) ──────────────────────────────────────────────────────
	async function lineage(
		request: PromoteRequest,
		freight: FreightRecord,
		intent: DeltaIntent,
		ctx: CdContext,
	): Promise<Outcome<PipelineNodeRecord | undefined>> {
		if (LINEAGE_FREE.has(intent)) return { ok: true, value: undefined };
		const nowMs = ctx.now();
		const approvals = await d.freight.approvals(request.freightId);
		const approved = (campId: string) =>
			approvals.some((a) => a.campId === campId && (msOf(a.expiresAt) ?? 0) > nowMs);
		const reapply = async (campId: CampId) => (await d.desired.current(campId))?.freightId === freight.freightId;
		const coveredBy = async (campId: CampId) => approved(campId) || (await reapply(campId));
		if (request.pipeline !== undefined && request.pipeline !== "") {
			const pipeline = await d.pipelines.get(request.pipeline);
			const node = pipeline?.nodes.find((n) => n.name === request.node);
			if (!pipeline || !node)
				return { ok: false, reasons: [reason(PROMOTION_REASON.pipelineUnknown, `pipeline ${request.pipeline} has no node ${request.node ?? ""}`, "Apply the pipeline first, or name an existing node.", request.pipeline)] };
			const placed = node.placement !== "";
			if (!placed) {
				const allowed = new Set(node.campIds);
				const outside = request.targets.filter(
					(t) => !allowed.has(t) && !(intent === "preview" && request.sourceCampId !== undefined && allowed.has(request.sourceCampId)),
				);
				if (outside.length > 0)
					return { ok: false, reasons: [reason(PROMOTION_REASON.targetOutsideNode, `Camps ${outside.join(", ")} are not in node ${node.name}`, `Promote to the Camps node ${node.name} lists, or add them to the pipeline.`, outside.join(","))] };
			}
			const available = await d.pipelines.available({ pipeline: request.pipeline, node: node.name });
			if (available.some((a) => a.freightId === request.freightId)) return { ok: true, value: node };
			const uncovered: CampId[] = [];
			for (const target of request.targets) if (!(await coveredBy(target))) uncovered.push(target);
			if (uncovered.length === 0) return { ok: true, value: node };
			const enforce = isRail(freight) && node.policyMode === PolicyMode.ENFORCE;
			return {
				ok: false,
				reasons: [
					reason(
						enforce ? PROMOTION_REASON.shadowRequired : PROMOTION_REASON.lineage,
						enforce
							? `Rail Freight ${freight.freightId} is not qualified by an INFORM node upstream of ${node.name}`
							: `Freight ${freight.freightId} is not available to node ${node.name} (not qualified upstream or not soaked)`,
						enforce
							? "Bind the Rail in INFORM upstream and let it qualify, or record an expiring approval for the Camp."
							: "Promote it through the upstream nodes until it qualifies and soaks, or record an audited hotfix approval (`freight.Approved`) for the target Camp.",
						uncovered.join(","),
					),
				],
			};
		}
		// No pipeline named: allowed only for Camps that no pipeline node governs.
		const governed: string[] = [];
		for (const pipeline of await d.pipelines.list()) {
			for (const node of pipeline.nodes)
				for (const target of request.targets)
					if (node.campIds.includes(target) && !(await coveredBy(target))) governed.push(`${target} (${pipeline.name}/${node.name})`);
		}
		if (governed.length > 0)
			return { ok: false, reasons: [reason(PROMOTION_REASON.lineage, `Camps ${governed.join(", ")} are governed by a pipeline`, "Promote through the pipeline node that lists the Camp so lineage applies.", governed.join(","))] };
		if (isRail(freight))
			return { ok: false, reasons: [reason(PROMOTION_REASON.shadowRequired, "Rail Freight promotes only through a Rail pipeline", "Define a Rail pipeline with an INFORM node before an ENFORCE node.", freight.freightId)] };
		return { ok: true, value: undefined };
	}

	// ── Gate helpers ───────────────────────────────────────────────────────
	async function railResolved(campId: CampId): Promise<{ resolved: ResolvedDeploymentSet; current?: SetRecord }> {
		const current = await d.desired.current(campId);
		if (current) return { resolved: await d.desired.resolved(current), current };
		return {
			resolved: createResolvedDeploymentSet({
				tenant: d.tenant,
				environment: campId,
				campId,
				plan: { schema: DEPLOYMENT_PLAN_SCHEMA, resources: [], dependencyOrder: [], objective: "min-cost" },
				matches: [],
				gatekeeper: { decision: "allow", gatekeeperDecisionId: "pending", obligations: [], decidedAt: iso(0) },
			}),
		};
	}

	function railDelta(view: PromotionView, campId: string, freight: FreightRecord, current: SetRecord | undefined, ctx: CdContext): DeltaRecord {
		return create(DeltaRecordSchema, {
			schemaVersion: DELTA_SCHEMA,
			deltaId: `delta_rail_${sha256Hex(canonicalJson({ promotion: view.promotionId, campId, freight: freight.freightId })).slice(0, 20)}`,
			campId,
			baseSetId: current?.setId ?? "",
			freightId: freight.freightId,
			openedBy: principalName(ctx.principal),
			proposal: view.request.proposal,
			openedAt: iso(ctx.now()),
			intent: view.intent,
		});
	}

	type Candidate = { delta: DeltaRecord; resolved: ResolvedDeploymentSet; current?: SetRecord };

	async function candidateFor(
		view: PromotionView,
		campId: CampId,
		freight: FreightRecord,
		deltaId: string | undefined,
		ctx: CdContext,
	): Promise<Outcome<Candidate>> {
		if (isRail(freight)) {
			const { resolved, current } = await railResolved(campId);
			return { ok: true, value: { delta: railDelta(view, campId, freight, current, ctx), resolved, ...(current ? { current } : {}) } };
		}
		const current = await d.desired.current(campId);
		const cached = deltaId ? resolvedByDelta.get(deltaId) : undefined;
		const stored = deltaId ? await d.desired.get(asDelta(deltaId)) : undefined;
		if (cached && stored) return { ok: true, value: { delta: stored, resolved: cached, ...(current ? { current } : {}) } };
		const resolved = await d.resolver.resolve(
			{
				freight,
				campId,
				intent: view.intent,
				...(current ? { base: current } : {}),
				...(view.request.sourceCampId !== "" ? { sourceCampId: asCamp(view.request.sourceCampId) } : {}),
			},
			ctx,
		);
		if (!resolved.ok) return resolved;
		const delta = create(DeltaRecordSchema, { ...resolved.value.delta, proposal: view.request.proposal });
		if (deltaId && delta.deltaId !== deltaId)
			return { ok: false, reasons: [reason(PROMOTION_REASON.resolutionChanged, `re-resolving Camp ${campId} produced Delta ${delta.deltaId}, not the recorded ${deltaId}`, "The Camp's topology or base Set changed mid-promotion; promote again to resolve against the new state.", campId)] };
		resolvedByDelta.set(delta.deltaId, resolved.value.resolved);
		return { ok: true, value: { delta: stored ?? delta, resolved: resolved.value.resolved, ...(current ? { current } : {}) } };
	}

	async function gate(
		view: PromotionView,
		candidate: Candidate,
		freight: FreightRecord,
		node: PipelineNodeRecord | undefined,
		ctx: CdContext,
	): Promise<GateVerdict> {
		return d.gate.evaluate(
			{
				intent: view.intent,
				delta: candidate.delta,
				freight,
				resolved: candidate.resolved,
				windows: node ? [...node.windows] : [],
				...(candidate.current ? { current: candidate.current } : {}),
			},
			ctx,
		);
	}

	function windowClosed(verdict: GateVerdict, intent: DeltaIntent): boolean {
		if (!verdict.window || verdict.window.open) return false;
		return !(intent === "rollback" && verdict.window.rollbackAllowed);
	}

	// ── One Camp's forward path ────────────────────────────────────────────
	async function advanceCamp(
		view: PromotionView,
		progress: CampProgress,
		ctx: CdContext,
		all: readonly PromotionView[],
	): Promise<void> {
		if (progress.terminal !== undefined) {
			if (progress.terminal === "promoted") await contractAfterSoak(view, progress, ctx);
			return;
		}
		const campId = asCamp(progress.campId);
		const has = (step: StepName) => progress.steps.has(step);
		const freight = await d.freight.get(asFreight(view.request.freightId));
		const fail = (reasons: readonly ReasonRecord[], terminal: "rejected" | "failed" = has(STEP.applied) ? "failed" : "rejected") => {
			throw new CampFailure(campId, reasons, terminal);
		};
		// I13: yanked or retired Freight never starts or continues.
		if (!freight || !(await d.freight.isUsable(asFreight(view.request.freightId))))
			return fail([reason(PROMOTION_REASON.freightUnusable, `Freight ${view.request.freightId} is yanked, retired or unknown`, "Promote other Freight; a yanked Freight never continues.", campId)]);
		// Per-Camp queue: one in-flight promotion per Camp; the newest queued wins.
		if (!has(STEP.applied)) {
			const mine = order.indexOf(view.promotionId);
			let held = false;
			for (const other of all) {
				if (other.promotionId === view.promotionId || other.rolledBack) continue;
				const theirs = other.camps.get(campId);
				if (!theirs || theirs.terminal !== undefined) continue;
				if (order.indexOf(other.promotionId) > mine) {
					await supersede(view, campId, other, ctx);
					return;
				}
				if (theirs.steps.has(STEP.applied)) held = true;
				else await supersede(other, campId, view, ctx);
			}
			if (held) return;
		}
		const node = await nodeOf(view);
		const rail = isRail(freight);
		let verdict: GateVerdict | undefined;
		// 5–6. Resolve and open the Delta (infrastructure_diff included).
		if (!has(STEP.resolved)) {
			const candidate = await candidateFor(view, campId, freight, undefined, ctx);
			if (!candidate.ok) return fail([reason(PROMOTION_REASON.resolveFailed, `Camp ${campId} could not be resolved`, "See the following reasons.", campId), ...candidate.reasons]);
			if (!rail && !(await d.desired.get(asDelta(candidate.value.delta.deltaId)))) {
				const opened = await d.desired.open(candidate.value.delta, ctx);
				if (!opened.ok) return fail([reason(PROMOTION_REASON.deltaRefused, `Delta for Camp ${campId} was refused`, "See the following reasons.", campId), ...opened.reasons]);
			}
			await appendStep(view, campId, STEP.resolved, candidate.value.delta.deltaId, ctx);
		}
		const deltaId = progress.steps.get(STEP.resolved)?.handle ?? "";
		// 7. Gate (policy, compat, trust, residency, ownership, windows, shadow).
		if (!has(STEP.gated)) {
			const candidate = await candidateFor(view, campId, freight, deltaId, ctx);
			if (!candidate.ok) return fail(candidate.reasons);
			verdict = await gate(view, candidate.value, freight, node, ctx);
			if (verdict.effect === "deny") {
				if (!rail) await d.desired.reject(asDelta(deltaId), verdict.reasons, ctx);
				return fail([reason(PROMOTION_REASON.gateDenied, `the gate denied Camp ${campId} (${verdict.decisionId})`, "Correct the causes below and promote again.", campId), ...verdict.reasons]);
			}
			if (windowClosed(verdict, view.intent)) {
				await appendStep(view, campId, STEP.awaitingWindow, `${verdict.window?.activeFreezes.join(",") ?? ""} ${verdict.window?.nextOpenAtMs ?? ""}`.trim(), ctx);
				return;
			}
			await appendStep(view, campId, STEP.gated, `${verdict.effect} ${verdict.decisionId}`, ctx);
		}
		const gatedHandle = progress.steps.get(STEP.gated)?.handle ?? "";
		// 8. Approval: proposals wait for a human; require-approval and node approval use the ApprovalPort.
		const needsApproval =
			view.request.proposal || handleEffect(gatedHandle) === "require-approval" || node?.approvalRequired === true;
		if (needsApproval && !has(STEP.approved)) {
			if (has(STEP.approvalDenied))
				return fail([reason(PROMOTION_REASON.approvalDenied, `approval for Camp ${campId} was denied by ${progress.steps.get(STEP.approvalDenied)?.handle ?? ""}`, "Address the approver's objection and promote again.", campId)]);
			const subject = approvalSubject(view.promotionId, campId);
			const requestedAt = progress.steps.get(STEP.approvalRequested)?.atMs ?? ctx.now();
			const expiresAtMs = requestedAt + CD_DEFAULTS.approvalTtlMs;
			if (view.request.proposal) {
				await appendStep(view, campId, STEP.approvalRequested, `${subject} ${expiresAtMs}`, ctx);
				if (ctx.now() >= expiresAtMs)
					return fail([reason(PROMOTION_REASON.approvalExpired, `proposal for Camp ${campId} expired unapproved`, "Propose again; an operator must approve within the approval TTL.", campId)]);
				return;
			}
			const { requestId } = await d.approvals.request(
				{ subject, summary: `Promote ${freight.alias || freight.freightId} to ${campId}`, obligations: [], expiresAtMs },
				ctx,
			);
			const status: ApprovalStatus = await d.approvals.status(requestId);
			if (status === "approved") await appendStep(view, campId, STEP.approved, requestId, ctx);
			else if (status === "denied")
				return fail([reason(PROMOTION_REASON.approvalDenied, `approval ${requestId} was denied`, "Address the approver's objection and promote again.", campId)]);
			else if (status === "expired")
				return fail([reason(PROMOTION_REASON.approvalExpired, `approval ${requestId} expired`, "Promote again to open a fresh approval request.", campId)]);
			else {
				await appendStep(view, campId, STEP.approvalRequested, `${requestId} ${expiresAtMs}`, ctx);
				return;
			}
		}
		// 9. BEFORE_APPLY hooks.
		const subject = { promotionId: view.promotionId, campId, freightId: asFreight(freight.freightId), pipeline: view.request.pipeline, node: view.request.node };
		if (!has(STEP.beforeApply)) {
			const ran = await hooks.run({ hooks: node?.hooks ?? [], point: HookPoint.BEFORE_APPLY, subject }, ctx);
			if (!ran.ok) return fail([reason(PROMOTION_REASON.hookFailed, `BEFORE_APPLY hooks failed for Camp ${campId}`, "See the hook reasons below.", campId), ...ran.reasons]);
			await appendStep(view, campId, STEP.beforeApply, String(ran.value), ctx);
		}
		// 10. Trails expand when the declaration changes data shape (D11).
		const migration = await migrationFor(freight, campId);
		if (!migration.ok) return fail(migration.reasons);
		if (migration.value && !has(STEP.expanded)) {
			const expanded = await d.trails?.run({ migrationId: migration.value, campId, phase: "expand" }, ctx);
			if (!expanded?.ok) {
				if (expanded && expanded.reasons.some((r) => r.code === "trails-migration-held")) return;
				return fail(expanded?.reasons ?? []);
			}
			await appendStep(view, campId, STEP.expanded, migration.value, ctx);
		}
		// 11. Apply: a Set through DeltaLedger, or (RAIL) the binding through CampPolicy.
		if (!has(STEP.applied)) {
			const candidate = await candidateFor(view, campId, freight, deltaId, ctx);
			if (!candidate.ok) return fail(candidate.reasons);
			// The decision that admits the apply must be current (windows, I17).
			verdict ??= await gate(view, candidate.value, freight, node, ctx);
			if (verdict.effect === "deny") {
				if (!rail) await d.desired.reject(asDelta(deltaId), verdict.reasons, ctx);
				return fail([reason(PROMOTION_REASON.gateDenied, `the gate denied Camp ${campId} at apply (${verdict.decisionId})`, "Correct the causes below and promote again.", campId), ...verdict.reasons]);
			}
			if (windowClosed(verdict, view.intent)) return;
			if (rail) {
				const mode = node?.policyMode === PolicyMode.ENFORCE ? PolicyMode.ENFORCE : PolicyMode.INFORM;
				const bound = await d.campPolicy.bind({ campId, freight, mode, promotionId: asPromotion(view.promotionId) }, ctx);
				if (!bound.ok) return fail([reason(PROMOTION_REASON.bindFailed, `binding Rail ${freight.manifest?.declarationHash ?? ""} to Camp ${campId} failed`, "See the following reasons.", campId), ...bound.reasons], "rejected");
				await appendStep(view, campId, STEP.applied, `binding ${PolicyMode[mode]} ${verdict.decisionId}`, ctx);
			} else {
				const effect = verdict.effect === "allow-degraded" ? "allow-degraded" : "allow";
				const sealed = sealResolved(candidate.value.resolved, {
					decision: effect,
					decisionId: verdict.decisionId,
					obligations: verdict.obligations.map((o) => o.id),
					decidedAtMs: ctx.now(),
				});
				const applied = await d.desired.apply(
					{ deltaId: asDelta(deltaId), gateDecisionId: verdict.decisionId, resolved: sealed, origin: ORIGIN[view.intent] },
					ctx,
				);
				if (!applied.ok) return fail([reason(PROMOTION_REASON.applyFailed, `apply to Camp ${campId} was refused`, "See the following reasons.", campId), ...applied.reasons], "rejected");
				await appendStep(view, campId, STEP.applied, applied.value.setId, ctx);
			}
		}
		// 12. Progressive rollout (workloads only; a Rail binding moves no traffic).
		const strategy = view.request.strategy !== RolloutStrategy.UNSPECIFIED ? view.request.strategy : (node?.strategy ?? RolloutStrategy.ALL_AT_ONCE);
		const spec = node?.verification ?? defaultSpec();
		if (!rail && !has(STEP.rollout)) {
			const planned = await d.rollouts.plan(
				{
					promotion: create(PromotionRecordSchema, { ...recordOf(view), targetCampIds: [campId], strategy }),
					obligations: [],
					verification: spec,
					stagePercents: stagesFor(strategy, node),
					windows: node ? [...node.windows] : [],
				},
				ctx,
			);
			if (!planned.ok) return fail([reason(PROMOTION_REASON.rolloutFailed, `rollout for Camp ${campId} could not be planned`, "See the following reasons.", campId), ...planned.reasons]);
			await d.rollouts.run(planned.value, ctx);
			await appendStep(view, campId, STEP.rollout, planned.value.rolloutId, ctx);
		}
		if (!has(STEP.converged)) {
			if (!rail) {
				const snapshot = await d.rollouts.get(asRollout(progress.steps.get(STEP.rollout)?.handle ?? ""));
				if (!snapshot) return;
				if (snapshot.status === "failed" || snapshot.status === "rolled-back" || snapshot.status === "halted")
					return fail([reason(PROMOTION_REASON.rolloutFailed, `rollout ${snapshot.rolloutId} ended ${snapshot.status} at ${snapshot.percent}%`, "Inspect the rollout evidence; the predecessor Set is restored by compensation.", campId), ...snapshot.reasons]);
				if (snapshot.status !== "promoted") return;
			}
			await appendStep(view, campId, STEP.converged, rail ? "binding" : "promoted", ctx);
		}
		// 13. AFTER_CONVERGED hooks.
		if (!has(STEP.afterConverged)) {
			const ran = await hooks.run({ hooks: node?.hooks ?? [], point: HookPoint.AFTER_CONVERGED, subject }, ctx);
			if (!ran.ok) return fail([reason(PROMOTION_REASON.hookFailed, `AFTER_CONVERGED hooks failed for Camp ${campId}`, "See the hook reasons below.", campId), ...ran.reasons]);
			await appendStep(view, campId, STEP.afterConverged, String(ran.value), ctx);
		}
		// 14. Verification (fails closed; PASS is the only qualification).
		if (!has(STEP.verification)) {
			const id = await d.verification.start(
				{ spec, freightId: asFreight(freight.freightId), campId, cohortAware: strategy === RolloutStrategy.CANARY || strategy === RolloutStrategy.EXPERIMENT },
				ctx,
			);
			await appendStep(view, campId, STEP.verification, id, ctx);
		}
		if (!has(STEP.qualified)) {
			const result = await d.verification.get(asVerification(progress.steps.get(STEP.verification)?.handle ?? ""));
			if (!result || result.verdict === VerificationVerdict.UNSPECIFIED) return;
			if (result.verdict !== VerificationVerdict.PASS)
				return fail([reason(PROMOTION_REASON.verificationFailed, `verification ${result.verificationId} ended ${VerificationVerdict[result.verdict]} for Camp ${campId}`, "Inspect the verification checks; the predecessor Set is restored by compensation.", campId), ...result.reasons]);
			if (view.request.pipeline !== "" && view.request.node !== "") {
				const qualified = await d.freight.qualify(
					{ freightId: asFreight(freight.freightId), campId, pipeline: view.request.pipeline, node: view.request.node, result },
					ctx,
				);
				if (!qualified.ok) return fail([reason(PROMOTION_REASON.qualifyFailed, `Freight could not be qualified at Camp ${campId}`, "See the following reasons.", campId), ...qualified.reasons]);
			}
			await appendStep(view, campId, STEP.qualified, result.verificationId, ctx);
		}
		// 15. AFTER_QUALIFIED hooks, then env.Promoted.
		if (!has(STEP.afterQualified)) {
			const ran = await hooks.run({ hooks: node?.hooks ?? [], point: HookPoint.AFTER_QUALIFIED, subject }, ctx);
			if (!ran.ok) return fail([reason(PROMOTION_REASON.hookFailed, `AFTER_QUALIFIED hooks failed for Camp ${campId}`, "See the hook reasons below.", campId), ...ran.reasons]);
			await appendStep(view, campId, STEP.afterQualified, String(ran.value), ctx);
		}
		await appendOutcome(view, campId, CD_EVENTS.EnvPromoted, PromotionState.PROMOTED, [], ctx);
		metric(PROMOTION_METRIC.promoted, ctx.now(), { camp: campId, intent: view.intent });
		const recordedAt = msOf(freight.recordedAt);
		if (recordedAt !== undefined)
			metric(PROMOTION_METRIC.leadTime, ctx.now(), { camp: campId }, Math.max(0, ctx.now() - recordedAt), "histogram");
		// 16. Trails contract after soak.
		await contractAfterSoak(view, progress, ctx);
	}

	async function migrationFor(freight: FreightRecord, campId: CampId): Promise<Outcome<string | undefined>> {
		if (d.trails) {
			const migration = await d.trails.migrationFor({ freight, campId });
			return { ok: true, value: migration?.migrationId };
		}
		const label = freight.manifest?.labels["hobo.cd/data-migration"] ?? "";
		if (label === "") return { ok: true, value: undefined };
		return { ok: false, reasons: [reason(PROMOTION_REASON.trailsUnavailable, `Freight names data migration ${label} but no Trails sequencer is composed`, "Compose the Trails adapter (`createTrailsMigrations`) into the promotion service.", campId)] };
	}

	async function contractAfterSoak(view: PromotionView, progress: CampProgress, ctx: CdContext): Promise<void> {
		if (progress.steps.has(STEP.contracted) || !d.trails) return;
		const migrationId = progress.steps.get(STEP.expanded)?.handle;
		if (!migrationId) return;
		const node = await nodeOf(view);
		const soakMs = Number(node?.requiredSoakMs ?? 0n);
		const promotedAt = progress.promotedAtMs ?? ctx.now();
		if (ctx.now() < promotedAt + soakMs) return;
		const contracted = await d.trails.run({ migrationId, campId: asCamp(progress.campId), phase: "contract" }, ctx);
		if (contracted.ok) await appendStep(view, progress.campId, STEP.contracted, migrationId, ctx);
	}

	// ── Compensation (environment groups, D12) ─────────────────────────────
	async function compensate(view: PromotionView, failure: CampFailure, ctx: CdContext): Promise<void> {
		const node = await nodeOf(view);
		for (const progress of view.camps.values()) {
			const campId = asCamp(progress.campId);
			const failed = campId === failure.campId;
			// A promoted member of a failed group is rolled back too; other terminal Camps stay.
			if (progress.terminal !== undefined && progress.terminal !== "promoted") continue;
			const subject = { promotionId: view.promotionId, campId, freightId: asFreight(view.request.freightId), pipeline: view.request.pipeline, node: view.request.node };
			if (failed || progress.steps.has(STEP.applied))
				await hooks.run({ hooks: node?.hooks ?? [], point: HookPoint.ON_FAILURE, subject }, ctx);
			const reasons: ReasonRecord[] = failed
				? [...failure.reasons]
				: [reason(PROMOTION_REASON.compensated, `compensated: Camp ${failure.campId} of the same promotion failed`, "Fix the failing Camp and promote the group again.", campId)];
			if (progress.steps.has(STEP.applied)) {
				const restored = await restoreCamp(view, progress, failure.reasons[0]?.message ?? "compensation", ctx);
				if (!restored.ok) reasons.push(...restored.reasons);
				await appendStep(view, campId, STEP.compensated, restored.ok ? restored.value : "restore-refused", ctx);
			}
			await appendOutcome(
				view,
				campId,
				CD_EVENTS.EnvPromoteRejected,
				failed && failure.terminal === "rejected" ? PromotionState.REJECTED : PromotionState.FAILED,
				reasons,
				ctx,
			);
		}
		await appendOnce({
			store: d.store,
			streamId: CD_STREAMS.promotion(view.promotionId),
			type: SAGA_FACT.compensated,
			data: toJsonValue(compensatedFact(view.promotionId, `${failure.campId}`, failure.reasons[0]?.code ?? "failed").data),
			idempotencyKey: "saga:compensated",
			tenant: d.tenant,
			actor: ctx.principal,
		});
		metric(failure.terminal === "rejected" && !failure.reasons.some((r) => r.code === PROMOTION_REASON.compensated) ? PROMOTION_METRIC.refused : PROMOTION_METRIC.failed, ctx.now(), { camp: failure.campId, reason: failure.reasons[0]?.code ?? "" });
		if (view.camps.size > 1) metric(PROMOTION_METRIC.compensated, ctx.now(), { camps: String(view.camps.size) });
	}

	/** Zero exposure, then a Delta to the predecessor Set through the same gate (D12). */
	async function restoreCamp(view: PromotionView, progress: CampProgress, why: string, ctx: CdContext): Promise<Outcome<string>> {
		const campId = asCamp(progress.campId);
		const rolloutId = progress.steps.get(STEP.rollout)?.handle;
		if (rolloutId) await d.rollouts.rollback({ rolloutId: asRollout(rolloutId), reason: why }, ctx);
		const freight = await d.freight.get(asFreight(view.request.freightId));
		if (freight && isRail(freight)) {
			const restored = await d.campPolicy.restore({ campId, promotionId: asPromotion(view.promotionId) }, ctx);
			return restored.ok ? { ok: true, value: `binding ${restored.value.enforcedRailDigest}` } : restored;
		}
		const applied = progress.steps.get(STEP.applied)?.handle ?? "";
		const restored = await rollbackSet(campId, applied, undefined, ctx);
		return restored.ok ? { ok: true, value: restored.value.setId } : restored;
	}

	async function rollbackSet(
		campId: CampId,
		expectedCurrent: string,
		toSetId: SetId | undefined,
		ctx: CdContext,
	): Promise<Outcome<SetRecord>> {
		const current = await d.desired.current(campId);
		if (!current)
			return { ok: false, reasons: [reason(PROMOTION_REASON.rollbackNoPredecessor, `Camp ${campId} has no current Set`, "Nothing to roll back; promote Freight to the Camp.", campId)] };
		// Compensation restores only the Set this promotion applied; a newer Set is not ours to undo.
		if (expectedCurrent !== "" && current.setId !== expectedCurrent) return { ok: true, value: current };
		const targetId = toSetId ?? current.predecessorSetId;
		const target = targetId === "" ? undefined : await d.desired.get(targetId as SetId);
		if (!target)
			return { ok: false, reasons: [reason(PROMOTION_REASON.rollbackNoPredecessor, `Camp ${campId} has no predecessor Set to restore`, "Exposure was zeroed; promote known-good Freight or tear the Camp down with `hobo down`.", campId)] };
		const freight = await d.freight.get(asFreight(target.freightId));
		if (!freight || !(await d.freight.isUsable(asFreight(target.freightId))))
			return { ok: false, reasons: [reason(PROMOTION_REASON.rollbackTargetUnusable, `the predecessor Set's Freight ${target.freightId} is yanked or retired`, "Name an earlier Set with toSetId, or promote known-good Freight.", campId)] };
		const before = await d.desired.resolved(current);
		const after = await d.desired.resolved(target);
		const delta = create(DeltaRecordSchema, {
			schemaVersion: DELTA_SCHEMA,
			deltaId: deltaIdFor({ campId, freightId: target.freightId, intent: "rollback", baseSetId: current.setId, contentHash: after.contentHash }),
			campId,
			baseSetId: current.setId,
			freightId: target.freightId,
			changes: diffResolvedSets(before, after),
			openedBy: principalName(ctx.principal),
			proposal: false,
			openedAt: iso(ctx.now()),
			intent: "rollback",
		});
		if (!(await d.desired.get(asDelta(delta.deltaId)))) {
			const opened = await d.desired.open(delta, ctx);
			if (!opened.ok) return opened;
		}
		const verdict = await d.gate.evaluate({ intent: "rollback", delta, freight, resolved: after, windows: [], current }, ctx);
		if (verdict.effect === "deny") {
			await d.desired.reject(asDelta(delta.deltaId), verdict.reasons, ctx);
			return { ok: false, reasons: [reason(PROMOTION_REASON.gateDenied, `the gate denied the rollback of Camp ${campId}`, "Correct the causes below; rollback goes through the same gate (I7).", campId), ...verdict.reasons] };
		}
		if (windowClosed(verdict, "rollback"))
			return { ok: false, reasons: [reason(PROMOTION_REASON.windowClosed, `a freeze forbids rollback at Camp ${campId}`, "Record a governed window override (`window.Overridden`), then roll back.", campId)] };
		const sealed = sealResolved(after, {
			decision: verdict.effect === "allow-degraded" ? "allow-degraded" : "allow",
			decisionId: verdict.decisionId,
			obligations: verdict.obligations.map((o) => o.id),
			decidedAtMs: ctx.now(),
		});
		return d.desired.apply({ deltaId: asDelta(delta.deltaId), gateDecisionId: verdict.decisionId, resolved: sealed, origin: SetOrigin.ROLLBACK }, ctx);
	}

	// ── Saga driver ────────────────────────────────────────────────────────
	async function advance(promotionId: string, ctx: CdContext, all?: readonly PromotionView[]): Promise<void> {
		const loaded = await load(promotionId);
		if (!loaded || loaded.view.rolledBack || loaded.view.sagaCompleted) return;
		const { view, trigger } = loaded;
		if (view.preview && view.previewExpired) return;
		const everyone = all ?? (await views());
		let failure: CampFailure | undefined;
		const saga = defineSaga({
			name: PROMOTION_SAGA,
			trigger: CD_EVENTS.EnvPromoteRequested,
			step: async () => {
				for (const progress of view.camps.values()) {
					try {
						await advanceCamp(view, progress, ctx, everyone);
					} catch (error) {
						if (error instanceof CampFailure) {
							failure = error;
							throw error;
						}
						// A port threw (transient): nothing is decided; the next tick retries.
						metric(PROMOTION_METRIC.stepError, ctx.now(), {
							camp: progress.campId,
							error: error instanceof Error ? error.name : "unknown",
						});
					}
				}
			},
			compensate: async (_event, _ctx, cause) => {
				const thrown =
					failure ??
					new CampFailure(
						[...view.camps.keys()][0] ?? "",
						[reason(PROMOTION_REASON.applyFailed, cause instanceof Error ? cause.message : String(cause), "Inspect the promotion journal; the group was compensated.", promotionId)],
						"failed",
					);
				await compensate(view, thrown, ctx);
			},
		});
		await saga.run(trigger, { store: d.store, actorHost: NO_DISPATCH });
		const done = [...view.camps.values()].every(
			(c) => c.terminal !== undefined && (c.terminal !== "promoted" || !c.steps.has(STEP.expanded) || c.steps.has(STEP.contracted)),
		);
		if (done)
			await appendOnce({
				store: d.store,
				streamId: CD_STREAMS.promotion(promotionId),
				type: SAGA_FACT.completed,
				data: toJsonValue(completedFact(promotionId, PromotionState[recordOf(view).state] ?? "UNSPECIFIED").data),
				idempotencyKey: "saga:completed",
				tenant: d.tenant,
				actor: ctx.principal,
			});
	}

	async function record(promotionId: string): Promise<PromotionRecord | undefined> {
		const loaded = await load(promotionId);
		return loaded ? recordOf(loaded.view) : undefined;
	}

	// ── Requests ───────────────────────────────────────────────────────────
	async function request(
		input: PromoteRequest,
		promotionId: PromotionId,
		ctx: CdContext,
		preview?: PreviewEnvironmentRecord,
	): Promise<Outcome<PromotionRecord>> {
		const intent: DeltaIntent = input.intent ?? (preview ? "preview" : "promote");
		const refusal = (code: string, message: string, remediation: string, subjectId = ""): Outcome<PromotionRecord> => {
			metric(PROMOTION_METRIC.refused, ctx.now(), { reason: code });
			return { ok: false, reasons: [reason(code, message, remediation, subjectId)] };
		};
		if (input.targets.length === 0 || input.idempotencyKey === "" || new Set(input.targets).size !== input.targets.length)
			return refusal(PROMOTION_REASON.invalidRequest, "a promotion needs distinct targets and an idempotency key", "Name each target Camp once and pass a stable idempotency key.");
		const existing = await load(promotionId);
		if (existing) {
			const same =
				existing.view.request.freightId === input.freightId &&
				canonicalJson([...existing.view.request.targetCampIds].sort()) === canonicalJson([...input.targets].sort());
			return same
				? { ok: true, value: recordOf(existing.view) }
				: refusal(PROMOTION_REASON.idempotencyReused, `idempotency key ${input.idempotencyKey} already names promotion ${promotionId} of other Freight or targets`, "Use a new idempotency key for a different promotion.", promotionId);
		}
		const freight = await d.freight.get(input.freightId);
		if (!freight)
			return refusal(PROMOTION_REASON.freightUnknown, `Freight ${input.freightId} is not recorded`, "Record the Freight (ingest or source discovery) before promoting it.", input.freightId);
		const rail = isRail(freight);
		// 1. Authorize.
		const authz = await d.authorizer.authorize(
			rail ? "rail.promote" : intent === "preview" ? "preview.create" : "promote",
			{
				freightId: input.freightId,
				targets: [...input.targets],
				pipeline: input.pipeline ?? "",
				node: input.node ?? "",
				intent,
				bindle: freight.manifest?.bindle ?? "",
				subject: rail ? "RAIL" : "BINDLE",
			},
			ctx,
		);
		if (!authz.ok) {
			metric(PROMOTION_METRIC.refused, ctx.now(), { reason: PROMOTION_REASON.unauthorized });
			return { ok: false, reasons: [reason(PROMOTION_REASON.unauthorized, `${principalName(ctx.principal)} may not promote`, "Request the promote grant from the Station's policy pack owner.", input.freightId), ...authz.reasons] };
		}
		// 2. Refuse yanked or retired Freight (I13).
		if (!(await d.freight.isUsable(input.freightId)))
			return refusal(PROMOTION_REASON.freightUnusable, `Freight ${input.freightId} is yanked or retired`, "Promote other Freight; yanked or retired Freight never starts a promotion.", input.freightId);
		// 3. Lineage (I16), unless an approval covers the target.
		const lineaged = await lineage(input, freight, intent, ctx);
		if (!lineaged.ok) {
			metric(PROMOTION_METRIC.refused, ctx.now(), { reason: lineaged.reasons[0]?.code ?? "" });
			return lineaged;
		}
		// D20 aggregate: refused before any Camp of the fan-out starts.
		if (input.fanoutId !== undefined && input.fanoutId !== "") {
			if (!d.aggregate)
				return refusal(PROMOTION_REASON.fanoutAggregateUnavailable, "fan-out promotions need the aggregate gate", "Compose `createFanoutAggregateGate` into the promotion service.", input.fanoutId);
			const aggregate = await d.aggregate.evaluate({ fanoutId: input.fanoutId, freight }, ctx);
			if (!aggregate.ok) {
				metric(PROMOTION_METRIC.refused, ctx.now(), { reason: aggregate.reasons[0]?.code ?? "" });
				return aggregate;
			}
		}
		const node = lineaged.value;
		const proposal = input.proposal === true || authz.value.proposalOnly;
		const promotion = create(PromotionRecordSchema, {
			schemaVersion: PROMOTION_SCHEMA,
			promotionId,
			freightId: input.freightId,
			sourceCampId: input.sourceCampId ?? "",
			targetCampIds: [...input.targets],
			pipeline: input.pipeline ?? "",
			node: input.node ?? "",
			state: PromotionState.QUEUED,
			requestedBy: principalName(ctx.principal),
			requestedAt: iso(ctx.now()),
			strategy: input.strategy ?? node?.strategy ?? RolloutStrategy.UNSPECIFIED,
			proposal,
			idempotencyKey: input.idempotencyKey,
			fanoutId: input.fanoutId ?? "",
			subject: rail ? FreightSubject.RAIL : FreightSubject.BINDLE,
			gateDecisionId: "",
		});
		const events = [
			{ type: CD_EVENTS.EnvPromoteRequested, data: body(PromotionRecordSchema, promotion), idempotencyKey: "request" },
			{ type: SAGA_FACT.started, data: toJsonValue(startedFact(promotionId, intent).data), idempotencyKey: "saga:started" },
			...(preview
				? [{ type: CD_EVENTS.EnvCloned, data: body(PreviewEnvironmentRecordSchema, preview), idempotencyKey: "preview:cloned" }]
				: []),
		];
		const appended = await appendAll({ store: d.store, streamId: CD_STREAMS.promotion(promotionId), events, tenant: d.tenant, actor: ctx.principal });
		if (!appended)
			return refusal(PROMOTION_REASON.journalConflict, `promotion ${promotionId} could not be journaled`, "Retry with the same idempotency key.", promotionId);
		metric(PROMOTION_METRIC.requested, ctx.now(), { intent, subject: rail ? "RAIL" : "BINDLE", proposal: String(proposal) });
		await advance(promotionId, ctx);
		return { ok: true, value: (await record(promotionId)) ?? promotion };
	}

	// ── Public surface ─────────────────────────────────────────────────────
	const service: PromotionService & PreviewEnvironments = {
		promote(input, ctx) {
			return request(input, promotionIdFor(d.tenant, input.idempotencyKey), ctx);
		},

		async rollback(input, ctx) {
			const rollbackId = rollbackIdFor(d.tenant, input.idempotencyKey);
			const existing = await load(rollbackId);
			if (existing) return { ok: true, value: recordOf(existing.view) };
			const authz = await d.authorizer.authorize("rollback", { campId: input.campId, reason: input.reason, toSetId: input.toSetId ?? "" }, ctx);
			if (!authz.ok) return authz;
			if (authz.value.proposalOnly)
				return { ok: false, reasons: [reason(PROMOTION_REASON.unauthorized, `${principalName(ctx.principal)} may only propose a rollback`, "Ask an operator with the rollback grant to run it (ADR-0094).", input.campId)] };
			const all = await views();
			const latest = [...all].reverse().find((v) => !v.rolledBack && v.camps.get(input.campId)?.steps.has(STEP.applied));
			const progress = latest?.camps.get(input.campId);
			// D11: never roll back past a completed Trails contract.
			const current = await d.desired.current(input.campId);
			for (const v of all) {
				const p = v.camps.get(input.campId);
				const contracted = p?.steps.get(STEP.contracted)?.handle;
				if (contracted && p?.steps.get(STEP.applied)?.handle === current?.setId)
					return {
						ok: false,
						reasons: [
							reason(
								PROMOTION_REASON.rollbackPastContract,
								`Camp ${input.campId} completed Trails contract of migration ${contracted}; the predecessor Set expects the old data shape`,
								`Run the compensating Trails expand for migration ${contracted} (re-add the contracted shape), then roll back.`,
								input.campId,
							),
						],
					};
			}
			let restoredFreight = current?.freightId ?? "";
			let gateDecisionId = "";
			const freight = latest ? await d.freight.get(asFreight(latest.request.freightId)) : undefined;
			if (latest && progress && freight && isRail(freight) && !input.toSetId) {
				const restored = await restoreCamp(latest, progress, input.reason, ctx);
				if (!restored.ok) return restored;
				restoredFreight = latest.request.freightId;
			} else {
				if (latest && progress && progress.terminal === undefined) {
					const rolloutId = progress.steps.get(STEP.rollout)?.handle;
					if (rolloutId) await d.rollouts.rollback({ rolloutId: asRollout(rolloutId), reason: input.reason }, ctx);
				}
				const restored = await rollbackSet(input.campId, "", input.toSetId, ctx);
				if (!restored.ok) return restored;
				restoredFreight = restored.value.freightId;
				gateDecisionId = restored.value.gateDecisionId;
			}
			if (latest && progress && progress.terminal === undefined) {
				await appendStep(latest, input.campId, STEP.compensated, `rollback ${rollbackId}`, ctx);
				await appendOutcome(latest, input.campId, CD_EVENTS.EnvPromoteRejected, PromotionState.FAILED, [reason(PROMOTION_REASON.compensated, `rolled back by ${principalName(ctx.principal)}: ${input.reason}`, "Promote again when the cause is fixed.", input.campId)], ctx);
			}
			const rolled = create(PromotionRecordSchema, {
				schemaVersion: PROMOTION_SCHEMA,
				promotionId: rollbackId,
				freightId: restoredFreight,
				targetCampIds: [input.campId],
				state: PromotionState.ROLLED_BACK,
				requestedBy: principalName(ctx.principal),
				requestedAt: iso(ctx.now()),
				idempotencyKey: input.idempotencyKey,
				gateDecisionId,
				reasons: [reason("rollback", input.reason, "Promote again when the cause is fixed.", input.campId)],
				subject: freight && isRail(freight) ? FreightSubject.RAIL : FreightSubject.BINDLE,
			});
			await appendOnce({ store: d.store, streamId: CD_STREAMS.promotion(rollbackId), type: CD_EVENTS.EnvPromoteRolledBack, data: body(PromotionRecordSchema, rolled), idempotencyKey: "rolled-back", tenant: d.tenant, actor: ctx.principal });
			metric(PROMOTION_METRIC.rolledBack, ctx.now(), { camp: input.campId });
			return { ok: true, value: rolled };
		},

		async approve(promotionId, ctx) {
			const loaded = await load(promotionId);
			if (!loaded)
				return { ok: false, reasons: [reason(PROMOTION_REASON.notFound, `promotion ${promotionId} is not recorded`, "List promotions with PromotionService.list.", promotionId)] };
			const authz = await d.authorizer.authorize("approve", { promotionId }, ctx);
			if (!authz.ok) return authz;
			if (authz.value.proposalOnly)
				return { ok: false, reasons: [reason(PROMOTION_REASON.unauthorized, `${principalName(ctx.principal)} may only propose; approval needs a human or granted principal`, "Ask an operator with the approve grant (ADR-0094).", promotionId)] };
			const waiting = [...loaded.view.camps.values()].filter(
				(p) => p.terminal === undefined && p.steps.has(STEP.approvalRequested) && !p.steps.has(STEP.approved),
			);
			if (waiting.length === 0)
				return { ok: false, reasons: [reason(PROMOTION_REASON.notAwaitingApproval, `promotion ${promotionId} is not awaiting approval`, "Approve only promotions in AWAITING_APPROVAL.", promotionId)] };
			for (const p of waiting) await appendStep(loaded.view, p.campId, STEP.approved, principalName(ctx.principal), ctx);
			await advance(promotionId, ctx);
			return { ok: true, value: (await record(promotionId)) ?? recordOf(loaded.view) };
		},

		get(promotionId) {
			return record(promotionId);
		},

		async list(query) {
			const all = await views();
			const filtered = all
				.filter((v) => !query?.campId || v.camps.has(query.campId) || v.request.targetCampIds.includes(query.campId))
				.reverse()
				.map(recordOf);
			return query?.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
		},

		async tick(ctx) {
			const all = await views();
			for (const view of all) {
				if (view.rolledBack || view.sagaCompleted) continue;
				await advance(view.promotionId, ctx, all);
			}
		},

		async createPreview(input, ctx) {
			if (input.ttlMs <= 0 || input.idempotencyKey === "")
				return { ok: false, reasons: [reason(PROMOTION_REASON.previewInvalid, "a preview needs a positive TTL and an idempotency key", "Pass ttlMs > 0 (the node's preview_ttl_ms) and a stable key.", input.sourceCampId)] };
			const promotionId = previewPromotionIdFor(d.tenant, input.idempotencyKey);
			const campId = previewCampIdFor(d.tenant, input.sourceCampId, input.idempotencyKey);
			const existing = await load(promotionId);
			if (existing?.view.preview) return { ok: true, value: existing.view.preview };
			const freight = await d.freight.get(input.freightId);
			const preview = create(PreviewEnvironmentRecordSchema, {
				campId,
				sourceCampId: input.sourceCampId,
				freightId: input.freightId,
				ttlMs: BigInt(input.ttlMs),
				expiresAt: iso(ctx.now() + input.ttlMs),
				createdBy: principalName(ctx.principal),
				...(freight?.manifest?.source ? { source: freight.manifest.source } : {}),
				pipeline: input.pipeline ?? "",
				node: input.node ?? "",
			});
			const requested = await request(
				{
					freightId: input.freightId,
					targets: [campId],
					idempotencyKey: input.idempotencyKey,
					sourceCampId: input.sourceCampId,
					intent: "preview",
					...(input.pipeline === undefined ? {} : { pipeline: input.pipeline }),
					...(input.node === undefined ? {} : { node: input.node }),
				},
				promotionId,
				ctx,
				preview,
			);
			if (!requested.ok) return requested;
			metric(PROMOTION_METRIC.previewCreated, ctx.now(), { source: input.sourceCampId });
			return { ok: true, value: preview };
		},

		async expirePreviews(ctx) {
			const expired: PreviewEnvironmentRecord[] = [];
			for (const view of await views()) {
				const preview = view.preview;
				if (!preview || view.previewExpired) continue;
				if ((msOf(preview.expiresAt) ?? Number.POSITIVE_INFINITY) > ctx.now()) continue;
				const campId = asCamp(preview.campId);
				const progress = view.camps.get(campId);
				if (progress && progress.terminal === undefined)
					await appendOutcome(view, campId, CD_EVENTS.EnvPromoteRejected, PromotionState.FAILED, [reason(PROMOTION_REASON.previewInvalid, `preview ${campId} expired before it was promoted`, "Create a new preview with a longer TTL.", campId)], ctx);
				const torn = await teardown(campId, ctx);
				if (!torn.ok) {
					metric(PROMOTION_METRIC.refused, ctx.now(), { reason: PROMOTION_REASON.previewTeardownRefused, camp: campId });
					continue;
				}
				await appendOnce({ store: d.store, streamId: CD_STREAMS.promotion(view.promotionId), type: CD_EVENTS.EnvExpired, data: body(PreviewEnvironmentRecordSchema, preview), idempotencyKey: "preview:expired", tenant: d.tenant, actor: ctx.principal });
				metric(PROMOTION_METRIC.previewExpired, ctx.now(), { source: preview.sourceCampId });
				expired.push(preview);
			}
			return expired;
		},

		async listPreviews() {
			return (await views()).filter((v) => v.preview && !v.previewExpired).flatMap((v) => (v.preview ? [v.preview] : []));
		},
	};

	/** Teardown Delta for an expired preview Camp: intent `down`, through the same gate. */
	async function teardown(campId: CampId, ctx: CdContext): Promise<Outcome<true>> {
		const current = await d.desired.current(campId);
		if (!current || current.origin === SetOrigin.TEARDOWN) return { ok: true, value: true };
		const freight = await d.freight.get(asFreight(current.freightId));
		if (!freight) return { ok: false, reasons: [reason(PROMOTION_REASON.freightUnknown, `Freight ${current.freightId} of preview ${campId} is not recorded`, "Restore the Freight record; the teardown retries on the next sweep.", campId)] };
		const resolved = await d.resolver.resolve({ freight, campId, intent: "down", base: current }, ctx);
		if (!resolved.ok) return resolved;
		const delta = resolved.value.delta;
		if (!(await d.desired.get(asDelta(delta.deltaId)))) {
			const opened = await d.desired.open(delta, ctx);
			if (!opened.ok) return opened;
		}
		const verdict = await d.gate.evaluate({ intent: "down", delta, freight, resolved: resolved.value.resolved, windows: [], current }, ctx);
		if (verdict.effect === "deny" || windowClosed(verdict, "down"))
			return { ok: false, reasons: [reason(PROMOTION_REASON.previewTeardownRefused, `teardown of preview ${campId} was refused by the gate`, "Fix the gate causes; the sweep retries.", campId), ...verdict.reasons] };
		const sealed = sealResolved(resolved.value.resolved, {
			decision: verdict.effect === "allow-degraded" ? "allow-degraded" : "allow",
			decisionId: verdict.decisionId,
			obligations: verdict.obligations.map((o) => o.id),
			decidedAtMs: ctx.now(),
		});
		const applied = await d.desired.apply({ deltaId: asDelta(delta.deltaId), gateDecisionId: verdict.decisionId, resolved: sealed, origin: SetOrigin.TEARDOWN }, ctx);
		return applied.ok ? { ok: true, value: true } : applied;
	}

	return service;
}
