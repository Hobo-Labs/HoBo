import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1" as const;

// domain-view: parse-produced draft-proof record; its wire form is the ProviderSelection proto message in data-models/.
export interface ProviderSelection {
  readonly kind: "provider-selection";
  readonly providerId: string;
  readonly selector: string;
  readonly options: Readonly<JsonObject>;
}

export interface BindleResourceDescriptor {
  readonly kind: string;
  readonly name: string;
  readonly stableId: string;
  readonly portRef: readonly string[];
  readonly providerAgnostic: true;
}

export interface Bindle {
  readonly kind: "bindle";
  readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
  readonly name: string;
  readonly source: "programmatic";
  readonly configFile: false;
  readonly providerAgnostic: true;
  readonly providerIds: readonly [];
  readonly resources: readonly BindleResourceDescriptor[];
}

export interface Camp {
  readonly kind: "camp";
  readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly env: string;
  readonly envType: string;
  readonly providerId: string;
  readonly runtime: JsonValue;
  readonly bindle: Bindle;
  readonly mappings: {
    readonly defaultProvider: ProviderSelection | null;
    readonly tiers: Readonly<Record<string, ProviderSelection>>;
    readonly bindings: Readonly<Record<string, ProviderSelection>>;
  };
  readonly resolutionOrder: readonly ["bindings", "tiers", "defaultProvider"];
  readonly resolutionPrecedence: readonly ResolutionPrecedenceRecord[];
}

export interface Yard {
  readonly kind: "yard";
  readonly contract: typeof TOPOLOGY_CONTRACT_VERSION;
  readonly name: string;
  readonly providerId: string;
  readonly camps: readonly Camp[];
}

export interface ResolutionPrecedenceRecord {
  readonly resource: string;
  readonly resourceName: string;
  readonly resourceKind: string;
  readonly portRef: string;
  readonly order: readonly ResolutionStep[];
}

export interface ResolutionStep {
  readonly source: "bindings" | "tiers" | "defaultProvider";
  readonly key: string;
  readonly providerId: string | null;
  readonly selector: string | null;
}

export interface BindleCollector {
  use(resource: BindleResourceInput): BindleResourceDescriptor;
}

export type BindleResourceInput =
  | BindleResourceDescriptor
  | {
      readonly toDescriptor?: () => BindleResourceDescriptor;
      readonly kind?: string;
      readonly name?: string;
      readonly stableId?: string;
      readonly portRef?: readonly string[];
      readonly provider?: string;
      readonly defaultProvider?: JsonValue;
      readonly tiers?: JsonValue;
      readonly bindings?: JsonValue;
      readonly providerAnnotations?: JsonValue;
      readonly options?: { readonly providerOptions?: unknown };
      readonly annotations?: { readonly with?: unknown };
    };

export function providerSelection(
  providerId: string,
  selector = "default",
  options: Readonly<JsonObject> = {},
): ProviderSelection {
  requireName("providerId", providerId);
  requireName("selector", selector);
  if (!isPlainObject(options)) {
    throw new TypeError("provider selection options must be an object");
  }

  return deepFreeze({
    kind: "provider-selection",
    providerId,
    selector,
    options: sortKeys(options),
  });
}

export function bindle(name: string, builder: (collector: BindleCollector) => void): Bindle {
  requireName("bindle name", name);
  if (!(builder instanceof Function)) {
    throw new TypeError("bindle builder must be a function");
  }

  const resources: BindleResourceDescriptor[] = [];
  const byStableId = new Set<string>();
  const collector: BindleCollector = Object.freeze({
    use(resource) {
      assertNoProviderSpecificFields(resource);
      const descriptor = normalizeResourceDescriptor(resource);
      assertNoProviderSpecificFields(descriptor);
      if (byStableId.has(descriptor.stableId)) {
        throw new Error(`duplicate Bindle resource ${descriptor.stableId}`);
      }
      byStableId.add(descriptor.stableId);
      resources.push(descriptor);
      return descriptor;
    },
  });

  builder(collector);

  return deepFreeze({
    kind: "bindle",
    contract: TOPOLOGY_CONTRACT_VERSION,
    name,
    source: "programmatic",
    configFile: false,
    providerAgnostic: true,
    providerIds: [],
    resources,
  });
}

export function camp(name: string, config: CampConfig): Camp {
  requireName("camp name", name);
  if (!isPlainObject(config)) {
    throw new TypeError("camp config must be an object");
  }
  if (config.bindle?.kind !== "bindle") {
    throw new TypeError("camp requires a Bindle object");
  }
  if (!config.runtime) {
    throw new TypeError("camp requires a runtime backend descriptor");
  }

  const defaultProvider = config.defaultProvider
    ? normalizeProviderSelection(config.defaultProvider)
    : null;
  const tiers = normalizeSelectorMap(config.tiers ?? {}, "tiers");
  const bindings = normalizeSelectorMap(config.bindings ?? {}, "bindings");
  const providerId = singleProviderId([defaultProvider, ...Object.values(tiers), ...Object.values(bindings)]);
  const { id, env } = normalizeCampId(name, providerId);
  const mappings = {
    defaultProvider,
    tiers,
    bindings,
  };

  return deepFreeze({
    kind: "camp",
    contract: TOPOLOGY_CONTRACT_VERSION,
    id,
    name: id,
    env,
    envType: config.envType ?? inferEnvType(env),
    providerId,
    runtime: config.runtime,
    bindle: config.bindle,
    mappings,
    resolutionOrder: ["bindings", "tiers", "defaultProvider"],
    resolutionPrecedence: buildResolutionPrecedence(config.bindle, mappings),
  });
}

export interface CampConfig {
  readonly bindle: Bindle;
  readonly runtime: JsonValue;
  readonly envType?: string;
  readonly defaultProvider?: ProviderSelection;
  readonly tiers?: Readonly<Record<string, ProviderSelection>>;
  readonly bindings?: Readonly<Record<string, ProviderSelection>>;
}

export function yard(name: string, config: { readonly camps: readonly Camp[] }): Yard {
  requireName("yard name", name);
  const camps = requireArray(config?.camps, "yard camps");
  if (camps.length === 0) {
    throw new Error("yard requires at least one Camp");
  }
  for (const entry of camps) {
    if (entry?.kind !== "camp") {
      throw new TypeError("yard camps must be Camp objects");
    }
  }

  const providerIds = [...new Set(camps.map((entry) => entry.providerId))];
  if (providerIds.length !== 1) {
    throw new Error(`Yard ${name} cannot mix providers: ${providerIds.join(", ")}`);
  }

  return deepFreeze({
    kind: "yard",
    contract: TOPOLOGY_CONTRACT_VERSION,
    name,
    providerId: providerIds[0]!,
    camps,
  });
}

export function resolutionPrecedenceFor(
  campObject: Camp,
  resourceKey: string,
): readonly ResolutionStep[] {
  if (campObject?.kind !== "camp") {
    throw new TypeError("resolutionPrecedenceFor expects a Camp object");
  }
  requireName("resource key", resourceKey);

  const record = campObject.resolutionPrecedence.find((entry) =>
    [
      entry.resource,
      entry.resourceName,
      `${campObject.bindle.name}.${entry.resourceName}`,
      entry.resourceKind,
      entry.portRef,
    ].includes(resourceKey),
  );
  if (!record) {
    throw new Error(`no resolution precedence record for ${resourceKey}`);
  }
  return record.order;
}

export function descriptorFromHandle(handle: {
  readonly kind: string;
  readonly name: string;
  readonly port?: string;
}): BindleResourceDescriptor {
  const kind = handle.kind === "resource" ? "data" : handle.kind;
  const port =
    handle.port ?? (kind === "service" || kind === "container" ? "wasi:http" : "hobo:data");
  return deepFreeze({
    kind,
    name: handle.name,
    stableId: `${kind}:${handle.name}`,
    portRef: [port],
    providerAgnostic: true,
  });
}

function normalizeResourceDescriptor(resource: BindleResourceInput): BindleResourceDescriptor {
  const descriptor =
    resource?.toDescriptor instanceof Function ? resource.toDescriptor() : resource;
  if (!isPlainObject(descriptor)) {
    throw new TypeError("Bindle resources must be descriptor objects");
  }

  requireName("resource kind", descriptor.kind);
  requireName("resource name", descriptor.name);
  requireName("resource stableId", descriptor.stableId);
  if (!Array.isArray(descriptor.portRef)) {
    throw new TypeError(`resource ${descriptor.stableId} portRef must be an array`);
  }
  assertNoProviderSpecificFields(descriptor);

  return deepFreeze({
    kind: descriptor.kind,
    name: descriptor.name,
    stableId: descriptor.stableId,
    portRef: [...descriptor.portRef],
    providerAgnostic: true,
  });
}

function assertNoProviderSpecificFields(value: BindleResourceInput): void {
  if (!value || !isJsonObject(value)) return;
  const annotations = value.annotations?.with;
  const providerOptions = value.options?.providerOptions;
  if (
    value.provider ||
    value.defaultProvider ||
    value.tiers ||
    value.bindings ||
    value.providerAnnotations ||
    providerOptions ||
    annotations
  ) {
    throw new Error("provider-specific options belong on Camp mappings, not Bindle resources");
  }
}

function normalizeSelectorMap(
  value: Readonly<Record<string, ProviderSelection>>,
  fieldName: string,
): Readonly<Record<string, ProviderSelection>> {
  if (!isPlainObject(value)) {
    throw new TypeError(`camp ${fieldName} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, selector]) => [key, normalizeProviderSelection(selector)]),
  );
}

function normalizeProviderSelection(value: ProviderSelection): ProviderSelection {
  if (value?.kind !== "provider-selection") {
    throw new TypeError("provider mappings must use providerSelection(...) descriptors");
  }
  return value;
}

function singleProviderId(selectors: readonly (ProviderSelection | null)[]): string {
  const ids = [...new Set(selectors.filter(Boolean).map((selector) => selector!.providerId))];
  if (ids.length === 0) {
    throw new Error("camp requires at least one provider mapping");
  }
  if (ids.length > 1) {
    throw new Error(`camp mappings must target one provider, got ${ids.join(", ")}`);
  }
  return ids[0]!;
}

function buildResolutionPrecedence(
  bindleObject: Bindle,
  mappings: Camp["mappings"],
): ResolutionPrecedenceRecord[] {
  return bindleObject.resources.flatMap((resource) =>
    resource.portRef.map((portRef) => {
      const binding = firstSelection(mappings.bindings, [
        resource.stableId,
        resource.name,
        `${bindleObject.name}.${resource.name}`,
        portRef,
      ]);
      const tier = firstSelection(mappings.tiers, [resource.kind, portRef]);

      return {
        resource: resource.stableId,
        resourceName: resource.name,
        resourceKind: resource.kind,
        portRef,
        order: [
          summarizeResolution("bindings", binding.key ?? resource.name, binding.selector),
          summarizeResolution("tiers", tier.key ?? resource.kind, tier.selector),
          summarizeResolution("defaultProvider", "*", mappings.defaultProvider),
        ],
      };
    }),
  );
}

interface ProviderSelectionPick {
  key: string | null;
  selector: ProviderSelection | null;
}

function firstSelection(
  map: Readonly<Record<string, ProviderSelection>>,
  keys: readonly string[],
): ProviderSelectionPick {
  for (const key of keys) {
    if (map[key]) {
      return { key, selector: map[key]! };
    }
  }
  return { key: null, selector: null };
}

interface CampId {
  id: string;
  env: string;
}

function normalizeCampId(name: string, providerId: string): CampId {
  const suffix = `-${providerId}`;
  if (name.endsWith(suffix)) {
    const env = name.slice(0, -suffix.length);
    requireName("camp env", env);
    return { id: name, env };
  }
  return { id: `${name}-${providerId}`, env: name };
}

function inferEnvType(env: string): string {
  if (/^(prod|production)$/i.test(env)) return "production";
  if (/^staging$/i.test(env)) return "staging";
  if (/^(preview|pr|ephemeral)$/i.test(env)) return "ephemeral";
  if (/^(dev|development|local)$/i.test(env)) return "development";
  return env;
}

function summarizeResolution(
  source: ResolutionStep["source"],
  key: string,
  selector: ProviderSelection | null,
): ResolutionStep {
  return {
    source,
    key,
    providerId: selector?.providerId ?? null,
    selector: selector?.selector ?? null,
  };
}

function requireArray<T>(value: readonly T[] | undefined, fieldName: string): readonly T[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return value;
}

function requireName(label: string, value: string): void {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

function sortKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
