import type {
	MatchDecided,
	PlanRemediation,
	ResourceIntent,
} from "../plan-types.js";
import type {
	PlannerRegistry,
	ResourceDefinition,
} from "../registry/catalog.js";
import type { HostingPlanningPass } from "./hosting-budget.js";
import {
	emptyPlacementContext,
	type PlacementContext,
	pickPlacementRegion,
	placementRejection,
	spreadSurvivors,
} from "./placement.js";
import { assessCostObjective, classifyPriceQuality } from "./price-quality.js";

// Matching (control-plane.md steps 2-5): resolve a Resource Definition per
// resource via context-matching, negotiate the provider Capability.satisfies,
// apply the E19 placement-constraint vocabulary as deterministic hard filters,
// then rank the survivors by the configured objective with a stable tiebreak.
// Deterministic — no solver, no LLM.

export interface MatchAccepted {
	ok: true;
	decision: MatchDecided;
	region: string;
	definition: ResourceDefinition;
}

export interface MatchRejected {
	ok: false;
	remediation: PlanRemediation;
}

export type MatchOutcome = MatchAccepted | MatchRejected;

function marginal(def: ResourceDefinition): number {
	if (def.cost.pricingStatus === "unknown") return Number.POSITIVE_INFINITY;
	if (classifyPriceQuality(def.cost) === "unparseable")
		return Number.POSITIVE_INFINITY;
	const value = Number(def.cost.marginalPrice);
	return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

// Objective ranking: default is min-cost within constraints, then a stable
// tiebreak on definition id (control-plane.md step 5).
function rankByObjective(
	a: ResourceDefinition,
	b: ResourceDefinition,
	objective: string,
): number {
	if (a.specificity !== b.specificity) return b.specificity - a.specificity;
	if (a.priority !== b.priority) return b.priority - a.priority;
	if (objective === "min-cost" || objective === "cost") {
		const left = marginal(a),
			right = marginal(b);
		if (left < right) return -1;
		if (left > right) return 1;
	}
	return a.id.localeCompare(b.id);
}

function pickRegion(intent: ResourceIntent, def: ResourceDefinition): string {
	if (intent.region) return intent.region;
	// Colocation-neutral deterministic choice: the lexicographically smallest
	// advertised region (single-provider plans share a region set).
	const regions = [...def.regions].sort();
	return regions[0] ?? "";
}

export function matchResource(
	intent: ResourceIntent,
	registry: PlannerRegistry,
	placementContext?: PlacementContext,
	hosting?: HostingPlanningPass,
): MatchOutcome {
	const supported =
		intent.objective === "min-cost" ||
		intent.objective === "cost" ||
		(intent.objective === "maximize-credits" && hosting !== undefined);
	if (!supported)
		return {
			ok: false,
			remediation: {
				resource: intent.name,
				code: "placement.unsupported-objective",
				requiredPort: intent.port,
				requiredFeatures: intent.require,
				missing: [],
				remediation: `objective ${intent.objective} requires an implemented ranking contract; maximize-credits requires fresh scoped hosting budget evidence`,
			},
		};
	const context = placementContext ?? emptyPlacementContext();
	const defs = registry.definitions();
	// Context-matching by capability class (the resource's `type` -> port).
	const candidates = defs.filter((def) => def.port === intent.port);

	const accepted: ResourceDefinition[] = [];
	const rejectedCandidates: { definitionId: string; reason: string }[] = [];
	let lastMissing: string[] = [];

	for (const candidate of candidates) {
		const verdict = candidate.satisfies({
			port: intent.port,
			features: intent.require,
		});
		if (verdict.kind === "full") {
			accepted.push(candidate);
		} else if (verdict.kind === "partial") {
			lastMissing = verdict.missing;
			if (intent.negotiation === "prefer") {
				// Degrade: accept with an implicit PlanWarning (control-plane.md step 3).
				accepted.push(candidate);
			} else {
				rejectedCandidates.push({
					definitionId: candidate.id,
					reason: `required features not satisfied: ${verdict.missing.join(", ")}`,
				});
			}
		} else {
			rejectedCandidates.push({
				definitionId: candidate.id,
				reason: "capability verdict none",
			});
		}
	}

	if (accepted.length === 0) {
		// Unsatisfiable: emit machine-readable remediation an agent can act on.
		// First preference: a provider that is INSTALLED but not APPROVED and
		// advertises the port — approval, not registration, is what's missing
		// (walkthrough Part 0/2).
		const heldMatch = registry
			.held?.()
			.find((held) => held.ports.includes(intent.port));
		if (heldMatch) {
			return {
				ok: false,
				remediation: {
					resource: intent.name,
					code: "capability.provider-not-approved",
					requiredPort: intent.port,
					requiredFeatures: intent.require,
					missing: [],
					suggestedProvider: heldMatch.providerId,
					remediation: `provider ${heldMatch.providerId} is installed but not approved; approve it (hobo add ${heldMatch.providerId}) so Matching can consider port ${intent.port}`,
				},
			};
		}
		// Otherwise prefer naming a registered provider that *does* advertise the port.
		const suggestion = defs.find(
			(def) =>
				def.port === intent.port &&
				def.satisfies({ port: intent.port, features: intent.require }).kind !==
					"none",
		);
		const suggestedProvider = suggestion?.providerId;
		const remediation: PlanRemediation = {
			resource: intent.name,
			code:
				candidates.length === 0
					? "capability.port-unavailable"
					: "capability.required-not-satisfied",
			requiredPort: intent.port,
			requiredFeatures: intent.require,
			missing: lastMissing,
			remediation: suggestedProvider
				? `lower requirement to prefer, or select provider ${suggestedProvider} which advertises port ${intent.port}`
				: `no registered provider advertises port ${intent.port} for resource ${intent.name}; register a provider that satisfies it or change the resource capability`,
		};
		if (suggestedProvider !== undefined)
			remediation.suggestedProvider = suggestedProvider;
		return { ok: false, remediation };
	}

	// E19: placement criteria act as deterministic hard filters between
	// capability negotiation and objective ranking — the lexicographic
	// `specificity → priority → objective → definition id` ranking (ADR-0033,
	// ADR-0088) is untouched among the survivors.
	const criteria = intent.placement;
	let survivors = accepted;
	if (criteria !== undefined) {
		survivors = [];
		for (const candidate of accepted) {
			const reason = placementRejection(candidate, criteria, context);
			if (reason === undefined) survivors.push(candidate);
			else rejectedCandidates.push({ definitionId: candidate.id, reason });
		}
		const spreadKept = spreadSurvivors(survivors, intent, context);
		if (spreadKept.length !== survivors.length) {
			const keptIds = new Set(spreadKept.map((c) => c.id));
			for (const candidate of survivors) {
				if (!keptIds.has(candidate.id)) {
					rejectedCandidates.push({
						definitionId: candidate.id,
						reason: "placement: spread across yards prefers a less-loaded yard",
					});
				}
			}
		}
		survivors = spreadKept;
		if (survivors.length === 0) {
			return {
				ok: false,
				remediation: {
					resource: intent.name,
					code: "placement.unsatisfiable",
					requiredPort: intent.port,
					requiredFeatures: intent.require,
					missing: rejectedCandidates
						.filter((entry) => entry.reason.startsWith("placement:"))
						.map((entry) => `${entry.definitionId}: ${entry.reason}`),
					remediation: `no candidate for port ${intent.port} satisfies the placement criteria for resource ${intent.name}; relax the selectors/affinity or register a provider in the required region/yard`,
				},
			};
		}
	}

	const normalizedCosts = new Map<string, number>();
	if (hosting) {
		survivors = survivors.filter((candidate) => {
			const quote = hosting.evaluate(intent.name, candidate);
			if (!quote.ok) {
				rejectedCandidates.push({
					definitionId: candidate.id,
					reason: quote.reason,
				});
				return false;
			}
			normalizedCosts.set(candidate.id, quote.allocation.expectedMicros);
			return true;
		});
		if (survivors.length === 0)
			return {
				ok: false,
				remediation: {
					resource: intent.name,
					code: "budget.no-eligible-offer",
					requiredPort: intent.port,
					requiredFeatures: intent.require,
					missing: rejectedCandidates.map(
						(candidate) => `${candidate.definitionId}: ${candidate.reason}`,
					),
					remediation:
						"no fresh, compatible quote fits the remaining bounded budget allowance; update evidence or explicitly fund a different plan",
				},
			};
	} else if (
		new Set(survivors.map((candidate) => candidate.cost.unit)).size > 1
	) {
		return {
			ok: false,
			remediation: {
				resource: intent.name,
				code: "cost.incomparable-units",
				requiredPort: intent.port,
				requiredFeatures: intent.require,
				missing: [],
				remediation:
					"price units differ; supply hosting budget evidence with a common usage horizon before comparing them",
			},
		};
	}
	const ranked = [...survivors].sort((a, b) => {
		if (!hosting) return rankByObjective(a, b, intent.objective);
		if (a.specificity !== b.specificity) return b.specificity - a.specificity;
		if (a.priority !== b.priority) return b.priority - a.priority;
		return (
			(normalizedCosts.get(a.id) ?? Infinity) -
				(normalizedCosts.get(b.id) ?? Infinity) || a.id.localeCompare(b.id)
		);
	});
	if (criteria?.pickN !== undefined && ranked.length < criteria.pickN.count) {
		return {
			ok: false,
			remediation: {
				resource: intent.name,
				code: "placement.cardinality-unsatisfiable",
				requiredPort: intent.port,
				requiredFeatures: intent.require,
				missing: [],
				remediation: `placement pickN=${criteria.pickN.count} requires at least ${criteria.pickN.count} distinct satisfying candidates for resource ${intent.name}; only ${ranked.length} matched — register more providers advertising port ${intent.port} or lower the cardinality`,
			},
		};
	}
	// SAFETY: `const winner = ranked[0] as ResourceDefinition;` is required at this I/O or test boundary.
	const winner = ranked[0] as ResourceDefinition;
	const region =
		criteria !== undefined
			? pickPlacementRegion(intent, winner, context)
			: pickRegion(intent, winner);
	const losers = ranked
		.slice(1)
		.map((d) => ({ definitionId: d.id, reason: "outranked" }));
	// Tie attribution (ADR-0088): the winner and runner-up compare equal on
	// every objective dimension and are separated only by the definition-id
	// tiebreak — recorded so a winner flip is attributable to a catalog change.
	const runnerUp = ranked[1];
	const costObjective =
		intent.objective === "min-cost" || intent.objective === "cost";
	const tie =
		runnerUp !== undefined &&
		winner.specificity === runnerUp.specificity &&
		winner.priority === runnerUp.priority &&
		(hosting
			? normalizedCosts.get(winner.id) === normalizedCosts.get(runnerUp.id)
			: !costObjective || marginal(winner) === marginal(runnerUp));
	const allRejected = [...rejectedCandidates, ...losers];
	const priceQuality = assessCostObjective({
		objective: intent.objective,
		candidates: survivors,
	});

	const decision: MatchDecided = {
		deploymentId: "",
		resource: intent.name,
		winner: `${winner.providerId}.${winner.port}`,
		providerId: winner.providerId,
		port: winner.port,
		specificity: winner.specificity,
		rejected: allRejected.map((entry) => entry.definitionId),
		rejectedCandidates: allRejected,
		ranking: ranked.map((d) => ({
			definitionId: d.id,
			providerId: d.providerId,
			specificity: d.specificity,
			priority: d.priority,
		})),
		tie,
		objective: intent.objective,
		rationale: hosting
			? "expected incremental cost after shared entitlements; bounded exposure within budget; stable tiebreak=definition-id"
			: !priceQuality.claimable
				? `cost optimum unclaimed: ${priceQuality.reason}; stable tiebreak=definition-id`
				: intent.objective === "min-cost" || intent.objective === "cost"
					? "min-cost within constraints; stable tiebreak=definition-id"
					: `objective=${intent.objective}; stable tiebreak=definition-id`,
		catalogHash: registry.catalogHash,
		catalogContentHash: registry.catalogHash,
	};
	if (region) decision.region = region;

	return { ok: true, decision, region, definition: winner };
}
