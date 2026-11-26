export type CatalogFactoryName =
  | "api"
  | "kv"
  | "cache"
  | "bucket"
  | "queue"
  | "topic"
  | "secret"
  | "data"
  | "schedule"
  | "websocket"
  | "job"
  | "web"
  | "service"
  | "flag"
  | "auth"
  | "crypto"
  | "notify"
  | "guardrail"
  | "ui"
  | "experiment";

export type ApiAllowVerb = never;
export type KvAllowVerb = "get" | "set" | "delete";
export type CacheAllowVerb = "get" | "set" | "delete" | "invalidate";
export type BucketAllowVerb = "read" | "write" | "delete";
export type QueueAllowVerb = "enqueue" | "dequeue";
export type TopicAllowVerb = "publish" | "subscribe";
export type SecretAllowVerb = "put" | "access";
export type DataAllowVerb = "read" | "write" | "query" | "admin";
export type ScheduleAllowVerb = never;
export type WebsocketAllowVerb = "accept" | "connect" | "send" | "broadcast" | "subscribe";
export type JobAllowVerb = "submit";
export type WebAllowVerb = never;
export type ServiceAllowVerb = never;
export type FlagAllowVerb = "eval" | "change";
export type AuthAllowVerb = "verify" | "session";
export type CryptoAllowVerb = "encrypt" | "decrypt" | "sign" | "verify";
export type NotifyAllowVerb = "send";
export type GuardrailAllowVerb = "check";
export type UiAllowVerb = "render" | "drive";
export type ExperimentAllowVerb = "assign" | "expose" | "analyze";

export interface CatalogEntry<Factory extends CatalogFactoryName, Verb extends string> {
  readonly factory: Factory;
  readonly portRef: readonly string[];
  readonly allowVerbs: readonly Verb[];
}

export interface ResourceIdentity<Kind extends CatalogFactoryName> {
  readonly kind: Kind;
  readonly name: string;
  readonly stableId: `${Kind}:${string}`;
}

export interface LoweredCall<Kind extends CatalogFactoryName, Verb extends string> {
  readonly lowersTo: "hobo:sdk";
  readonly kind: Kind;
  readonly name: string;
  readonly handleStableId: `${Kind}:${string}`;
  readonly portRef: readonly string[];
  readonly verb: Verb;
  readonly args: readonly unknown[];
}

export interface ResourceDescriptor<Kind extends CatalogFactoryName, Verb extends string> {
  readonly kind: Kind;
  readonly name: string;
  readonly stableId: `${Kind}:${string}`;
  readonly portRef: readonly string[];
  readonly allowVerbs: readonly Verb[];
  readonly declaredAllow: readonly Verb[];
}

export interface ResourceHandle<Kind extends CatalogFactoryName, Verb extends string> {
  readonly kind: Kind;
  readonly name: string;
  readonly portRef: readonly string[];
  readonly allowVerbs: readonly Verb[];
  readonly allowVerbsType: `${Kind}.allow`;
  readonly stableId: `${Kind}:${string}`;
  readonly identity: ResourceIdentity<Kind>;
  readonly declaredAllow: readonly Verb[];
  allow(...verbs: readonly Verb[]): this;
  toDescriptor(): ResourceDescriptor<Kind, Verb>;
}

export interface ApiHandle extends ResourceHandle<"api", ApiAllowVerb> {}

export interface KvHandle extends ResourceHandle<"kv", KvAllowVerb> {
  get(...args: readonly unknown[]): LoweredCall<"kv", "get">;
  set(...args: readonly unknown[]): LoweredCall<"kv", "set">;
  delete(...args: readonly unknown[]): LoweredCall<"kv", "delete">;
}

export interface CacheHandle extends ResourceHandle<"cache", CacheAllowVerb> {
  get(...args: readonly unknown[]): LoweredCall<"cache", "get">;
  set(...args: readonly unknown[]): LoweredCall<"cache", "set">;
  delete(...args: readonly unknown[]): LoweredCall<"cache", "delete">;
  invalidate(...args: readonly unknown[]): LoweredCall<"cache", "invalidate">;
}

export interface BucketHandle extends ResourceHandle<"bucket", BucketAllowVerb> {
  read(...args: readonly unknown[]): LoweredCall<"bucket", "read">;
  write(...args: readonly unknown[]): LoweredCall<"bucket", "write">;
  delete(...args: readonly unknown[]): LoweredCall<"bucket", "delete">;
}

export interface QueueHandle extends ResourceHandle<"queue", QueueAllowVerb> {
  enqueue(...args: readonly unknown[]): LoweredCall<"queue", "enqueue">;
  dequeue(...args: readonly unknown[]): LoweredCall<"queue", "dequeue">;
}

export interface TopicHandle extends ResourceHandle<"topic", TopicAllowVerb> {
  publish(...args: readonly unknown[]): LoweredCall<"topic", "publish">;
  subscribe(...args: readonly unknown[]): LoweredCall<"topic", "subscribe">;
}

export interface SecretHandle extends ResourceHandle<"secret", SecretAllowVerb> {
  put(...args: readonly unknown[]): LoweredCall<"secret", "put">;
  access(...args: readonly unknown[]): LoweredCall<"secret", "access">;
}

export interface DataHandle extends ResourceHandle<"data", DataAllowVerb> {
  read(...args: readonly unknown[]): LoweredCall<"data", "read">;
  write(...args: readonly unknown[]): LoweredCall<"data", "write">;
  query(...args: readonly unknown[]): LoweredCall<"data", "query">;
  admin(...args: readonly unknown[]): LoweredCall<"data", "admin">;
}

export interface ScheduleHandle extends ResourceHandle<"schedule", ScheduleAllowVerb> {}

export interface WebsocketHandle extends ResourceHandle<"websocket", WebsocketAllowVerb> {
  accept(...args: readonly unknown[]): LoweredCall<"websocket", "accept">;
  connect(...args: readonly unknown[]): LoweredCall<"websocket", "connect">;
  send(...args: readonly unknown[]): LoweredCall<"websocket", "send">;
  broadcast(...args: readonly unknown[]): LoweredCall<"websocket", "broadcast">;
  subscribe(...args: readonly unknown[]): LoweredCall<"websocket", "subscribe">;
}

export interface JobHandle extends ResourceHandle<"job", JobAllowVerb> {
  submit(...args: readonly unknown[]): LoweredCall<"job", "submit">;
}

export interface WebHandle extends ResourceHandle<"web", WebAllowVerb> {}

export interface ServiceHandle extends ResourceHandle<"service", ServiceAllowVerb> {}

export interface FlagHandle extends ResourceHandle<"flag", FlagAllowVerb> {
  eval(...args: readonly unknown[]): LoweredCall<"flag", "eval">;
  change(...args: readonly unknown[]): LoweredCall<"flag", "change">;
}

export interface AuthHandle extends ResourceHandle<"auth", AuthAllowVerb> {
  verify(...args: readonly unknown[]): LoweredCall<"auth", "verify">;
  session(...args: readonly unknown[]): LoweredCall<"auth", "session">;
}

export interface CryptoHandle extends ResourceHandle<"crypto", CryptoAllowVerb> {
  encrypt(...args: readonly unknown[]): LoweredCall<"crypto", "encrypt">;
  decrypt(...args: readonly unknown[]): LoweredCall<"crypto", "decrypt">;
  sign(...args: readonly unknown[]): LoweredCall<"crypto", "sign">;
  verify(...args: readonly unknown[]): LoweredCall<"crypto", "verify">;
}

export interface NotifyHandle extends ResourceHandle<"notify", NotifyAllowVerb> {
  send(...args: readonly unknown[]): LoweredCall<"notify", "send">;
}

export interface GuardrailHandle extends ResourceHandle<"guardrail", GuardrailAllowVerb> {
  check(...args: readonly unknown[]): LoweredCall<"guardrail", "check">;
}

export interface UiHandle extends ResourceHandle<"ui", UiAllowVerb> {
  render(...args: readonly unknown[]): LoweredCall<"ui", "render">;
  drive(...args: readonly unknown[]): LoweredCall<"ui", "drive">;
}

export interface ExperimentHandle extends ResourceHandle<"experiment", ExperimentAllowVerb> {
  assign(...args: readonly unknown[]): LoweredCall<"experiment", "assign">;
  expose(...args: readonly unknown[]): LoweredCall<"experiment", "expose">;
  analyze(...args: readonly unknown[]): LoweredCall<"experiment", "analyze">;
}

export interface SecretValueRef {
  readonly kind: "secret-ref";
  readonly ref: string;
  readonly catalogFactory: false;
  readonly portRef: "wasi:config/hobo:secrets";
  readonly stableId: `secret-ref:${string}`;
  readonly lowersTo: "hobo:sdk";
}

export const CATALOG: readonly CatalogEntry<CatalogFactoryName, string>[];
export function catalogFactoryNames(): CatalogFactoryName[];
export function api(name: string): ApiHandle;
export function kv(name: string): KvHandle;
export function cache(name: string): CacheHandle;
export function bucket(name: string): BucketHandle;
export function queue(name: string): QueueHandle;
export function topic(name: string): TopicHandle;
export function secret(name: string): SecretHandle;
export function data(name: string): DataHandle;
export function schedule(name: string): ScheduleHandle;
export function websocket(name: string): WebsocketHandle;
export function job(name: string): JobHandle;
export function web(name: string): WebHandle;
export function service(name: string): ServiceHandle;
export function flag(name: string): FlagHandle;
export function auth(name: string): AuthHandle;
export function crypto(name: string): CryptoHandle;
export function notify(name: string): NotifyHandle;
export function guardrail(name: string): GuardrailHandle;
export function ui(name: string): UiHandle;
export function experiment(name: string): ExperimentHandle;
export function secretRef(ref: string): SecretValueRef;
