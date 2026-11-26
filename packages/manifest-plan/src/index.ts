/**
 * The plan manifest: the resolved DAG the Planner emits and the control plane
 * content-addresses.
 *
 * Parse, don't validate. The types below are the parsed derived domain types a
 * consumer works with; their protobuf wire forms live in
 * `data-models/resource_plan.proto` and their CUE constraints in
 * `data-models/resource_plan.cue`. `parseResourcePlan` and
 * `parseDeploymentPlan` are the only way to obtain a value of these types —
 * they are branded, so a raw record cannot be cast into one by accident and no
 * downstream code has to re-validate.
 *
 * ### Why this package owns the canonical form
 *
 * A `DeploymentPlan` is content-addressed: `hashDeploymentPlan` is compared
 * across packages, and `packages/cloud/test/planner.test.ts` pins the digest of
 * `test/fixtures/golden-plan.json` as a committed constant. So the
 * canonicalization is not an implementation detail of a serializer, it is part
 * of the contract, and it is reproduced here byte-for-byte rather than
 * borrowed:
 *
 * `@hobo/core` exports a `sortKeys` that looks interchangeable with the one
 * `@hobo/cloud` keeps private, but it is not. Core sorts with
 * `String.prototype.localeCompare` (ICU collation); cloud sorts with the
 * default comparator (UTF-16 code unit order). They disagree whenever two keys
 * differ only in case or in where an underscore falls — `{Tier, tier}` sorts
 * `["Tier","tier"]` under cloud and `["tier","Tier"]` under core. Plan digests
 * would be stable for the fixed field names and silently fork on
 * `realizationParameters`, whose keys are author-supplied. This module
 * therefore carries cloud's comparator, and `test/canonical-form.test.ts` pins
 * the divergence so a future "just reuse the shared helper" cannot land
 * quietly.
 *
 * ### Where this sits in the event architecture
 *
 * A `DeploymentPlan` is not itself a command or an event: the `deploy` command
 * produces it, the `deployment.Planned` event carries it together with its
 * hash, and the deployment saga actor replays that event from the event store
 * to rebuild its state. The deployment-view projection materializes the plan
 * into a read store as a materialized view keyed by deployment id, and an
 * actor snapshot records the plan hash rather than the plan, which is what
 * makes the hash worth being exact about.
 */

import { createHash } from "node:crypto";

export const DEPLOYMENT_PLAN_SCHEMA = "hobo.deployment-plan/v1" as const;

const objectTag = Object.prototype.toString;

export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;

/** Realization-parameter JSON. Same contract as {@link JsonValue}. */
export type PlanParameterValue = JsonValue;

/**
 * Untrusted object at the parse boundary: JSON fields plus values this parser
 * refuses rather than normalizes (`undefined`, `Date`, functions).
 */
export interface PlanParseObject {
	readonly [key: string]: PlanParseInput | undefined;
}

/**
 * Untrusted parse-boundary input. Broader than {@link JsonValue} so the
 * boundary can still name and refuse non-JSON values.
 */
export type PlanParseInput =
	| JsonValue
	| bigint
	| symbol
	| undefined
	| Date
	| ((...args: JsonValue[]) => JsonValue | undefined)
	| PlanParseObject
	| readonly PlanParseInput[];

interface MutableJsonObject {
	[key: string]: JsonValue;
}

type ResourcePlanDraft = {
	name: string;
	port: string;
	provider: string;
	deps: readonly string[];
	strategy?: string;
	region?: string;
	deploymentId?: string;
	productId?: string;
	realizationParameters?: JsonObject;
	nonPortableRows?: readonly string[];
};

declare const resourcePlanBrand: unique symbol;

// domain-view:
export type ResourcePlan = {
	readonly name: string;
	readonly port: string;
	readonly provider: string;
	readonly deps: readonly string[];
	readonly strategy?: string;
	readonly region?: string;
	readonly deploymentId?: string;
	readonly productId?: string;
	readonly realizationParameters?: JsonObject;
	readonly nonPortableRows?: readonly string[];
	readonly [resourcePlanBrand]: "ResourcePlan";
};

declare const deploymentPlanBrand: unique symbol;

// domain-view:
export type DeploymentPlan = {
	readonly schema: typeof DEPLOYMENT_PLAN_SCHEMA;
	readonly resources: readonly ResourcePlan[];
	readonly dependencyOrder: readonly string[];
	readonly objective: string;
	readonly [deploymentPlanBrand]: "DeploymentPlan";
};

export interface ResourcePlanAuthoring {
	name: string;
	port: string;
	provider: string;
	deps: string[];
	strategy?: string;
	region?: string;
	deploymentId?: string;
	productId?: string;
	realizationParameters?: Readonly<JsonObject>;
	nonPortableRows?: readonly string[];
}

export interface DeploymentPlanAuthoring {
	schema: typeof DEPLOYMENT_PLAN_SCHEMA;
	resources: ResourcePlanAuthoring[];
	dependencyOrder: string[];
	objective: string;
}

export type PlanHash = `sha256:${string}`;

export class ResourcePlanError extends Error {
	readonly code = "INVALID_RESOURCE_PLAN" as const;
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`invalid resource plan at ${path}: ${detail}`);
		this.name = "ResourcePlanError";
		this.path = path;
	}
}

export class DeploymentPlanError extends Error {
	readonly code = "INVALID_DEPLOYMENT_PLAN" as const;
	readonly path: string;

	constructor(path: string, detail: string) {
		super(`invalid deployment plan at ${path}: ${detail}`);
		this.name = "DeploymentPlanError";
		this.path = path;
	}
}

/**
 * Property keys that read as a secret value rather than a locator.
 *
 * Character-for-character `CREDENTIAL_KEY_PATTERN` in
 * `packages/yards/src/canonical.ts`. That boundary already refuses these when a
 * Yard binding row is authored; refusing them again here is not redundancy but
 * the second half of the same law — a plan assembled by any route other than
 * the planner would otherwise carry credential material into a record that gets
 * hashed, logged and projected.
 */
const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

const RESOURCE_PLAN_KEYS = [
	"name",
	"port",
	"provider",
	"deps",
	"strategy",
	"region",
	"deploymentId",
	"productId",
	"realizationParameters",
	"nonPortableRows",
] as const;

const DEPLOYMENT_PLAN_KEYS = [
	"schema",
	"resources",
	"dependencyOrder",
	"objective",
] as const;

type Fail = (path: string, detail: string) => never;

function isPrimitiveString(value: PlanParseInput): value is string {
	return (
		objectTag.call(value) === "[object String]" && !(value instanceof String)
	);
}

function isPrimitiveNumber(value: PlanParseInput): value is number {
	return (
		objectTag.call(value) === "[object Number]" && !(value instanceof Number)
	);
}

function isPrimitiveBoolean(value: PlanParseInput): value is boolean {
	return (
		objectTag.call(value) === "[object Boolean]" && !(value instanceof Boolean)
	);
}

function isFunction(
	value: PlanParseInput,
): value is (...args: JsonValue[]) => JsonValue | undefined {
	const tag = objectTag.call(value);
	return (
		tag === "[object Function]" ||
		tag === "[object AsyncFunction]" ||
		tag === "[object GeneratorFunction]" ||
		tag === "[object AsyncGeneratorFunction]"
	);
}

function isJsonRecord(value: JsonValue): value is JsonObject {
	return value !== null && objectTag.call(value) === "[object Object]";
}

function isPlanParseObject(value: PlanParseInput): value is PlanParseObject {
	if (value === null || value === undefined) return false;
	if (Array.isArray(value)) return false;
	if (
		isPrimitiveString(value) ||
		isPrimitiveNumber(value) ||
		isPrimitiveBoolean(value)
	) {
		return false;
	}
	if (isFunction(value)) return false;
	const tag = objectTag.call(value);
	return tag !== "[object BigInt]" && tag !== "[object Symbol]";
}

function instanceName(value: PlanParseObject): string {
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null || prototype === undefined) return "an exotic object";
	const ctor = prototype.constructor;
	if (ctor === null || ctor === undefined) return "an exotic object";
	const name = ctor.name;
	if (objectTag.call(name) !== "[object String]" || name.length === 0) {
		return "an exotic object";
	}
	return name;
}

function record(
	value: PlanParseInput,
	path: string,
	fail: Fail,
): PlanParseObject {
	if (!isPlanParseObject(value)) {
		fail(path, `expected an object, received ${describe(value)}`);
	}
	return value;
}

function describe(value: PlanParseInput): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (value === undefined) return "undefined";
	if (isPrimitiveString(value)) return `string ${JSON.stringify(value)}`;
	if (isPrimitiveNumber(value)) return `number ${JSON.stringify(value)}`;
	if (isPrimitiveBoolean(value)) return `boolean ${JSON.stringify(value)}`;
	if (isFunction(value)) return `function ${JSON.stringify(value)}`;
	const tag = objectTag.call(value);
	if (tag === "[object BigInt]") return `bigint ${String(value)}`;
	if (tag === "[object Symbol]") return `symbol ${JSON.stringify(value)}`;
	return `object ${JSON.stringify(value)}`;
}

function rejectUnknownKeys(
	source: PlanParseObject,
	allowed: readonly string[],
	path: string,
	fail: Fail,
): void {
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) {
			fail(
				`${path}.${key}`,
				`unknown field; a field this schema does not carry would be dropped from the canonical form and change the plan digest`,
			);
		}
	}
}

function requiredString(
	source: PlanParseObject,
	key: string,
	path: string,
	fail: Fail,
	allowEmpty = false,
): string {
	const value = source[key];
	if (!isPrimitiveString(value)) {
		fail(`${path}.${key}`, `expected a string, received ${describe(value)}`);
	}
	if (!allowEmpty && value.length === 0) {
		fail(`${path}.${key}`, "expected a non-empty string");
	}
	return value;
}

function optionalString(
	source: PlanParseObject,
	key: string,
	path: string,
	fail: Fail,
	allowEmpty = false,
): string | undefined {
	if (!Object.hasOwn(source, key)) return undefined;
	const value = source[key];
	if (value === undefined || value === null) {
		fail(
			`${path}.${key}`,
			`optional field is present holding ${value === null ? "null" : "undefined"}; an optional field must be absent, not empty-valued`,
		);
	}
	return requiredString(source, key, path, fail, allowEmpty);
}

function stringArray(
	value: PlanParseInput,
	path: string,
	fail: Fail,
	allowEmptyEntries: boolean,
): readonly string[] {
	if (!Array.isArray(value)) {
		fail(path, `expected an array of strings, received ${describe(value)}`);
	}
	return Object.freeze(
		value.map((entry, index) => {
			if (!isPrimitiveString(entry)) {
				fail(
					`${path}[${index}]`,
					`expected a string, received ${describe(entry)}`,
				);
			}
			if (!allowEmptyEntries && entry.length === 0) {
				fail(`${path}[${index}]`, "expected a non-empty string");
			}
			return entry;
		}),
	);
}

function parameterValue(
	value: PlanParseInput,
	path: string,
	fail: Fail,
): PlanParameterValue {
	if (value === null) return null;
	if (isPrimitiveBoolean(value) || isPrimitiveString(value)) return value;
	if (isPrimitiveNumber(value)) {
		if (!Number.isFinite(value)) {
			fail(
				path,
				`expected a finite number, received ${value}; it is not representable in JSON and would canonicalize to null`,
			);
		}
		return value;
	}
	if (Array.isArray(value)) {
		return Object.freeze(
			value.map((entry, index) =>
				parameterValue(entry, `${path}[${index}]`, fail),
			),
		);
	}
	if (isPlanParseObject(value)) {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			fail(
				path,
				`expected a plain JSON object, received an instance of ${instanceName(value)}; it has no faithful canonical form`,
			);
		}
		const out: MutableJsonObject = {};
		for (const key of Object.keys(value)) {
			if (!Object.hasOwn(value, key)) continue;
			out[key] = parameterValue(value[key], `${path}.${key}`, fail);
		}
		return Object.freeze(out);
	}
	fail(
		path,
		`expected a JSON value, received ${describe(value)}; realization parameters are serialized into the plan digest, so a non-JSON value has no canonical form`,
	);
}

function realizationParameters(
	value: PlanParseInput,
	path: string,
	fail: Fail,
): JsonObject {
	const source = record(value, path, fail);
	const out: MutableJsonObject = {};
	for (const key of Object.keys(source)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) {
			fail(
				`${path}.${key}`,
				"realization parameters carry locators, never credential values; reference the secret by locator instead",
			);
		}
		const entry = source[key];
		if (entry === undefined) {
			fail(
				`${path}.${key}`,
				"realization parameter is present holding undefined; JSON.stringify drops it, so it would never reach the plan digest",
			);
		}
		out[key] = parameterValue(entry, `${path}.${key}`, fail);
	}
	return Object.freeze(out);
}

function freezeResourcePlan(draft: ResourcePlanDraft): ResourcePlan {
	return Object.freeze(draft) as ResourcePlan;
}

function freezeDeploymentPlan(draft: {
	schema: typeof DEPLOYMENT_PLAN_SCHEMA;
	resources: readonly ResourcePlan[];
	dependencyOrder: readonly string[];
	objective: string;
}): DeploymentPlan {
	return Object.freeze(draft) as DeploymentPlan;
}

/**
 * Parse-don't-validate boundary for one plan node.
 *
 * @param input a raw record, typically straight from JSON.
 * @param path dotted path used in error messages when the node is nested
 *   inside a plan.
 * @throws {ResourcePlanError} naming the exact offending field.
 */
export function parseResourcePlan(
	input: PlanParseInput,
	path = "resource",
): ResourcePlan {
	const fail: Fail = (at, detail) => {
		throw new ResourcePlanError(at, detail);
	};
	const source = record(input, path, fail);
	rejectUnknownKeys(source, RESOURCE_PLAN_KEYS, path, fail);

	const name = requiredString(source, "name", path, fail);
	const port = requiredString(source, "port", path, fail);
	const provider = requiredString(source, "provider", path, fail);
	if (!Object.hasOwn(source, "deps")) {
		fail(
			`${path}.deps`,
			"required field is absent; a node with no dependencies carries an empty array, because absent and empty hash differently",
		);
	}
	const deps = stringArray(source.deps, `${path}.deps`, fail, true);

	const strategy = optionalString(source, "strategy", path, fail, true);
	const region = optionalString(source, "region", path, fail, true);
	const deploymentId = optionalString(source, "deploymentId", path, fail, true);
	const productId = optionalString(source, "productId", path, fail);

	let parameters: JsonObject | undefined;
	if (Object.hasOwn(source, "realizationParameters")) {
		const raw = source.realizationParameters;
		if (raw === undefined || raw === null) {
			fail(
				`${path}.realizationParameters`,
				`optional field is present holding ${raw === null ? "null" : "undefined"}; an optional field must be absent, not empty-valued`,
			);
		}
		parameters = realizationParameters(
			raw,
			`${path}.realizationParameters`,
			fail,
		);
	}

	let rows: readonly string[] | undefined;
	if (Object.hasOwn(source, "nonPortableRows")) {
		const raw = source.nonPortableRows;
		if (raw === undefined || raw === null) {
			fail(
				`${path}.nonPortableRows`,
				`optional field is present holding ${raw === null ? "null" : "undefined"}; an optional field must be absent, not empty-valued`,
			);
		}
		rows = stringArray(raw, `${path}.nonPortableRows`, fail, false);
	}

	// Assign-if-present, never `key: undefined`: under
	// exactOptionalPropertyTypes the two are different values, and the second
	// one disappears from the canonical JSON without disappearing from
	// `Object.keys`.
	const parsed: ResourcePlanDraft = {
		name,
		port,
		provider,
		deps,
	};
	if (strategy !== undefined) parsed.strategy = strategy;
	if (region !== undefined) parsed.region = region;
	if (deploymentId !== undefined) parsed.deploymentId = deploymentId;
	if (productId !== undefined) parsed.productId = productId;
	if (parameters !== undefined) parsed.realizationParameters = parameters;
	if (rows !== undefined) parsed.nonPortableRows = rows;
	return freezeResourcePlan(parsed);
}

/**
 * Parse-don't-validate boundary for a whole plan DAG.
 *
 * What this refuses is structural: shape, presence, unknown fields, duplicate
 * resource names. What it deliberately does **not** refuse is a
 * `dependencyOrder` that is not a topological order, or a `deps` entry naming a
 * resource outside the plan. Both are admitted by the producing planner today
 * (`packages/cloud/src/planner/plan.ts` skips unknown deps outright and appends
 * the members of a dependency cycle alphabetically rather than rejecting), so
 * refusing them here would reject plans the system currently emits. See the
 * README.
 *
 * @throws {DeploymentPlanError} for plan-level faults.
 * @throws {ResourcePlanError} for a fault inside one node.
 */
export function parseDeploymentPlan(input: PlanParseInput): DeploymentPlan {
	const path = "plan";
	const fail: Fail = (at, detail) => {
		throw new DeploymentPlanError(at, detail);
	};
	const source = record(input, path, fail);
	rejectUnknownKeys(source, DEPLOYMENT_PLAN_KEYS, path, fail);

	const schema = requiredString(source, "schema", path, fail);
	if (schema !== DEPLOYMENT_PLAN_SCHEMA) {
		fail(
			`${path}.schema`,
			`expected ${JSON.stringify(DEPLOYMENT_PLAN_SCHEMA)}, received ${JSON.stringify(schema)}`,
		);
	}

	if (!Array.isArray(source.resources)) {
		fail(
			`${path}.resources`,
			`expected an array, received ${describe(source.resources)}`,
		);
	}
	const resources = Object.freeze(
		source.resources.map((entry, index) =>
			parseResourcePlan(entry, `${path}.resources[${index}]`),
		),
	);

	const seen = new Set<string>();
	for (const [index, resource] of resources.entries()) {
		if (seen.has(resource.name)) {
			fail(
				`${path}.resources[${index}].name`,
				`duplicate resource name ${JSON.stringify(resource.name)}; deps and dependencyOrder address nodes by name, so a duplicate makes both ambiguous`,
			);
		}
		seen.add(resource.name);
	}

	if (!Object.hasOwn(source, "dependencyOrder")) {
		fail(`${path}.dependencyOrder`, "required field is absent");
	}
	const dependencyOrder = stringArray(
		source.dependencyOrder,
		`${path}.dependencyOrder`,
		fail,
		false,
	);

	const objective = requiredString(source, "objective", path, fail);

	return freezeDeploymentPlan({
		schema: DEPLOYMENT_PLAN_SCHEMA,
		resources,
		dependencyOrder,
		objective,
	});
}

function resourcePlanJson(resource: ResourcePlan): JsonObject {
	const out: MutableJsonObject = {
		name: resource.name,
		port: resource.port,
		provider: resource.provider,
		deps: [...resource.deps],
	};
	if (resource.strategy !== undefined) out.strategy = resource.strategy;
	if (resource.region !== undefined) out.region = resource.region;
	if (resource.deploymentId !== undefined)
		out.deploymentId = resource.deploymentId;
	if (resource.productId !== undefined) out.productId = resource.productId;
	if (resource.realizationParameters !== undefined) {
		out.realizationParameters = resource.realizationParameters;
	}
	if (resource.nonPortableRows !== undefined) {
		out.nonPortableRows = [...resource.nonPortableRows];
	}
	return out;
}

function deploymentPlanJson(plan: DeploymentPlan): JsonObject {
	return {
		schema: plan.schema,
		resources: plan.resources.map(resourcePlanJson),
		dependencyOrder: [...plan.dependencyOrder],
		objective: plan.objective,
	};
}

/**
 * Key-sorted at every depth, arrays left in their given order.
 *
 * The comparator is `Array.prototype.sort`'s default — UTF-16 code unit order —
 * and **not** `localeCompare`. This is load-bearing: `@hobo/core`'s exported
 * `sortKeys` uses `localeCompare`, the two disagree on keys differing only by
 * case or underscore placement, and `realizationParameters` keys are
 * author-supplied. Swapping the comparator changes plan digests that are
 * already committed as constants elsewhere in the repo.
 */
function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (isJsonRecord(value)) {
		const out: MutableJsonObject = {};
		for (const key of Object.keys(value).sort()) {
			const entry = value[key];
			if (entry === undefined) continue;
			out[key] = sortKeys(entry);
		}
		return out;
	}
	return value;
}

export function canonicalPlanJson(plan: DeploymentPlan): string {
	return JSON.stringify(sortKeys(deploymentPlanJson(plan)));
}

/** SHA-256 over {@link canonicalPlanJson}. */
export function hashDeploymentPlan(plan: DeploymentPlan): PlanHash {
	const digest = createHash("sha256")
		.update(canonicalPlanJson(plan))
		.digest("hex");
	return `sha256:${digest}`;
}
