import type {
	PlacementAffinityRule,
	PlacementCriteria,
	PlacementPropertySelector,
	ResourceIntent,
} from "../plan-types.js";
import type { ResourceDefinition } from "../registry/catalog.js";

export interface DecidedPlacement {
	resource: string;
	port: string;
	providerId: string;
	region: string;
}

export interface PlacementContext {
	placements: DecidedPlacement[];
}

interface EligibleRegions {
	regions: string[];
	rejection?: string;
}

export function emptyPlacementContext(): PlacementContext {
	return { placements: [] };
}

function parseNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number.parseFloat(raw);
	return Number.isFinite(value) ? value : undefined;
}

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

export function placementRejection(
	def: ResourceDefinition,
	criteria: PlacementCriteria,
	context: PlacementContext,
	region?: string,
): string | undefined {
	return eligibleRegions(def, criteria, context, region).rejection;
}

function eligibleRegions(
	def: ResourceDefinition,
	criteria: PlacementCriteria,
	context: PlacementContext,
	requestedRegion?: string,
): EligibleRegions {
	let regions = [...def.regions].sort();
	if (requestedRegion !== undefined) {
		if (!regions.includes(requestedRegion)) {
			return {
				regions: [],
				rejection: `placement: requested region ${requestedRegion} is not advertised by ${def.id}`,
			};
		}
		regions = [requestedRegion];
	}
	for (const selector of criteria.selectors) {
		if (selector.key !== "region") {
			const reason = selectorRejection(def, selector);
			if (reason !== undefined) return { regions: [], rejection: reason };
			continue;
		}
		const candidates = regions.filter(
			(region) =>
				selectorRejection({ ...def, regions: [region] }, selector) ===
				undefined,
		);
		if (candidates.length === 0) {
			return {
				regions: [],
				rejection:
					selectorRejection({ ...def, regions }, selector) ??
					`placement: selector region ${selector.op} [${selector.values.join(", ")}] leaves no eligible region`,
			};
		}
		regions = candidates;
	}
	for (const rule of criteria.affinities) {
		if (rule.scope !== "region") {
			const reason = affinityRejection(def, rule, context);
			if (reason !== undefined) return { regions: [], rejection: reason };
			continue;
		}
		const targetRegions = new Set(
			targetsOf(rule, context)
				.map((target) => target.region)
				.filter((region) => region !== ""),
		);
		if (targetRegions.size === 0) continue;
		const candidates = regions.filter((region) =>
			rule.mode === "affinity"
				? targetRegions.has(region)
				: !targetRegions.has(region),
		);
		if (candidates.length === 0) {
			return {
				regions: [],
				rejection:
					affinityRejection({ ...def, regions }, rule, context) ??
					`placement: ${rule.mode} to class ${rule.targetPort} leaves no eligible region`,
			};
		}
		regions = candidates;
	}
	return { regions };
}

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

export function pickPlacementRegion(
	intent: ResourceIntent,
	def: ResourceDefinition,
	context: PlacementContext,
): string {
	const criteria = intent.placement;
	let { regions } = eligibleRegions(
		def,
		criteria ?? { selectors: [], affinities: [] },
		context,
		intent.region,
	);

	if (criteria?.spread?.dimension === "region" && regions.length > 1) {
		const usage = (region: string): number =>
			context.placements.filter(
				(p) => p.port === intent.port && p.region === region,
			).length;
		const min = Math.min(...regions.map(usage));
		regions = regions.filter((region) => usage(region) === min);
	}

	return regions[0] ?? "";
}
