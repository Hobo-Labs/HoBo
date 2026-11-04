import type { ConnectionClient } from "./connection.js";
import type { JsonObject, JsonValue } from "./json.js";

export const CATALOG_ROWS = [
	{ factory: "api", portRef: ["wasi:http", "hobo:http"], allowVerbs: [] },
	{
		factory: "kv",
		portRef: ["wasi:keyvalue"],
		allowVerbs: ["get", "set", "delete"],
	},
	{
		factory: "bucket",
		portRef: ["wasi:blobstore", "hobo:blob-events"],
		allowVerbs: ["read", "write", "delete"],
	},
	{
		factory: "queue",
		portRef: ["hobo:queue"],
		allowVerbs: ["enqueue", "dequeue"],
	},
	{
		factory: "topic",
		portRef: ["wasi:messaging"],
		allowVerbs: ["publish", "subscribe"],
	},
	{
		factory: "secret",
		portRef: ["wasi:config", "hobo:secrets"],
		allowVerbs: ["put", "access"],
	},
	{
		factory: "data",
		portRef: ["hobo:data"],
		allowVerbs: ["read", "write", "query", "admin"],
	},
	{ factory: "schedule", portRef: ["hobo:scheduler"], allowVerbs: [] },
	{
		factory: "websocket",
		portRef: ["wasi:websocket", "hobo:websocket"],
		allowVerbs: ["accept", "connect", "send", "broadcast", "subscribe"],
	},
	{ factory: "job", portRef: ["hobo:job"], allowVerbs: ["submit"] },
	{ factory: "web", portRef: ["wasi:http"], allowVerbs: [] },
	{ factory: "service", portRef: ["wasi:http"], allowVerbs: [] },
	{ factory: "external", portRef: ["hobo:external"], allowVerbs: [] },
	{ factory: "container", portRef: ["hobo:container"], allowVerbs: [] },
	{
		factory: "wasm-component",
		portRef: ["wasi:http", "hobo:wasm-component"],
		allowVerbs: [],
	},
	{
		factory: "flag",
		portRef: ["hobo:feature-flag"],
		allowVerbs: ["eval", "change"],
	},
	{
		factory: "auth",
		portRef: ["hobo:auth"],
		allowVerbs: ["verify", "session"],
	},
	{
		factory: "crypto",
		portRef: ["hobo:crypto"],
		allowVerbs: ["encrypt", "decrypt", "sign", "verify"],
	},
	{ factory: "notify", portRef: ["hobo:notify"], allowVerbs: ["send"] },
	{ factory: "guardrail", portRef: ["hobo:guardrail"], allowVerbs: ["check"] },
	{
		factory: "ui",
		portRef: ["hobo:ui-render"],
		allowVerbs: ["render", "drive"],
	},
	{
		factory: "experiment",
		portRef: ["hobo:experiment"],
		allowVerbs: ["assign", "expose", "analyze"],
	},
	{
		factory: "rollout",
		portRef: ["hobo:delivery"],
		allowVerbs: ["start", "step", "promote", "rollback"],
	},
] as const;

export type ResourceKind = (typeof CATALOG_ROWS)[number]["factory"];

export type AllowVerbsByKind = {
	api: never;
	kv: "get" | "set" | "delete";
	bucket: "read" | "write" | "delete";
	queue: "enqueue" | "dequeue";
	topic: "publish" | "subscribe";
	secret: "put" | "access";
	data: "read" | "write" | "query" | "admin";
	schedule: never;
	websocket: "accept" | "connect" | "send" | "broadcast" | "subscribe";
	job: "submit";
	web: never;
	service: never;
	external: never;
	container: never;
	"wasm-component": never;
	flag: "eval" | "change";
	auth: "verify" | "session";
	crypto: "encrypt" | "decrypt" | "sign" | "verify";
	notify: "send";
	guardrail: "check";
	ui: "render" | "drive";
	experiment: "assign" | "expose" | "analyze";
	rollout: "start" | "step" | "promote" | "rollback";
};

export type AllowVerbsFor<K extends ResourceKind> = AllowVerbsByKind[K];

export interface ResourceCatalogEntry {
	readonly factory: ResourceKind;
	readonly portRef: readonly string[];
	readonly allowVerbs: readonly string[];
}

// domain-view: branded parse-don't-validate view over the generated wire form.
export interface LoweringDescriptor {
	readonly lowersTo: "hobo:sdk";
	readonly kind: ResourceKind;
	readonly name: string;
	readonly handleStableId: string;
	readonly portRef: readonly string[];
	readonly verb: string;
	readonly args: readonly unknown[];
}

// domain-view: generic, branded stableId view over the generated wire form.
export interface ResourceDescriptor<K extends ResourceKind = ResourceKind> {
	readonly kind: K;
	readonly name: string;
	readonly stableId: `${K}:${string}`;
	readonly portRef: readonly string[];
	readonly allowVerbs: readonly string[];
	readonly declaredAllow: readonly string[];
}

type VerbMethodsFor<K extends ResourceKind> = {
	[V in AllowVerbsFor<K>]: (...args: JsonValue[]) => LoweringDescriptor;
};

export type ResourceHandle<K extends ResourceKind, A = never> = {
	readonly kind: K;
	readonly name: string;
	readonly stableId: `${K}:${string}`;
	readonly portRef: readonly string[];
	readonly identity: {
		readonly kind: K;
		readonly name: string;
		readonly stableId: string;
	};
	readonly declaredAllow: readonly A[];
	allow<V extends AllowVerbsFor<K>>(...verbs: V[]): ResourceHandle<K, V>;
	toDescriptor(): ResourceDescriptor<K>;
} & VerbMethodsFor<K>;

export interface SecretRef {
	readonly kind: "secret-ref";
	readonly ref: string;
	readonly stableId: `secret-ref:${string}`;
	readonly lowersTo: "hobo:sdk";
}

// domain-view: readonly parse-don't-validate view over the generated wire form.
export interface ProviderAnnotation {
	readonly provider: string;
	readonly option: string;
	readonly config: JsonObject;
}

export interface ConnectorAuthDefinition {
	readonly protocol: "auth.md";
	readonly discovery: string;
}

/** Metadata owned by a connector package, never by application code. */
export interface ConnectorDefinition<
	Id extends string = string,
	Capability extends string = string,
> {
	readonly kind: "connector-definition";
	readonly id: Id;
	readonly origin: string;
	readonly audience?: string;
	readonly auth: ConnectorAuthDefinition;
	readonly capabilities: readonly Capability[];
}

/** Opaque value exported by connector packages and consumed by b.connector(). */
export type ConnectorSymbol<
	D extends ConnectorDefinition = ConnectorDefinition,
> = symbol & { readonly __hoboConnectorDefinition?: D };

export type ConnectorCapability<D extends ConnectorDefinition> =
	D["capabilities"][number];

export interface ConnectorBinding<
	D extends ConnectorDefinition = ConnectorDefinition,
> {
	readonly kind: "connector";
	readonly definition: D;
	readonly declaredAllow: readonly ConnectorCapability<D>[];
	allow<C extends ConnectorCapability<D>>(
		...capabilities: C[]
	): ConnectorBinding<D>;
}

export interface BindleConnectorRecord {
	readonly kind: "connector";
	readonly name: string;
	readonly target: string;
	readonly origin: string;
	readonly auth: ConnectorAuthDefinition;
	readonly audience?: string;
	readonly allow: readonly string[];
}

/** Runtime connector membrane supplied by the Station hosting the Bindle. */
export interface BindleRuntimeContext {
	/**
	 * Resolves the declaration against Station Connection inventory. The result
	 * may represent personal, team, or organization-authorized access. Token
	 * issuance remains Station/broker-owned; application code never reads local
	 * provider credentials.
	 */
	connector(binding: ConnectorBinding): ConnectionClient;
}

// domain-view: readonly parse-don't-validate view over the generated wire form.
export interface BindleEdge {
	readonly from: string;
	readonly to: string;
}

// domain-view: generic, branded parse-don't-validate view over the wire form.
export interface BindleResourceRecord<K extends ResourceKind = ResourceKind> {
	readonly kind: K;
	readonly name: string;
	readonly stableId: `${K}:${string}`;
	readonly declaredAllow: readonly string[];
	readonly annotations: readonly ProviderAnnotation[];
	readonly dependsOn: readonly string[];
}

export type BindleDependency = BindleResource | ConnectorBinding;

export interface BindleResource<K extends ResourceKind = ResourceKind> {
	readonly kind: K;
	dependsOn(...deps: BindleDependency[]): BindleResource<K>;
	withReference(...deps: BindleDependency[]): BindleResource<K>;
	allow(...verbs: AllowVerbsFor<K>[]): BindleResource<K>;
	with(...annotations: ProviderAnnotation[]): BindleResource<K>;
}

export interface BindleRequirements {
	readonly require: readonly string[];
	readonly prefer: readonly string[];
	readonly runtimes: readonly string[];
	readonly labels: Readonly<Record<string, string>>;
}

export interface BindleDefinition {
	readonly name: string;
	readonly resources: Readonly<Record<string, BindleResourceRecord>>;
	readonly connectors?: Readonly<Record<string, BindleConnectorRecord>>;
	readonly edges: readonly BindleEdge[];
	readonly requirements: BindleRequirements;
	entrypoint(name: string): BindleEntrypoint | undefined;
}

export type DeclaredComponent = new () => object;

export interface BindleHandlerObject {
	readonly [key: string]: JsonValue | undefined;
}

/** Framework-neutral HTTP handler accepted by the local component hosts. */
export type BindleFetchHandler = (
	request: Request,
) => Response | Promise<Response>;

export type BindleEntrypoint = (
	context?: BindleRuntimeContext,
) =>
	| JsonValue
	| BindleHandlerObject
	| BindleFetchHandler
	| { readonly fetch: BindleFetchHandler };

/** App entrypoint factory; the Station supplies runtime context when serving. */
export type ComponentBinding = BindleEntrypoint | DeclaredComponent;

export interface ExternalDependencyOptions {
	readonly connectionString?: string;
	readonly endpoints?: Readonly<Record<string, string>>;
}

export interface ContainerDependencyOptions {
	readonly image: string;
	readonly endpoints?: Readonly<
		Record<string, { readonly port: number; readonly external?: boolean }>
	>;
	readonly env?: Readonly<Record<string, string>>;
}

export interface WasmComponentDependencyOptions {
	readonly source: string;
	readonly witWorld?: string;
	readonly endpoints?: Readonly<Record<string, { readonly port?: number }>>;
}

export interface BindleBuilder {
	api(binding?: ComponentBinding): BindleResource<"api">;
	web(binding?: ComponentBinding): BindleResource<"web">;
	kv(): BindleResource<"kv">;
	bucket(): BindleResource<"bucket">;
	// biome-ignore-start lint/correctness/noUnusedVariables: `T` is documentary.
	// Callers write `b.queue<OrderEvent>()` to record the message type at the
	// authoring site; it does not yet flow into BindleResource. Dropping the
	// parameter would break those call sites, so it stays until the resource
	// type carries it.
	queue<_T = JsonValue>(): BindleResource<"queue">;
	topic<_T = JsonValue>(): BindleResource<"topic">;
	// biome-ignore-end lint/correctness/noUnusedVariables: see above
	secret(): BindleResource<"secret">;
	data(): BindleResource<"data">;
	schedule(): BindleResource<"schedule">;
	websocket(binding?: ComponentBinding): BindleResource<"websocket">;
	job(binding?: ComponentBinding): BindleResource<"job">;
	service(binding?: ComponentBinding): BindleResource<"service">;
	flag(): BindleResource<"flag">;
	auth(): BindleResource<"auth">;
	crypto(): BindleResource<"crypto">;
	notify(): BindleResource<"notify">;
	guardrail(): BindleResource<"guardrail">;
	ui(binding?: ComponentBinding): BindleResource<"ui">;
	experiment(): BindleResource<"experiment">;
	rollout(): BindleResource<"rollout">;
	connector<D extends ConnectorDefinition>(
		symbol: ConnectorSymbol<D>,
	): ConnectorBinding<D>;
	external(options?: ExternalDependencyOptions): BindleResource<"external">;
	container(options: ContainerDependencyOptions): BindleResource<"container">;
	wasmComponent(
		options: WasmComponentDependencyOptions,
	): BindleResource<"wasm-component">;
}
