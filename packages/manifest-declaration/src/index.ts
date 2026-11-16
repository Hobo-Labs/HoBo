/**
 * The declaration manifest — `ResourceIntent`, the provider-neutral node a
 * Bindle declares before planning.
 *
 * A declaration says *what* is wanted (a capability class, the features it must
 * have, what it binds to, where it may run) and never *who* provides it. That
 * separation is the whole point of the shape: provider, product, SKU and region
 * are decided later, by matching, and a declaration that leaked any of them
 * would make the plan unportable before the Planner ever ran.
 *
 * Parse, don't validate. {@link parseResourceIntent} is the only way to obtain a
 * {@link ParsedResourceIntent}: the branded, deeply-readonly, frozen parsed
 * derived type. Downstream code that holds one never re-checks it. The
 * unbranded {@link ResourceIntent} interface is the structural authoring shape,
 * kept mutable and field-for-field identical to the definition in
 * `packages/cloud/src/plan-types.ts` so that re-exporting this module from
 * there is a drop-in substitution rather than a type break — `@hobo/cloud`
 * builds `ResourceIntent` values with object literals and assigns to
 * `intent.region` after construction, neither of which a branded or readonly
 * type admits.
 *
 * ## Where this sits in the control plane
 *
 * The declaration manifest is the body of a *command*, not of an event. A
 * `hobo plan` command carries lowered `ResourceIntent` nodes into the Planner
 * actor; the actor matches each against the Registry catalog and appends the
 * resulting `match.Decided` and `deployment.Planned` events to the event store.
 * The materialized views (the deployment projection and the plan read store)
 * are folded from those events, and a snapshot of the projection is what a
 * later reader loads instead of replaying the stream. Nothing in this package
 * writes to any of them: a manifest package owns a shape and its parse
 * boundary, and owns no state, no actor, and no stream.
 *
 * ## Wire form
 *
 * `data-models/resource_intent.proto` is the wire record and
 * `data-models/resource_intent.cue` the constraint set. {@link
 * encodeResourceIntent} emits the canonical proto3-JSON mapping of that record
 * — snake_case field names, fields at their proto3 default omitted — and {@link
 * decodeResourceIntent} is its exact inverse. `region` is declared `optional` in
 * the proto because it is the one optional *scalar* in the record: without
 * explicit presence, proto3 cannot tell an absent region from `""`, and
 * `exactOptionalPropertyTypes` makes those two different values in TypeScript.
 * The parse boundary closes the remaining gap by refusing `region: ""`
 * outright.
 */

import { sortKeys } from "@hobo/core";

// The PACT body and any producer that stamps a schema onto a transported intent
// name this exact string, so a divergent spelling is a different contract rather
// than a typo.
// public-contract: wire identity of the declaration manifest.
export const RESOURCE_INTENT_SCHEMA = "hobo.resource-intent/v1";

/** Whole-intent degradation mode: hard requirement, or best-effort. */
export type Negotiation = "require" | "prefer";

/** Comparison operators a placement property selector may use. */
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

// ---- Structural authoring shapes. Mutable and non-readonly on purpose: these
// are the exact declarations `@hobo/cloud` uses today, so re-exporting them
// from there changes no consumer.

// domain-view: authoring view; wire form is PlacementPropertySelector in data-models/resource_intent.proto.
export interface PlacementPropertySelector {
	/** "cost" | "region" | "provider" | "capacity" | "latency" | custom feature key. */
	key: string;
	op: PlacementSelectorOp;
	values: string[];
}

// domain-view: authoring view; wire form is PlacementAffinityRule in data-models/resource_intent.proto.
export interface PlacementAffinityRule {
	mode: PlacementAffinityMode;
	/** The referenced resource class (capability port). */
	targetPort: string;
	scope: PlacementScope;
}

// domain-view: authoring view; wire form is PlacementSpread in data-models/resource_intent.proto.
export interface PlacementSpread {
	dimension: PlacementScope;
}

// domain-view: authoring view; wire form is PlacementPickN in data-models/resource_intent.proto.
export interface PlacementPickN {
	/** Minimum distinct satisfying candidates matching must find (>= 1). */
	count: number;
}

// domain-view: authoring view; wire form is PlacementCriteria in data-models/resource_intent.proto.
export interface PlacementCriteria {
	selectors: PlacementPropertySelector[];
	affinities: PlacementAffinityRule[];
	spread?: PlacementSpread;
	pickN?: PlacementPickN;
}

// domain-view: authoring view; wire form is ResourceIntent in data-models/resource_intent.proto.
export interface ResourceIntent {
	name: string;
	port: string;
	require: string[];
	prefer: string[];
	negotiation: Negotiation;
	deps: string[];
	region?: string;
	objective: string;
	placement?: PlacementCriteria;
}

// ---- Parsed derived types. Deeply readonly, frozen, and branded so the type
// cannot be forged by an object literal.

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

/** A parsed declaration manifest. Construct only through {@link parseResourceIntent}. */
export type ParsedResourceIntent = {
	readonly name: string;
	readonly port: string;
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly negotiation: Negotiation;
	readonly deps: readonly string[];
	readonly region?: string;
	readonly objective: string;
	readonly placement?: ParsedPlacementCriteria;
	readonly [resourceIntentBrand]: "ResourceIntent";
};

// ---- Canonical proto3-JSON wire records. Every field that proto3 omits at its
// default value is optional here, which is exactly the set of fields whose
// absence and default are the same value.

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
	readonly region?: string;
	readonly objective: string;
	readonly placement?: PlacementCriteriaRecord;
};

/** Every refusal from this module. `path` names the offending field. */
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
	// SAFETY: the tag check above excludes null, arrays, primitives, and exotic objects.
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
		// Silently dropping an unrecognised key is how a producer's new field
		// disappears without anyone noticing it stopped arriving.
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
	// SAFETY: the string tag check above establishes the runtime string representation.
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
			// require/prefer/deps are sets by meaning; a repeated entry adds
			// nothing and makes two spellings of one declaration.
			throw new ResourceIntentError(
				`${path}[${index}]`,
				`duplicate entry ${JSON.stringify(item)}`,
			);
		}
		seen.add(item);
		out.push(item);
	}
	// Order is preserved exactly as authored: normalising it here would make a
	// round trip lossy for every producer that means something by the order.
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
	// SAFETY: the string tag check makes this cast a string before membership is checked.
	if (!allowed.includes(value as T)) {
		throw new ResourceIntentError(
			path,
			`${JSON.stringify(value)} is not one of ${allowed.join(" | ")}`,
		);
	}
	// SAFETY: the string tag check and closed-vocabulary membership check establish T.
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
	// The evaluator in @hobo/cloud reads values[0] for the scalar comparisons
	// and the whole list for in/not-in, and ignores values entirely for
	// "exists". Both malformed arities below are therefore silent rather than
	// loud downstream: an operandless "eq" compares against undefined and
	// rejects every candidate, and an "exists" carrying operands reads as a
	// filter that is never applied.
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
		// SAFETY: the number tag and integer checks establish the numeric count.
		const numericCount = count as number;
		if (numericCount < 1) {
			// A cardinality of zero asks matching to find nothing, which is not a
			// weaker constraint but an incoherent one.
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

/**
 * Parse-don't-validate boundary for the declaration manifest.
 *
 * Throws {@link ResourceIntentError} naming the offending field path. Never
 * repairs, never defaults, never drops: an input this function returns from is
 * structurally identical to the input it was given, so a value can be parsed,
 * encoded and parsed again without changing.
 */
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
	const objective = requireNonEmptyString(record.objective, "$.objective");

	if (deps.includes(name)) {
		// A bind edge from a resource to itself is a one-node cycle. It is
		// checkable here, inside one record, rather than only once the whole DAG
		// is ordered.
		throw new ResourceIntentError(
			"$.deps",
			`resource ${JSON.stringify(name)} cannot depend on itself`,
		);
	}

	let region: string | undefined;
	if ("region" in record) {
		if (record.region === undefined) {
			// Under exactOptionalPropertyTypes an absent optional field and one
			// holding undefined are different values, and only the first has a
			// wire form. Accepting the second would make the round trip lossy at
			// the very first step.
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
	if (placement !== undefined) result.placement = placement;
	// SAFETY: every property was parsed above and the unique brand is never observable at runtime.
	return Object.freeze(result) as ParsedResourceIntent;
}

/**
 * The canonical proto3-JSON wire record for a parsed declaration.
 *
 * Follows the proto3 JSON mapping exactly: snake_case field names, and fields
 * whose value equals the proto3 default omitted — except `region`, which the
 * schema declares `optional` and which therefore round-trips its presence.
 */
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

/**
 * The exact inverse of {@link encodeResourceIntent}: rebuilds the parsed
 * declaration from its wire record, restoring the defaults proto3 omitted.
 *
 * Runs the full parse boundary, so a hand-written record gets the same refusals
 * an authored value does.
 */
export function decodeResourceIntent<T>(record: T): ParsedResourceIntent {
	const wire = asObject(record, "$");
	const allowed = [
		"name",
		"port",
		"require",
		"prefer",
		"negotiation",
		"deps",
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

/**
 * Byte-stable serialization of the wire record: keys sorted at every depth,
 * array order left alone.
 *
 * `sortKeys` comes from `@hobo/core` rather than being rewritten here, because
 * the repository already carries two spellings of canonical ordering and a
 * third would be one more thing to keep in step.
 */
export function canonicalResourceIntentJson(
	intent: ParsedResourceIntent,
): string {
	return JSON.stringify(sortKeys(encodeResourceIntent(intent)));
}

/**
 * The mutable authoring view of a parsed declaration.
 *
 * The inverse direction of {@link parseResourceIntent}, for the callers that
 * build `ResourceIntent` literals today — notably `@hobo/cloud`'s planner,
 * which mutates `intent.region` after construction.
 */
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
