// Reference fleet adapters (placement, fan-out, posture, inventory) and their
// harnesses. Small and deterministic; each mutant breaks one fleet invariant.
import {
	CD_CONDITION_STATUS,
	CD_CONDITION_TYPE,
	CD_FANOUT_STATE,
	CD_FANOUT_STRATEGY,
	CD_REFUSAL,
	CD_SIGNAL_SOURCE,
	CD_TAINT_EFFECT,
	type CampInventoryHarness,
	type CampStatusLike,
	type CdOutcomeLike,
	type FanoutControllerHarness,
	type FanoutScenario,
	type FanoutStatusLike,
	type PlacementDecisionLike,
	type PlacementEngineHarness,
	type PlacementScenario,
	type PostureClauseLike,
	type PostureEvaluationLike,
	type PostureEvaluatorHarness,
	type PostureResourceLike,
	type PostureRuleLike,
	type ScenarioCamp,
	cdCanonicalText,
} from "@hobo/conformance";
import { ManualClock, ok, type RefCtx, refCtx, refuse, sha256 } from "./common.js";

// ── Placement ────────────────────────────────────────────────────────────────

export type PlacementMutant = "order-sensitive" | "claims-grant" | "extrapolates-scores";

export function referenceDecide(scenario: PlacementScenario, order: readonly string[], mutant?: PlacementMutant): CdOutcomeLike<PlacementDecisionLike> {
	const byId = new Map(scenario.camps.map((camp) => [camp.campId, camp]));
	const registered = order.map((id) => byId.get(id)).filter((camp): camp is ScenarioCamp => camp !== undefined);
	const spec = scenario.placement;
	const scores = scenario.scores.filter((s) => mutant === "extrapolates-scores" || s.validUntilMs > scenario.nowMs);
	const scoreOf = (campId: string) =>
		(spec.scores ?? []).reduce((sum, w) => sum + w.weight * (scores.find((s) => s.score === w.score)?.byCamp[campId] ?? 0), 0);
	const exclusions = new Map<string, string[]>();
	for (const camp of registered) {
		const codes: string[] = [];
		if (camp.management === "OBSERVE_ONLY") codes.push("observe-only");
		if ((camp.taints ?? []).includes("NO_PLACE")) codes.push("taint:no-place");
		for (const claim of spec.requiredClaims ?? []) if (camp.claims?.[claim] === undefined) codes.push(`missing-claim:${claim}`);
		const regions = mutant === "claims-grant" && camp.claims?.region ? [camp.claims.region] : camp.regions;
		if ((spec.residencyRegions ?? []).length > 0 && !regions.some((r) => spec.residencyRegions?.includes(r))) codes.push("residency");
		exclusions.set(camp.campId, codes);
	}
	const index = new Map(registered.map((camp, i) => [camp.campId, i]));
	const eligible = registered
		.filter((camp) => (exclusions.get(camp.campId) ?? []).length === 0)
		.sort((a, b) => scoreOf(b.campId) - scoreOf(a.campId) || (mutant === "order-sensitive" ? (index.get(a.campId) ?? 0) - (index.get(b.campId) ?? 0) : a.campId.localeCompare(b.campId)));
	const count = spec.count === 0 ? eligible.length : spec.count;
	const key = (camp: ScenarioCamp, topology: string) => (topology === "provider" ? camp.provider : topology === "yard" ? camp.yard : (camp.regions[0] ?? ""));
	const chosen: ScenarioCamp[] = [];
	for (const spread of spec.spread ?? []) {
		const values = new Set(eligible.map((camp) => key(camp, spread.topologyKey)));
		if (values.size < spread.minGroups || count < spread.minGroups) {
			return refuse(CD_REFUSAL.placementUnsatisfiable, `spread ${spread.topologyKey} min ${spread.minGroups} over ${values.size} distinct value(s)`, "add Camps in more distinct topology values or lower min_groups");
		}
		const seen = new Set(chosen.map((camp) => key(camp, spread.topologyKey)));
		for (const camp of eligible) {
			if (seen.size >= spread.minGroups) break;
			if (!seen.has(key(camp, spread.topologyKey)) && !chosen.includes(camp)) {
				chosen.push(camp);
				seen.add(key(camp, spread.topologyKey));
			}
		}
	}
	for (const camp of eligible) if (chosen.length < count && !chosen.includes(camp)) chosen.push(camp);
	const ranked = eligible.filter((camp) => chosen.includes(camp));
	for (const camp of registered) if (!ranked.includes(camp) && (exclusions.get(camp.campId) ?? []).length === 0) exclusions.set(camp.campId, ["not-ranked"]);
	const size = spec.defaultGroupSize ?? ranked.length;
	const groups = [];
	for (let i = 0; i < ranked.length; i += Math.max(1, size)) groups.push({ name: `group-${groups.length}`, campIds: ranked.slice(i, i + Math.max(1, size)).map((c) => c.campId) });
	const inventory = [...registered].sort((a, b) => a.campId.localeCompare(b.campId));
	return ok({
		inventoryDigest: sha256(cdCanonicalText(mutant === "order-sensitive" ? registered : inventory)),
		scoreSnapshotDigests: scores.map((s) => sha256(cdCanonicalText(s))).sort(),
		groups,
		candidates: inventory.map((camp) => ({ campId: camp.campId, selected: ranked.includes(camp), exclusionCodes: ranked.includes(camp) ? [] : (exclusions.get(camp.campId) ?? []) })),
		reasons: [],
	});
}

export function refPlacementHarness(mutant?: PlacementMutant): PlacementEngineHarness {
	return { subject: mutant ? `reference-placement[${mutant}]` : "reference-placement", decide: async (scenario, order) => referenceDecide(scenario, order, mutant) };
}

// ── Fan-out ──────────────────────────────────────────────────────────────────

export type FanoutMutant = "unbounded" | "defer-as-failure" | "eager-groups" | "non-idempotent";

export function referenceFanout(scenario: FanoutScenario, mutant?: FanoutMutant) {
	const started: string[] = [];
	const inFlight = new Set<string>();
	const succeeded: string[] = [];
	const failed: string[] = [];
	const deferred: string[] = [];
	let state: number = CD_FANOUT_STATE.RUNNING;
	let groupIndex = 0;
	let starts = 1;
	const perGroup = scenario.strategy === CD_FANOUT_STRATEGY.PROGRESSIVE_PER_GROUP;
	const queue = (): readonly string[] => (perGroup ? (scenario.groups[groupIndex]?.campIds ?? []) : scenario.camps);
	const resolved = (id: string) => succeeded.includes(id) || failed.includes(id) || deferred.includes(id);
	const status = (): FanoutStatusLike => ({
		fanoutId: "fanout-1",
		state,
		inFlight: [...inFlight],
		succeeded: [...succeeded],
		failed: [...failed],
		deferred: [...deferred],
		pending: scenario.camps.filter((id) => !resolved(id) && !inFlight.has(id)),
	});
	const tick = async () => {
		if (state !== CD_FANOUT_STATE.RUNNING) return;
		for (const id of inFlight) (scenario.outcomes[id] === "fail" ? failed : succeeded).push(id);
		inFlight.clear();
		const mandatoryFailed = scenario.groups.some((g) => g.mandatory && g.campIds.some((id) => failed.includes(id)));
		if (failed.length > scenario.maxFailures || mandatoryFailed) {
			state = CD_FANOUT_STATE.HALTED;
			return;
		}
		const limit = mutant === "unbounded" ? Number.POSITIVE_INFINITY : scenario.maxConcurrency;
		const candidates = mutant === "eager-groups" ? scenario.camps : queue();
		for (const id of candidates) {
			if (inFlight.size >= limit) break;
			if (resolved(id) || inFlight.has(id)) continue;
			if (scenario.outcomes[id] === "defer") {
				(mutant === "defer-as-failure" ? failed : deferred).push(id);
				continue;
			}
			started.push(id);
			inFlight.add(id);
		}
		if (perGroup && queue().every(resolved) && inFlight.size === 0) groupIndex += 1;
		if (scenario.camps.every(resolved) && inFlight.size === 0) state = CD_FANOUT_STATE.COMPLETED;
	};
	return {
		status: async () => status(),
		tick,
		started: () => [...started],
		startAgain: async () => {
			starts += 1;
			return mutant === "non-idempotent" ? `fanout-${starts}` : "fanout-1";
		},
	};
}

export function refFanoutHarness(mutant?: FanoutMutant): FanoutControllerHarness {
	return { subject: mutant ? `reference-fanout[${mutant}]` : "reference-fanout", start: async (scenario) => referenceFanout(scenario, mutant) };
}

// ── Posture ──────────────────────────────────────────────────────────────────

export type PostureMutant = "unknown-passes" | "unbounded-observed";

function semver(text: string): readonly number[] | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function clause(c: PostureClauseLike, attributes: Readonly<Record<string, string>>): boolean | undefined {
	const present = Object.hasOwn(attributes, c.field);
	if (c.op === "exists") return present;
	if (c.op === "absent") return !present;
	if (!present) return undefined;
	const v = attributes[c.field] ?? "";
	if (c.op === "in") return c.values.includes(v);
	if (c.op === "not-in") return !c.values.includes(v);
	if (c.op === "eq") return v === c.value;
	if (c.op === "neq") return v !== c.value;
	if (c.op === "semver-gte") {
		const a = semver(v);
		const b = semver(c.value);
		if (!a || !b) return undefined;
		const diff = a.map((n, i) => n - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;
		return diff >= 0;
	}
	if (c.op !== "lt" && c.op !== "lte" && c.op !== "gt" && c.op !== "gte") return undefined;
	const left = Number(v);
	const right = Number(c.value);
	if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
	if (c.op === "lt") return left < right;
	if (c.op === "lte") return left <= right;
	if (c.op === "gt") return left > right;
	return left >= right;
}

export function referenceEvaluate(rules: readonly PostureRuleLike[], observation: Readonly<{ resources: readonly PostureResourceLike[] }>, mutant?: PostureMutant): PostureEvaluationLike {
	const findings: { rule: string; resource: string; state: "compliant" | "noncompliant" | "unknown" | "not-applicable"; observed: string }[] = [];
	for (const rule of rules) {
		const matched = observation.resources.filter((r) => (rule.kinds.length === 0 || rule.kinds.includes(r.kind)) && (rule.classifications.length === 0 || rule.classifications.includes(r.classification)));
		if (matched.length === 0) findings.push({ rule: rule.id, resource: "", state: "not-applicable", observed: "" });
		for (const r of matched) {
			const outcomes = [...rule.require.map((c) => clause(c, r.attributes)), ...rule.forbid.map((c) => { const hit = clause(c, r.attributes); return hit === undefined ? undefined : !hit; })];
			const state = outcomes.includes(false) ? "noncompliant" : outcomes.includes(undefined) ? (mutant === "unknown-passes" ? "compliant" : "unknown") : "compliant";
			const fields = [...rule.require, ...rule.forbid].map((c) => c.field);
			const observed = fields.map((f) => `${f}=${r.attributes[f] ?? "<absent>"}`).join(",");
			findings.push({ rule: rule.id, resource: r.resource, state, observed: mutant === "unbounded-observed" ? observed : observed.slice(0, 256) });
		}
	}
	findings.sort((a, b) => `${a.rule}\u0000${a.resource}`.localeCompare(`${b.rule}\u0000${b.resource}`));
	const applicable = findings.filter((f) => f.state !== "not-applicable");
	const bad = applicable.filter((f) => f.state !== "compliant").length;
	const state = applicable.length === 0 ? "not-applicable" : applicable.some((f) => f.state === "noncompliant") ? "noncompliant" : bad > 0 ? "unknown" : "compliant";
	return { state, noncompliantRatio: applicable.length === 0 ? 0 : bad / applicable.length, findings };
}

export function refPostureHarness(mutant?: PostureMutant): PostureEvaluatorHarness {
	return { subject: mutant ? `reference-posture[${mutant}]` : "reference-posture", evaluate: (rules, observation) => referenceEvaluate(rules, observation, mutant) };
}

// ── Inventory ────────────────────────────────────────────────────────────────

export type InventoryMutant = "agent-no-run" | "order-digest" | "accepts-agent-no-run";
type Condition = Readonly<{ type: number; status: number; source: number; reason: string }>;
type Claim = Readonly<{ name: string; value: string; reportedBy: string }>;
type Taint = Readonly<{ key: string; effect: number; source: number; reason: string }>;
const UNREACHABLE_AFTER_MS = 90_000;

export function refInventoryHarness(mutant?: InventoryMutant): CampInventoryHarness<Condition, Claim, Taint, RefCtx> {
	return {
		subject: mutant ? `reference-inventory[${mutant}]` : "reference-inventory",
		unreachableAfterMs: UNREACHABLE_AFTER_MS,
		condition: (type, status, source, why) => ({ type, status, source, reason: why }),
		claim: (name, value, reportedBy) => ({ name, value, reportedBy }),
		taint: (key, effect, source, why) => ({ key, effect, source, reason: why }),
		ctx: (principal) => refCtx(undefined, principal === "agent" ? "agent:rec-1" : "operator:alice"),
		create: async (camps) => {
			const clock = new ManualClock();
			const lastContact = new Map<string, number>();
			const agentUnreachable = new Map<string, number>();
			const statuses = new Map<string, { conditions: Condition[]; claims: Claim[]; taints: Taint[] }>();
			for (const camp of camps) statuses.set(camp.campId, { conditions: [], claims: [], taints: [] });
			const view = (campId: string): CampStatusLike | undefined => {
				const s = statuses.get(campId);
				return s ? { campId, conditions: [...s.conditions], claims: [...s.claims], taints: [...s.taints] } : undefined;
			};
			const setCondition = (campId: string, c: Condition) => {
				const s = statuses.get(campId);
				if (s) s.conditions = [...s.conditions.filter((x) => !(x.type === c.type && x.source === c.source)), c].sort((a, b) => a.type - b.type || a.source - b.source);
			};
			const setTaint = (campId: string, key: string, present: boolean, why: string) => {
				const s = statuses.get(campId);
				if (!s) return;
				s.taints = s.taints.filter((t) => t.key !== key);
				if (present) s.taints = [...s.taints, { key, effect: CD_TAINT_EFFECT.NO_PLACE, source: CD_SIGNAL_SOURCE.STATION, reason: why }].sort((a, b) => a.key.localeCompare(b.key));
			};
			const inventory = {
				status: async (campId: string) => view(campId),
				observe: async (input: Readonly<{ campId: string; source: number; conditions: readonly Condition[]; claims: readonly Claim[] }>): Promise<CdOutcomeLike<CampStatusLike>> => {
					const s = statuses.get(input.campId);
					if (!s) return refuse("camp-unknown", `no Camp ${input.campId}`, "declare the Camp in topology first");
					for (const c of input.conditions) {
						setCondition(input.campId, { ...c, source: input.source });
						if (c.type === CD_CONDITION_TYPE.REACHABLE && c.status === CD_CONDITION_STATUS.FALSE && input.source === CD_SIGNAL_SOURCE.RECONCILER) {
							agentUnreachable.set(input.campId, (agentUnreachable.get(input.campId) ?? 0) + 1);
						}
					}
					if (input.claims.length > 0) s.claims = [...input.claims].sort((a, b) => a.name.localeCompare(b.name));
					return ok(view(input.campId) ?? { campId: input.campId, conditions: [], claims: [], taints: [] });
				},
				taint: async (input: Readonly<{ campId: string; taint: Taint }>): Promise<CdOutcomeLike<CampStatusLike>> => {
					const s = statuses.get(input.campId);
					if (!s) return refuse("camp-unknown", `no Camp ${input.campId}`, "declare the Camp in topology first");
					if (input.taint.effect === CD_TAINT_EFFECT.NO_RUN && input.taint.source !== CD_SIGNAL_SOURCE.OPERATOR && mutant !== "accepts-agent-no-run") {
						return refuse("taint-source-forbidden", "only an operator or a Rail-permitted multi-signal rule may add NO_RUN", "ask an operator to taint the Camp (camp.taint)");
					}
					s.taints = [...s.taints.filter((t) => t.key !== input.taint.key), input.taint].sort((a, b) => a.key.localeCompare(b.key));
					return ok(view(input.campId) ?? { campId: input.campId, conditions: [], claims: [], taints: [] });
				},
				untaint: async (input: Readonly<{ campId: string; key: string; effect: number }>): Promise<CdOutcomeLike<CampStatusLike>> => {
					const s = statuses.get(input.campId);
					if (!s) return refuse("camp-unknown", `no Camp ${input.campId}`, "declare the Camp in topology first");
					s.taints = s.taints.filter((t) => !(t.key === input.key && t.effect === input.effect));
					return ok(view(input.campId) ?? { campId: input.campId, conditions: [], claims: [], taints: [] });
				},
				snapshot: async () => {
					const listed = mutant === "order-digest" ? camps : [...camps].sort((a, b) => a.campId.localeCompare(b.campId));
					const views = listed.map((camp) => ({ topology: { campId: camp.campId, regions: [...camp.regions] }, status: view(camp.campId) }));
					return { digest: sha256(cdCanonicalText(views)), camps: views };
				},
				tick: async () => {
					for (const camp of camps) {
						const seen = lastContact.get(camp.campId);
						const reachable = seen !== undefined && clock.now() - seen <= UNREACHABLE_AFTER_MS;
						setCondition(camp.campId, { type: CD_CONDITION_TYPE.REACHABLE, status: reachable ? CD_CONDITION_STATUS.TRUE : CD_CONDITION_STATUS.FALSE, source: CD_SIGNAL_SOURCE.STATION, reason: reachable ? "lease activity" : "no lease activity" });
						setTaint(camp.campId, "hobo.cd/unreachable", !reachable, "no Station-observed contact");
						const claimed = statuses.get(camp.campId)?.claims.find((c) => c.name === "region")?.value;
						const consistent = claimed === undefined || camp.regions.includes(claimed);
						setCondition(camp.campId, { type: CD_CONDITION_TYPE.CLAIMS_CONSISTENT, status: consistent ? CD_CONDITION_STATUS.TRUE : CD_CONDITION_STATUS.FALSE, source: CD_SIGNAL_SOURCE.STATION, reason: consistent ? "claims match topology" : `claimed region ${claimed}` });
						setTaint(camp.campId, "hobo.cd/claims-inconsistent", !consistent, "claims contradict declared topology");
						if (mutant === "agent-no-run" && (agentUnreachable.get(camp.campId) ?? 0) >= 3) {
							const s = statuses.get(camp.campId);
							if (s && !s.taints.some((t) => t.effect === CD_TAINT_EFFECT.NO_RUN)) s.taints.push({ key: "hobo.cd/agent-down", effect: CD_TAINT_EFFECT.NO_RUN, source: CD_SIGNAL_SOURCE.RECONCILER, reason: "agent says so" });
						}
					}
				},
			};
			return {
				inventory,
				advance: (ms: number) => clock.advance(ms),
				contact: async (campId: string) => {
					lastContact.set(campId, clock.now());
				},
				campSet: "all",
			};
		},
	};
}
