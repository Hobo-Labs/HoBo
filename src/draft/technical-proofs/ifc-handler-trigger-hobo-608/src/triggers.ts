import { isJsonString, isJsonObject, type JsonValue } from "./json.js";

interface TriggerHandleHost {
  [key: string]: JsonValue | ((path: string, handler: Handler) => TriggerEdge);
}
const MANIFEST_SCHEMA = "hobo.manifest/v1";
const DEFAULT_COMPONENT_HOST = Object.freeze({
  kind: "wasmtime",
  version: "46.0.1",
});
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

const PORT_BY_KIND = Object.freeze({
  api: "wasi:http",
  bucket: "wasi:blobstore",
  kv: "wasi:keyvalue",
  queue: "hobo:queue",
  schedule: "hobo:scheduler",
  topic: "wasi:messaging",
});

const CLIENT_TYPE_BY_KIND = Object.freeze({
  bucket: "BucketClient",
  kv: "KvClient",
  queue: "QueueClient",
  schedule: "ScheduleClient",
  topic: "TopicClient",
});

export class TriggerContractError extends Error {
  path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "TriggerContractError";
    this.path = path;
  }
}

export type BindingMap = Record<string, ResourceHandle>;

export type BindingClients<Bindings extends BindingMap> = {
  [Key in keyof Bindings]: ClientForKind<Bindings[Key]["kind"]>;
};

type ClientForKind<K extends string> = K extends "kv"
  ? {
      get(key: string): Promise<JsonValue>;
      set(key: string, value: JsonValue): Promise<void>;
      delete(key: string): Promise<void>;
    }
  : K extends "queue"
    ? { enqueue(message: JsonValue): Promise<void>; dequeue(): Promise<JsonValue> }
    : K extends "topic"
      ? { publish(message: JsonValue): Promise<void> }
      : K extends "bucket"
        ? {
            read(key: string): Promise<JsonValue>;
            write(key: string, value: JsonValue): Promise<void>;
            delete(key: string): Promise<void>;
          }
        : Record<string, never>;

export interface HandlerContext<Bindings extends BindingMap = BindingMap> {
  params: Readonly<Record<string, string>>;
  json: <T = JsonValue>() => Promise<T>;
  body: JsonValue;
  bindings: BindingClients<Bindings>;
  config: Readonly<Record<string, string>>;
  user?: JsonValue;
  identity?: JsonValue;
}

export type Handler<Bindings extends BindingMap = BindingMap> = ((
  ctx: HandlerContext<Bindings>,
) => JsonValue | void | Promise<JsonValue | void>) & { name?: string };

export interface WorkflowHandler {
  kind: "workflow";
  name: string;
  handler: Handler;
}

// domain-view: parse-produced draft-proof record; its wire form is the TriggerEdge proto message in data-models/.
export interface TriggerEdge {
  id: string;
  kind:
    | "http.route"
    | "topic.subscribe"
    | "bucket.on"
    | "schedule.cron"
    | "schedule.every"
    | "queue.worker";
  resource: string;
  method?: string;
  path?: string;
  event?: string;
  cron?: string;
  every?: string;
  batch?: number;
  exportInterface: string;
  handler: string;
  inferredPermissions?: string[];
  durableRuntime?: {
    primitive: "workflow";
    interface: "hobo:runtime/workflow@0.1.0";
    handler: string;
  };
}

export interface ResourceHandle<K extends string = string> {
  __hoboTriggerContract: true;
  kind: K;
  name: string;
  stableId: string;
  port: string;
  durableEvents: boolean;
  bindings: Record<string, BindingDescriptor>;
  triggers: TriggerEdge[];
  permissions: Set<string>;
  routeKeys: Set<string>;
  clientType?: string;
  get?: (path: string, handler: Handler) => TriggerEdge;
  post?: (path: string, handler: Handler) => TriggerEdge;
  put?: (path: string, handler: Handler) => TriggerEdge;
  patch?: (path: string, handler: Handler) => TriggerEdge;
  delete?: (path: string, handler: Handler) => TriggerEdge;
  subscribe?: (
    eventType: string | Handler | WorkflowHandler,
    handler?: Handler | WorkflowHandler,
  ) => TriggerEdge;
  cron?: (expression: string, handler: Handler | WorkflowHandler) => TriggerEdge;
  every?: (spec: string, handler: Handler | WorkflowHandler) => TriggerEdge;
  on?: (event: string, handler: Handler | WorkflowHandler) => TriggerEdge;
  worker?: (handler: Handler, opts?: { batch?: number }) => TriggerEdge;
}

interface BindingDescriptor {
  port: string;
  resource: string;
  clientType: string;
}

interface HostTriggerInput {
  id: string;
  kind: TriggerEdge["kind"];
  event?: string;
  cron?: string;
  every?: string;
  batch?: number;
  exportInterface: string;
  handler: Handler | WorkflowHandler;
  inferredPermissions: string[];
}

export function api<const Bindings extends BindingMap = BindingMap>(
  name: string,
  options: { bind?: Bindings } = {},
): ResourceHandle<"api"> & {
  get(path: string, handler: Handler<Bindings>): TriggerEdge;
  post(path: string, handler: Handler<Bindings>): TriggerEdge;
  put(path: string, handler: Handler<Bindings>): TriggerEdge;
  patch(path: string, handler: Handler<Bindings>): TriggerEdge;
  delete(path: string, handler: Handler<Bindings>): TriggerEdge;
} {
  const handle = createHandle("api", name, options);
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
    // SAFETY: HTTP method keys are attached to the handle host at this contract edge.
    const host: TriggerHandleHost = handle as never;
    host[method.toLowerCase()] = (path: string, handler: Handler<Bindings>) => {
      // SAFETY: HTTP handlers are stored erased at the trigger registry edge.
      const registered: Handler = handler as Handler;
      return registerHttpRoute(handle, method, path, registered);
    };
  }
  // SAFETY: assertion to `return Object.freeze(handle) as ResourceHandle<"api"> & {` is required at this boundary.
  return Object.freeze(handle) as ResourceHandle<"api"> & {
    get(path: string, handler: Handler<Bindings>): TriggerEdge;
    post(path: string, handler: Handler<Bindings>): TriggerEdge;
    put(path: string, handler: Handler<Bindings>): TriggerEdge;
    patch(path: string, handler: Handler<Bindings>): TriggerEdge;
    delete(path: string, handler: Handler<Bindings>): TriggerEdge;
  };
}

export function kv(name: string): ResourceHandle<"kv"> {
  return createHandle("kv", name);
}

export function queue(name: string): ResourceHandle<"queue"> {
  const handle = createHandle("queue", name);
  handle.worker = (handler: Handler, opts: { batch?: number } = {}) =>
    registerHostTrigger(handle, {
      id: `${name}.worker`,
      kind: "queue.worker",
      exportInterface: "hobo:trigger/queue-worker",
      handler,
      inferredPermissions: ["dequeue"],
      batch: opts.batch,
    });
  return Object.freeze(handle);
}

export function topic(name: string, options: { durableEvents?: boolean } = {}) {
  const handle = createHandle("topic", name, options);
  handle.subscribe = (
    eventType: string | Handler | WorkflowHandler,
    handler?: Handler | WorkflowHandler,
  ) => {
    const normalized =
      eventType instanceof Function || isWorkflowHandler(eventType)
        ? { eventType: "*", handler: eventType }
        : {
            eventType: assertString(eventType, `resources.${name}.triggers.subscribe.event`),
            handler: handler!,
          };
    return registerHostTrigger(handle, {
      id: `${name}.subscribe.${normalized.eventType}`,
      kind: "topic.subscribe",
      event: normalized.eventType,
      exportInterface: "hobo:trigger/topic-subscriber",
      handler: normalized.handler,
      inferredPermissions: ["subscribe"],
    });
  };
  return Object.freeze(handle);
}

export function schedule(name: string, options: { durableEvents?: boolean } = {}) {
  const handle = createHandle("schedule", name, options);
  handle.cron = (expression: string, handler: Handler | WorkflowHandler) =>
    registerHostTrigger(handle, {
      id: `${name}.cron.${assertString(expression, `resources.${name}.triggers.cron.expression`)}`,
      kind: "schedule.cron",
      cron: expression,
      exportInterface: "hobo:trigger/scheduled-run",
      handler,
      inferredPermissions: [],
    });
  handle.every = (spec: string, handler: Handler | WorkflowHandler) =>
    registerHostTrigger(handle, {
      id: `${name}.every.${assertString(spec, `resources.${name}.triggers.every.spec`)}`,
      kind: "schedule.every",
      every: spec,
      exportInterface: "hobo:trigger/scheduled-run",
      handler,
      inferredPermissions: [],
    });
  return Object.freeze(handle);
}

export function bucket(name: string, options: { durableEvents?: boolean } = {}) {
  const handle = createHandle("bucket", name, options);
  handle.on = (event: string, handler: Handler | WorkflowHandler) => {
    const eventName = assertString(event, `resources.${name}.triggers.event`);
    const inferredPermissions =
      eventName === "write" ? ["event:write", "read"] : [`event:${eventName}`];
    return registerHostTrigger(handle, {
      id: `${name}.${eventName}`,
      kind: "bucket.on",
      event: eventName,
      exportInterface: "hobo:trigger/blob-event",
      handler,
      inferredPermissions,
    });
  };
  return Object.freeze(handle);
}

export function workflow(name: string, handler: Handler) {
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
  options: {
    triggers?: TriggerEdge[];
    componentHost?: { kind: string; version: string };
  } = {},
) {
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
  const manifest: HandlerManifestDraft = {
    schema: MANIFEST_SCHEMA,
    componentHost: options.componentHost ?? DEFAULT_COMPONENT_HOST,
    resources: Object.fromEntries(resources.map((resource) => [resource.name, manifestResource(resource)])),
    triggerEdges,
  };

  if (triggerEdges.length === 0) {
    delete manifest.triggerEdges;
  }

  return manifest;
}

interface HandlerManifestDraft {
  schema: string;
  componentHost: { kind: string; version: string };
  resources: { [name: string]: ReturnType<typeof manifestResource> };
  triggerEdges?: TriggerEdge[];
}

function createHandle<K extends string>(
  kind: K,
  name: string,
  options: { bind?: BindingMap; durableEvents?: boolean } = {},
): ResourceHandle<K> {
  assertResourceName(name, `${kind}.name`);
  const bind = normalizeBindMap(options.bind ?? {}, `${kind}.${name}.bind`);
  const handle: ResourceHandle<K> = {
    __hoboTriggerContract: true,
    kind,
    name,
    stableId: `${kind}:${name}`,
    // SAFETY: assertion to `port: PORT_BY_KIND[kind as keyof typeof PORT_BY_KIND],` is required at this boundary.
    port: PORT_BY_KIND[kind as keyof typeof PORT_BY_KIND],
    durableEvents: options.durableEvents ?? true,
    bindings: Object.fromEntries(
      Object.entries(bind).map(([alias, target]) => [
        alias,
        {
          port: target.port,
          resource: target.name,
          // SAFETY: assertion to `clientType: target.clientType ?? CLIENT_TYPE_BY_KIND[target.kind as keyof typeof` is required at this boundary.
          clientType: target.clientType ?? CLIENT_TYPE_BY_KIND[target.kind as keyof typeof CLIENT_TYPE_BY_KIND],
        },
      ]),
    ),
    triggers: [],
    permissions: new Set(),
    routeKeys: new Set(),
    // SAFETY: assertion to `clientType: CLIENT_TYPE_BY_KIND[kind as keyof typeof CLIENT_TYPE_BY_KIND],` is required at this boundary.
    clientType: CLIENT_TYPE_BY_KIND[kind as keyof typeof CLIENT_TYPE_BY_KIND],
  };
  return handle;
}

function registerHttpRoute(
  handle: ResourceHandle,
  method: string,
  path: string,
  handler: Handler,
) {
  const routePath = assertString(path, `resources.${handle.name}.routes.path`);
  assertHandler(handler, `resources.${handle.name}.routes.${method} ${routePath}`);
  const key = `${method} ${routePath}`;
  if (handle.routeKeys.has(key)) {
    throw new TriggerContractError(`resources.${handle.name}.routes[${key}]`, "duplicate route");
  }

  handle.routeKeys.add(key);
  const trigger = omitUndefined({
    id: `${handle.name}.${method}.${routePath}`,
    kind: "http.route" as const,
    resource: handle.name,
    method,
    path: routePath,
    exportInterface: "wasi:http/incoming-handler",
    handler: handlerName(handler),
  });
  handle.triggers.push(trigger);
  return trigger;
}

function registerHostTrigger(handle: ResourceHandle, trigger: HostTriggerInput) {
  assertHandler(trigger.handler, `resources.${handle.name}.triggers.${trigger.event ?? trigger.kind}`);
  if (isWorkflowHandler(trigger.handler) && handle.durableEvents !== true) {
    throw new TriggerContractError(
      `resources.${handle.name}.triggers.${trigger.event ?? trigger.kind}`,
      "workflow subscriber requires a durable event path",
    );
  }

  for (const permission of trigger.inferredPermissions) {
    handle.permissions.add(permission);
  }

  const edge = omitUndefined({
    id: trigger.id,
    kind: trigger.kind,
    resource: handle.name,
    event: trigger.event,
    cron: trigger.cron,
    every: trigger.every,
    batch: trigger.batch,
    exportInterface: trigger.exportInterface,
    handler: handlerName(trigger.handler),
    inferredPermissions: trigger.inferredPermissions.length > 0 ? trigger.inferredPermissions : undefined,
    durableRuntime: durableRuntimeFor(trigger.handler),
  });
  handle.triggers.push(edge);
  return edge;
}

function collectTriggerEdges(
  resources: ResourceHandle[],
  extraTriggers: TriggerEdge[],
  resourceMap: Map<string, ResourceHandle>,
) {
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

function manifestResource(handle: ResourceHandle) {
  if (handle.kind === "api") {
    return omitEmpty({
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

function normalizeBindMap(bind: BindingMap, path: string) {
  if (!bind || !isJsonObject(bind)) {
    throw new TriggerContractError(path, "must be a resource map");
  }

  for (const [alias, target] of Object.entries(bind)) {
    assertResourceName(alias, `${path}.${alias}`);
    assertHandle(target, `${path}.${alias}`);
  }
  return bind;
}

function assertHandle<T>(handle: T, path: string): asserts handle is T & ResourceHandle {
  if (!isJsonObject(handle) || handle.__hoboTriggerContract !== true || !isJsonString(handle.name)) {
    throw new TriggerContractError(path, "must contain HoBo handler-trigger resource handles");
  }
}

function assertResourceName(name: string, path: string) {
  if (!isJsonString(name) || !RESOURCE_ID.test(name)) {
    throw new TriggerContractError(path, "invalid resource id");
  }
}

function assertString<T>(value: T, path: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TriggerContractError(path, "must be a non-empty string");
  }
  return value;
}

function assertHandler<T>(handler: T, path: string) {
  if (!(handler instanceof Function) && !isWorkflowHandler(handler)) {
    throw new TriggerContractError(path, "handler must be a function or workflow handler");
  }
}

function isWorkflowHandler<T>(handler: T): handler is T & WorkflowHandler {
  return isJsonObject(handler) && handler.kind === "workflow";
}

function handlerName(handler: Handler | WorkflowHandler) {
  if (isWorkflowHandler(handler)) {
    return handler.name;
  }
  return handler.name || "anonymous";
}

function durableRuntimeFor(handler: Handler | WorkflowHandler) {
  if (!isWorkflowHandler(handler)) {
    return undefined;
  }
  return {
    primitive: "workflow" as const,
    interface: "hobo:runtime/workflow@0.1.0" as const,
    handler: handler.name,
  };
}

function omitEmpty<T>(value: T) {
  // SAFETY: Object.entries erases T at this object-bag boundary.
  const entries: Array<[string, JsonValue]> = Object.entries(value as never);
  return Object.fromEntries(
    entries.filter(([, entry]) => {
      if (Array.isArray(entry)) {
        return entry.length > 0;
      }
      if (entry && isJsonObject(entry)) {
        return Object.keys(entry).length > 0;
      }
      return entry !== undefined;
    }),
  );
}

function omitUndefined<T>(value: T): T {
  // SAFETY: Object.entries erases T at this object-bag boundary.
  const entries: Array<[string, JsonValue | undefined]> = Object.entries(value as never);
  // SAFETY: filtered entries reconstruct T after dropping undefined fields.
  const omitted: T = Object.fromEntries(entries.filter(([, entry]) => entry !== undefined)) as T;
  return omitted;
}
