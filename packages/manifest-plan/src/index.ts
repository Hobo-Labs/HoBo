
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

export type PlanParameterValue = JsonValue;

export interface PlanParseObject {
	readonly [key: string]: PlanParseInput | undefined;
}

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
	readyDeps?: readonly string[];
	completedDeps?: readonly string[];
	strategy?: string;
	region?: string;
	deploymentId?: string;
	productId?: string;
	realizationParameters?: JsonObject;
	nonPortableRows?: readonly string[];
};

declare const resourcePlanBrand: unique symbol;

export type ResourcePlan = {
	readonly name: string;
	readonly port: string;
	readonly provider: string;
	readonly deps: readonly string[];
	readonly readyDeps?: readonly string[];
	readonly completedDeps?: readonly string[];
	readonly strategy?: string;
	readonly region?: string;
	readonly deploymentId?: string;
	readonly productId?: string;
	readonly realizationParameters?: JsonObject;
	readonly nonPortableRows?: readonly string[];
	readonly [resourcePlanBrand]: "ResourcePlan";
};

declare const deploymentPlanBrand: unique symbol;

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
	readyDeps?: readonly string[];
	completedDeps?: readonly string[];
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

const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

const RESOURCE_PLAN_KEYS = [
	"name",
	"port",
	"provider",
	"deps",
	"readyDeps",
	"completedDeps",
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
	const readyDeps = parseReadinessDependencies(
		source,
		"readyDeps",
		deps,
		path,
		fail,
	);
	const completedDeps = parseReadinessDependencies(
		source,
		"completedDeps",
		deps,
		path,
		fail,
	);
	if (readyDeps?.some((dependency) => completedDeps?.includes(dependency))) {
		fail(
			`${path}.completedDeps`,
			"dependency cannot require both readiness and completion",
		);
	}

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

	const parsed: ResourcePlanDraft = {
		name,
		port,
		provider,
		deps,
	};
	if (strategy !== undefined) parsed.strategy = strategy;
	if (readyDeps !== undefined) parsed.readyDeps = readyDeps;
	if (completedDeps !== undefined) parsed.completedDeps = completedDeps;
	if (region !== undefined) parsed.region = region;
	if (deploymentId !== undefined) parsed.deploymentId = deploymentId;
	if (productId !== undefined) parsed.productId = productId;
	if (parameters !== undefined) parsed.realizationParameters = parameters;
	if (rows !== undefined) parsed.nonPortableRows = rows;
	return freezeResourcePlan(parsed);
}

function parseReadinessDependencies(
	source: PlanParseObject,
	field: "readyDeps" | "completedDeps",
	deps: readonly string[],
	path: string,
	fail: Fail,
): readonly string[] | undefined {
	if (!Object.hasOwn(source, field)) return undefined;
	const values = stringArray(source[field], `${path}.${field}`, fail, false);
	if (
		values.length === 0 ||
		new Set(values).size !== values.length ||
		values.some((value) => !deps.includes(value))
	) {
		fail(
			`${path}.${field}`,
			"must be non-empty, unique, and reference declared dependencies",
		);
	}
	return values;
}

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
	if (resource.readyDeps !== undefined) out.readyDeps = [...resource.readyDeps];
	if (resource.completedDeps !== undefined)
		out.completedDeps = [...resource.completedDeps];
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

export function hashDeploymentPlan(plan: DeploymentPlan): PlanHash {
	const digest = createHash("sha256")
		.update(canonicalPlanJson(plan))
		.digest("hex");
	return `sha256:${digest}`;
}
