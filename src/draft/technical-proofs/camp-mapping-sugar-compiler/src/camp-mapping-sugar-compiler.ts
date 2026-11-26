import { defineResource } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CAMP_MAPPING_SUGAR_VERSION = "hobo.camp-mapping-sugar/v1";

export function compileCampMapping({ campId, resources, mapping }) {
  if (!isNonEmptyString(campId)) {
    throw new Error("campId is required");
  }
  const normalizedResources = normalizeResources(resources);
  const normalizedMapping = mapping ?? {};
  const definitions = [];
  const sources = [];

  if (normalizedMapping.defaultProvider !== undefined) {
    const target = normalizeProviderTarget(normalizedMapping.defaultProvider, "defaultProvider");
    for (const group of uniqueResourceKinds(normalizedResources)) {
      addDefinition({
        definitions,
        sources,
        campId,
        source: "defaultProvider",
        id: `camp.${slug(campId)}.default.${kindSuffix(group.kind)}`,
        target,
        kind: group.kind,
        match: {},
        resourceIds: group.resourceIds
      });
    }
  }

  for (const tier of normalizeTierEntries(normalizedMapping.tiers ?? {})) {
    const tierResources = normalizedResources.filter((resource) => resource.serviceModel === tier.serviceModel);
    if (tierResources.length === 0) {
      throw new Error(`tier ${tier.rawName} does not match any declared resource service model`);
    }

    const target = normalizeProviderTarget(tier.target, `tier ${tier.rawName}`);
    for (const group of uniqueResourceKinds(tierResources)) {
      addDefinition({
        definitions,
        sources,
        campId,
        source: "tiers",
        serviceModel: tier.serviceModel,
        id: `camp.${slug(campId)}.tier.${tier.serviceModel}.${kindSuffix(group.kind)}`,
        target,
        kind: group.kind,
        match: { resourceClass: tier.serviceModel },
        resourceIds: group.resourceIds
      });
    }
  }

  for (const [resourceId, bindingTarget] of Object.entries(normalizedMapping.bindings ?? {})) {
    const resource = normalizedResources.find((candidate) => candidate.id === resourceId);
    if (!resource) {
      throw new Error(`binding ${resourceId} does not match a declared resource`);
    }

    const target = normalizeProviderTarget(bindingTarget, `binding ${resourceId}`);
    addDefinition({
      definitions,
      sources,
      campId,
      source: "bindings",
      id: `camp.${slug(campId)}.binding.${slug(resourceId)}`,
      target,
      kind: resourceKind(resource),
      match: { resourceId },
      resourceIds: [resourceId]
    });
  }

  assertNoCompiledDefinitionCollisions(definitions);

  return {
    apiVersion: CAMP_MAPPING_SUGAR_VERSION,
    campId,
    definitions,
    sources
  };
}

export function registerCompiledDefinitions(catalog, compiled) {
  if (!(catalog?.register instanceof Function)) {
    throw new Error("catalog with register(definition) is required");
  }
  if (!Array.isArray(compiled?.definitions)) {
    throw new Error("compiled mapping with definitions is required");
  }

  return compiled.definitions.flatMap((definition) => catalog.register(definition));
}

function addDefinition({ definitions, sources, campId, source, serviceModel, id, target, kind, match, resourceIds }) {
  const definition = defineResource({
    id,
    type: kind.type,
    engine: target.engine ?? kind.engine,
    className: target.className ?? kind.className,
    paradigm: target.paradigm ?? kind.paradigm,
    provider: target.provider,
    driver: target.driver,
    with: target.with,
    match,
    priority: target.priority,
    coProvisioned: target.coProvisioned
  });

  definitions.push(definition);
  sources.push({
    definitionId: definition.id,
    sugar: source,
    campId,
    resourceIds: [...resourceIds],
    ...(serviceModel ? { serviceModel } : undefined)
  });
}

function normalizeResources(resources) {
  if (!Array.isArray(resources) || resources.length === 0) {
    throw new Error("resources must be a non-empty array");
  }

  const seenIds = new Set();
  return resources.map((resource, index) => {
    const label = `resource[${index}]`;
    if (!isNonEmptyString(resource?.id)) {
      throw new Error(`${label}.id is required`);
    }
    if (!isNonEmptyString(resource?.type)) {
      throw new Error(`${label}.type is required`);
    }
    if (seenIds.has(resource.id)) {
      throw new Error(`resource ${resource.id} declared more than once`);
    }
    seenIds.add(resource.id);

    return {
      id: resource.id,
      type: resource.type,
      engine: optionalString(resource.engine),
      className: optionalString(resource.className ?? resource.class),
      paradigm: optionalString(resource.paradigm),
      serviceModel: resource.serviceModel === undefined ? undefined : normalizeServiceModel(resource.serviceModel, label)
    };
  });
}

function normalizeTierEntries(tiers) {
  if (!isPlainObject(tiers)) {
    throw new Error("tiers must be an object");
  }

  const seen = new Map();
  return Object.entries(tiers).map(([rawName, target]) => {
    const serviceModel = normalizeServiceModel(rawName, `tier ${rawName}`);
    const firstRawName = seen.get(serviceModel);
    if (firstRawName) {
      throw new Error(
        `compiled definition collision: tier ${firstRawName} and tier ${rawName} both lower to service model ${serviceModel}`
      );
    }
    seen.set(serviceModel, rawName);
    return { rawName, serviceModel, target };
  });
}

function normalizeProviderTarget(target, label) {
  if (isNonEmptyString(target)) {
    return {
      provider: target,
      driver: "terraform",
      with: {},
      priority: 0,
      coProvisioned: []
    };
  }
  if (!isPlainObject(target)) {
    throw new Error(`${label} provider target must be a provider id or object`);
  }

  const provider = target.provider ?? target.id;
  if (!isNonEmptyString(provider)) {
    throw new Error(`${label} provider is required`);
  }

  return {
    provider,
    driver: target.driver ?? "terraform",
    engine: optionalString(target.engine),
    className: optionalString(target.className ?? target.class),
    paradigm: optionalString(target.paradigm),
    with: sortKeys(target.with ?? target.options ?? {}),
    priority: Number.isInteger(target.priority) ? target.priority : 0,
    coProvisioned: Array.isArray(target.coProvisioned) ? structuredClone(target.coProvisioned) : []
  };
}

function uniqueResourceKinds(resources) {
  const groups = new Map();
  for (const resource of resources) {
    const kind = resourceKind(resource);
    const key = JSON.stringify(sortKeys(kind));
    const group = groups.get(key) ?? { kind, resourceIds: [] };
    group.resourceIds.push(resource.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function resourceKind(resource) {
  const kind = { type: resource.type };
  if (resource.engine) kind.engine = resource.engine;
  if (resource.className) kind.className = resource.className;
  if (resource.paradigm) kind.paradigm = resource.paradigm;
  return kind;
}

function assertNoCompiledDefinitionCollisions(definitions) {
  const byId = new Map();
  const byMatchKey = new Map();

  for (const definition of definitions) {
    const existingId = byId.get(definition.id);
    if (existingId) {
      throw new Error(`compiled definition collision: ${existingId.id} and ${definition.id} share an id`);
    }
    byId.set(definition.id, definition);

    const matchKey = JSON.stringify(sortKeys({
      type: definition.type,
      engine: definition.engine,
      className: definition.className,
      paradigm: definition.paradigm,
      match: definition.match
    }));
    const existingMatch = byMatchKey.get(matchKey);
    if (existingMatch) {
      throw new Error(
        `compiled definition collision: ${existingMatch.id} and ${definition.id} share resource kind and match criteria`
      );
    }
    byMatchKey.set(matchKey, definition);
  }
}

function kindSuffix(kind) {
  return [kind.type, kind.engine, kind.className, kind.paradigm].filter(Boolean).map(slug).join(".");
}

function normalizeServiceModel(value, label) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${label} service model is required`);
  }
  return value.trim().toLowerCase();
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function optionalString(value) {
  return isNonEmptyString(value) ? value : undefined;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isPlainObject(value) {
  return isJsonObject(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
