import { isJsonString, isJsonObject, type JsonValue } from "./json.js";
type ResourceKind = "api" | "kv" | "queue" | "topic" | "schedule" | "bucket";

// A handler accepts whatever arguments its trigger kind supplies; declaring
// the rest-parameter as `never[]` makes this a safe "any function" shape
// (every concrete handler signature is assignable to it) without resorting
// to `Function` or `any`.
type Handler = (...args: never[]) => JsonValue | void | Promise<JsonValue | void>;

interface WorkflowHandler {
  readonly kind: "workflow";
  readonly name: string;
  readonly handler: Handler;
}

type HandlerLike = Handler | WorkflowHandler;

interface KvClient {
  get(key: string): Promise<JsonValue>;
}

interface QueueClient {
  enqueue(message: JsonValue): Promise<void>;
}

interface BucketClient {}

interface ScheduleClient {}

interface TopicClient {}

type ClientForKind<K extends ResourceKind> = K extends "kv"
  ? KvClient
  : K extends "queue"
    ? QueueClient
    : K extends "bucket"
      ? BucketClient
      : K extends "schedule"
        ? ScheduleClient
        : K extends "topic"
          ? TopicClient
          : never;

interface BindingDescriptor {
  readonly port: string | undefined;
  readonly resource: string;
  readonly clientType: string | undefined;
}

interface DurableRuntime {
  readonly primitive: "workflow";
  readonly interface: string;
  readonly handler: string;
}

interface TriggerEdge {
  readonly id: string;
  readonly kind: string;
  readonly resource: string;
  readonly method?: string;
  readonly path?: string;
  readonly event?: string;
  readonly cron?: string;
  readonly exportInterface: string;
  readonly handler: string;
  readonly inferredPermissions?: readonly string[];
  readonly durableRuntime?: DurableRuntime;
}

interface MutableHandleMethods {
  [name: string]: ((...args: never[]) => TriggerEdge) | JsonValue;
}

interface HostTriggerInput {
  readonly id: string;
  readonly kind: string;
  readonly event?: string;
  readonly cron?: string;
  readonly exportInterface: string;
  readonly handler: HandlerLike | undefined;
  readonly inferredPermissions: readonly string[];
}

interface ComponentHost {
  readonly kind: string;
  readonly version: string;
}

interface ApiManifestResource {
  readonly type: "component.v1";
  readonly kind: "api";
  readonly runtime: "wasm";
  readonly exports: readonly string[];
  readonly bindings: Record<string, BindingDescriptor>;
  readonly links: ReadonlyArray<{ readonly import: string | undefined; readonly to: string }>;
  readonly collection: { readonly stableId: string };
}

interface DataManifestResource {
  readonly type: "data.v1";
  readonly kind: Exclude<ResourceKind, "api">;
  readonly port: string;
  readonly allow: readonly string[];
  readonly usage: { readonly inferred: readonly string[]; readonly source: string };
  readonly collection: { readonly stableId: string };
}

type ManifestResource = ApiManifestResource | DataManifestResource;

interface CompileManifestOptions {
  readonly triggers?: TriggerEdge[];
  readonly componentHost?: ComponentHost;
}

interface HandlerManifest {
  readonly schema: string;
  readonly componentHost: ComponentHost;
  readonly resources: Record<string, ManifestResource>;
  triggerEdges?: TriggerEdge[];
}

type BindMap = Record<string, ResourceHandle>;

interface ResourceOptions {
  readonly bind?: BindMap;
  readonly durableEvents?: boolean;
}

interface ApiOptions<B extends BindMap = BindMap> {
  readonly bind?: B;
  readonly durableEvents?: boolean;
}

interface ResourceHandle<K extends ResourceKind = ResourceKind> {
  readonly __hoboTriggerContract: true;
  readonly kind: K;
  readonly name: string;
  readonly stableId: string;
  readonly port: string;
  readonly durableEvents: boolean;
  readonly bindings: Record<string, BindingDescriptor>;
  readonly triggers: TriggerEdge[];
  readonly permissions: Set<string>;
  readonly routeKeys: Set<string>;
  readonly clientType: string | undefined;
}

interface KvHandle extends ResourceHandle<"kv"> {}

interface QueueHandle extends ResourceHandle<"queue"> {}

interface BucketHandle extends ResourceHandle<"bucket"> {
  on(event: string, handler: HandlerLike): TriggerEdge;
}

interface ScheduleHandle extends ResourceHandle<"schedule"> {
  cron(expression: string, handler: HandlerLike): TriggerEdge;
}

interface TopicHandle extends ResourceHandle<"topic"> {
  subscribe(handler: HandlerLike): TriggerEdge;
  subscribe(eventType: string, handler: HandlerLike): TriggerEdge;
}

type BindingsOf<B extends BindMap> = {
  [Alias in keyof B]: B[Alias] extends ResourceHandle<infer K> ? ClientForKind<K> : never;
};

interface HandlerContext<B extends BindMap = BindMap> {
  readonly params: Record<string, string>;
  readonly bindings: BindingsOf<B>;
}

type HttpHandler<B extends BindMap> = (ctx: HandlerContext<B>) => JsonValue | void | Promise<JsonValue | void>;

interface ApiHandle<B extends BindMap = BindMap> extends ResourceHandle<"api"> {
  get(path: string, handler: HttpHandler<B>): TriggerEdge;
  post(path: string, handler: HttpHandler<B>): TriggerEdge;
  put(path: string, handler: HttpHandler<B>): TriggerEdge;
  patch(path: string, handler: HttpHandler<B>): TriggerEdge;
  delete(path: string, handler: HttpHandler<B>): TriggerEdge;
}

const MANIFEST_SCHEMA = "hobo.manifest/v1";
const DEFAULT_COMPONENT_HOST: ComponentHost = Object.freeze({
  kind: "wasmtime",
  version: "46.0.1",
});
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const PORT_BY_KIND: Record<ResourceKind, string> = Object.freeze({
  api: "wasi:http",
  bucket: "wasi:blobstore",
  kv: "wasi:keyvalue",
  queue: "hobo:queue",
  schedule: "hobo:scheduler",
  topic: "wasi:messaging",
});

const CLIENT_TYPE_BY_KIND: Partial<Record<ResourceKind, string>> = Object.freeze({
  bucket: "BucketClient",
  kv: "KvClient",
  queue: "QueueClient",
  schedule: "ScheduleClient",
  topic: "TopicClient",
});

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export class TriggerContractError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TriggerContractError";
    this.path = path;
  }
}

export function api<B extends BindMap = BindMap>(name: string, options: ApiOptions<B> = {}): ApiHandle<B> {
  const handle = createHandle("api", name, options);
  // SAFETY: host handle is mutated with HTTP verbs before freeze.
  const mutable: MutableHandleMethods = handle as never;
  for (const method of HTTP_METHODS) {
    mutable[method.toLowerCase()] = (path: string, handler: HttpHandler<B>) =>
      registerHttpRoute(handle, method, path, handler);
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.freeze(handle) as ApiHandle<B>;
}

export function kv(name: string): KvHandle {
  return createHandle("kv", name);
}

export function queue(name: string): QueueHandle {
  return createHandle("queue", name);
}

export function topic(name: string, options: ResourceOptions = {}): TopicHandle {
  const handle = createHandle("topic", name, options);
  // SAFETY: host handle is mutated with subscribe before freeze.
  const mutable: MutableHandleMethods = handle as never;
  mutable.subscribe = (eventType: string | HandlerLike, handler?: HandlerLike) => {
    const normalized =
      eventType instanceof Function || isWorkflowHandler(eventType)
        ? { eventType: "*", handler: eventType }
        : { eventType: assertString(eventType, `resources.${name}.triggers.subscribe.event`), handler };
    return registerHostTrigger(handle, {
      id: `${name}.subscribe.${normalized.eventType}`,
      kind: "topic.subscribe",
      event: normalized.eventType,
      exportInterface: "hobo:trigger/topic-subscriber",
      handler: normalized.handler,
      inferredPermissions: ["subscribe"],
    });
  };
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.freeze(handle) as TopicHandle;
}

export function schedule(name: string, options: ResourceOptions = {}): ScheduleHandle {
  const handle = createHandle("schedule", name, options);
  // SAFETY: host handle is mutated with cron before freeze.
  const mutable: MutableHandleMethods = handle as never;
  mutable.cron = (expression: string, handler: HandlerLike) =>
    registerHostTrigger(handle, {
      id: `${name}.cron.${assertString(expression, `resources.${name}.triggers.cron.expression`)}`,
      kind: "schedule.cron",
      cron: expression,
      exportInterface: "hobo:trigger/scheduled-run",
      handler,
      inferredPermissions: [],
    });
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.freeze(handle) as ScheduleHandle;
}

export function bucket(name: string, options: ResourceOptions = {}): BucketHandle {
  const handle = createHandle("bucket", name, options);
  // SAFETY: host handle is mutated with on() before freeze.
  const mutable: MutableHandleMethods = handle as never;
  mutable.on = (event: string, handler: HandlerLike) => {
    const eventName = assertString(event, `resources.${name}.triggers.event`);
    const inferredPermissions = eventName === "write" ? ["event:write", "read"] : [`event:${eventName}`];
    return registerHostTrigger(handle, {
      id: `${name}.${eventName}`,
      kind: "bucket.on",
      event: eventName,
      exportInterface: "hobo:trigger/blob-event",
      handler,
      inferredPermissions,
    });
  };
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.freeze(handle) as BucketHandle;
}

export function workflow(name: string, handler: Handler): WorkflowHandler {
  const handlerName = assertString(name, "workflow.name");
  if (!(handler instanceof Function)) {
    throw new TriggerContractError("workflow.handler", "must be a function");
  }
  return Object.freeze({
    kind: "workflow",
    name: handlerName,
    handler,
  });
}

export function compileHandlerManifest(
  resources: ResourceHandle[],
  options: CompileManifestOptions = {},
): HandlerManifest {
  if (!Array.isArray(resources)) {
    throw new TriggerContractError("resources", "must be an array");
  }

  const resourceMap = new Map<string, ResourceHandle>();
  for (const resource of resources) {
    assertHandle(resource, "resources");
    if (resourceMap.has(resource.name)) {
      throw new TriggerContractError(`resources.${resource.name}`, "duplicate resource id");
    }
    resourceMap.set(resource.name, resource);
  }

  const triggerEdges = collectTriggerEdges(resources, options.triggers ?? [], resourceMap);
  const manifest: HandlerManifest = {
    schema: MANIFEST_SCHEMA,
    componentHost: options.componentHost ?? DEFAULT_COMPONENT_HOST,
    resources: Object.fromEntries(
      resources.map((resource) => [resource.name, manifestResource(resource)]),
    ),
    triggerEdges,
  };

  if (triggerEdges.length === 0) {
    delete manifest.triggerEdges;
  }

  return manifest;
}

function createHandle<K extends ResourceKind>(
  kind: K,
  name: string,
  options: ResourceOptions = {},
): ResourceHandle<K> {
  assertResourceName(name, `${kind}.name`);
  const bind = normalizeBindMap(options.bind ?? {}, `${kind}.${name}.bind`);
  const handle: ResourceHandle<K> = {
    __hoboTriggerContract: true,
    kind,
    name,
    stableId: `${kind}:${name}`,
    port: PORT_BY_KIND[kind],
    durableEvents: options.durableEvents ?? true,
    bindings: Object.fromEntries(
      Object.entries(bind).map(([alias, target]) => [
        alias,
        {
          port: target.port,
          resource: target.name,
          clientType: target.clientType,
        },
      ]),
    ),
    triggers: [],
    permissions: new Set(),
    routeKeys: new Set(),
    clientType: CLIENT_TYPE_BY_KIND[kind],
  };
  return handle;
}

function registerHttpRoute(
  handle: ResourceHandle<"api">,
  method: string,
  path: string,
  handler: Handler,
): TriggerEdge {
  const routePath = assertString(path, `resources.${handle.name}.routes.path`);
  assertHandler(handler, `resources.${handle.name}.routes.${method} ${routePath}`);
  const key = `${method} ${routePath}`;
  if (handle.routeKeys.has(key)) {
    throw new TriggerContractError(`resources.${handle.name}.routes[${key}]`, "duplicate route");
  }

  handle.routeKeys.add(key);
  const trigger = omitUndefined<TriggerEdge>({
    id: `${handle.name}.${method}.${routePath}`,
    kind: "http.route",
    resource: handle.name,
    method,
    path: routePath,
    exportInterface: "wasi:http/incoming-handler",
    handler: handlerName(handler),
  });
  handle.triggers.push(trigger);
  return trigger;
}

function registerHostTrigger(handle: ResourceHandle, trigger: HostTriggerInput): TriggerEdge {
  const handler = trigger.handler;
  assertHandler(handler, `resources.${handle.name}.triggers.${trigger.event ?? trigger.kind}`);
  if (isWorkflowHandler(handler) && handle.durableEvents !== true) {
    throw new TriggerContractError(
      `resources.${handle.name}.triggers.${trigger.event ?? trigger.kind}`,
      "workflow subscriber requires a durable event path",
    );
  }

  for (const permission of trigger.inferredPermissions) {
    handle.permissions.add(permission);
  }

  const edge = omitUndefined<TriggerEdge>({
    id: trigger.id,
    kind: trigger.kind,
    resource: handle.name,
    event: trigger.event,
    cron: trigger.cron,
    exportInterface: trigger.exportInterface,
    handler: handlerName(handler),
    inferredPermissions: trigger.inferredPermissions.length > 0 ? trigger.inferredPermissions : undefined,
    durableRuntime: durableRuntimeFor(handler),
  });
  handle.triggers.push(edge);
  return edge;
}

function collectTriggerEdges(
  resources: ResourceHandle[],
  extraTriggers: TriggerEdge[],
  resourceMap: Map<string, ResourceHandle>,
): TriggerEdge[] {
  const triggerEdges: TriggerEdge[] = [];
  for (const resource of resources) {
    triggerEdges.push(...resource.triggers);
  }
  triggerEdges.push(...extraTriggers);

  return triggerEdges.map((trigger, index) => {
    if (!resourceMap.has(trigger.resource)) {
      throw new TriggerContractError(
        `triggers[${index}].resource`,
        `${trigger.resource} is not declared in this Bindle`,
      );
    }
    return trigger;
  });
}

function manifestResource(handle: ResourceHandle): ManifestResource {
  if (handle.kind === "api") {
    return omitEmpty<ApiManifestResource>({
      type: "component.v1",
      kind: handle.kind,
      runtime: "wasm",
      exports: handle.triggers.some((trigger) => trigger.kind === "http.route")
        ? ["wasi:http/incoming-handler"]
        : [],
      bindings: handle.bindings,
      links: Object.values(handle.bindings).map((binding) => ({
        import: binding.port,
        to: binding.resource,
      })),
      collection: {
        stableId: handle.stableId,
      },
    });
  }

  return {
    type: "data.v1",
    kind: handle.kind,
    port: handle.port,
    allow: [...handle.permissions].sort(),
    usage: {
      inferred: [...handle.permissions].sort(),
      source: "handler-trigger-contract",
    },
    collection: {
      stableId: handle.stableId,
    },
  };
}

function normalizeBindMap(bind: BindMap, path: string): BindMap {
  if (!bind || !isJsonObject(bind)) {
    throw new TriggerContractError(path, "must be a resource map");
  }

  for (const [alias, target] of Object.entries(bind)) {
    assertResourceName(alias, `${path}.${alias}`);
    assertHandle(target, `${path}.${alias}`);
  }
  return bind;
}

function assertHandle<T>(handle: T, path: string): void {
  // SAFETY: handle is a host resource object; brand marker is checked below.
  const candidate = handle as { __hoboTriggerContract?: JsonValue; name?: JsonValue };
  if (!candidate?.__hoboTriggerContract || !isJsonString(candidate.name)) {
    throw new TriggerContractError(path, "must contain HoBo handler-trigger resource handles");
  }
}

function assertResourceName(name: string, path: string): void {
  if (!isJsonString(name) || !RESOURCE_ID.test(name)) {
    throw new TriggerContractError(path, "invalid resource id");
  }
}

function assertString(value: string, path: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TriggerContractError(path, "must be a non-empty string");
  }
  return value;
}

function assertHandler<T>(handler: T, path: string): asserts handler is T & HandlerLike {
  if (!(handler instanceof Function) && !isWorkflowHandler(handler)) {
    throw new TriggerContractError(path, "handler must be a function or workflow handler");
  }
}

function isWorkflowHandler<T>(value: T): value is T & WorkflowHandler {
  // SAFETY: workflow handlers are host objects tagged with kind "workflow".
  const candidate = value as { kind?: JsonValue };
  return candidate?.kind === "workflow";
}

function handlerName(handler: HandlerLike): string {
  if (isWorkflowHandler(handler)) {
    return handler.name;
  }
  return handler.name || "anonymous";
}

function durableRuntimeFor(handler: HandlerLike): DurableRuntime | undefined {
  if (!isWorkflowHandler(handler)) {
    return undefined;
  }
  return {
    primitive: "workflow",
    interface: "hobo:runtime/workflow@0.1.0",
    handler: handler.name,
  };
}

function omitEmpty<T extends object>(value: T): T {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (Array.isArray(entry)) {
        return entry.length > 0;
      }
      if (entry && isJsonObject(entry)) {
        return Object.keys(entry).length > 0;
      }
      return entry !== undefined;
    }),
  ) as T;
}

function omitUndefined<T extends object>(value: T): T {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
