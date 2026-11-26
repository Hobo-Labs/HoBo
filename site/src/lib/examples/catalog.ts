import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { register } from "tsx/esm/api";

import type { BindleDefinition } from "@hobo/bindles";

import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonTree,
	type JsonObject,
	type JsonValue,
} from "../json-inspect.js";
import type { MutableSparseBudgetPolicy, RoutingPolicy } from "./policy-planner.js";
import type {
	ExampleBindleContainer,
	ExampleBindleWebApp,
	ExampleCatalogEntry,
	ExamplePolicy,
	ExampleRuntimeDescriptor,
	ExampleRuntimeResource,
	ExampleRuntimeRoute,
	ExampleTopology,
	ExampleUiKind,
	ExampleYard,
	RuntimeAction,
} from "./catalog-contract.js";
import { deriveWebGuestFromBindle } from "./derive-web-guest.js";
import { synthesizeTryRuntimeFromDeclared } from "./synthesize-try-runtime.js";

export type {
	ExampleCatalogEntry,
	ExamplePolicy,
	ExampleRuntimeDescriptor,
	ExampleTopology,
	ExampleUiKind,
	ExampleYard,
	RuntimeAction,
} from "./catalog-contract.js";

const DEFAULT_REPO_ROOT = fileURLToPath(
	new URL("../../../../", import.meta.url),
);
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// One process-wide tsx loader + module memo. `tsImport()` per app is a trap:
// every call registers ANOTHER namespaced ESM loader, resolution cost
// compounds per registered loader (measured 0.6s → 6s → 76s → minutes for
// successive app imports — 16 CPU-hours of spin in a pre-commit hook), and
// on Node 22.22 the namespaced-loader path can deadlock outright. So:
// register() the tsx loader exactly once and use plain dynamic import; the
// site vitest config marks the app modules external so the runner leaves
// these imports to the native loader too.
type ExampleAppModule = {
	readonly default?: BindleDefinition;
	readonly runtime?: JsonValue;
};

type NodeErrno = {
	readonly code?: string;
};

type MutableRuntimeRoute = {
	method: ExampleRuntimeRoute["method"];
	path: string;
	action: RuntimeAction;
	resource?: string;
	key?: string;
};

type ParsedMeta = {
	readonly id: string;
	readonly title: string;
	readonly blurb: string;
	readonly tags: readonly string[];
	readonly needs: readonly string[];
	readonly ui: ExampleUiKind;
	readonly deployKind: "browser-wit" | "local-bridge";
	readonly entry: string;
	readonly sourcePath: string;
};

type ParsedDescriptor = {
	readonly appPolicy: ExamplePolicy;
	readonly deploymentPolicy: ExamplePolicy;
	readonly topology: ExampleTopology;
};

type ParsedYardPool = {
	readonly homeStationId: string;
	readonly yards: readonly ExampleYard[];
	readonly yardIds: Set<string>;
};

type ExampleRuntimeParts = {
	readonly runtime: ExampleRuntimeDescriptor;
	readonly guestHandlersSource: string;
};

let tsLoaderRegistered = false;
const appModuleCache = new Map<string, Promise<ExampleAppModule>>();

function importAppModule(appPath: string): Promise<ExampleAppModule> {
	const cached = appModuleCache.get(appPath);
	if (cached) return cached;
	if (!tsLoaderRegistered) {
		register();
		tsLoaderRegistered = true;
	}
	// SAFETY: example app modules expose Bindle `default` plus optional try-runtime JSON.
	const loaded = import(
		/* @vite-ignore */ pathToFileURL(appPath).href,
	) as Promise<ExampleAppModule>;
	appModuleCache.set(appPath, loaded);
	return loaded;
}

// The catalog itself is deterministic per repoRoot within one process —
// every test file and prerender path shares one load.
const catalogCache = new Map<
	string,
	Promise<readonly ExampleCatalogEntry[]>
>();

export function loadExamplesCatalog(
	repoRoot = DEFAULT_REPO_ROOT,
): Promise<readonly ExampleCatalogEntry[]> {
	const cached = catalogCache.get(repoRoot);
	if (cached) return cached;
	const loaded = loadExamplesCatalogUncached(repoRoot);
	catalogCache.set(repoRoot, loaded);
	return loaded;
}

async function loadExamplesCatalogUncached(
	repoRoot: string,
): Promise<readonly ExampleCatalogEntry[]> {
	const trySiteRoot = path.join(repoRoot, "examples", "try-site");
	const examplesRoot = path.join(trySiteRoot, "apps");
	const pool = parseYardPool(
		parseJsonTree(await readFile(path.join(trySiteRoot, "yards.json"), "utf8")),
	);
	const directories = (await readdir(examplesRoot, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	const catalog: ExampleCatalogEntry[] = [];

	for (const directory of directories) {
		const exampleRoot = path.join(examplesRoot, directory);
		let metaText: string;
		try {
			metaText = await readFile(path.join(exampleRoot, "meta.json"), "utf8");
		} catch (error) {
			if (error instanceof Error && isMissingFile(error)) continue;
			throw error;
		}
		const topologyText = await readFile(path.join(exampleRoot, "yard.json"), "utf8");

		const meta = parseMeta(parseJsonTree(metaText), directory);
		const descriptor = parseDescriptor(
			parseJsonTree(topologyText),
			directory,
			pool,
		);
		const appPath = path.join(exampleRoot, meta.entry);
		const appSource = await readFile(appPath, "utf8");
		let handlersFile = "";
		try {
			handlersFile = await readFile(path.join(exampleRoot, "handlers.txt"), "utf8");
		} catch (error) {
			if (!(error instanceof Error && isMissingFile(error))) throw error;
		}
		const appModule = await importAppModule(appPath);

		const { runtime, guestHandlersSource } = resolveExampleRuntime(
			meta.id,
			meta.deployKind,
			appSource,
			appModule,
			handlersFile,
		);
		const bindleContainers = extractBindleContainers(appModule.default);
		const bindleWebApp = extractBindleWebApp(appModule.default);
		if (
			meta.deployKind === "local-bridge" &&
			bindleContainers.length === 0 &&
			bindleWebApp === null
		) {
			throw new TypeError(
				`${meta.id}: local-bridge Bindle must declare b.web(waspApp|convexApp(...)) and/or b.container({ image }) resources to ship`,
			);
		}

		catalog.push({
			...meta,
			source: `${appSource.trimEnd()}\n`,
			handlersSource: guestHandlersSource,
			bindleContainers,
			bindleWebApp,
			runtime,
			...descriptor,
		});
	}

	return catalog;
}

const BRIDGE_PLACEHOLDER_RUNTIME: ExampleRuntimeDescriptor = {
	schemaVersion: "hobo.try-runtime/v1",
	resources: {},
	routes: [{ method: "GET", path: "/health", action: "health" }],
};

function extractBindleWebApp(
	definition: BindleDefinition | undefined,
): ExampleBindleWebApp | null {
	if (!definition) return null;
	for (const resource of Object.values(definition.resources)) {
		if (resource.kind !== "web") continue;
		for (const annotation of resource.annotations) {
			if (annotation.option !== "webapp" || annotation.provider !== "hobo") {
				continue;
			}
			// SAFETY: Bindle annotation config is a JSON bag at this parse boundary.
			const config = annotation.config as JsonObject;
			const framework = config.framework;
			const root = config.root;
			if (isJsonString(framework) && isJsonString(root)) {
				return { framework, root };
			}
		}
	}
	return null;
}

function extractBindleContainers(
	definition: BindleDefinition | undefined,
): readonly ExampleBindleContainer[] {
	if (!definition) return [];
	const out: ExampleBindleContainer[] = [];
	for (const [name, resource] of Object.entries(definition.resources)) {
		if (resource.kind !== "container") continue;
		for (const annotation of resource.annotations) {
			if (annotation.option !== "dependency" || annotation.provider !== "hobo") {
				continue;
			}
			// SAFETY: Bindle annotation config is a JSON bag at this parse boundary.
			const config = annotation.config as JsonObject;
			const image = config.image;
			if (isJsonString(image) && image.length > 0) {
				out.push({ name, image });
			}
		}
	}
	return out;
}

function resolveExampleRuntime(
	id: string,
	deployKind: "browser-wit" | "local-bridge",
	appSource: string,
	appModule: ExampleAppModule,
	handlersFile: string,
): ExampleRuntimeParts {
	if (deployKind === "local-bridge") {
		// Browser WIT guest unused — ship path deploys Bindle container images.
		return { runtime: BRIDGE_PLACEHOLDER_RUNTIME, guestHandlersSource: "" };
	}

	const bindleDef = appModule.default;
	const webFactory = bindleDef?.entrypoint("web");
	const webFactoryTag = Object.prototype.toString.call(webFactory);
	const hasWebEntrypoint =
		webFactoryTag === "[object Function]" ||
		webFactoryTag === "[object AsyncFunction]";

	if (hasWebEntrypoint && bindleDef && appModule.runtime === undefined) {
		return deriveWebGuestFromBindle(bindleDef, appSource);
	}

	if (appModule.runtime !== undefined) {
		return {
			runtime: parseRuntime(appModule.runtime),
			guestHandlersSource: handlersFile.trim(),
		};
	}

	if (handlersFile.trim().length > 0) {
		return {
			runtime: synthesizeTryRuntimeFromDeclared(appSource),
			guestHandlersSource: handlersFile.trim(),
		};
	}

	throw new TypeError(
		`Example ${id}: export runtime, handlers.txt, or bindle default with b.web(Trainable)`,
	);
}

function parseMeta(value: JsonValue, directory: string): ParsedMeta {
	const input = record(value, `${directory}/meta.json`);
	const id = string(input.id, "meta.id");
	if (!ID.test(id) || id !== directory) {
		throw new TypeError(`meta.id must match its example directory (${directory})`);
	}
	const entry = string(input.entry, "meta.entry");
	if (!/^[a-z0-9-]+\.(?:ts|mts)$/u.test(entry)) {
		throw new TypeError("meta.entry must be a local TypeScript filename");
	}
	const sourcePath = string(input.sourcePath, "meta.sourcePath");
	if (sourcePath !== `examples/try-site/apps/${id}/${entry}`) {
		throw new TypeError(
			`meta.sourcePath must be examples/try-site/apps/${id}/${entry}`,
		);
	}
	const ui = parseUiKind(string(input.ui, "meta.ui"));
	const deployKindRaw =
		input.deployKind === undefined ? "browser-wit" : string(input.deployKind, "meta.deployKind");
	if (deployKindRaw !== "browser-wit" && deployKindRaw !== "local-bridge") {
		throw new TypeError("meta.deployKind must be browser-wit or local-bridge");
	}
	return {
		id,
		title: string(input.title, "meta.title"),
		blurb: string(input.blurb, "meta.blurb"),
		tags: strings(input.tags, "meta.tags"),
		needs: strings(input.needs, "meta.needs"),
		ui,
		deployKind: deployKindRaw,
		entry,
		sourcePath,
	};
}

function parseDescriptor(
	value: JsonValue,
	directory: string,
	pool: ParsedYardPool,
): ParsedDescriptor {
	const input = record(value, `${directory}/yard.json`);
	if (input.schemaVersion !== "hobo.try-example/v1") {
		throw new TypeError("yard.schemaVersion must be hobo.try-example/v1");
	}
	return {
		appPolicy: parsePolicy(input.appPolicy, "appPolicy"),
		deploymentPolicy: parsePolicy(input.deploymentPolicy, "deploymentPolicy"),
		topology: parseTopology(input.topology, pool),
	};
}

function parseYardPool(value: JsonValue): ParsedYardPool {
	const input = record(value, "yards.json");
	if (input.schemaVersion !== "hobo.try-yards/v1") {
		throw new TypeError("yards.schemaVersion must be hobo.try-yards/v1");
	}
	const homeStation = record(input.homeStation, "yards.homeStation");
	if (!isJsonArray(input.yards) || input.yards.length === 0) {
		throw new TypeError("yards.yards must contain provider-specific Yards");
	}
	const yards = input.yards.map((entry, index) => parseYard(entry, index));
	const ids = new Set(yards.map((yard) => yard.id));
	if (ids.size !== yards.length) throw new TypeError("Yard IDs must be unique");
	return {
		homeStationId: string(homeStation.id, "yards.homeStation.id"),
		yards,
		yardIds: ids,
	};
}

function parseYard(value: JsonValue, index: number): ExampleYard {
	const yard = record(value, `yards.yards[${index}]`);
	return {
		id: string(yard.id, `yards.yards[${index}].id`),
		targetId: string(yard.targetId, `yards.yards[${index}].targetId`),
		providerId: string(yard.providerId, `yards.yards[${index}].providerId`),
		campId: string(yard.campId, `yards.yards[${index}].campId`),
	};
}

function parsePolicy(value: JsonValue | undefined, label: string): ExamplePolicy {
	const input = record(value, label);
	const output: MutableSparseBudgetPolicy = {};
	const known = new Set([
		"preferLocal",
		"routing",
		"redundancy",
		"maxReplicas",
		"maxConcurrent",
		"monthlySpendCapUsd",
		"resourcePool",
	]);
	for (const key of Object.keys(input)) {
		if (!known.has(key)) {
			throw new TypeError(`${label}.${key} is not a policy field`);
		}
	}
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
		output.monthlySpendCapUsd = finiteNumber(
			input.monthlySpendCapUsd,
			`${label}.monthlySpendCapUsd`,
			0,
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

function parseTopology(
	value: JsonValue | undefined,
	pool: ParsedYardPool,
): ExampleTopology {
	const input = record(value, "topology");
	const junction = record(input.junction, "topology.junction");
	const junctionYardIds = references(
		junction.yardIds,
		"topology.junction.yardIds",
		pool.yardIds,
	);
	const allowedYardIds =
		input.allowedYardIds === null || input.allowedYardIds === undefined
			? null
			: references(
					input.allowedYardIds,
					"topology.allowedYardIds",
					pool.yardIds,
				);
	const junctionMembers = new Set(junctionYardIds);
	if (allowedYardIds?.some((id) => !junctionMembers.has(id))) {
		throw new TypeError(
			"topology.allowedYardIds must be a subset of topology.junction.yardIds",
		);
	}
	return {
		homeStation: {
			id: pool.homeStationId,
			registeredYardIds: [...pool.yardIds],
		},
		yards: pool.yards,
		junction: {
			id: string(junction.id, "topology.junction.id"),
			yardIds: junctionYardIds,
		},
		allowedYardIds,
	};
}

function parseRuntime(value: JsonValue): ExampleRuntimeDescriptor {
	const input = record(value, "runtime.json");
	if (input.schemaVersion !== "hobo.try-runtime/v1") {
		throw new TypeError("runtime.schemaVersion must be hobo.try-runtime/v1");
	}
	const resourcesInput = record(input.resources, "runtime.resources");
	const resources: Record<string, ExampleRuntimeResource> = {};
	for (const [name, raw] of Object.entries(resourcesInput)) {
		const resource = record(raw, `runtime.resources.${name}`);
		if (resource.kind !== "kv" && resource.kind !== "queue") {
			throw new TypeError(`runtime resource ${name} has an invalid kind`);
		}
		resources[name] = { kind: resource.kind, initial: resource.initial ?? null };
	}
	if (!isJsonArray(input.routes) || input.routes.length === 0) {
		throw new TypeError("runtime.routes must be a non-empty array");
	}
	const routes = input.routes.map((raw, index) => {
		const route = record(raw, `runtime.routes[${index}]`);
		const method = oneOf(route.method, `runtime.routes[${index}].method`, [
			"GET",
			"POST",
			"PATCH",
			"DELETE",
		] as const);
		const action = oneOf(
			route.action,
			`runtime.routes[${index}].action`,
			[
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
			] as const,
		);
		const resource =
			route.resource === undefined
				? undefined
				: string(route.resource, `runtime.routes[${index}].resource`);
		if (resource !== undefined && !(resource in resources)) {
			throw new TypeError(
				`runtime.routes[${index}] references an unknown resource`,
			);
		}
		const parsed: MutableRuntimeRoute = {
			method,
			path: string(route.path, `runtime.routes[${index}].path`),
			action,
		};
		if (resource !== undefined) parsed.resource = resource;
		if (route.key !== undefined) {
			parsed.key = string(route.key, `runtime.routes[${index}].key`);
		}
		return parsed;
	});
	return { schemaVersion: "hobo.try-runtime/v1", resources, routes };
}

function references(
	value: JsonValue | undefined,
	label: string,
	known: Set<string>,
): string[] {
	const values = strings(value, label);
	if (values.some((id) => !known.has(id))) {
		throw new TypeError(`${label} references an unknown Yard`);
	}
	return values;
}

function record(value: JsonValue | undefined, label: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value;
}

function string(value: JsonValue | undefined, label: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	return value;
}

function strings(value: JsonValue | undefined, label: string): string[] {
	if (!isJsonArray(value)) {
		throw new TypeError(`${label} must be a string array`);
	}
	const out: string[] = [];
	for (const entry of value) {
		if (!isJsonString(entry)) {
			throw new TypeError(`${label} must be a string array`);
		}
		out.push(entry);
	}
	return [...new Set(out)];
}

function boolean(value: JsonValue | undefined, label: string): boolean {
	if (!isJsonBoolean(value)) throw new TypeError(`${label} must be boolean`);
	return value;
}

function integer(value: JsonValue | undefined, label: string, minimum: number): number {
	const parsed = finiteNumber(value, label, minimum);
	if (!Number.isInteger(parsed)) {
		throw new TypeError(`${label} must be an integer >= ${minimum}`);
	}
	return parsed;
}

function finiteNumber(
	value: JsonValue | undefined,
	label: string,
	minimum: number,
): number {
	if (!isJsonNumber(value) || !Number.isFinite(value) || value < minimum) {
		throw new TypeError(`${label} must be a finite number >= ${minimum}`);
	}
	return value;
}

function parseUiKind(value: string): ExampleUiKind {
	for (const choice of ["counter", "hello", "notes", "todos", "queue", "saas"] as const) {
		if (choice === value) return choice;
	}
	throw new TypeError(
		"meta.ui must be counter, hello, notes, todos, queue, or saas",
	);
}

function oneOf<const T extends readonly string[]>(
	value: JsonValue | undefined,
	label: string,
	choices: T,
): T[number] {
	if (!isJsonString(value)) throw new TypeError(`${label} is invalid`);
	for (const choice of choices) {
		if (choice === value) return choice;
	}
	throw new TypeError(`${label} is invalid`);
}

function isMissingFile(error: Error): boolean {
	if (!("code" in error)) return false;
	// SAFETY: Node fs errors that carry `code` are ErrnoException at this boundary.
	return (error as NodeErrno).code === "ENOENT";
}
