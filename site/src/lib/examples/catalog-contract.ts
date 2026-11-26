import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json-inspect.js";
import type {
	MutableSparseBudgetPolicy,
	RoutingPolicy,
	SparseBudgetPolicy,
} from "./policy-planner.js";

export type { JsonObject, JsonValue };

export type ExampleUiKind = "counter" | "hello" | "notes" | "todos" | "queue" | "saas";
export type ExamplePolicy = SparseBudgetPolicy;

export interface ExampleYard {
	readonly id: string;
	readonly targetId: string;
	readonly providerId: string;
	readonly campId: string;
}

export type RuntimeAction =
	| "health"
	| "read"
	| "increment"
	| "reset"
	| "list"
	| "create"
	| "delete"
	| "toggle"
	| "enqueue"
	| "drain"
	| "greet"
	| "signup"
	| "login"
	| "logout"
	| "me"
	| "listProducts"
	| "checkout"
	| "listOrders"
	| "adminListUsers";

export type ExampleRuntimeRoute = {
	readonly method: "GET" | "POST" | "PATCH" | "DELETE";
	readonly path: string;
	readonly action: RuntimeAction;
	readonly resource?: string;
	readonly key?: string;
};

type MutableRuntimeRoute = {
	method: ExampleRuntimeRoute["method"];
	path: string;
	action: RuntimeAction;
	resource?: string;
	key?: string;
};

export type ExampleRuntimeResource = {
	readonly kind: "kv" | "queue";
	readonly initial: JsonValue;
};

export interface ExampleRuntimeDescriptor {
	readonly schemaVersion: "hobo.try-runtime/v1";
	readonly resources: Readonly<Record<string, ExampleRuntimeResource>>;
	readonly routes: readonly ExampleRuntimeRoute[];
}

export interface ExampleTopology {
	readonly homeStation: {
		readonly id: string;
		readonly registeredYardIds: readonly string[];
	};
	readonly yards: readonly ExampleYard[];
	readonly junction: { readonly id: string; readonly yardIds: readonly string[] };
	readonly allowedYardIds: readonly string[] | null;
}

export type ExampleDeployKind = "browser-wit" | "local-bridge";

/** OCI container resources extracted from the example Bindle (ship must use these). */
export type ExampleBindleContainer = {
	readonly name: string;
	readonly image: string;
};

/** webApp Kit metadata from Bindle annotations (e.g. `@hobo/wasp` waspApp). */
export type ExampleBindleWebApp = {
	readonly framework: string;
	readonly root: string;
};

export interface ExampleCatalogEntry {
	readonly id: string;
	readonly title: string;
	readonly blurb: string;
	readonly tags: readonly string[];
	readonly needs: readonly string[];
	readonly ui: ExampleUiKind;
	/** browser-wit = Component Model guest; local-bridge = Bindle container/webApp ship. */
	readonly deployKind: ExampleDeployKind;
	readonly entry: string;
	readonly sourcePath: string;
	readonly source: string;
	/** Object-literal handlers.txt body inlined into the browser WIT guest. */
	readonly handlersSource: string;
	/** Present when Bindle declares `b.container({ image })` (e.g. Postgres OCI). */
	readonly bindleContainers: readonly ExampleBindleContainer[];
	/** Present when Bindle declares `b.web(waspApp(...))` (or compatible webApp). */
	readonly bindleWebApp: ExampleBindleWebApp | null;
	readonly appPolicy: ExamplePolicy;
	readonly deploymentPolicy: ExamplePolicy;
	readonly topology: ExampleTopology;
	readonly runtime: ExampleRuntimeDescriptor;
}

const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
const ACTIONS = [
	"health",
	"read",
	"increment",
	"reset",
	"list",
	"create",
	"delete",
	"toggle",
	"enqueue",
	"drain",
	"greet",
	"signup",
	"login",
	"logout",
	"me",
	"listProducts",
	"checkout",
	"listOrders",
	"adminListUsers",
] as const;

export function parseExamplesCatalog(value: JsonValue): readonly ExampleCatalogEntry[] {
	if (!isJsonArray(value)) throw new TypeError("Examples catalog must be an array");
	return value.map((entry, index) => parseExample(entry, `catalog[${index}]`));
}

function parseExample(value: JsonValue, label: string): ExampleCatalogEntry {
	const input = record(value, label);
	const ui = oneOf(input.ui, `${label}.ui`, [
		"counter",
		"hello",
		"notes",
		"todos",
		"queue",
		"saas",
	] as const);
	const topology = parseTopology(input.topology, `${label}.topology`);
	const yardIds = new Set(topology.yards.map(({ id }) => id));
	if (
		topology.homeStation.registeredYardIds.some((id) => !yardIds.has(id)) ||
		topology.junction.yardIds.some((id) => !yardIds.has(id)) ||
		topology.allowedYardIds?.some((id) => !topology.junction.yardIds.includes(id))
	) {
		throw new TypeError(`${label}.topology references an unknown Yard`);
	}
	const deployKind =
		input.deployKind === undefined
			? "browser-wit"
			: oneOf(input.deployKind, `${label}.deployKind`, [
					"browser-wit",
					"local-bridge",
				] as const);
	return {
		id: string(input.id, `${label}.id`),
		title: string(input.title, `${label}.title`),
		blurb: string(input.blurb, `${label}.blurb`),
		tags: strings(input.tags, `${label}.tags`),
		needs: strings(input.needs, `${label}.needs`),
		ui,
		deployKind,
		entry: string(input.entry, `${label}.entry`),
		sourcePath: string(input.sourcePath, `${label}.sourcePath`),
		source: string(input.source, `${label}.source`),
		handlersSource:
			input.handlersSource === undefined
				? ""
				: stringAllowEmpty(input.handlersSource, `${label}.handlersSource`),
		bindleContainers: parseBindleContainers(
			input.bindleContainers,
			`${label}.bindleContainers`,
		),
		bindleWebApp: parseBindleWebApp(input.bindleWebApp, `${label}.bindleWebApp`),
		appPolicy: parsePolicy(input.appPolicy, `${label}.appPolicy`),
		deploymentPolicy: parsePolicy(input.deploymentPolicy, `${label}.deploymentPolicy`),
		topology,
		runtime: parseRuntime(input.runtime, `${label}.runtime`),
	};
}

function parseBindleWebApp(
	value: JsonValue | undefined,
	label: string,
): ExampleBindleWebApp | null {
	if (value === undefined || value === null) return null;
	const row = record(value, label);
	return {
		framework: string(row.framework, `${label}.framework`),
		root: string(row.root, `${label}.root`),
	};
}

function parseBindleContainers(
	value: JsonValue | undefined,
	label: string,
): readonly ExampleBindleContainer[] {
	if (value === undefined) return [];
	if (!isJsonArray(value)) {
		throw new TypeError(`${label} must be an array`);
	}
	return value.map((entry, index) => {
		const row = record(entry, `${label}[${index}]`);
		return {
			name: string(row.name, `${label}[${index}].name`),
			image: string(row.image, `${label}[${index}].image`),
		};
	});
}

function parseTopology(value: JsonValue | undefined, label: string): ExampleTopology {
	const input = record(value, label);
	const home = record(input.homeStation, `${label}.homeStation`);
	const junction = record(input.junction, `${label}.junction`);
	if (!isJsonArray(input.yards) || input.yards.length === 0) {
		throw new TypeError(`${label}.yards must be a non-empty array`);
	}
	const yards = input.yards.map((value, index) => {
		const yard = record(value, `${label}.yards[${index}]`);
		return {
			id: string(yard.id, `${label}.yards[${index}].id`),
			targetId: string(yard.targetId, `${label}.yards[${index}].targetId`),
			providerId: string(yard.providerId, `${label}.yards[${index}].providerId`),
			campId: string(yard.campId, `${label}.yards[${index}].campId`),
		};
	});
	if (new Set(yards.map(({ id }) => id)).size !== yards.length) {
		throw new TypeError(`${label}.yards must have unique ids`);
	}
	return {
		homeStation: {
			id: string(home.id, `${label}.homeStation.id`),
			registeredYardIds: strings(home.registeredYardIds, `${label}.homeStation.registeredYardIds`),
		},
		yards,
		junction: {
			id: string(junction.id, `${label}.junction.id`),
			yardIds: strings(junction.yardIds, `${label}.junction.yardIds`),
		},
		allowedYardIds:
			input.allowedYardIds === null
				? null
				: strings(input.allowedYardIds, `${label}.allowedYardIds`),
	};
}

function parseRuntime(value: JsonValue | undefined, label: string): ExampleRuntimeDescriptor {
	const input = record(value, label);
	if (input.schemaVersion !== "hobo.try-runtime/v1") {
		throw new TypeError(`${label}.schemaVersion is invalid`);
	}
	const resourcesInput = record(input.resources, `${label}.resources`);
	const resources: Record<string, ExampleRuntimeResource> = {};
	for (const [name, raw] of Object.entries(resourcesInput)) {
		const resource = record(raw, `${label}.resources.${name}`);
		resources[name] = {
			kind: oneOf(resource.kind, `${label}.resources.${name}.kind`, ["kv", "queue"] as const),
			initial: resource.initial ?? null,
		};
	}
	if (!isJsonArray(input.routes) || input.routes.length === 0) {
		throw new TypeError(`${label}.routes must be a non-empty array`);
	}
	const routes = input.routes.map((raw, index) => {
		const route = record(raw, `${label}.routes[${index}]`);
		const resource =
			route.resource === undefined
				? undefined
				: string(route.resource, `${label}.routes[${index}].resource`);
		if (resource !== undefined && !(resource in resources)) {
			throw new TypeError(`${label}.routes[${index}] references an unknown resource`);
		}
		const parsed: MutableRuntimeRoute = {
			method: oneOf(route.method, `${label}.routes[${index}].method`, METHODS),
			path: string(route.path, `${label}.routes[${index}].path`),
			action: oneOf(route.action, `${label}.routes[${index}].action`, ACTIONS),
		};
		if (resource !== undefined) parsed.resource = resource;
		if (route.key !== undefined) {
			parsed.key = string(route.key, `${label}.routes[${index}].key`);
		}
		return parsed;
	});
	return { schemaVersion: "hobo.try-runtime/v1", resources, routes };
}

function parsePolicy(value: JsonValue | undefined, label: string): ExamplePolicy {
	const input = record(value, label);
	const output: MutableSparseBudgetPolicy = {};
	if (input.preferLocal !== undefined) {
		output.preferLocal = boolean(input.preferLocal, `${label}.preferLocal`);
	}
	if (input.routing !== undefined) {
		output.routing = oneOf(input.routing, `${label}.routing`, [
			"local-first",
			"latency-first",
			"cost-first",
		] as const) satisfies RoutingPolicy;
	}
	if (input.redundancy !== undefined) {
		output.redundancy = oneOf(input.redundancy, `${label}.redundancy`, [
			"none",
			"active-passive",
			"active-active",
			"mirror",
		] as const);
	}
	if (input.maxReplicas !== undefined) {
		output.maxReplicas = integer(input.maxReplicas, `${label}.maxReplicas`, 0);
	}
	if (input.maxConcurrent !== undefined) {
		output.maxConcurrent = integer(input.maxConcurrent, `${label}.maxConcurrent`, 1);
	}
	if (input.monthlySpendCapUsd !== undefined) {
		output.monthlySpendCapUsd = number(
			input.monthlySpendCapUsd,
			`${label}.monthlySpendCapUsd`,
		);
	}
	if (input.resourcePool !== undefined) {
		output.resourcePool = strings(input.resourcePool, `${label}.resourcePool`).map(
			(entry) =>
				oneOf(entry, `${label}.resourcePool`, [
					"local",
					"anonymous-remote",
					"paid-remote",
				] as const),
		);
	}
	return output;
}

function requireJson(value: JsonValue | undefined, label: string): JsonValue {
	if (value === undefined) throw new TypeError(`${label} is required`);
	return value;
}

function record(value: JsonValue | undefined, label: string): JsonObject {
	const required = requireJson(value, label);
	if (!isJsonObject(required)) throw new TypeError(`${label} must be an object`);
	return required;
}

function string(value: JsonValue | undefined, label: string): string {
	const required = requireJson(value, label);
	if (!isJsonString(required) || required.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	return required;
}

function stringAllowEmpty(value: JsonValue | undefined, label: string): string {
	const required = requireJson(value, label);
	if (!isJsonString(required)) throw new TypeError(`${label} must be a string`);
	return required;
}

function strings(value: JsonValue | undefined, label: string): string[] {
	const required = requireJson(value, label);
	if (!isJsonArray(required)) throw new TypeError(`${label} must be a string array`);
	const out: string[] = [];
	for (const entry of required) {
		if (!isJsonString(entry)) throw new TypeError(`${label} must be a string array`);
		out.push(entry);
	}
	return [...new Set(out)];
}

function boolean(value: JsonValue | undefined, label: string): boolean {
	const required = requireJson(value, label);
	if (!isJsonBoolean(required)) throw new TypeError(`${label} must be boolean`);
	return required;
}

function number(value: JsonValue | undefined, label: string): number {
	const required = requireJson(value, label);
	if (!isJsonNumber(required) || !Number.isFinite(required) || required < 0) {
		throw new TypeError(`${label} must be a non-negative number`);
	}
	return required;
}

function integer(value: JsonValue | undefined, label: string, minimum: number): number {
	const parsed = number(value, label);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		throw new TypeError(`${label} must be an integer >= ${minimum}`);
	}
	return parsed;
}

function oneOf<const T extends readonly string[]>(
	value: JsonValue | undefined,
	label: string,
	choices: T,
): T[number] {
	const required = requireJson(value, label);
	if (!isJsonString(required)) throw new TypeError(`${label} is invalid`);
	for (const choice of choices) {
		if (choice === required) return choice;
	}
	throw new TypeError(`${label} is invalid`);
}
