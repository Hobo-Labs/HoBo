import { CollectionEngineError } from "./errors.js";
import {
  DEFAULT_COMPONENT_HOST,
  type CollectionInput,
  type ComponentHost,
  type CoverageEvaluator,
} from "./types.js";
import { isJsonString, isJsonObject } from "./json.js";

export interface CollectionInputSource {
  bindleId?: string;
  fileName?: string;
  sourceText?: string;
  componentHost?: { kind?: string; version?: string };
  define?: CollectionInput["define"];
  coverageEvaluator?: CoverageEvaluator;
}

export function parseCollectionInput(raw: CollectionInputSource): CollectionInput {
  if (!raw || !isJsonObject(raw)) {
    throw new CollectionEngineError("input", "must be an object");
  }
  if (!(raw.define instanceof Function)) {
    throw new CollectionEngineError("define", "must be a function");
  }

  let componentHost: ComponentHost = DEFAULT_COMPONENT_HOST;
  if (raw.componentHost !== undefined) {
    if (!raw.componentHost || !isJsonObject(raw.componentHost)) {
      throw new CollectionEngineError("componentHost", "must be an object");
    }
    const host = raw.componentHost;
    if (!isJsonString(host.kind) || host.kind.length === 0) {
      throw new CollectionEngineError("componentHost.kind", "required");
    }
    if (!isJsonString(host.version) || host.version.length === 0) {
      throw new CollectionEngineError("componentHost.version", "required");
    }
    componentHost = Object.freeze({
      kind: host.kind,
      version: host.version,
    });
  }

  return Object.freeze({
    bindleId: isJsonString(raw.bindleId) ? raw.bindleId : "bindle",
    fileName: isJsonString(raw.fileName) ? raw.fileName : "bindle.ts",
    sourceText: isJsonString(raw.sourceText) ? raw.sourceText : "",
    componentHost,
    define: raw.define,
    coverageEvaluator:
      raw.coverageEvaluator instanceof Function ? raw.coverageEvaluator : undefined,
  });
}
