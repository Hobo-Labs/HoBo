import { type JsonValue, type JsonObject } from "./json.js";
export interface TriggerEdge {
  readonly id: string;
  readonly kind: "http.route" | "topic.subscribe" | "schedule.cron" | "bucket.on";
  readonly resource: string;
  readonly event?: string;
  readonly cron?: string;
  readonly method?: string;
  readonly path?: string;
  readonly exportInterface: string;
  readonly handler: string;
  readonly inferredPermissions?: readonly string[];
  readonly durableRuntime?: {
    readonly primitive: "workflow";
    readonly interface: "hobo:runtime/workflow@0.1.0";
    readonly handler: string;
  };
}

export interface ResourceHandle<Kind extends string, Client> {
  readonly kind: Kind;
  readonly name: string;
  readonly stableId: `${Kind}:${string}`;
  readonly port: string;
  readonly clientType: string;
  readonly triggers: readonly TriggerEdge[];
  readonly bindings: Readonly<Record<string, BindingDescriptor>>;
}

export interface BindingDescriptor {
  readonly port: string;
  readonly resource: string;
  readonly clientType: string;
}

export interface KvClient {
  get(key: string): Promise<JsonValue>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface QueueClient {
  enqueue(message: JsonValue): Promise<void>;
  dequeue(): Promise<JsonValue>;
}

export interface TopicClient {
  publish(message: JsonValue): Promise<void>;
}

export interface BucketClient {
  read(key: string): Promise<JsonValue>;
  write(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
}

export type BindingMap = Record<string, ResourceHandle<string, unknown>>;

export type BindingClients<Bindings extends BindingMap> = {
  readonly [Key in keyof Bindings]: Bindings[Key] extends ResourceHandle<string, infer Client>
    ? Client
    : never;
};

export interface HandlerContext<Bindings extends BindingMap = {}> {
  readonly params: Readonly<Record<string, string>>;
  json<T = unknown>(): Promise<T>;
  readonly body: JsonValue;
  readonly bindings: BindingClients<Bindings>;
  readonly config: Readonly<Record<string, string>>;
  readonly user?: JsonValue;
  readonly identity?: JsonValue;
}

export type Handler<Bindings extends BindingMap = {}> = (
  ctx: HandlerContext<Bindings>,
) => JsonValue | void | Promise<JsonValue | void>;

export interface ApiHandle<Bindings extends BindingMap = {}> extends ResourceHandle<"api", never> {
  get(path: string, handler: Handler<Bindings>): TriggerEdge;
  post(path: string, handler: Handler<Bindings>): TriggerEdge;
  put(path: string, handler: Handler<Bindings>): TriggerEdge;
  patch(path: string, handler: Handler<Bindings>): TriggerEdge;
  delete(path: string, handler: Handler<Bindings>): TriggerEdge;
}

export interface TopicHandle extends ResourceHandle<"topic", TopicClient> {
  subscribe(eventType: string, handler: Handler | WorkflowHandler): TriggerEdge;
}

export interface ScheduleHandle extends ResourceHandle<"schedule", never> {
  cron(expression: string, handler: Handler | WorkflowHandler): TriggerEdge;
}

export interface BucketHandle extends ResourceHandle<"bucket", BucketClient> {
  on(event: string, handler: Handler | WorkflowHandler): TriggerEdge;
}

export interface WorkflowHandler {
  readonly kind: "workflow";
  readonly name: string;
  readonly handler: (...args: JsonValue[]) => JsonValue | void | Promise<JsonValue | void>;
}

export class TriggerContractError extends Error {
  readonly path: string;
  constructor(path: string, message: string);
}

export function api<Bindings extends BindingMap = {}>(
  name: string,
  options?: { bind?: Bindings },
): ApiHandle<Bindings>;

export function kv(name: string): ResourceHandle<"kv", KvClient>;
export function queue(name: string): ResourceHandle<"queue", QueueClient>;
export function topic(name: string, options?: { durableEvents?: boolean }): TopicHandle;
export function schedule(name: string, options?: { durableEvents?: boolean }): ScheduleHandle;
export function bucket(name: string, options?: { durableEvents?: boolean }): BucketHandle;
export function workflow(name: string, handler: (...args: JsonValue[]) => JsonValue | void | Promise<JsonValue | void>): WorkflowHandler;

export function compileHandlerManifest(
  resources: readonly ResourceHandle<string, JsonValue>[],
  options?: {
    readonly triggers?: readonly TriggerEdge[];
    readonly componentHost?: {
      readonly kind: string;
      readonly version: string;
    };
  },
): {
  readonly schema: "hobo.manifest/v1";
  readonly componentHost: {
    readonly kind: string;
    readonly version: string;
  };
  readonly resources: JsonObject;
  readonly triggerEdges?: readonly TriggerEdge[];
};
