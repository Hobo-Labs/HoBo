import { createBoundaryDeferred, observeBoundary } from "./async-boundary.js";
import type { BindleForAlchemy, PrimitiveDeclaration } from "./bindle.js";
import {
	quarantineCloudflareNative,
	releaseCloudflareNative,
	reserveCloudflareNative,
} from "./cloudflare-capacity.js";
import {
	type CloudflareR2Store,
	createCloudflareR2Store,
} from "./cloudflare-r2-client.js";
import {
	type CloudflareR2Grant,
	cloudflareR2Grant,
	cloudflareR2Option,
} from "./cloudflare-r2-protocol.js";
import { compareCodeUnits } from "./code-unit-order.js";

export type {
	CloudflareR2Object,
	CloudflareR2Store,
} from "./cloudflare-r2-client.js";
export {
	CLOUDFLARE_R2_MAX_CONTENT_TYPE_BYTES,
	CLOUDFLARE_R2_MAX_KEY_BYTES,
	CLOUDFLARE_R2_MAX_OBJECT_BYTES,
	CloudflareR2Error,
	type CloudflareR2Grant,
	cloudflareR2Digest,
} from "./cloudflare-r2-protocol.js";

import {
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	CloudflareKvError,
	type CloudflareKvGrant,
	type CloudflareKvMode,
	cloudflareEventualKv,
	cloudflareKvGrant,
	encodeCloudflareKvKey,
	readCloudflareKvBytes,
} from "./cloudflare-kv-protocol.js";
import { awaitCloudflareNative } from "./cloudflare-native-await.js";
import { observeCloudflareNativePromise } from "./cloudflare-native-promise.js";
import {
	cloudflareAbortSignal,
	cloudflareDiscardResponse,
	cloudflareHeaders,
	cloudflareNonThenable,
	cloudflareProtectResponse,
	cloudflareRequestInit,
	cloudflareResponseBody,
	cloudflareResponseStatus,
} from "./cloudflare-web-options.js";

export {
	CLOUDFLARE_KV_MAX_KEY_BYTES,
	CLOUDFLARE_KV_MAX_VALUE_BYTES,
	CloudflareKvError,
	type CloudflareKvGrant,
	type CloudflareKvMode,
} from "./cloudflare-kv-protocol.js";

const hasOwnDescriptor = Object.hasOwn;
const getKvNative = Reflect.get;
const applyKvNative = Reflect.apply;
const NativeRequest = Request;
const NativeAbortController = AbortController;
const NativeBytes = Uint8Array;
const isView = ArrayBuffer.isView;
const hasInstance = Function.prototype[Symbol.hasInstance];
const bytePrototype = Object.getPrototypeOf(NativeBytes.prototype);
const byteLength = Object.getOwnPropertyDescriptor(
	bytePrototype,
	"byteLength",
)?.get;
const byteBuffer = Object.getOwnPropertyDescriptor(
	bytePrototype,
	"buffer",
)?.get;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const abortController = AbortController.prototype.abort;

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

export type CloudflareBindingDescriptor = {
	readonly name: string;
	readonly env: string;
	readonly allow: readonly string[];
} & (
	| { readonly kind: "service" }
	| {
			readonly kind: "kv";
			readonly mode: CloudflareKvMode;
			readonly grantEpoch: string;
			readonly namespaceEpoch: string;
	  }
	| {
			readonly kind: "r2";
			readonly grantEpoch: string;
			readonly bucketEpoch: string;
	  }
);

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

	kv(name: string): CloudflareKvStore;

	bucket(name: string): CloudflareR2Store;
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

export function withCloudflareR2<Requirements>(
	bindle: BindleForAlchemy<CloudflareBindleEntrypoint, Requirements>,
	grants: Readonly<Record<string, CloudflareR2Grant>>,
): BindleForAlchemy<CloudflareBindleEntrypoint, Requirements> {
	/* oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: target options cross the application boundary. */
	if (typeof grants !== "object" || grants === null || Array.isArray(grants))
		throw new Error("explicit R2 target choices must be bounded and nonempty");
	const choices = Object.getOwnPropertyDescriptors(grants);
	if (
		Object.getOwnPropertySymbols(grants).length !== 0 ||
		Object.keys(choices).length === 0 ||
		Object.keys(choices).length > 256
	)
		throw new Error("explicit R2 target choices must be bounded and nonempty");
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
			declaration.kind !== "bucket" ||
			declaration.annotations.length !== 0
		)
			throw new Error(
				"R2 target choice does not match an unannotated bucket resource",
			);
		declarations[resourceName] = Object.freeze({
			...declaration,
			annotations: Object.freeze([cloudflareR2Option(choice.value)]),
		});
	}
	if (Object.keys(choices).some((key) => !Object.hasOwn(declarations, key)))
		throw new Error("R2 target choice names an unknown resource");
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

export function withCloudflareEventualKv<Requirements>(
	bindle: BindleForAlchemy<CloudflareBindleEntrypoint, Requirements>,
	modes: Readonly<Record<string, CloudflareKvGrant>>,
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
		const choice = hasOwnDescriptor(choices, resourceName)
			? choices[resourceName]
			: undefined;
		if (choice === undefined) {
			declarations[resourceName] = declaration;
			continue;
		}
		if (
			!hasOwnDescriptor(choice, "value") ||
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

const applyNative = Reflect.apply;
const getNative = Reflect.get;
const getWeakMap = WeakMap.prototype.get;
const setWeakMap = WeakMap.prototype.set;
const handlerDescriptor = Object.getOwnPropertyDescriptor;
const handlerHasOwn = Object.hasOwn;
const handlerPrototype = Object.getPrototypeOf;
const objectPrototype = Object.prototype;

function name(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function invoke(
	environment: CloudflareEnvironment,
	binding: CloudflareBindingDescriptor,
	operation: string,
	...args: unknown[]
): Promise<import("./async-boundary.js").BoundaryBox<unknown>> {
	let allowed = false;
	for (let index = 0; index < binding.allow.length; index++) {
		if (binding.allow[index] === operation) {
			allowed = true;
			break;
		}
	}
	if (!allowed)
		throw new Error(`operation is not allowed: ${binding.name}.${operation}`);
	const value = environment[binding.env];
	if (typeof value !== "object" || value === null)
		throw new Error(`native resource is unavailable: ${binding.name}`);
	const run = getNative(value, operation);
	if (typeof run !== "function")
		throw new Error(
			`native resource lacks the requested operation: ${binding.name}.${operation}`,
		);
	const lease = reserveCloudflareNative();
	if (lease === undefined) throw new Error("native capacity unavailable");
	const result = createBoundaryDeferred<unknown>();
	let output: unknown;
	try {
		output = applyNative(run, value, args);
	} catch (error) {
		quarantineCloudflareNative(lease);
		throw error;
	}
	if (cloudflareProtectResponse(output)) {
		result.resolve(output);
		observeBoundary(
			result.promise,
			() => releaseCloudflareNative(lease),
			() => {},
		);
	} else if (
		!observeCloudflareNativePromise(
			output,
			(value) => {
				if (!cloudflareProtectResponse(value)) {
					quarantineCloudflareNative(lease);
					result.reject(new Error("service returned an invalid response"));
					return;
				}
				result.resolve(value);
				releaseCloudflareNative(lease);
			},
			() => {
				releaseCloudflareNative(lease);
				result.reject(new Error("native resource request failed"));
			},
		)
	) {
		quarantineCloudflareNative(lease);
		throw new Error("native resource result could not be observed");
	}
	return result.promise;
}

function resources(
	bindings: readonly CloudflareBindingDescriptor[],
	environment: CloudflareEnvironment,
): CloudflareResources {
	const find = (name: string, kind: CloudflareBindingDescriptor["kind"]) => {
		for (let index = 0; index < bindings.length; index++) {
			const binding = bindings[index];
			if (
				binding !== undefined &&
				binding.name === name &&
				binding.kind === kind
			)
				return binding;
		}
		throw new Error(`resource is not bound: ${name}`);
	};
	return {
		bucket(name) {
			const binding = find(name, "r2");
			return createCloudflareR2Store(environment[binding.env], binding.allow);
		},
		service(name) {
			const binding = find(name, "service");
			return {
				async fetch(request) {
					const response = (
						await invoke(environment, binding, "fetch", request)
					).value;
					if (!cloudflareProtectResponse(response))
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
				let allowed = false;
				for (let index = 0; index < binding.allow.length; index++) {
					if (binding.allow[index] === operation) {
						allowed = true;
						break;
					}
				}
				if (!allowed)
					throw new CloudflareKvError(
						"KV_OPERATION_DENIED",
						`operation is not allowed: ${operation}`,
					);
				const encoded = encodeCloudflareKvKey(key);
				if (operation === "set") {
					let valid = false;
					try {
						valid =
							value !== undefined &&
							isView(value) &&
							byteLength !== undefined &&
							applyKvNative(hasInstance, NativeBytes, [value]) &&
							applyKvNative(byteLength, value, []) <=
								CLOUDFLARE_KV_MAX_VALUE_BYTES;
					} catch {}
					if (!valid)
						throw new CloudflareKvError(
							"KV_VALUE_INVALID",
							"value must be bounded bytes",
						);
				}
				try {
					if (byteBuffer === undefined)
						throw new Error("byte buffer unavailable");
					const body =
						value === undefined
							? undefined
							: applyKvNative(byteBuffer, new NativeBytes(value), []);
					const controller = new NativeAbortController();
					const init = cloudflareRequestInit(
						cloudflareHeaders("x-hobo-kv-key", encoded),
						cloudflareAbortSignal(controller),
						body,
					);
					const request = new NativeRequest(
						`https://hobo-kv.internal/${operation}`,
						init,
					);
					const proxy = environment[binding.env];
					if (typeof proxy !== "object" || proxy === null)
						throw new Error("service unavailable");
					const fetch = getKvNative(proxy, "fetch");
					if (typeof fetch !== "function")
						throw new Error("service unavailable");
					const result = await awaitCloudflareNative<unknown>(
						() => applyKvNative(fetch, proxy, [request]),
						() => applyKvNative(abortController, controller, []),
						cloudflareDiscardResponse,
					);
					const response = result.value;
					if (!cloudflareProtectResponse(response))
						throw new Error("invalid service response");
					const status = cloudflareResponseStatus(response);
					if (
						status !== 204 &&
						!(operation === "get" && (status === 200 || status === 404))
					) {
						cloudflareDiscardResponse(response);
						throw new Error("service request failed");
					}
					if (operation === "get" && status === 204) {
						cloudflareDiscardResponse(response);
						throw new Error("invalid read response");
					}
					if (operation === "get" && status === 404)
						cloudflareDiscardResponse(response);
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
				}
			};
			const get = async (key: string): Promise<Uint8Array | undefined> => {
				const response = await perform("get", key);
				if (cloudflareResponseStatus(response) === 404) return undefined;
				try {
					return cloudflareNonThenable(
						new NativeBytes(
							await readCloudflareKvBytes(cloudflareResponseBody(response)),
						),
					);
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
					const key = ownDescriptor(entry, "key");
					const value = ownDescriptor(entry, "value");
					if (
						key === undefined ||
						!hasOwnDescriptor(key, "value") ||
						value === undefined ||
						!hasOwnDescriptor(value, "value") ||
						typeof key.value !== "string"
					)
						throw new CloudflareKvError(
							"KV_VALUE_INVALID",
							"entry must contain own key and bytes",
						);
					await perform("set", key.value, value.value);
				},
				async delete(key: string) {
					await perform("delete", key);
				},
			});
		},
	};
}

export function cloudflareBindings(
	context?: CloudflareContextRef,
): CloudflareResources {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: only the private contexts map is queried through the captured intrinsic.
	const result =
		context === undefined
			? undefined
			: (applyNative(getWeakMap, contexts, [context]) as
					| CloudflareResources
					| undefined);
	if (result === undefined)
		throw new Error("Cloudflare bindle context is unavailable");
	return result;
}

export function cloudflareKvConfiguration(declaration: PrimitiveDeclaration): {
	readonly mode: CloudflareKvMode;
	readonly grantEpoch: string;
	readonly namespaceEpoch: string;
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
	const mode = hasOwnDescriptor(config, "mode") ? config.mode : undefined;
	const epoch = hasOwnDescriptor(config, "grantEpoch")
		? config.grantEpoch
		: undefined;
	const namespace = hasOwnDescriptor(config, "namespaceEpoch")
		? config.namespaceEpoch
		: undefined;
	const consistency = hasOwnDescriptor(config, "consistency")
		? config.consistency
		: undefined;
	const runtime = hasOwnDescriptor(config, "runtime")
		? config.runtime
		: undefined;
	if (
		Object.keys(config).length !== 5 ||
		mode === undefined ||
		!hasOwnDescriptor(mode, "value") ||
		(mode.value !== "read-only" && mode.value !== "write-only") ||
		epoch === undefined ||
		!hasOwnDescriptor(epoch, "value") ||
		namespace === undefined ||
		!hasOwnDescriptor(namespace, "value") ||
		consistency === undefined ||
		!hasOwnDescriptor(consistency, "value") ||
		consistency.value !== "eventual" ||
		runtime === undefined ||
		!hasOwnDescriptor(runtime, "value") ||
		runtime.value !== "worker-js"
	)
		throw new Error(
			"KV runtime is unsupported: invalid eventual worker-js mode",
		);
	return cloudflareKvGrant(
		mode.value,
		epoch.value,
		namespace.value,
		declaration.declaredAllow,
	);
}

export function cloudflareR2Configuration(declaration: PrimitiveDeclaration) {
	const annotation = declaration.annotations[0];
	if (
		declaration.annotations.length !== 1 ||
		annotation === undefined ||
		annotation.provider !== "cloudflare" ||
		annotation.option !== "bounded-r2"
	)
		throw new Error(
			"bucket runtime is unsupported: blob metadata, events and presigned URLs are not fully bound; explicit bounded worker-js R2 mode is required",
		);
	const fields = Object.getOwnPropertyDescriptors(annotation.config);
	const grant = fields.grantEpoch;
	const bucket = fields.bucketEpoch;
	const runtime = fields.runtime;
	if (
		Object.getOwnPropertySymbols(annotation.config).length !== 0 ||
		Object.keys(fields).length !== 3 ||
		grant === undefined ||
		!("value" in grant) ||
		!grant.enumerable ||
		bucket === undefined ||
		!("value" in bucket) ||
		!bucket.enumerable ||
		runtime === undefined ||
		!("value" in runtime) ||
		!runtime.enumerable ||
		runtime.value !== "worker-js"
	)
		throw new Error(
			"bucket runtime is unsupported: invalid bounded R2 configuration",
		);
	return cloudflareR2Grant(
		declaration.declaredAllow,
		grant.value,
		bucket.value,
	);
}

function allowFor(declaration: PrimitiveDeclaration) {
	switch (declaration.kind) {
		case "bucket": {
			const grant = cloudflareR2Configuration(declaration);
			return {
				kind: "r2",
				verbs: grant.allow,
				grantEpoch: grant.grantEpoch,
				bucketEpoch: grant.bucketEpoch,
			} as const;
		}
		case "kv": {
			const grant = cloudflareKvConfiguration(declaration);
			return {
				kind: "kv",
				verbs: grant.allow,
				mode: grant.mode,
				grantEpoch: grant.grantEpoch,
				namespaceEpoch: grant.namespaceEpoch,
			} as const;
		}
		case "queue":
			throw new Error(
				"queue operation is unsupported: native queue send lacks HoBo idempotency and receipt semantics",
			);
		case "api":
		case "service":
		case "ui":
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
			const base = { name: resourceName, env: `HOBO_RESOURCE_${index}` };
			return support.kind === "r2"
				? Object.freeze({
						...base,
						kind: "r2",
						allow: support.verbs,
						grantEpoch: support.grantEpoch,
						bucketEpoch: support.bucketEpoch,
					})
				: support.kind === "kv"
					? Object.freeze({
							...base,
							kind: "kv",
							allow: support.verbs,
							mode: support.mode,
							grantEpoch: support.grantEpoch,
							namespaceEpoch: support.namespaceEpoch,
						})
					: Object.freeze({
							...base,
							kind: "service",
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
		!["web", "api", "service", "ui"].includes(declaration.kind) ||
		typeof entrypoint !== "function"
	)
		throw new Error("an HTTP bindle entrypoint is required");
	if (declaration.kind === "ui" && declaration.declaredAllow.length > 0)
		throw new Error("UI render and drive operations are unsupported");
	if (
		bindle.connectors !== undefined &&
		Object.keys(bindle.connectors).length > 0
	)
		throw new Error("connector bindings are unsupported");
	validateCloudflareHttpAnnotations(declaration);
	const edges = bindle.edges
		.filter((edge) => edge.from === resourceName)
		.sort((a, b) => compareCodeUnits(a.to, b.to));
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
			applyNative(setWeakMap, contexts, [
				context,
				resources(bindings, environment),
			]);
			const result = entrypoint(context);
			let output: unknown;
			if (typeof result === "function")
				output = applyNative(result, undefined, [request]);
			else if (typeof result === "object" && result !== null) {
				if (
					observeCloudflareNativePromise(
						result,
						() => {},
						() => {},
					)
				)
					throw new Error("bindle entrypoint did not return an HTTP handler");
				let current: object | null = result;
				let found = false;
				for (
					let depth = 0;
					current !== null && current !== objectPrototype && depth < 32;
					depth++
				) {
					const field = handlerDescriptor(current, "fetch");
					if (field !== undefined) {
						if (
							!handlerHasOwn(field, "value") ||
							typeof field.value !== "function"
						)
							throw new Error(
								"bindle entrypoint did not return an HTTP handler",
							);
						output = applyNative(field.value, result, [request]);
						found = true;
						break;
					}
					current = handlerPrototype(current);
				}
				if (!found)
					throw new Error("bindle entrypoint did not return an HTTP handler");
			} else
				throw new Error("bindle entrypoint did not return an HTTP handler");
			if (cloudflareProtectResponse(output)) return output;
			const pending = createBoundaryDeferred<unknown>();
			if (
				!observeCloudflareNativePromise(
					output,
					(value) => pending.resolve(value),
					(reason) => pending.reject(reason),
				)
			)
				throw new Error("bindle handler result could not be observed");
			const response = (await pending.promise).value;
			if (!cloudflareProtectResponse(response))
				throw new Error("bindle handler returned an invalid response");
			return response;
		},
	};
	applyNative(setWeakMap, workers, [worker, description]);
	return Object.freeze(worker);
}

export function inspectCloudflareWorker(
	value: CloudflareWorker,
): CloudflareWorkerDescription | undefined {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: only the private workers map is queried through the captured intrinsic.
	return applyNative(getWeakMap, workers, [value]) as
		| CloudflareWorkerDescription
		| undefined;
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-reflect-get, anti-slop/no-reflect-apply */
