import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

import {
  compareGeneratedTree,
  generateCodegenArtifacts,
  stableStringify,
  writeFixtureProject as writeCodegenFixtureProject,
} from "../../hobo-codegen-cli-contract/src/codegen-cli-contract.js";
import { componentizeHelloBindle } from "../../hobo-componentize-contract/src/componentize-contract.js";

export const BUILD_MANIFEST_PATH = ".hobo/build/build-manifest.json";
export const BUILD_ARTIFACT_DIR = ".hobo/build/artifacts";
export const DEFAULT_SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";

const BUILD_SCHEMA = "hobo.build-manifest/v1";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const OCI_FALLBACK_ARTIFACT_TYPE = "application/vnd.hobo.service.oci-fallback.v1+json";

const DEFAULT_SERVICES = Object.freeze([
  Object.freeze({
    name: "hello-bindle",
    language: "ts",
    runtime: "wasm",
    sourceRoot: "services/hello-bindle",
    entrypoint: "services/hello-bindle/src/service.ts",
  }),
  Object.freeze({
    name: "legacy-worker",
    language: "python",
    runtime: "container",
    sourceRoot: "services/legacy-worker",
    entrypoint: "services/legacy-worker/src/app.py",
  }),
]);

export class BuildContractError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "BuildContractError";
    this.code = code;
    this.detail = detail;
  }
}

export function createBuildCli(options = {}) {
  const execute = options.execute ?? executeBuildRequest;
  const componentize = options.componentize ?? componentizeHelloBindle;

  return {
    async run(argv, runOptions = {}) {
      let request = {
        json: argv.includes("--json"),
        projectRoot: resolve(runOptions.cwd ?? process.cwd()),
        targetRuntime: "auto",
        sourceDateEpoch: DEFAULT_SOURCE_DATE_EPOCH,
      };

      try {
        request = parseArgv(argv, runOptions.cwd ?? process.cwd(), runOptions.env ?? process.env);
        const result = await execute({ ...request, componentize });
        return renderSuccess(request, result);
      } catch (error) {
        return renderFailure(request, error);
      }
    },
  };
}

export async function executeBuildRequest(request) {
  const projectRoot = resolve(request.projectRoot);
  const targetRuntime = request.targetRuntime ?? "auto";
  const sourceDateEpoch = request.sourceDateEpoch ?? DEFAULT_SOURCE_DATE_EPOCH;

  await assertGeneratedFresh(projectRoot);
  const services = await discoverServices(projectRoot);
  await rm(join(projectRoot, ".hobo/build"), { recursive: true, force: true });

  const builtArtifacts = [];
  for (const service of services) {
    builtArtifacts.push(
      await buildService({
        projectRoot,
        service,
        targetRuntime,
        sourceDateEpoch,
        componentize: request.componentize ?? componentizeHelloBindle,
      }),
    );
  }

  await writeBuildOutputs(projectRoot, builtArtifacts);

  const artifacts = builtArtifacts.map((built) => built.artifact);
  const manifest = {
    schema: BUILD_SCHEMA,
    generatedBy: "hobo build",
    runtimeTarget: targetRuntime,
    sourceDateEpoch,
    artifacts,
  };
  const manifestContent = stableStringify(manifest);
  await writeFile(join(projectRoot, BUILD_MANIFEST_PATH), manifestContent);

  return {
    manifest: BUILD_MANIFEST_PATH,
    manifestDigest: sha256Text(manifestContent),
    artifacts,
  };
}

export async function writeBuildFixtureProject(projectRoot, options = {}) {
  await writeCodegenFixtureProject(projectRoot, options.codegen );

  const services = options.services ?? DEFAULT_SERVICES;
  const bindlePath = join(projectRoot, "hobo.bindle.json");
  const bindle = JSON.parse(await readFile(bindlePath, "utf8"));
  bindle.services = services.map((service) => ({ ...service }));
  await writeFile(bindlePath, stableStringify(bindle));

  for (const service of services) {
    await writeServiceFixture(projectRoot, normalizeService(service), options);
  }
}

async function assertGeneratedFresh(projectRoot) {
  let artifacts;
  let drift;

  try {
    artifacts = await generateCodegenArtifacts({ projectRoot, guestLanguage: "ts" });
    drift = await compareGeneratedTree(projectRoot, artifacts);
  } catch (error) {
    throw new BuildContractError(
      "HOBO_BUILD_CODEGEN_FAILED",
      `codegen freshness check failed: ${error.message}`,
      { cause: error.message, code: error.code },
    );
  }

  if (drift.length > 0) {
    throw new BuildContractError(
      "HOBO_BUILD_CODEGEN_DRIFT",
      "generated tree drift detected; run hobo codegen to refresh _generated/",
      { drift },
    );
  }
}

async function discoverServices(projectRoot) {
  const bindle = await readJson(projectRoot, "hobo.bindle.json");
  const declared = Array.isArray(bindle.services) ? bindle.services : [];
  const services = declared.map((service) => normalizeService(service)).sort((left, right) => left.name.localeCompare(right.name));

  if (services.length === 0) {
    throw new BuildContractError("HOBO_BUILD_NO_SERVICES", "hobo.bindle.json must declare at least one service");
  }

  return services;
}

async function buildService({ projectRoot, service, targetRuntime, sourceDateEpoch, componentize }) {
  const fallbackReason = fallbackReasonFor(service, targetRuntime);
  if (fallbackReason) {
    return buildOciFallback({ projectRoot, service, fallbackReason });
  }

  try {
    const result = await componentize({
      sourceRoot: join(projectRoot, service.sourceRoot),
      sourceDateEpoch,
    });
    const path = `${BUILD_ARTIFACT_DIR}/${artifactFileStem(service.name)}.component.wasm`;

    return {
      artifact: {
        service: service.name,
        kind: "wasm-component",
        path,
        mediaType: result.component.mediaType,
        digest: result.component.digest,
        runtime: "wasm-component",
        witWorld: result.component.witWorld,
        source: service.entrypoint,
      },
      bytes: result.component.bytes,
    };
  } catch (error) {
    throw new BuildContractError(
      "HOBO_BUILD_COMPONENTIZE_FAILED",
      `componentize failed for service "${service.name}": ${error.message}`,
      {
        service: service.name,
        cause: error.message,
      },
    );
  }
}

async function buildOciFallback({ projectRoot, service, fallbackReason }) {
  const sources = await readServiceSources(projectRoot, service);
  const sourceIndex = stableStringify({
    schema: "hobo.oci-fallback-sources/v1",
    service: service.name,
    language: service.language,
    runtime: service.runtime,
    entrypoint: service.entrypoint,
    sources,
  });
  const config = stableStringify({
    schema: "hobo.oci-fallback-config/v1",
    service: service.name,
    reason: fallbackReason,
  });
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST_MEDIA_TYPE,
    artifactType: OCI_FALLBACK_ARTIFACT_TYPE,
    config: {
      mediaType: "application/vnd.hobo.service.config.v1+json",
      digest: sha256Text(config),
      size: Buffer.byteLength(config),
    },
    layers: [
      {
        mediaType: "application/vnd.hobo.service.sources.v1+json",
        digest: sha256Text(sourceIndex),
        size: Buffer.byteLength(sourceIndex),
      },
    ],
    annotations: {
      "dev.hobo.service": service.name,
      "dev.hobo.fallback.reason": fallbackReason,
    },
  };
  const bytes = Buffer.from(stableStringify(manifest), "utf8");
  const path = `${BUILD_ARTIFACT_DIR}/${artifactFileStem(service.name)}.oci.json`;

  return {
    artifact: {
      service: service.name,
      kind: "oci-container",
      path,
      mediaType: OCI_MANIFEST_MEDIA_TYPE,
      digest: sha256Bytes(bytes),
      runtime: "oci-container",
      fallbackReason,
      source: service.entrypoint,
    },
    bytes,
  };
}

async function writeBuildOutputs(projectRoot, builtArtifacts) {
  await mkdir(join(projectRoot, BUILD_ARTIFACT_DIR), { recursive: true });
  for (const built of builtArtifacts) {
    await writeFile(join(projectRoot, built.artifact.path), built.bytes);
  }
  await mkdir(dirname(join(projectRoot, BUILD_MANIFEST_PATH)), { recursive: true });
}

function fallbackReasonFor(service, targetRuntime) {
  if (!isWasmLanguage(service.language)) {
    return `unsupported-language: ${service.language}`;
  }
  if (targetRuntime === "container") {
    return "target-runtime: container";
  }
  if (service.runtime === "container") {
    return "declared-runtime: container";
  }
  return null;
}

function _isWasmCandidate(service) {
  return isWasmLanguage(service.language) && service.runtime !== "container";
}

function isWasmLanguage(language) {
  return new Set(["ts", "typescript", "js", "javascript"]).has(language);
}

function parseArgv(argv, cwd, env) {
  const flags = {
    json: false,
    targetRuntime: normalizeTargetRuntime(env.HOBO_RUNTIME ?? "auto"),
  };
  let sawVerb = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "build" && !sawVerb) {
      sawVerb = true;
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--runtime" || token === "--target") {
      flags.targetRuntime = normalizeTargetRuntime(takeValue(argv, index, token));
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new BuildContractError("HOBO_BUILD_USAGE", buildHelp(), { exitCode: 0 });
    }

    throw new BuildContractError("HOBO_BUILD_USAGE", `Unknown hobo build option "${token}".`, {
      exitCode: 2,
    });
  }

  if (!sawVerb) {
    throw new BuildContractError("HOBO_BUILD_USAGE", "Usage: hobo build [--json] [--runtime auto|wasm|container]", {
      exitCode: 2,
    });
  }

  return {
    json: flags.json,
    projectRoot: resolve(cwd),
    targetRuntime: flags.targetRuntime,
    sourceDateEpoch: normalizeSourceDateEpoch(env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH),
  };
}

function normalizeSourceDateEpoch(value) {
  const raw = String(value);
  if (/^\d+$/u.test(raw)) {
    const epochMs = Number(raw) * 1000;
    const date = new Date(epochMs);
    if (Number.isFinite(epochMs) && !Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return raw;
}

function renderSuccess(request, result) {
  if (request.json) {
    return {
      exitCode: 0,
      stdout: stableStringify({
        ok: true,
        command: "build",
        manifest: result.manifest,
        manifestDigest: result.manifestDigest,
        runtimeTarget: request.targetRuntime,
        artifacts: result.artifacts,
      }),
      stderr: "",
    };
  }

  return {
    exitCode: 0,
    stdout: `hobo build ok (${result.artifacts.length} artifacts)\n`,
    stderr: "",
  };
}

function renderFailure(request, error) {
  const contractError =
    error instanceof BuildContractError
      ? error
      : new BuildContractError("HOBO_BUILD_INTERNAL", "internal build wrapper error", { cause: error.message });
  const exitCode =
    contractError.detail.exitCode ??
    (contractError.code === "HOBO_BUILD_USAGE" ? 2 : 1);

  if (request.json) {
    return {
      exitCode,
      stdout: stableStringify({
        ok: false,
        command: "build",
        code: contractError.code,
        message: contractError.message,
        detail: contractError.detail,
      }),
      stderr: "",
    };
  }

  return {
    exitCode,
    stdout: "",
    stderr: `${contractError.message}\n`,
  };
}

async function writeServiceFixture(projectRoot, service, options) {
  if (service.language === "python") {
    await writeText(join(projectRoot, service.entrypoint), options.legacySource ?? "def handler(event):\n    return {'ok': True}\n");
    return;
  }

  await writeText(
    join(projectRoot, service.entrypoint),
    options.helloSource ?? 'export const health = () => ({ status: 200, body: "hello from wasm" });\n',
  );
}

async function readServiceSources(projectRoot, service) {
  const root = join(projectRoot, service.sourceRoot);
  const files = await listFiles(root);
  if (files.length === 0) {
    throw new BuildContractError("HOBO_BUILD_SOURCE_MISSING", `service "${service.name}" has no source files`, {
      service: service.name,
      sourceRoot: service.sourceRoot,
    });
  }

  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(join(root, file), "utf8");
      return {
        path: normalizePath(join(service.sourceRoot, file)),
        digest: sha256Text(normalizeText(content)),
      };
    }),
  );
}

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new BuildContractError("HOBO_BUILD_SOURCE_MISSING", `Cannot read ${normalizePath(directory)}: ${error.message}`, {
        sourceRoot: normalizePath(root),
      });
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(normalizePath(relative(root, path)));
      }
    }
  }

  await visit(root);
  return files.sort();
}

async function readJson(projectRoot, path) {
  try {
    return JSON.parse(await readFile(join(projectRoot, path), "utf8"));
  } catch (error) {
    throw new BuildContractError("HOBO_BUILD_SOURCE_PARSE", `Cannot parse ${path}: ${error.message}`, {
      file: path,
    });
  }
}

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function normalizeService(service) {
  const name = String(service.name ?? "");
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
    throw new BuildContractError("HOBO_BUILD_SERVICE_INVALID", `Invalid service name "${name}".`, { service: name });
  }

  const entrypoint = normalizePath(service.entrypoint ?? defaultEntrypoint(service));
  const sourceRoot = normalizePath(service.sourceRoot ?? dirname(entrypoint));
  assertRelativePath(sourceRoot, "sourceRoot");
  assertRelativePath(entrypoint, "entrypoint");

  return {
    name,
    language: normalizeLanguage(service.language ?? inferLanguage(entrypoint)),
    runtime: normalizeServiceRuntime(service.runtime ?? "wasm"),
    sourceRoot,
    entrypoint,
  };
}

function defaultEntrypoint(service) {
  const extension = normalizeLanguage(service.language ?? "ts") === "python" ? "py" : "ts";
  const file = extension === "py" ? "app.py" : "service.ts";
  return `services/${service.name}/src/${file}`;
}

function normalizeLanguage(language) {
  const normalized = String(language).toLowerCase();
  if (normalized === "typescript") return "ts";
  if (normalized === "javascript") return "js";
  if (normalized === "py") return "python";
  return normalized;
}

function inferLanguage(entrypoint) {
  const extension = extname(entrypoint).toLowerCase();
  if (extension === ".ts") return "ts";
  if (extension === ".js") return "js";
  if (extension === ".py") return "python";
  return extension.replace(/^\./, "") || "unknown";
}

function normalizeServiceRuntime(runtime) {
  const normalized = String(runtime).toLowerCase();
  if (new Set(["wasm", "component", "container"]).has(normalized)) return normalized;
  throw new BuildContractError("HOBO_BUILD_RUNTIME_INVALID", `Invalid service runtime "${runtime}".`, {
    runtime,
  });
}

function normalizeTargetRuntime(runtime) {
  const normalized = String(runtime).toLowerCase();
  if (new Set(["auto", "wasm", "component", "container"]).has(normalized)) {
    return normalized === "component" ? "wasm" : normalized;
  }
  throw new BuildContractError("HOBO_BUILD_RUNTIME_INVALID", `Invalid build runtime "${runtime}".`, {
    runtime,
  });
}

function assertRelativePath(path, label) {
  if (path.startsWith("/") || path.match(/^[A-Za-z]:/) || path.split("/").includes("..")) {
    throw new BuildContractError("HOBO_BUILD_PATH_INVALID", `Service ${label} must stay inside the project.`, {
      [label]: path,
    });
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new BuildContractError("HOBO_BUILD_USAGE", `${flag} requires a value.`, { exitCode: 2 });
  }
  return value;
}

function buildHelp() {
  return "Usage: hobo build [--json] [--runtime auto|wasm|container]\n";
}

function artifactFileStem(serviceName) {
  return serviceName.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

function sha256Text(value) {
  return `sha256:${createHash("sha256").update(normalizeText(value), "utf8").digest("hex")}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizeText(value) {
  return `${String(value).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/u, "")}\n`;
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}
