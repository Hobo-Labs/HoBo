// DeployGate over the existing Gatekeeper (`@hobo/contracts`
// `evaluateGatekeeper`): policy pack of the Camp's enforced Rail, can-deploy
// compatibility, provenance and trust freshness (`@hobo/trust`), residency
// (`@hobo/core` `evaluateResidency`, fail-closed, declared regions only),
// posture ownership conflicts (I22) and change windows. While a candidate
// Rail is bound in INFORM, the same inputs are evaluated with the candidate
// pack, the shadow decision is recorded through `ShadowRecorder`, and the
// verdict carries `shadow` — the enforced Rail alone decides (I23).
//
// `createFanoutAggregateGate` is the D20 aggregate check: the Camp count of a
// fan-out's placement decision against the Rail `max_fanout_camps` and the
// Station entitlement, and the summed cost quotes against the Station budget.
import { create } from "@bufbuild/protobuf";
import type { ResolvedDeploymentSet } from "@hobo/cloud";
import {
	type BoundaryContract,
	type CostQuotaInput,
	createPermissiveDefaultPack,
	evaluateGatekeeper,
	type GatekeeperDecision,
	type GatekeeperEffect,
	type PolicyPack,
	type ResidencyGateVerdict,
} from "@hobo/contracts";
import { evaluateResidency, type JurisdictionId } from "@hobo/core";
import {
	evaluateTrustBundle,
	type TrustEvidence,
	type TrustRequirement,
} from "@hobo/trust";
import {
	type DeltaRecord,
	type FreightRecord,
	ObligationRefSchema,
	type ReasonRecord,
	type SetRecord,
	ShadowDecisionRecordSchema,
} from "../_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	FANOUT_BUDGET_EXCEEDED,
	OWNERSHIP_CONFLICT,
} from "../events.js";
import { previewSourceOf } from "../promotion/ids.js";
import { digestOf, emitMetric, iso } from "../promotion/journal.js";
import { PROMOTION_METRIC, reason } from "../promotion/reasons.js";
import type {
	CampId,
	CampPolicy,
	CampTopology,
	CdBase,
	CdContext,
	ChangeWindows,
	DeployGate,
	Digest,
	FanoutController,
	FanoutId,
	GateVerdict,
	Outcome,
	PlacementEngine,
	PlacementSubject,
	PostureService,
	RailDeliveryReader,
	ShadowRecorder,
	ShadowVerdict,
	TelemetrySink,
	TopologyReader,
} from "../ports.js";

// public-contract: reason codes the deploy gate adds beside Gatekeeper's own.
export const GATE_REASON = Object.freeze({
	campUnknown: "gate-camp-unknown",
	unknownRunningVersions: "unknown-running-versions",
	provenanceUnverified: "trust-provenance-unverified",
	trustUnfresh: "trust-evidence-unfresh",
	ownershipConflict: OWNERSHIP_CONFLICT,
	residencyNoRegion: "residency-region-undeclared",
	fanoutUnknown: "fanout-aggregate-unknown-fanout",
	fanoutDecisionUnknown: "fanout-aggregate-unknown-decision",
	fanoutBudget: FANOUT_BUDGET_EXCEEDED,
	quoteMissing: "fanout-aggregate-quote-missing",
	budgetMissing: "fanout-aggregate-budget-missing",
} as const);

export type ContractState = Readonly<{
	/** Contracts running in the Camp; undefined when unknown (fail-closed when a Set exists). */
	deployed: readonly BoundaryContract[] | undefined;
	candidate: readonly BoundaryContract[];
}>;

export type EnforcedRail = Readonly<{ railDigest: Digest; policyPack: PolicyPack }>;

export type DeployGateDeps = CdBase & {
	readonly topology: TopologyReader;
	readonly windows: ChangeWindows;
	readonly campPolicy: CampPolicy;
	readonly shadow: ShadowRecorder;
	readonly posture: PostureService;
	/** Policy pack of an enforced Rail digest. */
	readonly resolvePack: (railDigest: Digest) => Promise<PolicyPack>;
	/** The Station's active Rail; used when a Camp has no enforced binding. */
	readonly stationRail: (stationId: string) => Promise<EnforcedRail | undefined>;
	readonly contracts: (
		input: Readonly<{ campId: CampId; freight: FreightRecord; resolved: ResolvedDeploymentSet; current?: SetRecord }>,
	) => Promise<ContractState>;
	/** Data classifications and residency constraints of the Freight's subject. */
	readonly subject: (freight: FreightRecord) => Promise<PlacementSubject>;
	readonly residencyCatalog?: Readonly<Record<string, readonly JurisdictionId[]>>;
	readonly trust?: Readonly<{
		requirement: TrustRequirement;
		evidence: (subjectId: string) => TrustEvidence | undefined;
	}>;
	readonly costQuota?: (campId: CampId) => CostQuotaInput;
	readonly telemetry: TelemetrySink;
};

const REMEDIATION: Readonly<Record<string, string>> = {
	contracts: "Deploy a compatible version first, dual-publish the missing fields, or add a compatibility shim.",
	policy: "Change the declaration to satisfy the Rail's policy, or promote a Rail that permits it.",
	obligations: "Satisfy the pending obligations, then approve the promotion.",
	cost: "Raise the quota through the Station budget authority or reduce the requested resources.",
	residency: "Choose a Camp whose declared Yard regions satisfy the residency constraint.",
};

function toReasons(decision: GatekeeperDecision, campId: string): ReasonRecord[] {
	return decision.reasons
		.filter((r) => r.gate !== "effects" && r.gate !== "resilience")
		.map((r) => {
			const fixes = r.details?.suggestedFixes;
			const remediation =
				Array.isArray(fixes) && fixes.length > 0
					? fixes.map(String).join("; ")
					: (REMEDIATION[r.gate] ?? "Inspect the gate decision and correct the cause.");
			return reason(r.code, r.message, remediation, `${r.gate}:${campId}`);
		});
}

function residencyVerdict(
	subject: PlacementSubject,
	camp: CampTopology,
	catalog: DeployGateDeps["residencyCatalog"],
): ResidencyGateVerdict | undefined {
	const applicable = subject.residency.filter(
		(constraint) =>
			constraint.classifications.length === 0 ||
			constraint.classifications.some((c) => subject.classifications.includes(c)),
	);
	if (applicable.length === 0) return undefined;
	if (camp.regions.length === 0)
		return {
			ok: false,
			reasons: [
				{
					code: GATE_REASON.residencyNoRegion,
					message: `Camp ${camp.campId} declares no Yard region; residency cannot be attested`,
				},
			],
		};
	const reasons: { code: string; message: string; region?: string; jurisdictions?: readonly string[] }[] = [];
	for (const constraint of applicable) {
		for (const region of [...camp.regions].sort()) {
			const result = evaluateResidency({
				constraint,
				region,
				...(catalog === undefined ? {} : { catalog }),
			});
			if (!result.ok)
				reasons.push({
					code: result.code,
					message: result.remediation,
					region: result.region,
					jurisdictions: result.regionJurisdictions,
				});
		}
	}
	return { ok: reasons.length === 0, reasons };
}

function provenanceReasons(freight: FreightRecord, campId: string): ReasonRecord[] {
	const unverified = (freight.manifest?.provenance ?? []).filter((p) => !p.verified);
	return unverified.map((p) =>
		reason(
			GATE_REASON.provenanceUnverified,
			`provenance ${p.statementDigest} of Freight ${freight.freightId} is not verified`,
			"Re-ingest the Freight with a verifiable attestation (Sigstore bundle or HoBo-signed).",
			`trust:${campId}`,
		),
	);
}

function trustReasons(
	trust: DeployGateDeps["trust"],
	resolved: ResolvedDeploymentSet,
	nowMs: number,
	campId: string,
): ReasonRecord[] {
	if (!trust) return [];
	const subjects = [
		...new Set(resolved.plan.resources.map((r) => r.productId ?? r.provider)),
	]
		.sort()
		.map((subjectId) => {
			const evidence = trust.evidence(subjectId);
			return evidence === undefined ? { subjectId } : { subjectId, evidence };
		});
	if (subjects.length === 0) return [];
	const verdict = evaluateTrustBundle({ subjects, requirement: trust.requirement, nowMs });
	if (verdict.selectable) return [];
	const reasons = verdict.subjects
		.filter((s) => !s.verdict.selectable)
		.map((s) =>
			reason(
				GATE_REASON.trustUnfresh,
				`trust evidence for ${s.subjectId} is ${s.freshness.state}: ${s.freshness.detail}`,
				"Refresh the provider's trust evidence (re-run its conformance lane) before promoting.",
				`trust:${campId}`,
			),
		);
	return reasons.length > 0
		? reasons
		: [
				reason(
					GATE_REASON.trustUnfresh,
					"trust bundle is not selectable",
					"Refresh the trust evidence of every product in the plan.",
					`trust:${campId}`,
				),
			];
}

/** Conflicts a Delta keeps: the resource stays in the Set and the Delta does not change it. */
async function ownershipReasons(
	posture: PostureService,
	delta: DeltaRecord,
	resolved: ResolvedDeploymentSet,
	campId: CampId,
): Promise<ReasonRecord[]> {
	const conflicts = (await posture.conflicts(campId)).filter((f) => f.ownershipConflict);
	const present = new Set(resolved.plan.resources.map((r) => r.name));
	const changed = new Set(delta.changes.map((c) => c.resource));
	return conflicts
		.filter((f) => present.has(f.resource) && !changed.has(f.resource))
		.map((f) =>
			reason(
				GATE_REASON.ownershipConflict,
				`posture rule ${f.rule} contradicts the Set-owned value of ${f.resource} (observed ${f.observed}) and this Delta keeps it`,
				`Change the declaration of ${f.resource} to satisfy ${f.rule}, or retire the rule from the Rail's posture packs.`,
				`posture:${campId}`,
			),
		);
}

// public-contract: label a preview Camp carries in gate and window evaluation.
export const PREVIEW_LABEL = "hobo.cd/preview" as const;

/** Declared topology of a Camp; a preview Camp inherits its source Camp's, labelled. */
export async function topologyOf(
	topology: TopologyReader,
	campId: string,
): Promise<CampTopology | undefined> {
	// SAFETY: Delta camp ids are Camp ids by construction (DeltaLedger).
	const declared = await topology.camp(campId as CampId);
	if (declared) return declared;
	const source = previewSourceOf(campId);
	const parent = source ? await topology.camp(source) : undefined;
	if (!parent) return undefined;
	return {
		...parent,
		// SAFETY: a preview Camp id is a Camp id minted by previewCampIdFor.
		campId: campId as CampId,
		labels: { ...parent.labels, [PREVIEW_LABEL]: "true" },
	};
}

export function createDeployGate(d: DeployGateDeps): DeployGate {
	async function enforcedRail(camp: CampTopology): Promise<EnforcedRail | undefined> {
		const binding = await d.campPolicy.binding(camp.campId);
		if (binding && binding.enforcedRailDigest !== "") {
			// SAFETY: binding digests are written by CampPolicy from Rail Freight (sha256:<hex>).
			const digest = binding.enforcedRailDigest as Digest;
			return { railDigest: digest, policyPack: await d.resolvePack(digest) };
		}
		return d.stationRail(camp.stationId);
	}

	function decide(
		pack: PolicyPack,
		base: Omit<Parameters<typeof evaluateGatekeeper>[0], "policyPack">,
		extra: readonly ReasonRecord[],
	): Readonly<{ decision: GatekeeperDecision; effect: GatekeeperEffect }> {
		const decision = evaluateGatekeeper({ ...base, policyPack: pack });
		return { decision, effect: extra.length > 0 ? "deny" : decision.decision };
	}

	return {
		async evaluate(input, ctx: CdContext): Promise<GateVerdict> {
			const campId = input.delta.campId;
			const camp = await topologyOf(d.topology, campId);
			const nowMs = ctx.now();
			if (!camp) {
				const reasons = [
					reason(
						GATE_REASON.campUnknown,
						`Camp ${campId} is not in the declared topology`,
						"Declare the Camp in its Yard before promoting to it.",
						`topology:${campId}`,
					),
				];
				return {
					decisionId: `gate_${digestOf({ campId, deltaId: input.delta.deltaId, reasons: reasons.map((r) => r.code), nowMs }).slice(7, 31)}`,
					effect: "deny",
					obligations: [],
					reasons,
				};
			}
			const subject = await d.subject(input.freight);
			const residency = residencyVerdict(subject, camp, d.residencyCatalog);
			const contracts = await d.contracts({
				campId: camp.campId,
				freight: input.freight,
				resolved: input.resolved,
				...(input.current === undefined ? {} : { current: input.current }),
			});
			const extra: ReasonRecord[] = [
				...provenanceReasons(input.freight, campId),
				...trustReasons(d.trust, input.resolved, nowMs, campId),
				...(await ownershipReasons(d.posture, input.delta, input.resolved, camp.campId)),
			];
			if (contracts.deployed === undefined && input.current !== undefined)
				extra.push(
					reason(
						GATE_REASON.unknownRunningVersions,
						`blocked: unknown running versions for ${campId}; compatibility cannot assume an empty contract state is safe`,
						"Rebuild the Camp's running-contract snapshot from its reconcile observations, then retry.",
						`contracts:${campId}`,
					),
				);
			const base = {
				request: {
					subject: { kind: ctx.principal.kind, id: ctx.principal.id },
					action: `cd.${input.intent}`,
					resource: { kind: "camp", id: campId },
					phase: "deploy",
					context: {
						target: campId,
						intent: input.intent,
						freightId: input.freight.freightId,
						bindle: input.freight.manifest?.bindle ?? "",
						envType: camp.envType,
						stationId: camp.stationId,
						yardId: camp.yardId,
						provider: camp.provider,
					},
				},
				deployedState: { contracts: [...(contracts.deployed ?? [])] },
				candidate: {
					plan: {
						objective: input.resolved.plan.objective,
						resources: input.resolved.plan.resources.map((r) => ({
							name: r.name,
							port: r.port,
							provider: r.provider,
						})),
					},
					contracts: [...contracts.candidate],
				},
				costQuota: d.costQuota?.(camp.campId) ?? {
					quota: "hobo.cd/delta",
					used: 0,
					limit: 1,
					requested: 1,
				},
				...(residency === undefined ? {} : { residency }),
			};
			const enforced = await enforcedRail(camp);
			const enforcedPack = enforced?.policyPack ?? createPermissiveDefaultPack();
			const { decision, effect } = decide(enforcedPack, base, extra);
			const reasons = [...toReasons(decision, campId), ...extra];
			const window = await d.windows.evaluate({
				campId: camp.campId,
				labels: camp.labels,
				envType: camp.envType,
				windowNames: input.windows,
				atMs: nowMs,
				intent: input.intent,
			});
			const decisionId = `gate_${digestOf({
				campId,
				deltaId: input.delta.deltaId,
				intent: input.intent,
				effect,
				rail: enforced?.railDigest ?? "default",
				reasons: reasons.map((r) => [r.code, r.subject]),
				nowMs,
			}).slice(7, 31)}`;
			let shadow: ShadowVerdict | undefined;
			const candidate = await d.shadow.candidate(camp.campId);
			if (candidate) {
				const shadowed = decide(candidate.policyPack, base, extra);
				const diverged = shadowed.effect !== effect;
				const shadowDecisionId = `${decisionId}-shadow`;
				await d.shadow.record(
					create(ShadowDecisionRecordSchema, {
						campId,
						deltaId: input.delta.deltaId,
						enforcedRailDigest: enforced?.railDigest ?? "",
						candidateRailDigest: candidate.railDigest,
						enforcedEffect: effect,
						candidateEffect: shadowed.effect,
						diverged,
						decidedAt: iso(nowMs),
					}),
					ctx,
				);
				shadow = {
					candidateRailDigest: candidate.railDigest,
					decisionId: shadowDecisionId,
					effect: shadowed.effect,
					diverged,
				};
				if (diverged)
					emitMetric(d.telemetry, {
						name: PROMOTION_METRIC.shadowDiverged,
						atMs: nowMs,
						attributes: { tenant: d.tenant, camp: campId, enforced: effect, candidate: shadowed.effect },
					});
			}
			emitMetric(d.telemetry, {
				name: PROMOTION_METRIC.gateDecided,
				atMs: nowMs,
				attributes: { tenant: d.tenant, camp: campId, intent: input.intent, effect, window: window.open ? "open" : "closed" },
			});
			return {
				decisionId,
				effect,
				obligations: decision.obligations.map((o) =>
					create(ObligationRefSchema, {
						id: o.id,
						kind: o.kind,
						satisfied: o.satisfied,
						deadline: o.deadline ?? "",
					}),
				),
				reasons,
				window,
				...(shadow === undefined ? {} : { shadow }),
			};
		},
	};
}

// ── Fan-out aggregate (D20) ────────────────────────────────────────────────

export type StationBudget = Readonly<{ limit: number; used: number }>;

export interface FanoutAggregateGate {
	/** Refuses `fanout-budget-exceeded` before any Camp of the fan-out starts. */
	evaluate(
		input: Readonly<{ fanoutId: FanoutId; freight: FreightRecord }>,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; camps: number; cost: number }>>>;
}

export type FanoutAggregateDeps = Readonly<{
	tenant: string;
	fanout: FanoutController;
	placement: PlacementEngine;
	topology: TopologyReader;
	rails: RailDeliveryReader;
	/** Cost quote for running the Freight in one Camp (the pricing authority). */
	quote: (input: Readonly<{ freight: FreightRecord; campId: CampId }>) => Promise<number | undefined>;
	/** The Station budget (the hosting budget authority); undefined when it has none recorded. */
	budget: (stationId: string) => Promise<StationBudget | undefined>;
	/** Station entitlement for the number of Camps one fan-out may reach. */
	entitlement?: (stationId: string) => Promise<number | undefined>;
	telemetry: TelemetrySink;
}>;

export function createFanoutAggregateGate(d: FanoutAggregateDeps): FanoutAggregateGate {
	const refusal = (code: string, message: string, remediation: string, subject: string) => ({
		ok: false as const,
		reasons: [reason(code, message, remediation, subject)],
	});
	return {
		async evaluate({ fanoutId, freight }, ctx) {
			const status = await d.fanout.get(fanoutId);
			if (!status)
				return refusal(GATE_REASON.fanoutUnknown, `fan-out ${fanoutId} is not recorded`, "Start the fan-out through FanoutController before promoting its Camps.", fanoutId);
			const decision = await d.placement.decision(status.decisionId);
			if (!decision)
				return refusal(GATE_REASON.fanoutDecisionUnknown, `placement decision ${status.decisionId} is not recorded`, "Re-decide the placement; a fan-out only schedules a recorded decision.", fanoutId);
			const selected =
				decision.groups.length > 0
					? decision.groups.flatMap((g) => g.campIds)
					: decision.candidates.filter((c) => c.selected).map((c) => c.campId);
			const campIds = [...new Set(selected)].sort();
			const byStation = new Map<string, CampId[]>();
			for (const id of campIds) {
				// SAFETY: placement decisions name Camp ids.
				const campId = id as CampId;
				const camp = await d.topology.camp(campId);
				const station = camp?.stationId ?? "";
				byStation.set(station, [...(byStation.get(station) ?? []), campId]);
			}
			let totalCost = 0;
			for (const [stationId, camps] of [...byStation.entries()].sort(([a], [b]) => a.localeCompare(b))) {
				const rail = await d.rails.forStation(stationId);
				const railMax = rail && rail.maxFanoutCamps > 0 ? rail.maxFanoutCamps : CD_DEFAULTS.maxFanoutCamps;
				const entitled = (await d.entitlement?.(stationId)) ?? railMax;
				const limit = Math.min(railMax, entitled);
				if (camps.length > limit)
					return refusal(
						GATE_REASON.fanoutBudget,
						`fan-out ${fanoutId} reaches ${camps.length} Camps on Station ${stationId}; the limit is ${limit} (Rail max_fanout_camps ${railMax}, entitlement ${entitled})`,
						"Narrow the placement (count, selector or groups) or raise the Rail's max_fanout_camps through a governed Rail promotion.",
						stationId,
					);
				let cost = 0;
				for (const campId of camps) {
					const quote = await d.quote({ freight, campId });
					if (quote === undefined)
						return refusal(GATE_REASON.quoteMissing, `no cost quote for Camp ${campId}`, "Record a price for the Camp's providers in the pricing catalog; the aggregate never assumes zero cost.", campId);
					cost += quote;
				}
				const budget = await d.budget(stationId);
				if (!budget)
					return refusal(GATE_REASON.budgetMissing, `Station ${stationId} has no budget evidence`, "Record the Station budget with the hosting budget authority before fanning out.", stationId);
				if (budget.used + cost > budget.limit)
					return refusal(
						GATE_REASON.fanoutBudget,
						`fan-out ${fanoutId} costs ${cost} on Station ${stationId}; ${budget.limit - budget.used} of ${budget.limit} remains`,
						"Reduce the placement count, choose cheaper Camps through score weights, or raise the Station budget.",
						stationId,
					);
				totalCost += cost;
			}
			emitMetric(d.telemetry, {
				name: PROMOTION_METRIC.gateDecided,
				atMs: ctx.now(),
				attributes: { tenant: d.tenant, fanout: fanoutId, effect: "allow", scope: "aggregate" },
			});
			return {
				ok: true,
				value: {
					decisionId: `aggregate_${digestOf({ fanoutId, decision: decision.decisionId, campIds, totalCost }).slice(7, 31)}`,
					camps: campIds.length,
					cost: totalCost,
				},
			};
		},
	};
}
