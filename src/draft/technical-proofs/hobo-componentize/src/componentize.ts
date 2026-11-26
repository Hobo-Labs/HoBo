import { createHash } from "node:crypto";

import { COMPONENT_MEDIA_TYPE, DEFAULT_CI_MATRIX, type ComponentizeSpec, type ComponentizeResult } from "./types.js";
import { inputsDigest, prepareSources, transpileEntry } from "./sources.js";

export async function componentizeService(spec: ComponentizeSpec): Promise<ComponentizeResult> {
  const prepared = await prepareSources(spec);
  await transpileEntry(spec, prepared);

  const { componentize } = await import("@bytecodealliance/componentize-js");
  const epochSeconds = sourceDateEpochSeconds(spec.sourceDateEpoch);
  const output = await componentize({
    sourcePath: prepared.entryJsPath,
    witPath: spec.witDir,
    worldName: spec.worldName,
    disableFeatures: ["random", "clocks", "stdio", "http"],
    env: {
      SOURCE_DATE_EPOCH: epochSeconds,
    },
  });

  const bytes = output.component;
  const digest = sha256Bytes(bytes);
  const witWorld = `hobo:examples/${spec.worldName}@0.1.0`;
  const component = Object.freeze({
    path: `dist/${spec.name}.component.wasm`,
    mediaType: COMPONENT_MEDIA_TYPE,
    digest,
    bytes,
    witWorld,
  });

  const { buildOciDescriptor } = await import("./oci.js");
  const oci = buildOciDescriptor(component, spec.name);

  const reproducibility = Object.freeze({
    controls: Object.freeze([
      "SOURCE_DATE_EPOCH",
      "sorted source file list",
      "workspace path remap",
      "pinned jco/componentize-js/wasm-tools/wasmtime versions",
    ]),
    inputsDigest: inputsDigest(spec, prepared.sources, prepared.pathRemap),
    sourceDigests: prepared.sources,
  });

  return Object.freeze({
    component,
    oci,
    reproducibility,
    ciMatrix: DEFAULT_CI_MATRIX,
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sourceDateEpochSeconds(sourceDateEpoch: string): string {
  const trimmed = sourceDateEpoch.trim();
  if (/^\d+$/u.test(trimmed)) {
    return trimmed;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid sourceDateEpoch: ${sourceDateEpoch}`);
  }
  return Math.floor(parsed / 1000).toString();
}
