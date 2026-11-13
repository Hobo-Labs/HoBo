import type {
	PlacementAffinityRule,
	PlacementCriteria,
	PlacementPropertySelector,
	ResourceIntent,
} from "../plan-types.js";
import type { ResourceDefinition } from "../registry/catalog.js";

// E19 placement-constraint evaluation. Placement
// criteria are HARD, deterministic candidate filters applied between
// capability negotiation and objective ranking, so the lexicographic
// `specificity → priority → objective → definition id` ranking (ADR-0033,
// ADR-0088) is preserved untouched among the survivors. The vocabulary records
// what the Planner PLANS; spread/anti-affinity EXECUTION stays delegated to
// wadm (adr/01-architecture-core.md:419).

// A placement already decided earlier in the same plan pass — the context
// affinity/anti-affinity/spread rules evaluate against. Deterministic because
// the Planner visits intents in the byte-stable lowered order.
export interface DecidedPlacement {
	resource: string;
	port: string;
	providerId: string;
	region: string;
}

export interface PlacementContext {
	placements: DecidedPlacement[];
}

export function emptyPlacementContext(): PlacementContext {
	return { placements: [] };
}

function parseNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) ? value : undefined;
}

// Resolve a selector key to the candidate's advertised values. Well-known keys
// map onto the Resource Definition record; any other key reads `key=value`
// entries (or the bare token, for `exists`) from the definition's features.
function resolveProperty(def: ResourceDefinition, key: string): string[] {
	if (key === "region") return [...def.regions];
	if (key === "provider") return [def.providerId];
	if (key === "cost") return [def.cost.marginalPrice];
	const prefix = `${key}=`;
	const values = def.features
		.filter((feature) => feature.startsWith(prefix))
		.map((feature) => feature.slice(prefix.length));
	if (values.length === 0 && def.features.includes(key)) return [key];
	return values;
}

function numericCompare(
	actual: string[],
	operand: string | undefined,
	satisfied: (delta: number) => boolean,
): boolean {
	const bound = parseNumber(operand);
	if (bound === undefined) return false;
	return actual.some((raw) => {
		const value = parseNumber(raw);
		return value !== undefined && satisfied(value - bound);
	});
}

// Evaluate one property selector; returns a rejection reason or undefined.
export function selectorRejection(
	def: ResourceDefinition,
	selector: PlacementPropertySelector,
): string | undefined {
	const actual = resolveProperty(def, selector.key);
	const operand = selector.values[0];
	const describe = () =>
		`placement: selector ${selector.key} ${selector.op} [${selector.values.join(", ")}] not satisfied (candidate advertises [${actual.join(", ")}])`;
	switch (selector.op) {
		case "exists":
			return actual.length > 0 ? undefined : describe();
		case "eq":
			return actual.some((value) => value === operand) ? undefined : describe();
		case "ne":
			return actual.every((value) => value !== operand)
				? undefined
				: describe();
		case "in":
			return actual.some((value) => selector.values.includes(value))
				? undefined
				: describe();
		case "not-in":
			return actual.every((value) => !selector.values.includes(value))
				? undefined
				: describe();
		case "lt":
			return numericCompare(actual, operand, (delta) => delta < 0)
				? undefined
				: describe();
		case "lte":
			return numericCompare(actual, operand, (delta) => delta <= 0)
				? undefined
				: describe();
		case "gt":
			return numericCompare(actual, operand, (delta) => delta > 0)
				? undefined
				: describe();
		case "gte":
			return numericCompare(actual, operand, (delta) => delta >= 0)
				? undefined
				: describe();
		default:
			return `placement: unknown selector op ${selector.op satisfies never}`;
	}
}

function targetsOf(
	rule: PlacementAffinityRule,
	context: PlacementContext,
): DecidedPlacement[] {
	return context.placements.filter((p) => p.port === rule.targetPort);
}

// Evaluate one affinity/anti-affinity rule against the placements already
// decided this pass. A rule referencing a class with no decided placement yet
// is vacuously satisfied (deterministic, given the byte-stable intent order).
export function affinityRejection(
	def: ResourceDefinition,
	rule: PlacementAffinityRule,
	context: PlacementContext,
): string | undefined {
	const targets = targetsOf(rule, context);
	if (targets.length === 0) return undefined;
	const targetProviders = new Set(targets.map((t) => t.providerId));
	const targetRegions = new Set(
		targets.map((t) => t.region).filter((r) => r !== ""),
	);
	if (rule.scope === "yard") {
		const colocated = targetProviders.has(def.providerId);
		if (rule.mode === "affinity" && !colocated) {
			return `placement: affinity to class ${rule.targetPort} requires yard in [${[...targetProviders].sort().join(", ")}]`;
		}
		if (rule.mode === "anti-affinity" && colocated) {
			return `placement: anti-affinity to class ${rule.targetPort} forbids yard ${def.providerId}`;
		}
		return undefined;
	}
	// scope === "region": co-location is judged on advertised regions; the
	// concrete region choice happens in pickPlacementRegion.
	if (targetRegions.size === 0) return undefined;
	const overlap = def.regions.some((region) => targetRegions.has(region));
	const hasEscapeRegion = def.regions.some(
		(region) => !targetRegions.has(region),
	);
	if (rule.mode === "affinity" && !overlap) {
		return `placement: affinity to class ${rule.targetPort} requires a region in [${[...targetRegions].sort().join(", ")}]`;
	}
	if (rule.mode === "anti-affinity" && !hasEscapeRegion) {
		return `placement: anti-affinity to class ${rule.targetPort} leaves no region outside [${[...targetRegions].sort().join(", ")}]`;
	}
	return undefined;
}

// Full pre-ranking placement verdict for one candidate: first failing
// selector/affinity reason, or undefined when the candidate survives.
export function placementRejection(
	def: ResourceDefinition,
	criteria: PlacementCriteria,
	context: PlacementContext,
): string | undefined {
	for (const selector of criteria.selectors) {
		const reason = selectorRejection(def, selector);
		if (reason !== undefined) return reason;
	}
	for (const rule of criteria.affinities) {
		const reason = affinityRejection(def, rule, context);
		if (reason !== undefined) return reason;
	}
	return undefined;
}

// Spread across yards, evaluated as a deterministic hard filter: keep only the
// candidates whose provider currently carries the minimum number of same-class
// placements. Ranking among the survivors stays lexicographic (ADR-0033).
export function spreadSurvivors(
	candidates: ResourceDefinition[],
	intent: ResourceIntent,
	context: PlacementContext,
): ResourceDefinition[] {
	const spread = intent.placement?.spread;
	if (spread === undefined || spread.dimension !== "yard") return candidates;
	if (candidates.length === 0) return candidates;
	const usage = (providerId: string): number =>
		context.placements.filter(
			(p) => p.port === intent.port && p.providerId === providerId,
		).length;
	const min = Math.min(...candidates.map((c) => usage(c.providerId)));
	return candidates.filter((c) => usage(c.providerId) === min);
}

// Deterministic region choice honoring region-scoped affinity/anti-affinity
// and region spread. Falls back to the pre-E19 rule (lexicographically
// smallest advertised region) when no criterion narrows the set.
export function pickPlacementRegion(
	intent: ResourceIntent,
	def: ResourceDefinition,
	context: PlacementContext,
): string {
	if (intent.region) return intent.region;
	let regions = [...def.regions].sort();
	const criteria = intent.placement;
	if (criteria === undefined) return regions[0] ?? "";

	for (const rule of criteria.affinities) {
		if (rule.scope !== "region") continue;
		const targetRegions = new Set(
			targetsOf(rule, context)
				.map((t) => t.region)
				.filter((r) => r !== ""),
		);
		if (targetRegions.size === 0) continue;
		if (rule.mode === "affinity") {
			const kept = regions.filter((region) => targetRegions.has(region));
			if (kept.length > 0) regions = kept;
		} else {
			const kept = regions.filter((region) => !targetRegions.has(region));
			if (kept.length > 0) regions = kept;
		}
	}

	if (criteria.spread?.dimension === "region" && regions.length > 1) {
		const usage = (region: string): number =>
			context.placements.filter(
				(p) => p.port === intent.port && p.region === region,
			).length;
		const min = Math.min(...regions.map(usage));
		regions = regions.filter((region) => usage(region) === min);
	}

	return regions[0] ?? "";
}
