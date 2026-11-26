import { createHash } from "node:crypto";

import { sortKeys } from "./sort-keys.js";
import type { CollectionEvent, CoverageSummary } from "./types.js";
import { type JsonValue, type JsonObject } from "./json.js";


function stableDigest(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function createFact(
  type: CollectionEvent["type"],
  data: JsonObject,
  seq: 1 | 2,
): CollectionEvent {
  return {
    id: `evt-${stableDigest({ type, data }).slice(0, 12)}`,
    type,
    seq,
    source: "hobo.collector",
    data,
  };
}

export function createCollectionEvents({
  bindleId,
  manifest,
  manifestHash,
  observedResourceIds,
  observedBindKeys,
  coverage,
}: {
  bindleId: string;
  manifest: JsonObject;
  manifestHash: string;
  observedResourceIds: string[];
  observedBindKeys: string[];
  coverage: CoverageSummary;
}): CollectionEvent[] {
  const collectedData = {
    bindleId,
    resources: observedResourceIds,
    binds: observedBindKeys,
    coverage: {
      status: coverage.status,
      diagnostics: coverage.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        resourceId: diagnostic.resourceId,
        bindKey: diagnostic.bindKey,
      })),
    },
  };
  const producedData = {
    bindleId,
    manifestHash,
    manifest,
  };

  return [
    createFact("bindle.ResourcesCollected", collectedData, 1),
    createFact("bindle.ManifestProduced", producedData, 2),
  ];
}
