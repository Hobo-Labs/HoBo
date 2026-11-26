import { isJsonString, isJsonObject } from "./json.js";
const RESOURCE_FACTORIES = new Map([
  ["kv", "wasi:keyvalue"],
  ["database", "wasi:sql"],
  ["data", "hobo:projection"],
  ["bucket", "wasi:blobstore"],
  ["objectStore", "wasi:blobstore"],
  ["queue", "hobo:queue"],
  ["topic", "wasi:messaging"],
  ["secret", "wasi:config"],
]);
const COMPONENT_FACTORIES = new Set(["api", "service", "web", "job"]);
const FACTORY_NAMES = new Set([...RESOURCE_FACTORIES.keys(), ...COMPONENT_FACTORIES]);
const IGNORED_RESOURCE_METHODS = new Set(["allow"]);
const DECLARATION =
  /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*["']([A-Za-z][A-Za-z0-9_-]*)["']\s*\)(?:\s*\.\s*allow\s*\(([^)]*)\))?/g;
const STATIC_CALL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const DYNAMIC_CALL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\[\s*[^\]]+\s*\]\s*\(/g;
const NAMED_BINDLES_IMPORT =
  /import\s*\{([\s\S]*?)\}\s*from\s*["']@hobo\/bindles["']/g;
const NAMESPACE_BINDLES_IMPORT =
  /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*["']@hobo\/bindles["']/g;

export class CapabilityDeniedError extends Error {
  constructor(code, details = {}) {
    super(`${code}: ${details.componentId ?? "unknown"}:${details.importInterface ?? "unknown"}`);
    this.name = "CapabilityDeniedError";
    this.code = code;
    Object.assign(this, details);
  }
}

export function inferCapabilityUsage({ sourceText, fileName = "bindle.ts" }) {
  if (!isJsonString(sourceText)) {
    throw new TypeError("sourceText must be a string");
  }

  const imports = parseBindlesImports(sourceText);
  const lineStarts = findLineStarts(sourceText);
  const resourcesByVariable = new Map();
  const resourcesById = new Map();
  const diagnostics = [];

  for (const match of sourceText.matchAll(DECLARATION)) {
    const [, variable, qualifier, callee, resourceId, allowText] = match;
    if (!isBindlesFactory({ qualifier, callee, imports })) {
      continue;
    }

    const factory = canonicalFactory({ qualifier, callee, imports });
    const resource = {
      resource: resourceId,
      variable,
      factory,
      port: RESOURCE_FACTORIES.get(factory),
      component: COMPONENT_FACTORIES.has(factory),
      declaredAllow: parseAllowList(allowText),
      operations: new Set(),
    };
    resourcesByVariable.set(variable, resource);
    resourcesById.set(resourceId, resource);
  }

  for (const match of sourceText.matchAll(DYNAMIC_CALL)) {
    const resource = resourcesByVariable.get(match[1]);
    if (!resource || resource.component) {
      continue;
    }
    const prefix = match[2]
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(".") || "(root)";
    diagnostics.push({
      code: "capability.usage.cannot-prove-operation",
      severity: "error",
      resource: resource.resource,
      operationPrefix: prefix,
      fileName,
      line: lineAt(lineStarts, match.index),
      message: `Static analysis cannot prove capability operation for ${resource.resource}; capability grants must fail closed.`,
    });
  }

  for (const match of sourceText.matchAll(STATIC_CALL)) {
    const resource = resourcesByVariable.get(match[1]);
    if (!resource || resource.component || IGNORED_RESOURCE_METHODS.has(match[2])) {
      continue;
    }
    resource.operations.add(match[2]);
  }

  const resources = Object.freeze(
    [...resourcesById.values()].map((resource) => Object.freeze({
      resource: resource.resource,
      factory: resource.factory,
      port: resource.port,
      declaredAllow: Object.freeze([...resource.declaredAllow].sort()),
      operations: Object.freeze([...resource.operations].sort()),
    })),
  );

  return Object.freeze({
    ok: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    resources,
    diagnostics: Object.freeze(diagnostics),
  });
}

export function evaluateCapabilityGrants({ sourceText, manifest, fileName = "bindle.ts" }) {
  if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
    throw new TypeError("manifest must be an object");
  }

  const usage = inferCapabilityUsage({ sourceText, fileName });
  const nextManifest = structuredClone(manifest);
  const diagnostics = [...usage.diagnostics];
  const usageByResource = new Map(
    usage.resources.map((resource) => [resource.resource, resource]),
  );

  for (const [resourceId, resource] of Object.entries(nextManifest.resources ?? {})) {
    if (resource.type === "component.v1") {
      continue;
    }

    const inferred = usageByResource.get(resourceId)?.operations ?? [];
    resource.usage = {
      inferred: [...inferred],
      source: "static-analysis",
    };

    const allowed = Array.isArray(resource.allow) ? [...resource.allow].sort() : [...inferred];
    const outsideAllow = inferred.filter((operation) => !allowed.includes(operation));
    if (outsideAllow.length > 0) {
      diagnostics.push({
        code: "capability.allow.narrow-below-usage",
        severity: "error",
        resource: resourceId,
        allowedOperations: allowed,
        observedOperations: outsideAllow,
        message: `Resource ${resourceId} observes capability operations outside declared .allow().`,
      });
    }
  }

  const grants = [];
  for (const [componentId, resource] of Object.entries(nextManifest.resources ?? {})) {
    if (resource.type !== "component.v1") {
      continue;
    }

    for (const link of resource.links ?? []) {
      const target = nextManifest.resources?.[link.to];
      if (!target || target.type === "component.v1") {
        continue;
      }
      const inferred = target.usage?.inferred ?? [];
      const allowed = Array.isArray(target.allow) ? target.allow : inferred;
      const operations = inferred.filter((operation) => allowed.includes(operation)).sort();
      if (operations.length === 0) {
        continue;
      }
      grants.push({
        componentId,
        importInterface: link.import,
        resource: link.to,
        operations,
      });
    }
  }

  return Object.freeze({
    schema: "hobo.capability-enforcement/v1",
    ok: usage.ok && !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    canDeployDimension: "capabilityGrants",
    diagnostics: Object.freeze(diagnostics),
    manifest: deepFreeze(nextManifest),
    grants: Object.freeze(grants.map((grant) => Object.freeze({
      ...grant,
      operations: Object.freeze([...grant.operations]),
    }))),
  });
}

export function createCapabilityRuntime({ grants = [] } = {}) {
  return new CapabilityRuntime(grants);
}

class CapabilityRuntime {
  #components = new Map();
  #providers = new Map();
  #links = new Map();
  #grants = new Map();
  #handles = new WeakMap();
  #nextHandleId = 0;

  constructor(grants) {
    for (const grant of grants) {
      this.#grants.set(grantKey(grant.componentId, grant.importInterface), {
        resource: grant.resource,
        operations: new Set(grant.operations ?? []),
      });
    }
    this.events = [];
  }

  registerComponent(component) {
    assertId(component?.id, "component");
    this.#components.set(component.id, {
      id: component.id,
      imports: new Set(component.imports ?? []),
    });
  }

  registerProvider(provider) {
    assertId(provider?.id, "provider");
    this.#providers.set(provider.id, {
      id: provider.id,
      exports: provider.exports ?? {},
    });
  }

  link({ componentId, importInterface, providerId, exportInterface }) {
    const component = this.#requireComponent(componentId);
    if (!component.imports.has(importInterface)) {
      throw new CapabilityDeniedError("capability.import-not-declared", {
        componentId,
        importInterface,
      });
    }

    const provider = this.#requireProvider(providerId);
    if (!provider.exports[exportInterface]) {
      throw new CapabilityDeniedError("capability.export-not-found", {
        componentId,
        importInterface,
        providerId,
        exportInterface,
      });
    }

    const link = Object.freeze({
      componentId,
      importInterface,
      providerId,
      exportInterface,
      transport: "in-process",
      grantSource: "usage-inferred",
    });
    this.#links.set(grantKey(componentId, importInterface), link);
    this.events.push({ type: "link.Established", ...link });
    return link;
  }

  issueHandle({ componentId, importInterface }) {
    this.#requireComponent(componentId);
    const grant = this.#grants.get(grantKey(componentId, importInterface));
    if (!grant) {
      throw new CapabilityDeniedError("capability.no-inferred-grant", {
        componentId,
        importInterface,
      });
    }

    const handle = Object.freeze({
      componentId,
      importInterface,
      token: `cap-${++this.#nextHandleId}`,
    });
    this.#handles.set(handle, { componentId, importInterface, grant });
    return handle;
  }

  async callWithHandle(handle, operation, payload = {}) {
    const info = this.#handles.get(handle);
    if (!info) {
      throw new CapabilityDeniedError("capability.fabricated-handle", {});
    }

    const { componentId, importInterface, grant } = info;
    if (!grant.operations.has(operation)) {
      throw new CapabilityDeniedError("capability.operation-not-granted", {
        componentId,
        importInterface,
        operation,
        resource: grant.resource,
      });
    }

    const link = this.#links.get(grantKey(componentId, importInterface));
    if (!link) {
      throw new CapabilityDeniedError("capability.no-linked-route", {
        componentId,
        importInterface,
        operation,
        resource: grant.resource,
      });
    }

    const provider = this.#requireProvider(link.providerId);
    const implementation = provider.exports?.[link.exportInterface]?.[operation];
    if (!(implementation instanceof Function)) {
      throw new CapabilityDeniedError("capability.operation-not-found", {
        componentId,
        importInterface,
        operation,
        providerId: link.providerId,
        exportInterface: link.exportInterface,
      });
    }

    const result = await implementation(structuredClone(payload), {
      componentId,
      importInterface,
      operation,
      resource: grant.resource,
    });
    this.events.push({
      type: "link.Called",
      componentId,
      importInterface,
      providerId: link.providerId,
      exportInterface: link.exportInterface,
      operation,
      resource: grant.resource,
      grantSource: link.grantSource,
      transport: link.transport,
    });
    return structuredClone(result);
  }

  #requireComponent(componentId) {
    const component = this.#components.get(componentId);
    if (!component) {
      throw new CapabilityDeniedError("capability.component-not-registered", {
        componentId,
      });
    }
    return component;
  }

  #requireProvider(providerId) {
    const provider = this.#providers.get(providerId);
    if (!provider) {
      throw new CapabilityDeniedError("capability.provider-not-registered", {
        providerId,
      });
    }
    return provider;
  }
}

function parseBindlesImports(sourceText) {
  const named = new Map();
  const namespaces = new Set();

  for (const match of sourceText.matchAll(NAMED_BINDLES_IMPORT)) {
    for (const specifier of match[1].split(",")) {
      const [imported, local = imported] = specifier
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (FACTORY_NAMES.has(imported)) {
        named.set(local, imported);
      }
    }
  }

  for (const match of sourceText.matchAll(NAMESPACE_BINDLES_IMPORT)) {
    namespaces.add(match[1]);
  }

  return { named, namespaces };
}

function canonicalFactory({ qualifier, callee, imports }) {
  if (qualifier && imports.namespaces.has(qualifier) && FACTORY_NAMES.has(callee)) {
    return callee;
  }
  return imports.named.get(callee);
}

function isBindlesFactory(input) {
  return Boolean(canonicalFactory(input));
}

function parseAllowList(allowText = "") {
  return [...allowText.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function grantKey(componentId, importInterface) {
  return `${componentId}\0${importInterface}`;
}

function assertId(id, kind) {
  if (!isJsonString(id) || id.length === 0) {
    throw new Error(`capability.${kind}-id-required`);
  }
}

function findLineStarts(sourceText) {
  const starts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return high + 1;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
