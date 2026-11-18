
import { sortKeys } from "@hobo/core";

export const RESOURCE_INTENT_SCHEMA = "hobo.resource-intent/v1";

export type Negotiation = "require" | "prefer";

export type PlacementSelectorOp =
	| "eq"
	| "ne"
	| "in"
	| "not-in"
	| "lt"
	| "lte"
	| "gt"
	| "gte"
	| "exists";

export type PlacementAffinityMode = "affinity" | "anti-affinity";

export type PlacementScope = "region" | "yard";

const NEGOTIATIONS: readonly Negotiation[] = ["require", "prefer"];

const SELECTOR_OPS: readonly PlacementSelectorOp[] = [
	"eq",
	"ne",
	"in",
	"not-in",
	"lt",
	"lte",
	"gt",
	"gte",
	"exists",
];

const AFFINITY_MODES: readonly PlacementAffinityMode[] = [
	"affinity",
	"anti-affinity",
];

const PLACEMENT_SCOPES: readonly PlacementScope[] = ["region", "yard"];


export interface PlacementPropertySelector {
	key: string;
	op: PlacementSelectorOp;
	values: string[];
}

export interface PlacementAffinityRule {
	mode: PlacementAffinityMode;
	targetPort: string;
	scope: PlacementScope;
}

export interface PlacementSpread {
	dimension: PlacementScope;
}

export interface PlacementPickN {
	count: number;
}

export interface PlacementCriteria {
	selectors: PlacementPropertySelector[];
	affinities: PlacementAffinityRule[];
	spread?: PlacementSpread;
	pickN?: PlacementPickN;
}

export interface ResourceIntent {
	name: string;
	port: string;
	require: string[];
	prefer: string[];
	negotiation: Negotiation;
	deps: string[];
	readyDeps?: string[];
	completedDeps?: string[];
	region?: string;
	objective: string;
	placement?: PlacementCriteria;
}


declare const resourceIntentBrand: unique symbol;

export type ParsedPlacementPropertySelector = {
	readonly key: string;
	readonly op: PlacementSelectorOp;
	readonly values: readonly string[];
};

export type ParsedPlacementAffinityRule = {
	readonly mode: PlacementAffinityMode;
	readonly targetPort: string;
	readonly scope: PlacementScope;
};

export type ParsedPlacementSpread = {
	readonly dimension: PlacementScope;
};

export type ParsedPlacementPickN = {
	readonly count: number;
};

export type ParsedPlacementCriteria = {
	readonly selectors: readonly ParsedPlacementPropertySelector[];
	readonly affinities: readonly ParsedPlacementAffinityRule[];
	readonly spread?: ParsedPlacementSpread;
	readonly pickN?: ParsedPlacementPickN;
};

export type ParsedResourceIntent = {
	readonly name: string;
	readonly port: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly negotiation: Negotiation;
	readonly deps: readonly string[];
	readonly readyDeps?: readonly string[];
	readonly completedDeps?: readonly string[];
	readonly region?: string;
	readonly objective: string;
	readonly placement?: ParsedPlacementCriteria;
	readonly [resourceIntentBrand]: "ResourceIntent";
};


export type PlacementPropertySelectorRecord = {
	readonly key: string;
	readonly op: string;
	readonly values?: readonly string[];
};

export type PlacementAffinityRuleRecord = {
	readonly mode: string;
	readonly target_port: string;
	readonly scope: string;
};

export type PlacementSpreadRecord = {
	readonly dimension: string;
};

export type PlacementPickNRecord = {
	readonly count: number;
};

export type PlacementCriteriaRecord = {
	readonly selectors?: readonly PlacementPropertySelectorRecord[];
	readonly affinities?: readonly PlacementAffinityRuleRecord[];
	readonly spread?: PlacementSpreadRecord;
	readonly pick_n?: PlacementPickNRecord;
};

export type ResourceIntentRecord = {
	readonly name: string;
	readonly port: string;
	readonly require?: readonly string[];
	readonly prefer?: readonly string[];
	readonly negotiation: string;
	readonly deps?: readonly string[];
	readonly ready_deps?: readonly string[];
	readonly completed_deps?: readonly string[];
	readonly region?: string;
	readonly objective: string;
	readonly placement?: PlacementCriteriaRecord;
};

export class ResourceIntentError extends Error {
	readonly code = "INVALID_RESOURCE_INTENT" as const;
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`resource intent ${path}: ${detail}`);
		this.name = "ResourceIntentError";
		this.path = path;
	}
}

const UINT32_MAX = 4_294_967_295;

const RESOURCE_INTENT_KEYS: readonly string[] = [
	"name",
	"port",
	"require",
	"prefer",
	"negotiation",
	"deps",
	"readyDeps",
	"completedDeps",
	"region",
	"objective",
	"placement",
];

const CRITERIA_KEYS: readonly string[] = [
	"selectors",
	"affinities",
	"spread",
	"pickN",
];

const SELECTOR_KEYS: readonly string[] = ["key", "op", "values"];

const AFFINITY_KEYS: readonly string[] = ["mode", "targetPort", "scope"];

type UnparsedValue =
	| null
	| boolean
	| number
	| string
	| undefined
	| readonly UnparsedValue[]
	| { readonly [key: string]: UnparsedValue };
type UnparsedRecord = { readonly [key: string]: UnparsedValue };
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };
type MutableParsedCriteria = Mutable<ParsedPlacementCriteria>;
type MutableParsedIntent = Mutable<
	Omit<ParsedResourceIntent, typeof resourceIntentBrand>
>;
type MutableIntentRecord = Mutable<ResourceIntentRecord>;
type MutableCriteriaRecord = Mutable<PlacementCriteriaRecord>;
type MutableSelectorRecord = Mutable<PlacementPropertySelectorRecord>;
type DecodedCriteria = {
	selectors: UnparsedRecord[];
	affinities: UnparsedRecord[];
	spread?: UnparsedValue;
	pickN?: UnparsedValue;
};
type DecodeInput = {
	name: UnparsedValue;
	port: UnparsedValue;
	require: UnparsedValue;
	prefer: UnparsedValue;
	negotiation: UnparsedValue;
	deps: UnparsedValue;
	readyDeps?: UnparsedValue;
	completedDeps?: UnparsedValue;
	objective: UnparsedValue;
	region?: UnparsedValue;
	placement?: DecodedCriteria;
};

const objectTag = Object.prototype.toString;

function asObject<T>(value: T, path: string): UnparsedRecord {
	if (objectTag.call(value) !== "[object Object]") {
		throw new ResourceIntentError(
			path,
			`expected an object, got ${describe(value)}`,
		);
	}
	return value as UnparsedRecord;
}

function describe<T>(value: T): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	const tag = objectTag.call(value);
	return tag === "[object Undefined]"
		? "undefined"
		: tag.slice(8, -1).toLowerCase();
}

function rejectUnknownKeys(
	record: UnparsedRecord,
	path: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(record)) {
		if (allowed.includes(key)) continue;
		throw new ResourceIntentError(
			`${path}.${key}`,
			`unknown field; expected one of ${allowed.join(", ")}`,
		);
	}
}

function requireNonEmptyString(value: UnparsedValue, path: string): string {
	if (objectTag.call(value) !== "[object String]") {
		throw new ResourceIntentError(
			path,
			`expected a string, got ${describe(value)}`,
		);
	}
	if (value === "") {
		throw new ResourceIntentError(path, "must not be empty");
	}
	return value as string;
}

function requireStringList(
	value: UnparsedValue,
	path: string,
): readonly string[] {
	if (!Array.isArray(value)) {
		throw new ResourceIntentError(
			path,
			`expected an array, got ${describe(value)}`,
		);
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const [index, entry] of value.entries()) {
		const item = requireNonEmptyString(entry, `${path}[${index}]`);
		if (seen.has(item)) {
			throw new ResourceIntentError(
				`${path}[${index}]`,
				`duplicate entry ${JSON.stringify(item)}`,
			);
		}
		seen.add(item);
		out.push(item);
	}
	return Object.freeze(out);
}

function requireMember<T extends string>(
	value: UnparsedValue,
	path: string,
	allowed: readonly T[],
): T {
	if (objectTag.call(value) !== "[object String]") {
		throw new ResourceIntentError(
			path,
			`expected a string, got ${describe(value)}`,
		);
	}
	if (!allowed.includes(value as T)) {
		throw new ResourceIntentError(
			path,
			`${JSON.stringify(value)} is not one of ${allowed.join(" | ")}`,
		);
	}
	return value as T;
}

function parseSelector(
	value: UnparsedValue,
	path: string,
): ParsedPlacementPropertySelector {
	const record = asObject(value, path);
	rejectUnknownKeys(record, path, SELECTOR_KEYS);
	const key = requireNonEmptyString(record.key, `${path}.key`);
	const op = requireMember(record.op, `${path}.op`, SELECTOR_OPS);
	if (!Array.isArray(record.values)) {
		throw new ResourceIntentError(
			`${path}.values`,
			`expected an array, got ${describe(record.values)}`,
		);
	}
	const values = record.values.map((entry, index) =>
		requireNonEmptyString(entry, `${path}.values[${index}]`),
	);
	if (op === "exists" && values.length > 0) {
		throw new ResourceIntentError(
			`${path}.values`,
			'the "exists" operator is a presence test and takes no operands',
		);
	}
	if (op !== "exists" && values.length === 0) {
		throw new ResourceIntentError(
			`${path}.values`,
			`the ${JSON.stringify(op)} operator needs at least one operand`,
		);
	}
	return Object.freeze({ key, op, values: Object.freeze(values) });
}

function parseAffinity(
	value: UnparsedValue,
	path: string,
): ParsedPlacementAffinityRule {
	const record = asObject(value, path);
	rejectUnknownKeys(record, path, AFFINITY_KEYS);
	return Object.freeze({
		mode: requireMember(record.mode, `${path}.mode`, AFFINITY_MODES),
		targetPort: requireNonEmptyString(record.targetPort, `${path}.targetPort`),
		scope: requireMember(record.scope, `${path}.scope`, PLACEMENT_SCOPES),
	});
}

function parseCriteria(
	value: UnparsedValue,
	path: string,
): ParsedPlacementCriteria {
	const record = asObject(value, path);
	rejectUnknownKeys(record, path, CRITERIA_KEYS);
	if (!Array.isArray(record.selectors)) {
		throw new ResourceIntentError(
			`${path}.selectors`,
			`expected an array, got ${describe(record.selectors)}`,
		);
	}
	if (!Array.isArray(record.affinities)) {
		throw new ResourceIntentError(
			`${path}.affinities`,
			`expected an array, got ${describe(record.affinities)}`,
		);
	}
	const selectors = Object.freeze(
		record.selectors.map((entry, index) =>
			parseSelector(entry, `${path}.selectors[${index}]`),
		),
	);
	const affinities = Object.freeze(
		record.affinities.map((entry, index) =>
			parseAffinity(entry, `${path}.affinities[${index}]`),
		),
	);

	let spread: ParsedPlacementSpread | undefined;
	if ("spread" in record) {
		const nested = asObject(record.spread, `${path}.spread`);
		rejectUnknownKeys(nested, `${path}.spread`, ["dimension"]);
		spread = Object.freeze({
			dimension: requireMember(
				nested.dimension,
				`${path}.spread.dimension`,
				PLACEMENT_SCOPES,
			),
		});
	}

	let pickN: ParsedPlacementPickN | undefined;
	if ("pickN" in record) {
		const nested = asObject(record.pickN, `${path}.pickN`);
		rejectUnknownKeys(nested, `${path}.pickN`, ["count"]);
		const count = nested.count;
		if (
			objectTag.call(count) !== "[object Number]" ||
			!Number.isInteger(count)
		) {
			throw new ResourceIntentError(
				`${path}.pickN.count`,
				`expected an integer, got ${JSON.stringify(count)}`,
			);
		}
		const numericCount = count as number;
		if (numericCount < 1) {
			throw new ResourceIntentError(
				`${path}.pickN.count`,
				`must be at least 1, got ${numericCount}`,
			);
		}
		if (numericCount > UINT32_MAX) {
			throw new ResourceIntentError(
				`${path}.pickN.count`,
				`must fit in uint32, got ${numericCount}`,
			);
		}
		pickN = Object.freeze({ count: numericCount });
	}

	const result: MutableParsedCriteria = { selectors, affinities };
	if (spread !== undefined) result.spread = spread;
	if (pickN !== undefined) result.pickN = pickN;
	return Object.freeze(result);
}

export function parseResourceIntent<T>(input: T): ParsedResourceIntent {
	const record = asObject(input, "$");
	rejectUnknownKeys(record, "$", RESOURCE_INTENT_KEYS);

	const name = requireNonEmptyString(record.name, "$.name");
	const port = requireNonEmptyString(record.port, "$.port");
	const require = requireStringList(record.require, "$.require");
	const prefer = requireStringList(record.prefer, "$.prefer");
	const negotiation = requireMember(
		record.negotiation,
		"$.negotiation",
		NEGOTIATIONS,
	);
	const deps = requireStringList(record.deps, "$.deps");
	const readyDeps = parseReadinessDependencies(record, "readyDeps", deps);
	const completedDeps = parseReadinessDependencies(
		record,
		"completedDeps",
		deps,
	);
	if (readyDeps?.some((dependency) => completedDeps?.includes(dependency))) {
		throw new ResourceIntentError(
			"$.completedDeps",
			"dependency cannot require both readiness and completion",
		);
	}
	const objective = requireNonEmptyString(record.objective, "$.objective");

	if (deps.includes(name)) {
		throw new ResourceIntentError(
			"$.deps",
			`resource ${JSON.stringify(name)} cannot depend on itself`,
		);
	}

	let region: string | undefined;
	if ("region" in record) {
		if (record.region === undefined) {
			throw new ResourceIntentError(
				"$.region",
				"is present but undefined; omit the field instead",
			);
		}
		region = requireNonEmptyString(record.region, "$.region");
	}

	let placement: ParsedPlacementCriteria | undefined;
	if ("placement" in record) {
		placement = parseCriteria(record.placement, "$.placement");
	}

	const result: MutableParsedIntent = {
		name,
		port,
		require,
		prefer,
		negotiation,
		deps,
		objective,
	};
	if (region !== undefined) result.region = region;
	if (readyDeps !== undefined) result.readyDeps = readyDeps;
	if (completedDeps !== undefined) result.completedDeps = completedDeps;
	if (placement !== undefined) result.placement = placement;
	return Object.freeze(result) as ParsedResourceIntent;
}

function parseReadinessDependencies(
	record: UnparsedRecord,
	field: "readyDeps" | "completedDeps",
	deps: readonly string[],
): readonly string[] | undefined {
	if (!(field in record)) return undefined;
	const values = requireStringList(record[field], `$.${field}`);
	if (values.length === 0 || values.some((value) => !deps.includes(value))) {
		throw new ResourceIntentError(
			`$.${field}`,
			"must be non-empty and reference declared dependencies",
		);
	}
	return values;
}

export function encodeResourceIntent(
	intent: ParsedResourceIntent,
): ResourceIntentRecord {
	const record: MutableIntentRecord = {
		name: intent.name,
		port: intent.port,
		negotiation: intent.negotiation,
		objective: intent.objective,
	};
	if (intent.require.length > 0) record.require = [...intent.require];
	if (intent.prefer.length > 0) record.prefer = [...intent.prefer];
	if (intent.deps.length > 0) record.deps = [...intent.deps];
	if (intent.readyDeps !== undefined) record.ready_deps = [...intent.readyDeps];
	if (intent.completedDeps !== undefined)
		record.completed_deps = [...intent.completedDeps];
	if (intent.region !== undefined) record.region = intent.region;
	if (intent.placement !== undefined)
		record.placement = encodeCriteria(intent.placement);
	return record;
}

function encodeCriteria(
	criteria: ParsedPlacementCriteria,
): PlacementCriteriaRecord {
	const record: MutableCriteriaRecord = {};
	if (criteria.selectors.length > 0) {
		record.selectors = criteria.selectors.map((selector) => {
			const result: MutableSelectorRecord = {
				key: selector.key,
				op: selector.op,
			};
			if (selector.values.length > 0) result.values = [...selector.values];
			return result;
		});
	}
	if (criteria.affinities.length > 0) {
		record.affinities = criteria.affinities.map((rule) => ({
			mode: rule.mode,
			target_port: rule.targetPort,
			scope: rule.scope,
		}));
	}
	if (criteria.spread !== undefined)
		record.spread = { dimension: criteria.spread.dimension };
	if (criteria.pickN !== undefined)
		record.pick_n = { count: criteria.pickN.count };
	return record;
}

export function decodeResourceIntent<T>(record: T): ParsedResourceIntent {
	const wire = asObject(record, "$");
	const allowed = [
		"name",
		"port",
		"require",
		"prefer",
		"negotiation",
		"deps",
		"ready_deps",
		"completed_deps",
		"region",
		"objective",
		"placement",
	];
	rejectUnknownKeys(wire, "$", allowed);
	const input: DecodeInput = {
		name: wire.name,
		port: wire.port,
		require: wire.require ?? [],
		prefer: wire.prefer ?? [],
		negotiation: wire.negotiation,
		deps: wire.deps ?? [],
		objective: wire.objective,
	};
	if ("region" in wire) input.region = wire.region;
	if ("ready_deps" in wire) input.readyDeps = wire.ready_deps;
	if ("completed_deps" in wire) input.completedDeps = wire.completed_deps;
	if ("placement" in wire) input.placement = decodeCriteria(wire.placement);
	return parseResourceIntent(input);
}

function decodeCriteria<T>(value: T): DecodedCriteria {
	const wire = asObject(value, "$.placement");
	rejectUnknownKeys(wire, "$.placement", [
		"selectors",
		"affinities",
		"spread",
		"pick_n",
	]);
	const selectors = Array.isArray(wire.selectors) ? wire.selectors : [];
	const result: DecodedCriteria = {
		selectors: selectors.map((entry, index) => {
			const selector = asObject(entry, `$.placement.selectors[${index}]`);
			rejectUnknownKeys(selector, `$.placement.selectors[${index}]`, [
				"key",
				"op",
				"values",
			]);
			return {
				key: selector.key,
				op: selector.op,
				values: selector.values ?? [],
			};
		}),
		affinities: (Array.isArray(wire.affinities) ? wire.affinities : []).map(
			(entry, index) => {
				const rule = asObject(entry, `$.placement.affinities[${index}]`);
				rejectUnknownKeys(rule, `$.placement.affinities[${index}]`, [
					"mode",
					"target_port",
					"scope",
				]);
				return {
					mode: rule.mode,
					targetPort: rule.target_port,
					scope: rule.scope,
				};
			},
		),
	};
	if ("spread" in wire) result.spread = wire.spread;
	if ("pick_n" in wire) result.pickN = wire.pick_n;
	return result;
}

export function canonicalResourceIntentJson(
	intent: ParsedResourceIntent,
): string {
	return JSON.stringify(sortKeys(encodeResourceIntent(intent)));
}

export function toResourceIntent(intent: ParsedResourceIntent): ResourceIntent {
	const result: ResourceIntent = {
		name: intent.name,
		port: intent.port,
		require: [...intent.require],
		prefer: [...intent.prefer],
		negotiation: intent.negotiation,
		deps: [...intent.deps],
		objective: intent.objective,
	};
	if (intent.region !== undefined) result.region = intent.region;
	if (intent.readyDeps !== undefined) result.readyDeps = [...intent.readyDeps];
	if (intent.completedDeps !== undefined)
		result.completedDeps = [...intent.completedDeps];
	if (intent.placement !== undefined)
		result.placement = toPlacementCriteria(intent.placement);
	return result;
}

function toPlacementCriteria(
	criteria: ParsedPlacementCriteria,
): PlacementCriteria {
	const result: PlacementCriteria = {
		selectors: criteria.selectors.map((selector) => ({
			key: selector.key,
			op: selector.op,
			values: [...selector.values],
		})),
		affinities: criteria.affinities.map((rule) => ({
			mode: rule.mode,
			targetPort: rule.targetPort,
			scope: rule.scope,
		})),
	};
	if (criteria.spread !== undefined)
		result.spread = { dimension: criteria.spread.dimension };
	if (criteria.pickN !== undefined)
		result.pickN = { count: criteria.pickN.count };
	return result;
}
