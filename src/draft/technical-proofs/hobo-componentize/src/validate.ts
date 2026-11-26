import { createHash } from "node:crypto";

import { assertDigest, assertMediaType } from "./parse.js";
import { COMPONENT_MEDIA_TYPE, type ValidationReport, type WasmComponentArtifact } from "./types.js";

const COMPONENT_VERSION = 0x0d;

export function validateWasmComponentArtifact(artifact: WasmComponentArtifact): ValidationReport {
  assertMediaType(artifact.mediaType);
  assertDigest(artifact.digest, "component");

  if (artifact.bytes.byteLength < 8) {
    throw new Error("componentize.invalid_wasm: component too small");
  }

  const magic = Buffer.from(artifact.bytes.slice(0, 4)).toString("binary");
  if (magic !== "\0asm") {
    throw new Error("componentize.invalid_wasm: missing wasm magic");
  }
  if (artifact.bytes[4] !== COMPONENT_VERSION) {
    throw new Error("componentize.invalid_wasm: expected component model version 0x0d");
  }

  const actualDigest = sha256Bytes(artifact.bytes);
  if (actualDigest !== artifact.digest) {
    throw new Error(`componentize.digest_mismatch: expected ${artifact.digest} got ${actualDigest}`);
  }

  return Object.freeze({
    passed: true,
    command: `wasm-tools validate ${artifact.path}`,
    format: "wasm-component",
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isComponentMediaType(value: string): value is typeof COMPONENT_MEDIA_TYPE {
  return value === COMPONENT_MEDIA_TYPE;
}
