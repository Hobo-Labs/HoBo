import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPONENT_MEDIA_TYPE,
  PINNED_TOOLCHAIN,
  type ComponentizeSpec,
  type ToolchainPin,
} from "./types.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


const jcoVersion = pkgVersion("@bytecodealliance/jco");
const componentizeJsVersion = pkgVersion("@bytecodealliance/componentize-js");

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function parseComponentizeSpec(raw: JsonValue): ComponentizeSpec {
  if (!raw || !isJsonObject(raw)) {
    throw new Error("componentize.invalid_spec: expected object");
  }

  // SAFETY: `const value = raw as JsonObject;` is required at this I/O or test boundary.
  const value = raw as JsonObject;
  const name = readString(value, "name");
  const sourceRoot = readString(value, "sourceRoot");
  const entrypoint = readString(value, "entrypoint");
  const witDir = readString(value, "witDir");
  const worldName = readString(value, "worldName");
  const sourceDateEpoch = readString(value, "sourceDateEpoch");
  const toolchain = parseToolchainPin(value.toolchain);

  if (!name) {
    throw new Error("componentize.invalid_spec: name required");
  }
  if (!entrypoint.startsWith("src/") || !entrypoint.endsWith(".ts")) {
    throw new Error("componentize.invalid_spec: entrypoint must be src/**/*.ts");
  }
  if (!isValidSourceDateEpoch(sourceDateEpoch)) {
    throw new Error("componentize.invalid_source_date_epoch");
  }

  assertRuntimeToolchain(toolchain);

  return Object.freeze({
    name,
    sourceRoot,
    entrypoint,
    witDir,
    worldName,
    sourceDateEpoch,
    toolchain,
  });
}

function parseToolchainPin(raw: JsonValue): ToolchainPin {
  if (!raw || !isJsonObject(raw)) {
    throw new Error("componentize.invalid_spec: toolchain required");
  }

  // SAFETY: `const value = raw as JsonObject;` is required at this I/O or test boundary.
  const value = raw as JsonObject;
  const toolchain = Object.freeze({
    jco: readString(value, "jco"),
    componentizeJs: readString(value, "componentizeJs"),
    wasmTools: readString(value, "wasmTools"),
    wasmtime: readString(value, "wasmtime"),
  });

  for (const [key, expected] of Object.entries(PINNED_TOOLCHAIN)) {
    // SAFETY: `const actual = toolchain[key as keyof ToolchainPin];` is required at this I/O or test boundary.
    const actual = toolchain[key as keyof ToolchainPin];
    if (actual !== expected) {
      throw new Error(`componentize.toolchain_skew: ${key} expected ${expected} got ${actual}`);
    }
  }

  // Equality check above proves the parsed pins match the literals in ToolchainPin.
  return PINNED_TOOLCHAIN;
}

function assertRuntimeToolchain(toolchain: ToolchainPin) {
  if (jcoVersion !== toolchain.jco) {
    throw new Error(`componentize.toolchain_skew: jco expected ${toolchain.jco} got ${jcoVersion}`);
  }
  if (componentizeJsVersion !== toolchain.componentizeJs) {
    throw new Error(
      `componentize.toolchain_skew: componentizeJs expected ${toolchain.componentizeJs} got ${componentizeJsVersion}`,
    );
  }
}

export function assertDigest(value: string, label: string) {
  if (!DIGEST_PATTERN.test(value)) {
    throw new Error(`componentize.invalid_spec: ${label} digest invalid`);
  }
}

export function assertMediaType(value: string) {
  if (value !== COMPONENT_MEDIA_TYPE) {
    throw new Error(`componentize.invalid_spec: media type must be ${COMPONENT_MEDIA_TYPE}`);
  }
}

function readString(value: JsonObject, key: string): string {
  const candidate = value[key];
  if (!isJsonString(candidate) || candidate.length === 0) {
    throw new Error(`componentize.invalid_spec: ${key} required`);
  }
  return candidate;
}

function isValidSourceDateEpoch(sourceDateEpoch: string): boolean {
  const trimmed = sourceDateEpoch.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number.isFinite(Number(trimmed));
  }
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/u.test(trimmed) && !Number.isNaN(Date.parse(trimmed));
}

function pkgVersion(name: string): string {
  const packageRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    ...name.split("/"),
  );
  const packageJsonPath = join(packageRoot, "package.json");
  // SAFETY: `const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {` is required at this I/O or test boundary.
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: string;
    version?: string;
  };
  if (parsed.name !== name || !parsed.version) {
    throw new Error(`componentize.toolchain_skew: unable to resolve runtime version for ${name}`);
  }
  return parsed.version;
}
