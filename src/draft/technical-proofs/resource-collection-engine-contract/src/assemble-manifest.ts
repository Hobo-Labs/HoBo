import {
  COMPONENT_FACTORIES,
  DEFAULT_EXPORTS_BY_FACTORY,
  clientTypeFor,
} from "./handles.js";
import type { ComponentHost, ResourceRecord } from "./types.js";
import { isJsonObject, type JsonBag, type JsonObject } from "./json.js";

const factoryExports: { readonly [factory: string]: readonly string[] } = DEFAULT_EXPORTS_BY_FACTORY;

function omitEmpty(value: JsonObject): JsonObject {
  const bag: JsonBag = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (isJsonObject(entry) && Object.keys(entry).length === 0) continue;
    if (entry === undefined) continue;
    bag[key] = entry;
  }
  return bag;
}

function manifestResource(record: ResourceRecord): JsonObject {
  if (COMPONENT_FACTORIES.has(record.kind)) {
    const links = [...record.bindAliases.values()].map((target) => ({
      import: target.port,
      to: target.name,
    }));
    return omitEmpty({
      type: "component.v1",
      kind: record.kind,
      runtime: "wasm",
      exports: factoryExports[record.kind] ?? [],
      links,
      routes: record.routes,
      bindings: Object.fromEntries(
        [...record.bindAliases.entries()].map(([alias, target]) => [
          alias,
          {
            port: target.port,
            resource: target.name,
            clientType: clientTypeFor(target.kind),
          },
        ]),
      ),
      collection: {
        stableId: record.stableId,
      },
    });
  }

  const inferred = [...record.usedVerbs].sort();
  return {
    type: "data.v1",
    port: record.port,
    kind: record.kind,
    allow: inferred,
    usage: {
      inferred,
      source: "run-to-collect",
    },
    collection: {
      stableId: record.stableId,
    },
  };
}

export function assembleManifest({
  componentHost,
  resources,
}: {
  componentHost: ComponentHost;
  resources: Map<string, ResourceRecord>;
}): JsonObject {
  return {
    schema: "hobo.manifest/v1",
    componentHost,
    resources: Object.fromEntries(
      [...resources.values()].map((record) => [record.name, manifestResource(record)]),
    ),
  };
}
