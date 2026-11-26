import { createHash } from "node:crypto";
import { isJsonObject } from "./json.js";


export const BUILD_WASM_PROVIDER_ID = "@hobo/build-wasm";
export const BUILD_SPEC_VERSION = "hobo.buildSpec/v1";
export const COMPONENT_MEDIA_TYPE = "application/vnd.wasm.component.v1+wasm";

export const PINNED_WASM_TOOLCHAIN = Object.freeze({
  jco: "1.24.3",
  componentizeJs: "0.21.0",
  wasmTools: "1.235.0",
  cargoComponent: "0.21.1",
  tinygo: "0.36.0",
  digests: Object.freeze({
    jco: "sha256:4db7465bc949508edb46cadb2dddb2f8da3a8afec4f3c07e0a0f1fda47b0b83d",
    componentizeJs: "sha256:99b3e95fbd63feefb4e2c4d9658cb91ace05696b0fb6c9ef90431c3ea9705abe",
    wasmTools: "sha256:c9ee74cb4ba4436d705b17d9487cb60bd44f31c6c06707a32af42213265863e3",
    cargoComponent: "sha256:56d1085cdb88063df4e1c4fd4d2f36c3b2c6182d749176c146498c9e8c37f405",
    tinygo: "sha256:6b0c9c9cb7466ab23d7de6b9e4f7c9482d7d3434f687b1df0b2f0768346b0d7a",
  }),
});

const REGISTERED_TOOLCHAINS = Object.freeze({
  typescript: Object.freeze({
    id: "jco+componentize-js",
    pins: Object.freeze(["jco", "componentizeJs", "wasmTools"]),
  }),
  rust: Object.freeze({
    id: "cargo-component",
    pins: Object.freeze(["cargoComponent", "wasmTools"]),
  }),
  tinygo: Object.freeze({
    id: "tinygo",
    pins: Object.freeze(["tinygo", "wasmTools"]),
  }),
});

const DEFAULT_WIT_WORLD = "hobo:examples/hello-bindle@0.1.0/service";
const WASM_MAGIC = Object.freeze([0x00, 0x61, 0x73, 0x6d]);
const WASM_COMPONENT_VERSION = Object.freeze([0x0d, 0x00, 0x01, 0x00]);
const COMPONENT_MARKER_SECTION = "hobo.component";

export class BuildWasmError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BuildWasmError";
    this.code = code;
    this.details = details;
  }
}

export function createFixtureWasmBuildSpec(overrides = {}) {
  const base = {
    apiVersion: BUILD_SPEC_VERSION,
    id: "api-image",
    target: "wasm-component",
    outputKind: "ImageRef",
    source: {
      path: "services/api",
      language: "typescript",
      entrypoint: "src/service.ts",
      witWorld: DEFAULT_WIT_WORLD,
    },
    toolchain: PINNED_WASM_TOOLCHAIN,
    sourceDateEpoch: "2026-01-01T00:00:00.000Z",
    sizeBudgetBytes: 1024 * 1024,
    registry: "oci://registry.example/hobo",
    iacProgramRef: {
      nodeId: "api",
      inputPath: "inputs.image",
    },
  };

  return deepFreeze({
    ...base,
    ...overrides,
    source: {
      ...base.source,
      ...overrides.source,
    },
    toolchain: {
      ...base.toolchain,
      ...overrides.toolchain,
      digests: {
        ...base.toolchain.digests,
        ...overrides.toolchain?.digests,
      },
    },
  });
}

export function createBuildWasmProvider({ componentizer = defaultComponentizer } = {}) {
  return deepFreeze({
    id: BUILD_WASM_PROVIDER_ID,
    async build(spec) {
      const normalized = validateBuildSpec(spec);
      const languageToolchain = REGISTERED_TOOLCHAINS[normalized.source.language];
      const result = await componentizer(normalized);
      const bytes = toBuffer(result?.bytes);

      if (bytes.byteLength > normalized.sizeBudgetBytes) {
        throw new BuildWasmError(
          "component-size-budget-exceeded",
          `component size ${bytes.byteLength} exceeds budget ${normalized.sizeBudgetBytes}`,
          { size: bytes.byteLength, budget: normalized.sizeBudgetBytes },
        );
      }
      const componentMetadata = parseWasmComponentMetadata(bytes);
      if (
        !componentMetadata ||
        componentMetadata.schema !== "hobo.build-wasm.component/v1" ||
        componentMetadata.componentModel !== "wit-component" ||
        componentMetadata.witWorld !== normalized.source.witWorld ||
        componentMetadata.languageToolchain !== languageToolchain.id
      ) {
        throw new BuildWasmError(
          "invalid-component",
          "componentizer produced bytes that do not validate as a hobo wasm component",
        );
      }

      const componentDigest = sha256Bytes(bytes);
      const component = {
        mediaType: COMPONENT_MEDIA_TYPE,
        digest: componentDigest,
        size: bytes.byteLength,
        componentModel: componentMetadata.componentModel,
        witWorld: normalized.source.witWorld,
      };
      const sourceDigest = sha256Text(canonicalJson(normalized.source));
      const manifest = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        artifactType: COMPONENT_MEDIA_TYPE,
        config: {
          mediaType: "application/vnd.hobo.build-wasm.config.v1+json",
          digest: sha256Text(
            canonicalJson({
              artifactId: normalized.id,
              sourceDigest,
              toolchain: normalized.toolchain,
              languageToolchain: languageToolchain.id,
              target: normalized.target,
            }),
          ),
        },
        layers: [
          {
            mediaType: COMPONENT_MEDIA_TYPE,
            digest: componentDigest,
            size: bytes.byteLength,
          },
        ],
        annotations: {
          "dev.hobo.build.provider": BUILD_WASM_PROVIDER_ID,
          "dev.hobo.source.path": normalized.source.path,
          "dev.hobo.wit.world": normalized.source.witWorld,
        },
      };
      const manifestDigest = sha256Text(canonicalJson(manifest));
      const ref = `${normalized.registry}/${normalized.id}@${manifestDigest}`;

      return deepFreeze({
        kind: "ImageRef",
        apiVersion: "hobo.imageRef/v1",
        provider: BUILD_WASM_PROVIDER_ID,
        artifactId: normalized.id,
        ref,
        digest: manifestDigest,
        component,
        manifest,
        provenance: {
          builder: BUILD_WASM_PROVIDER_ID,
          sourceDigest,
          sourceDateEpoch: normalized.sourceDateEpoch,
          languageToolchain: languageToolchain.id,
          toolchain: normalized.toolchain,
          reproducibility: [
            "SOURCE_DATE_EPOCH",
            "canonical source descriptor",
            "pinned wasm toolchain",
            "content-addressed OCI manifest",
          ],
        },
      });
    },
  });
}

export async function runBuildWasmConformance(provider, { wireImageRef } = {}) {
  const coverage = [
    "build.wasm-component",
    "image-ref.reproducible",
    "image-ref.iac-wireback",
    "target.fail-closed",
  ];
  const failures = [];
  const spec = createFixtureWasmBuildSpec();

  if (provider?.id !== BUILD_WASM_PROVIDER_ID || !(provider?.build instanceof Function)) {
    throw new BuildWasmError("conformance-failed", "provider does not expose the @hobo/build-wasm shape");
  }

  const first = await provider.build(spec);
  const second = await provider.build(spec);
  if (first.ref !== second.ref || first.component.digest !== second.component.digest) {
    throw new BuildWasmError("non-reproducible-build", "same BuildSpec produced different ImageRefs", {
      first: first.ref,
      second: second.ref,
    });
  }
  if (first.kind !== "ImageRef" || first.artifactId !== spec.id || first.component.mediaType !== COMPONENT_MEDIA_TYPE) {
    failures.push("build did not return a wasm-component ImageRef for the requested artifact");
  }
  if (!(wireImageRef instanceof Function)) {
    failures.push("conformance did not receive an IacProgram wire-back hook");
  } else {
    const wireBack = await wireImageRef(first, spec);
    if (!wireBack?.accepted || wireBack.imageRef !== first.ref) {
      failures.push("ImageRef did not wire back into the fixture provider IacProgram");
    }
  }

  try {
    await provider.build(createFixtureWasmBuildSpec({ target: "container" }));
    failures.push("provider accepted non-wasm target container");
  } catch (error) {
    if (!(error instanceof BuildWasmError) || error.code !== "unsupported-target") {
      throw error;
    }
  }

  if (failures.length > 0) {
    throw new BuildWasmError("conformance-failed", failures.join("; "), { failures });
  }

  return deepFreeze({
    passed: true,
    coverage,
    failures,
  });
}

function validateBuildSpec(spec) {
  if (!spec || !isJsonObject(spec)) {
    throw new BuildWasmError("invalid-build-spec", "BuildSpec must be an object");
  }
  if (spec.apiVersion !== BUILD_SPEC_VERSION) {
    throw new BuildWasmError("invalid-build-spec", `BuildSpec apiVersion must be ${BUILD_SPEC_VERSION}`);
  }
  if (!spec.id) {
    throw new BuildWasmError("invalid-build-spec", "BuildSpec id is required");
  }
  if (spec.target !== "wasm-component") {
    throw new BuildWasmError("unsupported-target", `target ${spec.target} is not wasm-component`);
  }
  if (spec.outputKind !== "ImageRef") {
    throw new BuildWasmError("invalid-build-spec", "build-wasm emits ImageRef output only");
  }
  const language = spec.source?.language;
  if (!REGISTERED_TOOLCHAINS[language]) {
    throw new BuildWasmError("missing-toolchain", `no wasm toolchain registered for ${language ?? "unknown"}`);
  }
  if (!spec.source?.path) {
    throw new BuildWasmError("invalid-build-spec", "source.path is required");
  }
  if (!spec.source?.witWorld) {
    throw new BuildWasmError("invalid-build-spec", "source.witWorld is required");
  }
  if (!spec.sourceDateEpoch || Number.isNaN(Date.parse(spec.sourceDateEpoch))) {
    throw new BuildWasmError("invalid-build-spec", "sourceDateEpoch must be an ISO timestamp");
  }
  if (!Number.isInteger(spec.sizeBudgetBytes) || spec.sizeBudgetBytes <= 0) {
    throw new BuildWasmError("invalid-build-spec", "sizeBudgetBytes must be a positive integer");
  }

  const languageToolchain = REGISTERED_TOOLCHAINS[language];
  for (const name of languageToolchain.pins) {
    const expected = PINNED_WASM_TOOLCHAIN[name];
    const actual = spec.toolchain?.[name];
    if (actual !== expected) {
      throw new BuildWasmError("toolchain-drift", `${name} expected ${expected} got ${actual ?? "missing"}`);
    }
  }
  for (const name of languageToolchain.pins) {
    const expected = PINNED_WASM_TOOLCHAIN.digests[name];
    const actual = spec.toolchain?.digests?.[name];
    if (actual !== expected) {
      throw new BuildWasmError(
        "toolchain-drift",
        `${name} digest expected ${expected} got ${actual ?? "missing"}`,
      );
    }
  }

  return deepFreeze(structuredClone(spec));
}

async function defaultComponentizer(spec) {
  const languageToolchain = REGISTERED_TOOLCHAINS[spec.source.language];
  const metadata = canonicalJson({
    schema: "hobo.build-wasm.component/v1",
    componentModel: "wit-component",
    artifactId: spec.id,
    witWorld: spec.source.witWorld,
    languageToolchain: languageToolchain.id,
    source: spec.source,
    sourceDateEpoch: spec.sourceDateEpoch,
    toolchain: spec.toolchain,
  });

  return {
    bytes: buildValidWasmComponentBytes(metadata),
  };
}

function buildValidWasmComponentBytes(customData) {
  const header = Buffer.from([...WASM_MAGIC, ...WASM_COMPONENT_VERSION]);
  const name = Buffer.from(COMPONENT_MARKER_SECTION, "utf8");
  const data = Buffer.from(customData, "utf8");
  const payload = Buffer.concat([encodeU32(name.byteLength), name, data]);
  return Buffer.concat([header, Buffer.from([0x00]), encodeU32(payload.byteLength), payload]);
}

function parseWasmComponentMetadata(bytes) {
  if (!hasPrefix(bytes, WASM_MAGIC, 0) || !hasPrefix(bytes, WASM_COMPONENT_VERSION, 4)) {
    return null;
  }

  let offset = 8;
  while (offset < bytes.byteLength) {
    const sectionId = bytes[offset++];
    const sectionSize = decodeU32(bytes, offset);
    if (!sectionSize) return null;

    offset = sectionSize.offset;
    const sectionEnd = offset + sectionSize.value;
    if (sectionEnd > bytes.byteLength) return null;

    if (sectionId !== 0) {
      offset = sectionEnd;
      continue;
    }

    const nameSize = decodeU32(bytes, offset);
    if (!nameSize) return null;

    offset = nameSize.offset;
    const nameEnd = offset + nameSize.value;
    if (nameEnd > sectionEnd) return null;

    const name = bytes.subarray(offset, nameEnd).toString("utf8");
    const data = bytes.subarray(nameEnd, sectionEnd).toString("utf8");
    if (name !== COMPONENT_MARKER_SECTION) {
      offset = sectionEnd;
      continue;
    }

    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  return null;
}

function decodeU32(bytes, offset) {
  let result = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, offset: cursor };
    }
    shift += 7;
    if (shift > 28) return null;
  }

  return null;
}

function hasPrefix(bytes, prefix, offset) {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new BuildWasmError("invalid-component", "componentizer must return component bytes");
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value) || Buffer.isBuffer(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value) || ArrayBuffer.isView(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
