import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compareGeneratedTree,
  generateSdkCodegenArtifacts,
  writeGeneratedTree,
} from "../../sdk-codegen-surface-contract/src/sdk-codegen-surface.js";
import {
  canonicalManifestHash,
  validateManifest,
} from "../../hobo-manifest-contract/src/manifest.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_COMPONENT_HOST = { kind: "wasmtime", version: "46.0.1" };
const DECLARATION_ORDER = ["bindle", "camp", "yard", "data", "service", "website", "step", "workflow"];
const RESOURCE_KINDS = new Set(["data", "service", "website"]);
const SIDE_EFFECT_PATTERN = /^(import|from|require|exec|run|spawn|shell)\b/;
const VALUE_KEYS = new Set([
  "allow",
  "bind",
  "image",
  "in",
  "input",
  "paradigm",
  "port",
  "provider",
  "region",
  "returns",
]);

export class HoboCodeDslError extends Error {
  constructor(code, line, message) {
    super(`line ${line}: ${message}`);
    this.name = "HoboCodeDslError";
    this.code = code;
    this.line = line;
  }
}

export function parseHoboCode(source) {
  if (!isJsonString(source)) {
    throw new TypeError("Hobo Code source must be a string");
  }

  const draft = {
    bindle: null,
    camp: null,
    yard: null,
    resources: [],
    steps: [],
    workflows: [],
  };

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = stripComment(rawLine).trim();
    if (line === "") return;
    if (SIDE_EFFECT_PATTERN.test(line)) {
      throw new HoboCodeDslError(
        "HOBO_CODE_SIDE_EFFECT",
        lineNumber,
        "declaration-time side effect is forbidden",
      );
    }

    const tokens = line.split(/\s+/);
    const kind = tokens[0];
    if (!DECLARATION_ORDER.includes(kind)) {
      throw new HoboCodeDslError(
        "HOBO_CODE_UNKNOWN_DECLARATION",
        lineNumber,
        `unknown declaration ${kind}`,
      );
    }

    if (kind === "bindle") {
      draft.bindle = parseNamedIn(tokens, lineNumber, "bindle", "camp");
      return;
    }
    if (kind === "camp") {
      draft.camp = parseNamedIn(tokens, lineNumber, "camp", "yard");
      return;
    }
    if (kind === "yard") {
      draft.yard = parseYard(tokens, lineNumber);
      return;
    }
    if (RESOURCE_KINDS.has(kind)) {
      draft.resources.push(parseResource(kind, tokens, lineNumber));
      return;
    }
    if (kind === "step" || kind === "workflow") {
      draft[`${kind}s`].push(parseBehavior(kind, tokens, lineNumber));
    }
  });

  return normalizeAst(draft);
}

export function lowerHoboCode(sourceOrAst) {
  return lowerAst(astFrom(sourceOrAst));
}

export function lowerTypescriptBindle(input) {
  return lowerAst(
    normalizeAst({
      bindle: { name: required(input.bindle, "bindle"), camp: required(input.camp, "camp") },
      camp: { name: required(input.camp, "camp"), yard: required(input.yard?.name, "yard.name") },
      yard: {
        name: required(input.yard?.name, "yard.name"),
        provider: required(input.yard?.provider, "yard.provider"),
        region: required(input.yard?.region, "yard.region"),
      },
      resources: input.resources ?? [],
      steps: input.steps ?? [],
      workflows: input.workflows ?? [],
    }),
  );
}

export function compareHoboCodeToTypescript(hoboCode, typescript, options = {}) {
  const left = normalizedLowered(hoboCode);
  const right = normalizedLowered(typescript);
  if (left.manifestJson === right.manifestJson) {
    return { ok: true, manifestHash: left.manifestHash };
  }

  const result = {
    ok: false,
    code: "HOBO_CODE_MANIFEST_DIVERGENCE",
    hoboCodeHash: left.manifestHash,
    typescriptHash: right.manifestHash,
  };
  if (options.throwOnMismatch) {
    throw new HoboCodeDslError(
      "HOBO_CODE_MANIFEST_DIVERGENCE",
      0,
      `manifest IR divergence (${left.manifestHash} != ${right.manifestHash})`,
    );
  }
  return result;
}

export function formatHoboCode(sourceOrAst) {
  const ast = astFrom(sourceOrAst);
  const lines = [
    `bindle ${ast.bindle.name} in ${ast.bindle.camp}`,
    `camp ${ast.camp.name} in ${ast.camp.yard}`,
    `yard ${ast.yard.name} provider ${ast.yard.provider} region ${ast.yard.region}`,
    ...ast.resources.map(formatResource),
    ...ast.steps.map((step) => formatBehavior("step", step)),
    ...ast.workflows.map((workflow) => formatBehavior("workflow", workflow)),
  ];
  return `${lines.join("\n")}\n`;
}

export function generateHoboCodeArtifacts(sourceOrAst) {
  const ast = astFrom(sourceOrAst);
  const sdkArtifacts = generateSdkCodegenArtifacts({ sources: toSdkCodegenSources(ast) });
  return [...sdkArtifacts, stubArtifact(ast)].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export function createHoboCodegenCommand({ source }) {
  return {
    async run(args, { cwd }) {
      if (!Array.isArray(args) || args[0] !== "codegen") {
        return result(1, "", "usage: hobo codegen [--check] [--json]\n");
      }
      const check = args.includes("--check");
      const json = args.includes("--json");
      const artifacts = generateHoboCodeArtifacts(parseHoboCode(source));

      if (check) {
        const drift = await compareGeneratedTree(cwd, artifacts);
        if (drift.length > 0) {
          return result(
            1,
            json ? `${JSON.stringify({ ok: false, drift })}\n` : "",
            json ? "" : `Generated tree drift\n${formatDrift(drift)}\n`,
          );
        }
        return result(0, json ? `${JSON.stringify({ ok: true, drift: [] })}\n` : "", "");
      }

      await writeGeneratedTree(cwd, artifacts);
      return result(
        0,
        json ? `${JSON.stringify({ ok: true, written: artifacts.map((entry) => entry.path) })}\n` : "",
        "",
      );
    },
  };
}

export async function withTempHoboCodeProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-code-dsl-"));
  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

function parseNamedIn(tokens, line, declaration, target) {
  if (tokens.length !== 4 || tokens[2] !== "in") {
    throw new HoboCodeDslError(
      "HOBO_CODE_BAD_DECLARATION",
      line,
      `${declaration} declaration must be: ${declaration} <name> in <${target}>`,
    );
  }
  return { name: tokens[1], [target]: tokens[3] };
}

function parseYard(tokens, line) {
  const fields = fieldsFrom(tokens.slice(2), line);
  return {
    name: required(tokens[1], "yard.name"),
    provider: required(fields.provider?.[0], "yard.provider"),
    region: required(fields.region?.[0], "yard.region"),
  };
}

function parseResource(kind, tokens, line) {
  const fields = fieldsFrom(tokens.slice(2), line);
  return compact({
    kind,
    name: required(tokens[1], `${kind}.name`),
    allow: fields.allow,
    bind: fields.bind,
    image: fields.image?.[0],
    paradigm: fields.paradigm?.[0],
    port: fields.port?.[0],
  });
}

function parseBehavior(kind, tokens, line) {
  const fields = fieldsFrom(tokens.slice(2), line);
  return {
    name: required(tokens[1], `${kind}.name`),
    input: required(fields.input?.[0], `${kind}.input`),
    returns: required(fields.returns?.[0], `${kind}.returns`),
  };
}

function fieldsFrom(tokens, line) {
  const fields = {};
  for (let index = 0; index < tokens.length; ) {
    const key = tokens[index];
    if (!VALUE_KEYS.has(key)) {
      throw new HoboCodeDslError("HOBO_CODE_BAD_FIELD", line, `unknown field ${key}`);
    }
    index += 1;
    const values = [];
    while (index < tokens.length && !VALUE_KEYS.has(tokens[index])) {
      values.push(...tokens[index].split(",").filter(Boolean));
      index += 1;
    }
    if (values.length === 0) {
      throw new HoboCodeDslError("HOBO_CODE_BAD_FIELD", line, `field ${key} needs a value`);
    }
    fields[key] = values;
  }
  return fields;
}

function normalizeAst(draft) {
  if (!draft.bindle) throw new HoboCodeDslError("HOBO_CODE_MISSING_BINDLE", 0, "bindle is required");
  if (!draft.camp) throw new HoboCodeDslError("HOBO_CODE_MISSING_CAMP", 0, "camp is required");
  if (!draft.yard) throw new HoboCodeDslError("HOBO_CODE_MISSING_YARD", 0, "yard is required");
  if (draft.bindle.camp !== draft.camp.name) {
    throw new HoboCodeDslError("HOBO_CODE_SCOPE_MISMATCH", 0, "bindle must reference declared camp");
  }
  if (draft.camp.yard !== draft.yard.name) {
    throw new HoboCodeDslError("HOBO_CODE_SCOPE_MISMATCH", 0, "camp must reference declared yard");
  }

  const resources = sortResources((draft.resources ?? []).map(normalizeResource));
  const names = new Set();
  for (const resource of resources) {
    if (names.has(resource.name)) {
      throw new HoboCodeDslError("HOBO_CODE_DUPLICATE_RESOURCE", 0, `duplicate resource ${resource.name}`);
    }
    names.add(resource.name);
  }
  for (const resource of resources) {
    for (const target of resource.bind ?? []) {
      if (!names.has(target)) {
        throw new HoboCodeDslError(
          "HOBO_CODE_UNKNOWN_BIND",
          0,
          `resource ${resource.name} binds unknown resource ${target}`,
        );
      }
    }
  }

  return {
    schema: "hobo.code/v1",
    bindle: draft.bindle,
    camp: draft.camp,
    yard: draft.yard,
    resources,
    steps: sortByName((draft.steps ?? []).map(normalizeBehavior)),
    workflows: sortByName((draft.workflows ?? []).map(normalizeBehavior)),
  };
}

function normalizeResource(resource) {
  return compact({
    kind: resource.kind,
    name: required(resource.name, "resource.name"),
    allow: sorted(resource.allow ?? []),
    bind: sorted(resource.bind ?? []),
    image: resource.image,
    paradigm: resource.paradigm,
    port: resource.port ?? (resource.kind === "data" ? "hobo:data" : undefined),
  });
}

function normalizeBehavior(behavior) {
  return {
    name: required(behavior.name, "behavior.name"),
    input: required(behavior.input, "behavior.input"),
    returns: required(behavior.returns, "behavior.returns"),
  };
}

function lowerAst(ast) {
  const manifest = {
    schema: "hobo.manifest/v1",
    componentHost: DEFAULT_COMPONENT_HOST,
    resources: Object.fromEntries(ast.resources.map((resource) => [resource.name, manifestResource(ast, resource)])),
  };
  validateManifest(manifest);
  const manifestJson = json(manifest);
  return {
    ast,
    manifest,
    manifestJson,
    manifestHash: canonicalManifestHash(manifest),
  };
}

function manifestResource(ast, resource) {
  const base = {
    annotations: {
      "hobo.dev/source": "hobo-code",
      "hobo.dev/bindle": ast.bindle.name,
      "hobo.dev/camp": ast.camp.name,
      "hobo.dev/yard": ast.yard.name,
      "hobo.dev/provider": ast.yard.provider,
      "hobo.dev/region": ast.yard.region,
    },
  };

  if (resource.kind === "data") {
    return compact({
      ...base,
      type: "data.v1",
      port: resource.port,
      paradigm: resource.paradigm,
      allow: resource.allow,
    });
  }

  if (resource.kind === "website") {
    return compact({
      ...base,
      type: "website.v1",
      bind: resource.bind,
      allow: resource.allow,
    });
  }

  return compact({
    ...base,
    type: "component.v1",
    image: resource.image,
    runtime: "wasm",
    exports: ["wasi:http/incoming-handler"],
    allow: resource.allow,
    links: resource.bind?.map((target) => ({
      import: importForTarget(ast, target),
      to: target,
    })),
    env: Object.fromEntries((resource.bind ?? []).map((target) => [`ConnectionStrings__${target}`, `{${target}.connectionString}`])),
  });
}

function importForTarget(ast, target) {
  const resource = ast.resources.find((entry) => entry.name === target);
  return resource?.port ?? "hobo:component";
}

function toSdkCodegenSources(ast) {
  const records = recordTypes(ast);
  return {
    wit: {
      interfaces: ast.resources.map((resource) => ({
        name: resource.port ?? `hobo:${resource.kind}`,
        operations: resource.allow ?? [],
      })),
      records,
    },
    zodSchemas: { records },
    allowScopes: Object.fromEntries(ast.resources.map((resource) => [resource.name, resource.allow ?? []])),
    bindleGraph: {
      components: ast.resources
        .filter((resource) => resource.kind === "service" || resource.kind === "website")
        .map((resource) => ({
          name: resource.name,
          bindings: Object.fromEntries((resource.bind ?? []).map((target) => [target, target])),
        })),
      api: [],
      steps: ast.steps,
      workflows: ast.workflows,
    },
    providerOptions: [],
    rawEscapes: [],
    coverage: { ok: true, unobservedResources: [] },
  };
}

function recordTypes(ast) {
  const names = new Set();
  for (const behavior of [...ast.steps, ...ast.workflows]) {
    names.add(behavior.input);
    names.add(behavior.returns);
  }
  return [...names].sort().map((name) => ({
    name,
    fields: [{ name: "id", type: "string" }],
  }));
}

function stubArtifact(ast) {
  return {
    path: "src/_generated/hobo-code-stubs.ts",
    content: generateStubSource(ast),
  };
}

function generateStubSource(ast) {
  const imports = ['import { bindle, data, service, website, step, workflow } from "@hobo/bindles";'];
  const resourceLines = ast.resources.map((resource) => `export const ${resource.name} = ${resourceStub(resource)};`);
  const behaviorLines = [
    ...ast.steps.map((entry) => `export declare function ${entry.name}(input: ${entry.input}): Promise<${entry.returns}>;`),
    ...ast.workflows.map((entry) => `export declare function ${entry.name}(input: ${entry.input}): Promise<${entry.returns}>;`),
  ];
  const bindleLines = [
    `export default bindle("${ast.bindle.name}", (b) => {`,
    ...ast.resources.map((resource) => `  b.use(${resource.name});`),
    "});",
  ];

  return [
    "/* Generated from Hobo Code. Do not edit by hand. */",
    ...imports,
    "",
    ...resourceLines,
    "",
    ...behaviorLines,
    "",
    ...bindleLines,
    "",
  ].join("\n");
}

function resourceStub(resource) {
  const options = [];
  if (resource.bind && resource.bind.length > 0) {
    options.push(`bind: { ${resource.bind.join(", ")} }`);
  }
  const call =
    resource.kind === "data"
      ? `data("${resource.name}")`
      : resource.kind === "website"
        ? `website("${resource.name}"${options.length > 0 ? `, { ${options.join(", ")} }` : ""})`
        : `service("${resource.name}"${options.length > 0 ? `, { ${options.join(", ")} }` : ""})`;
  return appendAllow(call, resource.allow);
}

function appendAllow(call, allow = []) {
  return allow.reduce((chain, verb) => `${chain}.allow("${verb}")`, call);
}

function formatResource(resource) {
  const parts = [resource.kind, resource.name];
  if (resource.kind === "service" && resource.image) parts.push("image", resource.image);
  if (resource.kind === "data" && resource.port) parts.push("port", resource.port);
  if (resource.kind === "data" && resource.paradigm) parts.push("paradigm", resource.paradigm);
  if (resource.bind?.length) parts.push("bind", resource.bind.join(","));
  if (resource.allow?.length) parts.push("allow", resource.allow.join(","));
  return parts.join(" ");
}

function formatBehavior(kind, behavior) {
  return `${kind} ${behavior.name} input ${behavior.input} returns ${behavior.returns}`;
}

function astFrom(input) {
  if (isJsonString(input)) return parseHoboCode(input);
  return normalizeAst(input);
}

function normalizedLowered(value) {
  if (value?.manifestJson && value?.manifestHash) return value;
  return lowerHoboCode(value);
}

function stripComment(line) {
  const marker = line.indexOf("#");
  return marker === -1 ? line : line.slice(0, marker);
}

function required(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new HoboCodeDslError("HOBO_CODE_REQUIRED", 0, `${name} is required`);
  }
  return value;
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function sortByName(values) {
  return [...values].sort((left, right) => left.name.localeCompare(right.name));
}

function sortResources(values) {
  const rank = { data: 0, service: 1, website: 2 };
  return [...values].sort(
    (left, right) => (rank[left.kind] ?? 99) - (rank[right.kind] ?? 99) || left.name.localeCompare(right.name),
  );
}

function compact(value) {
  if (Array.isArray(value)) return value.length > 0 ? value : undefined;
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, nested]) => nested !== undefined && (!Array.isArray(nested) || nested.length > 0))
      .map(([key, nested]) => [key, compact(nested)]),
  );
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function json(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function result(exitCode, stdout, stderr) {
  return { exitCode, stdout, stderr };
}

function formatDrift(drift) {
  return drift.map((entry) => `${entry.status.toUpperCase()} ${entry.path}`).join("\n");
}
