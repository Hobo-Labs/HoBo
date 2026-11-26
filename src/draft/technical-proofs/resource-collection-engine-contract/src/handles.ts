import { CollectionEngineError } from "./errors.js";
import type {
  CatalogEntry,
  CollectionState,
  ResolvedResource,
  ResourceHandle,
  ResourceRecord,
} from "./types.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const COMPONENT_FACTORIES = new Set(["api", "web", "service", "job"]);
export const DEFAULT_EXPORTS_BY_FACTORY = Object.freeze({
  api: ["wasi:http/incoming-handler"],
  web: ["wasi:http/incoming-handler"],
  service: ["wasi:http/incoming-handler"],
  job: ["hobo:job/handler"],
});
export const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export function assertResourceName(name: JsonValue, path: string): asserts name is string {
  if (!isJsonString(name) || !RESOURCE_ID.test(name)) {
    throw new CollectionEngineError(path, "invalid resource id");
  }
}

export function resolveResourceHandle(
  handle: ResourceHandle | JsonObject,
  path: string,
): ResolvedResource {
  if (!handle || !isJsonObject(handle)) {
    throw new CollectionEngineError(path, "must reference a collected resource handle");
  }
  const name = handle.name;
  const port = handle.port;
  const kind = handle.kind;
  if (!isJsonString(name) || !isJsonString(port)) {
    throw new CollectionEngineError(path, "must reference a collected resource handle");
  }
  return {
    kind: isJsonString(kind) ? kind : String(kind),
    name,
    port,
  };
}

export function recordBindEdge(
  state: CollectionState,
  from: { name: string },
  to: ResolvedResource,
): void {
  const key = `${from.name}->${to.name}`;
  if (state.bindEdges.some((edge) => edge.key === key)) {
    return;
  }
  state.bindEdges.push({
    from: from.name,
    to: to.name,
    key,
    import: to.port,
  });
}

export function declareResource(
  state: CollectionState,
  entry: CatalogEntry,
  name: string,
  options: { bind?: JsonObject } = {},
): ResourceHandle {
  assertResourceName(name, `${entry.factory}.name`);
  if (state.resources.has(name)) {
    throw new CollectionEngineError(`resources.${name}`, "duplicate resource id");
  }

  const record: ResourceRecord = {
    kind: entry.factory,
    name,
    stableId: `${entry.factory}:${name}`,
    port: entry.portRef[0] ?? "",
    portRef: [...entry.portRef],
    usedVerbs: new Set(),
    routes: [],
    bindAliases: new Map(),
  };
  state.resources.set(name, record);

  for (const [alias, target] of Object.entries(options.bind ?? {})) {
    const targetRecord = resolveResourceHandle(
      target,
      `${entry.factory}.${name}.bind.${alias}`,
    );
    record.bindAliases.set(alias, targetRecord);
    recordBindEdge(state, record, targetRecord);
  }

  return createHandle(record, entry);
}

export function createHandle(
  record: ResourceRecord,
  entry: CatalogEntry,
): ResourceHandle {
  const handle: ResourceHandle = {
    kind: record.kind,
    name: record.name,
    stableId: record.stableId,
    port: record.port,
    route(method: string, path: string, handler?: () => void) {
      if (!COMPONENT_FACTORIES.has(record.kind)) {
        throw new CollectionEngineError(
          `resources.${record.name}.route`,
          "routes are only valid on component resources",
        );
      }
      record.routes.push({
        method: String(method).toUpperCase(),
        path: String(path),
      });
      if (handler instanceof Function) {
        handler();
      }
      return handle;
    },
    allow(...verbs: string[]) {
      for (const verb of verbs) {
        if (!entry.allowVerbs.includes(verb)) {
          throw new CollectionEngineError(
            `resources.${record.name}.allow`,
            `${record.kind} does not allow verb ${verb}`,
          );
        }
      }
      for (const verb of verbs) {
        record.usedVerbs.add(verb);
      }
      return handle;
    },
  };

  for (const verb of entry.allowVerbs) {
    handle[verb] = (...args: JsonValue[]) => {
      record.usedVerbs.add(verb);
      return Object.freeze({
        lowersTo: "hobo:sdk",
        kind: record.kind,
        name: record.name,
        handleStableId: record.stableId,
        portRef: Object.freeze([...record.portRef]),
        verb,
        args: Object.freeze([...args]),
      });
    };
  }

  return Object.freeze(handle);
}

export function clientTypeFor(kind: string): string {
  return `${kind[0].toUpperCase()}${kind.slice(1)}Client`;
}
