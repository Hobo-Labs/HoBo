import type { BindleForAlchemy, PrimitiveDeclaration } from "./bindle.js";

type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { readonly [key: string]: Json };
type FetchHandler = (request: Request) => Response | Promise<Response>;
type EntrypointResult =
	| Json
	| { readonly [key: string]: Json | undefined }
	| FetchHandler
	| { readonly fetch: FetchHandler };

/** The connector surface exists on HoBo contexts; connector binding is not yet supported here. */
export interface CloudflareContextRef {
	connector(...args: never[]): object;
}

export interface CloudflareConnectorBinding {
	readonly kind: "connector";
}

export interface CloudflareBindleContext extends CloudflareContextRef {
	connector(binding: CloudflareConnectorBinding): never;
}

export type CloudflareBindleEntrypoint = (
	context?: CloudflareBindleContext,
) => EntrypointResult;

export interface CloudflareBindingDescriptor {
	readonly name: string;
	readonly kind: "service";
	readonly env: string;
	readonly allow: readonly string[];
}

export interface CloudflareWorkerDescription {
	readonly bindleName: string;
	readonly resourceName: string;
	readonly entrypoint: CloudflareBindleEntrypoint;
	readonly bindings: readonly CloudflareBindingDescriptor[];
}

export interface CloudflareWorker {
	fetch(
		request: Request,
		environment: CloudflareEnvironment,
	): Promise<Response>;
}

export interface CloudflareService {
	fetch(request: Request): Promise<Response>;
}

export interface CloudflareResources {
	service(name: string): CloudflareService;
}

const contexts = new WeakMap<object, CloudflareResources>();
const workers = new WeakMap<object, CloudflareWorkerDescription>();

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply -- SAFETY: Workers supplies an external env record; each selected binding and method is checked before invocation. */
export type CloudflareEnvironment = Readonly<Record<string, unknown>>;

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

async function invoke(
	environment: CloudflareEnvironment,
	binding: CloudflareBindingDescriptor,
	operation: string,
	...args: unknown[]
): Promise<unknown> {
	if (!binding.allow.includes(operation))
		throw new Error(`operation is not allowed: ${binding.name}.${operation}`);
	const value = environment[binding.env];
	if (typeof value !== "object" || value === null)
		throw new Error(`native resource is unavailable: ${binding.name}`);
	const run = Reflect.get(value, operation);
	if (typeof run !== "function")
		throw new Error(
			`native resource lacks the requested operation: ${binding.name}.${operation}`,
		);
	return await Reflect.apply(run, value, args);
}

function resources(
	bindings: readonly CloudflareBindingDescriptor[],
	environment: CloudflareEnvironment,
): CloudflareResources {
	const find = (name: string, kind: CloudflareBindingDescriptor["kind"]) => {
		const binding = bindings.find(
			(item) => item.name === name && item.kind === kind,
		);
		if (binding === undefined)
			throw new Error(`resource is not bound: ${name}`);
		return binding;
	};
	return {
		service(name) {
			const binding = find(name, "service");
			return {
				async fetch(request) {
					const response = await invoke(environment, binding, "fetch", request);
					if (!(response instanceof Response))
						throw new Error("service returned an invalid response");
					return response;
				},
			};
		},
	};
}

/** Resolve only the resources declared as dependencies of the current HTTP entrypoint. */
export function cloudflareBindings(
	context?: CloudflareContextRef,
): CloudflareResources {
	const result = context === undefined ? undefined : contexts.get(context);
	if (result === undefined)
		throw new Error("Cloudflare bindle context is unavailable");
	return result;
}

function allowFor(declaration: PrimitiveDeclaration) {
	switch (declaration.kind) {
		case "bucket":
			throw new Error(
				"bucket runtime is unsupported: blob metadata, events and presigned URLs are not bound",
			);
		case "kv":
			throw new Error(
				"KV runtime is unsupported: WASI store semantics and consistency are not bound",
			);
		case "queue":
			throw new Error(
				"queue operation is unsupported: native queue send lacks HoBo idempotency and receipt semantics",
			);
		case "api":
		case "service":
		case "web":
			return { kind: "service", verbs: [] } as const;
		default:
			throw new Error(
				`Cloudflare dependency kind is unsupported: ${declaration.kind}`,
			);
	}
}

export function cloudflareDependencyBindings(
	declarations: Readonly<Record<string, PrimitiveDeclaration>>,
): readonly CloudflareBindingDescriptor[] {
	const names = Object.keys(declarations).sort();
	if (names.length > 256)
		throw new Error("HTTP dependencies exceed the resource limit");
	return Object.freeze(
		names.map((resourceName, index): CloudflareBindingDescriptor => {
			const dependency = Object.hasOwn(declarations, resourceName)
				? declarations[resourceName]
				: undefined;
			if (
				dependency === undefined ||
				!name(resourceName) ||
				dependency.name !== resourceName ||
				dependency.stableId !== `${dependency.kind}:${resourceName}`
			)
				throw new Error("HTTP dependency is invalid");
			const support = allowFor(dependency);
			if (
				dependency.declaredAllow.length > 256 ||
				new Set(dependency.declaredAllow).size !==
					dependency.declaredAllow.length ||
				dependency.declaredAllow.some(
					(verb) => !support.verbs.some((value) => value === verb),
				)
			)
				throw new Error(`${dependency.kind} operation is unsupported`);
			return Object.freeze({
				name: resourceName,
				kind: support.kind,
				env: `HOBO_RESOURCE_${index}`,
				allow: Object.freeze(["fetch"]),
			});
		}),
	);
}

export function validateCloudflareHttpAnnotations(
	declaration: PrimitiveDeclaration,
): void {
	if (declaration.annotations.length > 1)
		throw new Error("multiple HTTP annotations are unsupported");
	for (const annotation of declaration.annotations) {
		if (
			annotation.provider !== "hobo" ||
			annotation.option !== "session-replay" ||
			!("enabled" in annotation.config) ||
			annotation.config.enabled !== false ||
			Object.keys(annotation.config).some(
				(key) => !["enabled", "defaultSupply", "sampleRate"].includes(key),
			)
		)
			throw new Error("enabled session replay or annotation is unsupported");
	}
}

/** Create the default export of the worker module from the same Bindle entrypoint. */
export function bindleCloudflareWorker<Requirements>(
	bindle: BindleForAlchemy<CloudflareBindleEntrypoint, Requirements>,
	resourceName: string,
): CloudflareWorker {
	const declaration = Object.hasOwn(bindle.resources, resourceName)
		? bindle.resources[resourceName]
		: undefined;
	const entrypoint = bindle.entrypoint(resourceName);
	if (
		!name(bindle.name) ||
		declaration === undefined ||
		declaration.name !== resourceName ||
		!["web", "api", "service"].includes(declaration.kind) ||
		!(entrypoint instanceof Function)
	)
		throw new Error("an HTTP bindle entrypoint is required");
	if (
		bindle.connectors !== undefined &&
		Object.keys(bindle.connectors).length > 0
	)
		throw new Error("connector bindings are unsupported");
	validateCloudflareHttpAnnotations(declaration);
	const edges = bindle.edges
		.filter((edge) => edge.from === resourceName)
		.sort((a, b) => a.to.localeCompare(b.to));
	if (
		edges.length > 256 ||
		new Set(edges.map((edge) => edge.to)).size !== edges.length
	)
		throw new Error("HTTP dependencies must be bounded and unique");
	const dependencies: Record<string, PrimitiveDeclaration> =
		Object.create(null);
	for (const edge of edges) {
		const dependency = Object.hasOwn(bindle.resources, edge.to)
			? bindle.resources[edge.to]
			: undefined;
		if (dependency === undefined || dependency.name !== edge.to)
			throw new Error("HTTP dependency is missing");
		dependencies[edge.to] = dependency;
	}
	const bindings = cloudflareDependencyBindings(dependencies);
	const kinds = edges.map((edge) => bindle.resources[edge.to]?.kind).sort();
	const declared = [...declaration.dependsOn].sort();
	if (
		kinds.length !== declared.length ||
		kinds.some((value, index) => value !== declared[index])
	)
		throw new Error("HTTP dependency graph is incomplete");
	const description: CloudflareWorkerDescription = Object.freeze({
		bindleName: bindle.name,
		resourceName,
		entrypoint,
		bindings: Object.freeze(bindings),
	});
	const worker: CloudflareWorker = {
		async fetch(request, environment) {
			const context: CloudflareBindleContext = Object.freeze({
				connector() {
					throw new Error("connector bindings are unsupported");
				},
			});
			contexts.set(context, resources(bindings, environment));
			const result = entrypoint(context);
			if (result instanceof Function) return result(request);
			if (
				typeof result === "object" &&
				result !== null &&
				"fetch" in result &&
				result.fetch instanceof Function
			)
				return result.fetch(request);
			throw new Error("bindle entrypoint did not return an HTTP handler");
		},
	};
	workers.set(worker, description);
	return Object.freeze(worker);
}

/** The mapper checks that the module exports this worker and the same Bindle entrypoint. */
export function inspectCloudflareWorker(
	value: CloudflareWorker,
): CloudflareWorkerDescription | undefined {
	return workers.get(value);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply */
