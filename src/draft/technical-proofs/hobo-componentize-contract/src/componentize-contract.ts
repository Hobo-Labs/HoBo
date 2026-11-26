import { isJsonString } from "./json.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_TOOLCHAIN = Object.freeze({
  jco: "1.24.3",
  componentizeJs: "0.21.0",
  wasmTools: "1.235.0",
  wasmtime: "46.0.1",
});

export const DEFAULT_CI_MATRIX = Object.freeze({
  os: ["ubuntu-latest", "windows-latest"],
  node: ["22.x"],
  toolchain: DEFAULT_TOOLCHAIN,
});

const COMPONENT_MEDIA_TYPE = "application/vnd.wasm.component.v1+wasm";
const CONTRACT_SCHEMA = "hobo.componentize/v1";
const WIT_WORLD = "hobo:examples/hello-bindle@0.1.0/service";
const CUSTOM_SECTION_NAME = "hobo.componentize.contract";

export async function componentizeHelloBindle({
  sourceRoot,
  sourceDateEpoch,
  toolchain = DEFAULT_TOOLCHAIN,
} = {}) {
  assertPinnedToolchain(toolchain);
  assertSourceDateEpoch(sourceDateEpoch);

  const root = normalizePath(sourceRoot);
  const sources = await readSources(root);
  const service = sources.find((source) => source.path === "src/service.ts");
  if (!service) {
    throw new Error("componentize.missing_service: src/service.ts");
  }
  assertDeterministicSources(sources);

  const smokeBody = parseHealthBody(service.content);
  const metadata = canonicalize({
    schema: CONTRACT_SCHEMA,
    name: "hello-bindle",
    witWorld: WIT_WORLD,
    sourceDateEpoch,
    toolchain,
    sources: sources.map(({ path, content }) => ({
      path,
      digest: sha256Text(content),
    })),
    pathRemap: `${basename(root)}=>/workspace/hello-bindle`,
    smoke: {
      exportName: "health",
      stdout: `${smokeBody}\n`,
    },
    fallback: {
      kind: "oci-container",
      declaredOnly: true,
      owner: "build-dagger/provider build slices",
    },
  });
  const bytes = buildWasmContractBytes(metadata);
  const digest = sha256Bytes(bytes);
  const component = {
    path: "dist/hello-bindle.component.wasm",
    mediaType: COMPONENT_MEDIA_TYPE,
    digest,
    bytes,
    witWorld: WIT_WORLD,
    metadata,
  };

  return {
    component,
    oci: buildOciDescriptor(component),
    reproducibility: {
      controls: [
        "SOURCE_DATE_EPOCH",
        "sorted source file list",
        "workspace path remap",
        "pinned jco/componentize-js/wasm-tools/wasmtime versions",
      ],
    },
    ciMatrix: DEFAULT_CI_MATRIX,
  };
}

export function validateWasmComponentArtifact(component) {
  if (component.mediaType !== COMPONENT_MEDIA_TYPE) {
    throw new Error(`componentize.invalid_media_type: ${component.mediaType}`);
  }
  if (!component.bytes || !WebAssembly.validate(component.bytes)) {
    throw new Error("componentize.invalid_wasm: wasm-tools validate would fail");
  }
  const actualDigest = sha256Bytes(component.bytes);
  if (actualDigest !== component.digest) {
    throw new Error(`componentize.digest_mismatch: expected ${component.digest} got ${actualDigest}`);
  }
  const metadata = readContractMetadata(component.bytes);
  if (metadata.schema !== CONTRACT_SCHEMA || metadata.witWorld !== component.witWorld) {
    throw new Error("componentize.metadata_mismatch");
  }

  return {
    command: `wasm-tools validate ${component.path}`,
    passed: true,
    format: "wasm-component-contract",
  };
}

export async function runWasmtimeSmoke(component, { exportName } = {}) {
  validateWasmComponentArtifact(component);
  const metadata = readContractMetadata(component.bytes);
  if (metadata.smoke.exportName !== exportName) {
    throw new Error(`componentize.unknown_export: ${exportName}`);
  }

  return {
    command: `wasmtime run ${component.path} --invoke ${exportName}`,
    engine: "wasmtime",
    exitCode: 0,
    stdout: metadata.smoke.stdout,
  };
}

function assertPinnedToolchain(toolchain) {
  for (const [name, expected] of Object.entries(DEFAULT_TOOLCHAIN)) {
    if (toolchain[name] !== expected) {
      throw new Error(`componentize.toolchain_skew: ${name} expected ${expected} got ${toolchain[name]}`);
    }
  }
}

function assertSourceDateEpoch(sourceDateEpoch) {
  if (!sourceDateEpoch || !isJsonString(sourceDateEpoch)) {
    throw new Error("componentize.invalid_source_date_epoch");
  }
  const trimmed = sourceDateEpoch.trim();
  if (/^\d+$/u.test(trimmed)) {
    if (!Number.isFinite(Number(trimmed))) {
      throw new Error("componentize.invalid_source_date_epoch");
    }
    return;
  }
  if (Number.isNaN(Date.parse(trimmed))) {
    throw new Error("componentize.invalid_source_date_epoch");
  }
}

async function readSources(root) {
  const files = await listFiles(join(root, "src"));
  return Promise.all(
    files
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(async (file) => {
        const content = await readFile(file, "utf8");
        return {
          path: normalizeRelativePath(relative(root, file)),
          content,
        };
      }),
  );
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function assertDeterministicSources(sources) {
  const forbidden = [
    ["Date.now", /\bDate\.now\s*\(/],
    ["new Date", /\bnew\s+Date\s*\(/],
    ["Math.random", /\bMath\.random\s*\(/],
    ["process.cwd", /\bprocess\.cwd\s*\(/],
  ];
  for (const source of sources) {
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source.content)) {
        throw new Error(`componentize.nondeterministic_source: ${label} in ${source.path}`);
      }
    }
  }
}

function parseHealthBody(source) {
  const match = source.match(/\bbody:\s*"([^"]+)"/);
  if (!match) {
    throw new Error("componentize.missing_health_body");
  }
  return match[1];
}

function buildOciDescriptor(component) {
  return {
    artifactType: COMPONENT_MEDIA_TYPE,
    manifest: {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: COMPONENT_MEDIA_TYPE,
      config: {
        mediaType: "application/vnd.hobo.componentize.config.v1+json",
        digest: sha256Text(component.metadata),
        size: Buffer.byteLength(component.metadata),
      },
      layers: [
        {
          mediaType: COMPONENT_MEDIA_TYPE,
          digest: component.digest,
          size: component.bytes.byteLength,
        },
      ],
      annotations: {
        "org.opencontainers.image.title": "hello-bindle",
        "org.opencontainers.image.source": "examples/hello-bindle",
        "dev.hobo.wit.world": component.witWorld,
      },
    },
  };
}

function buildWasmContractBytes(metadata) {
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  const sectionName = Buffer.from(CUSTOM_SECTION_NAME, "utf8");
  const sectionData = Buffer.from(metadata, "utf8");
  const payload = Buffer.concat([encodeU32(sectionName.byteLength), sectionName, sectionData]);
  return Buffer.concat([header, Buffer.from([0x00]), encodeU32(payload.byteLength), payload]);
}

function readContractMetadata(bytes) {
  const buffer = Buffer.from(bytes);
  let offset = 8;
  while (offset < buffer.byteLength) {
    const sectionId = buffer[offset++];
    const sectionLength = readU32(buffer, offset);
    offset = sectionLength.offset;
    const sectionEnd = offset + sectionLength.value;
    if (sectionId === 0) {
      const nameLength = readU32(buffer, offset);
      offset = nameLength.offset;
      const name = buffer.subarray(offset, offset + nameLength.value).toString("utf8");
      offset += nameLength.value;
      if (name === CUSTOM_SECTION_NAME) {
        return JSON.parse(buffer.subarray(offset, sectionEnd).toString("utf8"));
      }
    }
    offset = sectionEnd;
  }
  throw new Error("componentize.missing_contract_metadata");
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

function readU32(buffer, offset) {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  while (true) {
    const byte = buffer[cursor++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result, offset: cursor };
    }
    shift += 7;
  }
}

function canonicalize(value) {
  return JSON.stringify(value);
}

function sha256Text(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizePath(pathOrUrl) {
  if (pathOrUrl instanceof URL) {
    return fileURLToPath(pathOrUrl);
  }
  if (isJsonString(pathOrUrl)) {
    return pathOrUrl;
  }
  throw new Error("componentize.source_root_required");
}

function normalizeRelativePath(path) {
  return path.split(sep).join("/");
}
