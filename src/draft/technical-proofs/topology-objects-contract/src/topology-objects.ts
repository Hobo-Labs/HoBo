export const TOPOLOGY_CONTRACT_VERSION = "hobo.topology-objects/v1";

export function providerSelection(providerId, selector = "default", options = {}) {
  requireName("providerId", providerId);
  requireName("selector", selector);
  if (!isPlainObject(options)) {
    throw new TypeError("provider selection options must be an object");
  }

  return deepFreeze({
    kind: "provider-selection",
    providerId,
    selector,
    options: sortKeys(options)
  });
}

export function bindle(name, builder) {
  requireName("bindle name", name);
  if (!isCallable(builder)) {
    throw new TypeError("bindle builder must be a function");
  }

  const resources = [];
  const byStableId = new Set();
  const collector = Object.freeze({
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
    }
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
    resources
  });
}

export function camp(name, config) {
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

  const defaultProvider = config.defaultProvider ? normalizeProviderSelection(config.defaultProvider) : null;
  const tiers = normalizeSelectorMap(config.tiers ?? {}, "tiers");
  const bindings = normalizeSelectorMap(config.bindings ?? {}, "bindings");
  const providerId = singleProviderId([defaultProvider, ...Object.values(tiers), ...Object.values(bindings)]);
  const { id, env } = normalizeCampId(name, providerId);
  const mappings = {
    defaultProvider,
    tiers,
    bindings
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
    resolutionPrecedence: buildResolutionPrecedence(config.bindle, mappings)
  });
}

export function yard(name, config) {
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
    providerId: providerIds[0],
    camps
  });
}

export function junction(name, config) {
  requireName("junction name", name);
  const yards = requireArray(config?.yards, "junction yards");
  if (yards.length === 0) {
    throw new Error("junction requires at least one Yard");
  }
  for (const entry of yards) {
    if (entry?.kind !== "yard") {
      throw new TypeError("junction yards must be Yard objects");
    }
  }

  return deepFreeze({
    kind: "junction",
    contract: TOPOLOGY_CONTRACT_VERSION,
    name,
    yards,
    providerIds: [...new Set(yards.map((entry) => entry.providerId))]
  });
}

export function resolutionPrecedenceFor(campObject, resourceKey) {
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
      entry.portRef
    ].includes(resourceKey)
  );
  if (!record) {
    throw new Error(`no resolution precedence record for ${resourceKey}`);
  }
  return record.order;
}

function normalizeResourceDescriptor(resource) {
  const descriptor = isCallable(resource?.toDescriptor) ? resource.toDescriptor() : resource;
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
    providerAgnostic: true
  });
}

function assertNoProviderSpecificFields(value) {
  if (!isObjectRecord(value)) return;
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

function normalizeSelectorMap(value, fieldName) {
  if (!isPlainObject(value)) {
    throw new TypeError(`camp ${fieldName} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, selector]) => [key, normalizeProviderSelection(selector)])
  );
}

function normalizeProviderSelection(value) {
  if (value?.kind !== "provider-selection") {
    throw new TypeError("provider mappings must use providerSelection(...) descriptors");
  }
  return value;
}

function singleProviderId(selectors) {
  const ids = [...new Set(selectors.filter(Boolean).map((selector) => selector.providerId))];
  if (ids.length === 0) {
    throw new Error("camp requires at least one provider mapping");
  }
  if (ids.length > 1) {
    throw new Error(`camp mappings must target one provider, got ${ids.join(", ")}`);
  }
  return ids[0];
}

function buildResolutionPrecedence(bindleObject, mappings) {
  return bindleObject.resources.flatMap((resource) =>
    resource.portRef.map((portRef) => {
      const binding = firstSelection(mappings.bindings, [
        resource.stableId,
        resource.name,
        `${bindleObject.name}.${resource.name}`,
        portRef
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
          summarizeResolution("defaultProvider", "*", mappings.defaultProvider)
        ]
      };
    })
  );
}

function firstSelection(map, keys) {
  for (const key of keys) {
    if (map[key]) {
      return { key, selector: map[key] };
    }
  }
  return { key: null, selector: null };
}

function normalizeCampId(name, providerId) {
  const suffix = `-${providerId}`;
  if (name.endsWith(suffix)) {
    const env = name.slice(0, -suffix.length);
    requireName("camp env", env);
    return { id: name, env };
  }
  return { id: `${name}-${providerId}`, env: name };
}

function inferEnvType(env) {
  if (/^(prod|production)$/i.test(env)) return "production";
  if (/^staging$/i.test(env)) return "staging";
  if (/^(preview|pr|ephemeral)$/i.test(env)) return "ephemeral";
  if (/^(dev|development|local)$/i.test(env)) return "development";
  return env;
}

function summarizeResolution(source, key, selector) {
  return {
    source,
    key,
    providerId: selector?.providerId ?? null,
    selector: selector?.selector ?? null
  };
}

function requireArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return value;
}

function requireName(label, value) {
  if (!isString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function isPlainObject(value) {
  return isObjectRecord(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
