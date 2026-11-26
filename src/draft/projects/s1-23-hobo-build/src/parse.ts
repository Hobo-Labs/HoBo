import { BuildError } from "./errors.js";
import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const BUILD_MANIFEST_SCHEMA = "hobo.build-manifest/v1" as const;
export const DEFAULT_SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";

export type ArtifactKind = "wasm-component" | "oci-container";

// domain-view: parse-produced draft-proof record; its wire form is the ServiceDeclaration proto message in data-models/.
export type ServiceDeclaration = {
  readonly name: string;
  readonly language: string;
  readonly runtime: "wasm" | "component" | "container";
  readonly sourceRoot: string;
  readonly entrypoint: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the BuildArtifact proto message in data-models/.
export type BuildArtifact = {
  readonly service: string;
  readonly kind: ArtifactKind;
  readonly path: string;
  readonly mediaType: string;
  readonly digest: string;
  readonly runtime: string;
  readonly witWorld?: string;
  readonly fallbackReason?: string;
  readonly source: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the BuildManifest proto message in data-models/.
export type BuildManifest = {
  readonly schema: typeof BUILD_MANIFEST_SCHEMA;
  readonly generatedBy: "hobo build";
  readonly runtimeTarget: TargetRuntime;
  readonly sourceDateEpoch: string;
  readonly artifacts: readonly BuildArtifact[];
};

export type TargetRuntime = "auto" | "wasm" | "container";

export type BuildRequest = {
  readonly json: boolean;
  readonly projectRoot: string;
  readonly targetRuntime: TargetRuntime;
  readonly sourceDateEpoch: string;
};

export type BuildResult = {
  readonly manifest: string;
  readonly manifestDigest: string;
  readonly artifacts: readonly BuildArtifact[];
};

export function parseBuildRequest(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): BuildRequest {
  const flags = {
    json: false,
    targetRuntime: normalizeTargetRuntime(env.HOBO_RUNTIME ?? "auto"),
  };
  let sawVerb = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

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
      throw new BuildError("HOBO_BUILD_USAGE", buildHelp(), { exitCode: 0 });
    }

    throw new BuildError("HOBO_BUILD_USAGE", `Unknown hobo build option "${token}".`, { exitCode: 2 });
  }

  if (!sawVerb) {
    throw new BuildError("HOBO_BUILD_USAGE", "Usage: hobo build [--json] [--runtime auto|wasm|container]", {
      exitCode: 2,
    });
  }

  return {
    json: flags.json,
    projectRoot: resolveProjectRoot(cwd),
    targetRuntime: flags.targetRuntime,
    sourceDateEpoch: env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH,
  };
}

export function parseServiceDeclaration(raw: JsonValue): ServiceDeclaration {
  if (!raw || !isJsonObject(raw)) {
    throw new BuildError("HOBO_BUILD_SERVICE_INVALID", "Service declaration must be an object.");
  }

  // SAFETY: `const record = raw as JsonObject;` is required at this I/O or test boundary.
  const record = raw as JsonObject;
  const name = String(record.name ?? "");
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
    throw new BuildError("HOBO_BUILD_SERVICE_INVALID", `Invalid service name "${name}".`, { service: name });
  }

  const entrypoint = normalizePath(String(record.entrypoint ?? defaultEntrypoint(record, name)));
  const sourceRoot = normalizePath(String(record.sourceRoot ?? dirnameOf(entrypoint)));
  assertRelativePath(sourceRoot, "sourceRoot");
  assertRelativePath(entrypoint, "entrypoint");

  return {
    name,
    language: normalizeLanguage(String(record.language ?? inferLanguage(entrypoint))),
    runtime: normalizeServiceRuntime(String(record.runtime ?? "wasm")),
    sourceRoot,
    entrypoint,
  };
}

export function parseBuildManifest(json: JsonValue): BuildManifest {
  if (!json || !isJsonObject(json)) {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", "Build manifest must be an object.");
  }

  // SAFETY: `const record = json as JsonObject;` is required at this I/O or test boundary.
  const record = json as JsonObject;
  if (record.schema !== BUILD_MANIFEST_SCHEMA) {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", `Unexpected manifest schema "${String(record.schema)}".`);
  }

  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts.map((artifact) => parseBuildArtifact(artifact))
    : [];

  return {
    schema: BUILD_MANIFEST_SCHEMA,
    generatedBy: "hobo build",
    runtimeTarget: normalizeTargetRuntime(String(record.runtimeTarget ?? "auto")),
    sourceDateEpoch: String(record.sourceDateEpoch ?? DEFAULT_SOURCE_DATE_EPOCH),
    artifacts,
  };
}

function parseBuildArtifact(raw: JsonValue): BuildArtifact {
  if (!raw || !isJsonObject(raw)) {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", "Build artifact must be an object.");
  }

  // SAFETY: `const record = raw as JsonObject;` is required at this I/O or test boundary.
  const record = raw as JsonObject;
  const kind = String(record.kind ?? "");
  if (kind !== "wasm-component" && kind !== "oci-container") {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", `Invalid artifact kind "${kind}".`);
  }

  const digest = String(record.digest ?? "");
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", `Invalid artifact digest "${digest}".`);
  }

  const path = normalizePath(String(record.path ?? ""));
  assertRelativePath(path, "path");

  const fallbackReason = record.fallbackReason !== undefined ? String(record.fallbackReason) : undefined;
  if (kind === "oci-container" && !fallbackReason) {
    throw new BuildError("HOBO_BUILD_SOURCE_PARSE", "OCI fallback artifacts require fallbackReason.");
  }

  const artifact: BuildArtifact = {
    service: String(record.service ?? ""),
    kind,
    path,
    mediaType: String(record.mediaType ?? ""),
    digest,
    runtime: String(record.runtime ?? ""),
    source: normalizePath(String(record.source ?? "")),
  };

  if (record.witWorld !== undefined) {
    return { ...artifact, witWorld: String(record.witWorld) };
  }
  if (fallbackReason !== undefined) {
    return { ...artifact, fallbackReason };
  }
  return artifact;
}

function normalizeLanguage(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized === "typescript") return "ts";
  if (normalized === "javascript") return "js";
  if (normalized === "py") return "python";
  return normalized;
}

function inferLanguage(entrypoint: string): string {
  const extension = entrypoint.slice(entrypoint.lastIndexOf(".")).toLowerCase();
  if (extension === ".ts") return "ts";
  if (extension === ".js") return "js";
  if (extension === ".py") return "python";
  return extension.replace(/^\./, "") || "unknown";
}

function normalizeServiceRuntime(runtime: string): ServiceDeclaration["runtime"] {
  const normalized = runtime.toLowerCase();
  if (normalized === "wasm" || normalized === "component" || normalized === "container") {
    return normalized === "component" ? "wasm" : normalized;
  }
  throw new BuildError("HOBO_BUILD_RUNTIME_INVALID", `Invalid service runtime "${runtime}".`, { runtime });
}

function normalizeTargetRuntime(runtime: string): TargetRuntime {
  const normalized = runtime.toLowerCase();
  if (normalized === "auto" || normalized === "wasm" || normalized === "component" || normalized === "container") {
    // SAFETY: `return normalized === "component" ? "wasm" : (normalized as TargetRuntime);` is required at this I/O or test boundary.
    return normalized === "component" ? "wasm" : (normalized as TargetRuntime);
  }
  throw new BuildError("HOBO_BUILD_RUNTIME_INVALID", `Invalid build runtime "${runtime}".`, { runtime });
}

function assertRelativePath(path: string, label: string): void {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..")) {
    throw new BuildError("HOBO_BUILD_PATH_INVALID", `Service ${label} must stay inside the project.`, {
      [label]: path,
    });
  }
}

function defaultEntrypoint(record: JsonObject, name: string): string {
  const language = normalizeLanguage(String(record.language ?? "ts"));
  const file = language === "python" ? "app.py" : "service.ts";
  return `services/${name}/src/${file}`;
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : path;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new BuildError("HOBO_BUILD_USAGE", `${flag} requires a value.`, { exitCode: 2 });
  }
  return value;
}

function buildHelp(): string {
  return "Usage: hobo build [--json] [--runtime auto|wasm|container]\n";
}

function resolveProjectRoot(cwd: string): string {
  return cwd.replace(/\\/g, "/");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}
