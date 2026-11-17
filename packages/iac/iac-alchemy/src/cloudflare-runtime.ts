import type { BindleForAlchemy, PrimitiveDeclaration } from "./bindle.js";
import {
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	CloudflareKvError,
	type CloudflareKvMode,
	cloudflareEventualKv,
	encodeCloudflareKvKey,
	readCloudflareKvBytes,
} from "./cloudflare-kv-protocol.js";

export {
	CLOUDFLARE_KV_MAX_KEY_BYTES,
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	CloudflareKvError,
	type CloudflareKvMode,
	cloudflareEventualKv,
} from "./cloudflare-kv-protocol.js";

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
	readonly kind: "service" | "kv";
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
	/** Native JavaScript subset; reads are eventually consistent and WASI guests are not wired. */
	kv(name: string): CloudflareKvStore;
}

export interface CloudflareKvStore {
	get(key: string): Promise<Uint8Array | undefined>;
	exists(key: string): Promise<boolean>;
	set(entry: {
		readonly key: string;
		readonly value: Uint8Array;
	}): Promise<void>;
	delete(key: string): Promise<void>;
}

const contexts = new WeakMap<object, CloudflareResources>();
const workers = new WeakMap<object, CloudflareWorkerDescription>();

/**
 * Attach target-specific KV choices to an adapter view of a provider-neutral
 * Bindle. The original Bindle remains unchanged and can be routed elsewhere.
 */
export function withCloudflareEventualKv<Requirements>(
	bindle: BindleForAlchemy<CloudflareBindleEntrypoint, Requirements>,
	modes: Readonly<Record<string, CloudflareKvMode>>,
): BindleForAlchemy<CloudflareBindleEntrypoint, Requirements> {
	const choices = Object.getOwnPropertyDescriptors(modes);
	if (
		Object.getOwnPropertySymbols(modes).length !== 0 ||
		Object.keys(choices).length === 0 ||
		Object.keys(choices).length > 256
	)
		throw new Error("explicit KV target choices must be bounded and nonempty");
	const declarations: Record<string, PrimitiveDeclaration> =
		Object.create(null);
	for (const [resourceName, declaration] of Object.entries(bindle.resources)) {
		const choice = choices[resourceName];
		if (choice === undefined) {
			declarations[resourceName] = declaration;
			continue;
		}
		if (
			!("value" in choice) ||
			!choice.enumerable ||
			declaration.kind !== "kv" ||
			declaration.annotations.length !== 0
		)
			throw new Error(
				"KV target choice does not match an unannotated KV resource",
			);
		declarations[resourceName] = Object.freeze({
			...declaration,
			annotations: Object.freeze([cloudflareEventualKv(choice.value)]),
		});
	}
	if (Object.keys(choices).some((key) => !Object.hasOwn(declarations, key)))
		throw new Error("KV target choice names an unknown resource");
	const view = {
		name: bindle.name,
		resources: Object.freeze(declarations),
		edges: bindle.edges,
		requirements: bindle.requirements,
		entrypoint: (resourceName: string) => bindle.entrypoint(resourceName),
	};
	return bindle.connectors === undefined
		? Object.freeze(view)
		: Object.freeze({ ...view, connectors: bindle.connectors });
}

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
		kv(name) {
			const binding = find(name, "kv");
			const perform = async (
				operation: "get" | "set" | "delete",
				key: string,
				value?: Uint8Array,
			): Promise<Response> => {
				if (!binding.allow.includes(operation))
					throw new CloudflareKvError(
						"KV_OPERATION_DENIED",
						`operation is not allowed: ${operation}`,
					);
				const encoded = encodeCloudflareKvKey(key);
				if (
					operation === "set" &&
					(!(value instanceof Uint8Array) ||
						value.byteLength > CLOUDFLARE_KV_MAX_VALUE_BYTES)
				)
					throw new CloudflareKvError(
						"KV_VALUE_INVALID",
						"value must be bounded bytes",
					);
				const body =
					value === undefined ? undefined : new Uint8Array(value).buffer;
				const controller = new AbortController();
				const init: RequestInit = {
					method: "POST",
					headers: { "x-hobo-kv-key": encoded },
					signal: controller.signal,
				};
				if (body !== undefined) init.body = body;
				const request = new Request(
					`https://hobo-kv.internal/${operation}`,
					init,
				);
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const proxy = environment[binding.env];
					if (typeof proxy !== "object" || proxy === null)
						throw new Error("service unavailable");
					const fetch = Reflect.get(proxy, "fetch");
					if (typeof fetch !== "function")
						throw new Error("service unavailable");
					const response = await Promise.race([
						Reflect.apply(fetch, proxy, [request]),
						new Promise<never>((_, reject) => {
							timer = setTimeout(() => {
								controller.abort();
								reject(new Error("service timed out"));
							}, 10_000);
						}),
					]);
					if (!(response instanceof Response))
						throw new Error("invalid service response");
					if (
						response.status !== 204 &&
						!(
							operation === "get" &&
							(response.status === 200 || response.status === 404)
						)
					)
						throw new Error("service request failed");
					if (operation === "get" && response.status === 204)
						throw new Error("invalid read response");
					return response;
				} catch {
					throw new CloudflareKvError(
						operation === "get"
							? "KV_READ_UNAVAILABLE"
							: "KV_MUTATION_OUTCOME_UNKNOWN",
						operation === "get"
							? "KV read failed"
							: "KV mutation may have taken effect; reconcile before retry",
					);
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			};
			const get = async (key: string): Promise<Uint8Array | undefined> => {
				const response = await perform("get", key);
				if (response.status === 404) return undefined;
				try {
					return new Uint8Array(await readCloudflareKvBytes(response.body));
				} catch {
					throw new CloudflareKvError(
						"KV_READ_UNAVAILABLE",
						"KV read was incomplete or too large",
					);
				}
			};
			return Object.freeze({
				get,
				async exists(key: string) {
					return (await get(key)) !== undefined;
				},
				async set(entry: { readonly key: string; readonly value: Uint8Array }) {
					if (typeof entry !== "object" || entry === null)
						throw new CloudflareKvError(
							"KV_VALUE_INVALID",
							"entry must contain a key and bytes",
						);
					await perform("set", entry.key, entry.value);
				},
				async delete(key: string) {
					await perform("delete", key);
				},
			});
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

/** Validate an explicit native subset and the exact HoBo capability grant. */
export function cloudflareKvConfiguration(declaration: PrimitiveDeclaration): {
	readonly mode: CloudflareKvMode;
	readonly allow: readonly string[];
} {
	const annotation = declaration.annotations[0];
	if (
		declaration.annotations.length !== 1 ||
		annotation === undefined ||
		annotation.provider !== "cloudflare" ||
		annotation.option !== "eventual-kv"
	)
		throw new Error(
			"KV runtime is unsupported: WASI store semantics and consistency are not bound; explicit eventual worker-js mode is required",
		);
	const config = Object.getOwnPropertyDescriptors(annotation.config);
	const mode = config.mode;
	const consistency = config.consistency;
	const runtime = config.runtime;
	if (
		Object.keys(config).length !== 3 ||
		mode === undefined ||
		!("value" in mode) ||
		(mode.value !== "read-only" && mode.value !== "write-only") ||
		consistency === undefined ||
		!("value" in consistency) ||
		consistency.value !== "eventual" ||
		runtime === undefined ||
		!("value" in runtime) ||
		runtime.value !== "worker-js"
	)
		throw new Error(
			"KV runtime is unsupported: invalid eventual worker-js mode",
		);
	const allowed = declaration.declaredAllow;
	if (
		allowed.length === 0 ||
		allowed.length > 2 ||
		new Set(allowed).size !== allowed.length ||
		(mode.value === "read-only" &&
			(allowed.length !== 1 || allowed[0] !== "get")) ||
		(mode.value === "write-only" &&
			allowed.some((verb) => verb !== "set" && verb !== "delete"))
	)
		throw new Error(
			"KV requires an explicit read-only or write-only allow list",
		);
	return Object.freeze({
		mode: mode.value,
		allow: Object.freeze([...allowed].sort()),
	});
}

function allowFor(declaration: PrimitiveDeclaration) {
	switch (declaration.kind) {
		case "bucket":
			throw new Error(
				"bucket runtime is unsupported: blob metadata, events and presigned URLs are not bound",
			);
		case "kv":
			return {
				kind: "kv",
				verbs: cloudflareKvConfiguration(declaration).allow,
			} as const;
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
				allow: support.kind === "kv" ? support.verbs : Object.freeze(["fetch"]),
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
