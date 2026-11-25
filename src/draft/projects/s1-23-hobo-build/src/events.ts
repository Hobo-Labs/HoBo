import { createHash } from "node:crypto";

import type { BuildArtifact, BuildManifest, TargetRuntime } from "./parse.js";
import { BUILD_MANIFEST_SCHEMA } from "./parse.js";
import { isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "./json.js";


export type BuildStartedEvent = {
  readonly type: "build.Started";
  readonly runtimeTarget: TargetRuntime;
  readonly sourceDateEpoch: string;
};

export type BuildArtifactProducedEvent = {
  readonly type: "build.ArtifactProduced";
  readonly service: string;
  readonly artifact: BuildArtifact;
};

export type BuildCompletedEvent = {
  readonly type: "build.Completed";
  readonly manifestDigest: string;
};

export type BuildFailedEvent = {
  readonly type: "build.Failed";
  readonly code: string;
  readonly message: string;
};

export type BuildEvent =
  | BuildStartedEvent
  | BuildArtifactProducedEvent
  | BuildCompletedEvent
  | BuildFailedEvent;

export function appendEvent(events: readonly BuildEvent[], event: BuildEvent): BuildEvent[] {
  return [...events, event];
}

export function projectBuildManifest(
  events: readonly BuildEvent[],
  runtimeTarget: TargetRuntime,
  sourceDateEpoch: string,
): BuildManifest {
  const artifacts = events
    .filter((event): event is BuildArtifactProducedEvent => event.type === "build.ArtifactProduced")
    .map((event) => event.artifact);

  return {
    schema: BUILD_MANIFEST_SCHEMA,
    generatedBy: "hobo build",
    runtimeTarget,
    sourceDateEpoch,
    artifacts,
  };
}

export function stableStringify(value: JsonValue): string {
  return `${JSON.stringify(value, replacer)}\n`;

  function replacer(this: JsonObject, key: string, inner: JsonValue): JsonValue {
    if (inner && isJsonObject(inner) && !Array.isArray(inner)) {
      const sorted: JsonBag = {};
      for (const childKey of Object.keys(inner).sort()) {
        sorted[childKey] = inner[childKey] ?? null;
      }
      return sorted;
    }
    return inner;
  }
}

export function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(normalizeText(value), "utf8").digest("hex")}`;
}

export function sha256Bytes(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeText(value: string): string {
  return `${String(value).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/u, "")}\n`;
}
