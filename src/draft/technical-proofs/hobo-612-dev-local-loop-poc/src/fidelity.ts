import type { FidelityLabel } from "./types.js";
import { isJsonString } from "./json.js";


const REAL_KINDS = new Set(["api", "service", "web", "websocket", "ui"]);
const SIMULATED_KINDS = new Set([
  "kv",
  "bucket",
  "queue",
  "topic",
  "data",
  "schedule",
  "flag",
  "experiment",
  "golden",
]);
const MOCKED_KINDS = new Set(["secret", "auth", "crypto", "notify", "guardrail"]);

export interface FidelityReport {
  labels: Record<string, FidelityLabel>;
}

export function fidelityLabels(
  resources: Array<{ kind: string; name: string }>,
  campOnlyCapabilities: string[] = [],
): FidelityReport {
  const labels: Record<string, FidelityLabel> = {};
  for (const resource of resources) {
    labels[resource.name] = fidelityClassFor(resource.kind);
  }
  for (const capability of campOnlyCapabilities) {
    if (!isJsonString(capability) || capability.length === 0) {
      throw new TypeError("campOnlyCapabilities[] must be non-empty strings");
    }
    labels[capability] = "camp-only";
  }
  return { labels };
}

function fidelityClassFor(kind: string): FidelityLabel {
  if (REAL_KINDS.has(kind)) return "real";
  if (SIMULATED_KINDS.has(kind)) return "simulated";
  if (MOCKED_KINDS.has(kind)) return "mocked";
  return "camp-only";
}
