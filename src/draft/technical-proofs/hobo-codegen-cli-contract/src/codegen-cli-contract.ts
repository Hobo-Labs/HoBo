import { isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const requireFromRepoRoot = createRequire(join(process.cwd(), "package.json"));

export const GENERATED_LAYOUT = Object.freeze([".hobo/generated", "src/_generated"]);
export const SOURCE_LAYOUT = Object.freeze({
  wit: ".hobo/sources/wit/sdk.wit",
  zod: ".hobo/sources/zod/resources.json",
  allow: ".hobo/sources/allow/scopes.json",
  bindle: "hobo.bindle.json",
});

export class CodegenContractError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "CodegenContractError";
    this.code = code;
    this.detail = detail;
  }
}

export function createCodegenCli(options = {}) {
  const engine = options.engine ?? generateCodegenArtifacts;

  return {
    async run(argv, runOptions = {}) {
      let request = {
        check: false,
        json: argv.includes("--json"),
        guestLanguage: "ts",
        projectRoot: resolve(runOptions.cwd ?? process.cwd()),
      };
      try {
        request = parseArgv(argv, runOptions.cwd ?? process.cwd());
        const result = await executeCodegenRequest({ ...request, engine });
        return renderSuccess(request, result);
      } catch (error) {
        return renderFailure(request, error);
      }
    },
  };
}

export async function executeCodegenRequest(request) {
  if (request.guestLanguage !== "ts") {
    throw new CodegenContractError(
      "HOBO_CODEGEN_STATIC_ANALYSIS_REQUIRED",
      `static-analysis required for non-TypeScript guest "${request.guestLanguage}"`,
      { guestLanguage: request.guestLanguage },
    );
  }

  const artifacts = await request.engine({
    projectRoot: request.projectRoot,
    guestLanguage: request.guestLanguage,
  });

  if (request.check) {
    const drift = await compareGeneratedTree(request.projectRoot, artifacts);
    if (drift.length > 0) {
      throw new CodegenContractError("HOBO_CODEGEN_DRIFT", "generated tree drift detected", {
        drift,
      });
    }

    return {
      mode: "check",
      drift: false,
      checked: artifacts.map((artifact) => artifact.path),
      written: [],
    };
  }

  await writeGeneratedTree(request.projectRoot, artifacts);
  return {
    mode: "write",
    drift: false,
    checked: [],
    written: artifacts.map((artifact) => artifact.path),
  };
}

export async function generateCodegenArtifacts(options = {}) {
  const projectRoot = options.projectRoot;
  const sources = options.sources ?? (await readProjectSources(projectRoot));
  const model = normalizeSourceModel(sources);
  const sourceDigests = digestSources(model.rawSources);

  return [
    {
      path: ".hobo/generated/codegen-manifest.json",
      content: `${stableStringify({
        schema: "hobo.codegen-manifest/v1",
        generatedBy: "hobo codegen",
        guestLanguage: options.guestLanguage ?? "ts",
        layout: GENERATED_LAYOUT,
        sourceDigests,
        resources: model.resources.map((resource) => resource.name),
        scopes: model.scopes.map((scope) => scope.name),
        bindles: model.bindles.map((bindle) => bindle.name),
      })}`,
    },
    {
      path: "src/_generated/api-tree.d.ts",
      content: renderApiTree(model),
    },
    {
      path: "src/_generated/bindings.d.ts",
      content: renderBindings(model),
    },
    {
      path: "src/_generated/hooks.d.ts",
      content: renderHooks(model),
    },
    {
      path: "src/_generated/steps.d.ts",
      content: renderStepSignatures(model),
    },
    {
      path: "src/_generated/workflows.d.ts",
      content: renderWorkflowSignatures(model),
    },
    {
      path: "src/_generated/with-options.d.ts",
      content: renderWithOptions(model),
    },
  ];
}

export async function writeGeneratedTree(projectRoot, artifacts) {
  for (const root of GENERATED_LAYOUT) {
    await rm(join(projectRoot, root), { recursive: true, force: true });
  }

  for (const artifact of artifacts.toSorted((left, right) => left.path.localeCompare(right.path))) {
    const target = join(projectRoot, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, normalizeText(artifact.content));
  }
}

export async function compareGeneratedTree(projectRoot, artifacts) {
  const expected = new Map(
    artifacts
      .map((artifact) => [normalizePath(artifact.path), normalizeText(artifact.content)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const actual = await readGeneratedTree(projectRoot);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const drift = [];

  for (const path of paths) {
    if (!expected.has(path)) {
      drift.push({
        path,
        status: "extra",
        actualDigest: digest(actual.get(path)),
      });
      continue;
    }
    if (!actual.has(path)) {
      drift.push({
        path,
        status: "missing",
        expectedDigest: digest(expected.get(path)),
      });
      continue;
    }
    if (actual.get(path) !== expected.get(path)) {
      drift.push({
        path,
        status: "changed",
        expectedDigest: digest(expected.get(path)),
        actualDigest: digest(actual.get(path)),
      });
    }
  }

  return drift;
}

export async function readProjectSources(projectRoot) {
  return {
    wit: await readTextSource(projectRoot, SOURCE_LAYOUT.wit),
    zod: await readJsonSource(projectRoot, SOURCE_LAYOUT.zod),
    allow: await readJsonSource(projectRoot, SOURCE_LAYOUT.allow),
    bindle: await readJsonSource(projectRoot, SOURCE_LAYOUT.bindle),
  };
}

export async function writeFixtureProject(projectRoot, options = {}) {
  const sources = fixtureSources(options);
  await writeText(join(projectRoot, SOURCE_LAYOUT.wit), sources.wit);
  await writeJson(join(projectRoot, SOURCE_LAYOUT.zod), sources.zod);
  await writeJson(join(projectRoot, SOURCE_LAYOUT.allow), sources.allow);
  await writeJson(join(projectRoot, SOURCE_LAYOUT.bindle), sources.bindle);
  return sources;
}

export function fixtureSources(options = {}) {
  const reverse = options.reverse === true;
  const resourceEntries = [
    [
      "ticket",
      {
        fields: mapFromEntries(
          [
            ["title", { type: "string" }],
            ["priority", { type: "enum", values: setFrom(["high", "normal", "low"], reverse) }],
            ["id", { type: "string" }],
          ],
          reverse,
        ),
      },
    ],
    [
      "incident",
      {
        fields: mapFromEntries(
          [
            ["id", { type: "string" }],
            ["severity", { type: "enum", values: setFrom(["sev1", "sev2", "sev3"], reverse) }],
            ["open", { type: "boolean" }],
          ],
          reverse,
        ),
      },
    ],
  ];
  const bindles = [
    {
      name: "support",
      provider: "camp",
      resources: setFrom(["ticket", "incident"], reverse),
      steps: setFrom(["ticket.validate", "incident.classify"], reverse),
      workflows: setFrom(["ticket.triage", "incident.restore"], reverse),
      with: mapFromEntries(
        [
          ["region", setFrom(["us", "eu"], reverse)],
          ["tier", setFrom(["free", "pro"], reverse)],
        ],
        reverse,
      ),
    },
  ];

  return {
    wit: `package hobo:sdk@0.1.0;\n\nworld app {\n  export support;\n}\n\ninterface support {\n}\n`,
    zod: {
      resources: mapFromEntries(resourceEntries, reverse),
    },
    allow: {
      scopes: mapFromEntries(
        [
          ["ticket:read", { grants: setFrom(["ticket.query", "ticket.subscribe"], reverse) }],
          ["incident:read", { grants: setFrom(["incident.query", "incident.subscribe"], reverse) }],
        ],
        reverse,
      ),
    },
    bindle: {
      bindles: reverse ? bindles.toReversed() : bindles,
    },
  };
}

export async function typecheckGeneratedTree(projectRoot) {
  const consumerPath = join(projectRoot, "generated-consumer.ts");
  await writeFile(
    consumerPath,
    `import type { HoboApiTree } from "./src/_generated/api-tree.js";\n` +
      `import type { Ticket } from "./src/_generated/bindings.js";\n` +
      `import type { ProviderWithOptions } from "./src/_generated/with-options.js";\n\n` +
      `const ticket: Ticket = { id: "t1", priority: "high", title: "hello" };\n` +
      `const provider: ProviderWithOptions = { provider: "camp", options: { region: "us", tier: "free" } };\n` +
      `const resource: keyof HoboApiTree["resources"] = "ticket";\n` +
      `export const proof = { ticket, provider, resource };\n`,
  );

  const args = [
    "--strict",
    "--noEmit",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    consumerPath,
  ];
  const localTsc = resolveLocalTsc();
  const command = localTsc
    ? process.execPath
    : process.platform === "win32"
      ? process.env.ComSpec ?? "cmd.exe"
      : "tsc";
  const commandArgs = localTsc
    ? [localTsc, ...args]
    : process.platform === "win32"
      ? ["/d", "/c", "tsc.cmd", ...args]
      : args;
  execFileSync(command, commandArgs, { cwd: projectRoot, stdio: "pipe" });
}

function resolveLocalTsc(): string | undefined {
  try {
    return requireFromRepoRoot.resolve("typescript/bin/tsc");
  } catch {
    return undefined;
  }
}

export async function withTempProject(callback) {
  const dir = await mkdtemp(join(tmpdir(), "hobo-codegen-"));
  try {
    await writeFixtureProject(dir);
    return await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function stableStringify(value) {
  return `${JSON.stringify(toStableValue(value), null, 2)}\n`;
}

function parseArgv(argv, cwd) {
  const flags = {
    check: false,
    json: false,
    guestLanguage: "ts",
  };
  let sawVerb = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "codegen" && !sawVerb) {
      sawVerb = true;
      continue;
    }
    if (token === "--check") {
      flags.check = true;
      continue;
    }
    if (token === "--json") {
      flags.json = true;
      continue;
    }
    if (token === "--guest-language") {
      flags.guestLanguage = takeValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new CodegenContractError("HOBO_CODEGEN_USAGE", codegenHelp(), { exitCode: 0 });
    }

    throw new CodegenContractError("HOBO_CODEGEN_USAGE", `Unknown hobo codegen option "${token}".`, {
      exitCode: 2,
    });
  }

  return {
    check: flags.check,
    json: flags.json,
    guestLanguage: flags.guestLanguage,
    projectRoot: resolve(cwd),
  };
}

function renderSuccess(request, result) {
  const envelope = {
    ok: true,
    command: "codegen",
    mode: result.mode,
    drift: result.drift,
    layout: GENERATED_LAYOUT,
    checked: result.checked,
    written: result.written,
  };

  if (request.json) {
    return {
      exitCode: 0,
      stdout: stableStringify(envelope),
      stderr: "",
    };
  }

  const files = result.mode === "check" ? result.checked : result.written;
  return {
    exitCode: 0,
    stdout: `hobo codegen ${result.mode} ok (${files.length} files)\n`,
    stderr: "",
  };
}

function renderFailure(request, error) {
  const contractError =
    error instanceof CodegenContractError
      ? error
      : new CodegenContractError("HOBO_CODEGEN_INTERNAL", "internal codegen wrapper error");
  const exitCode =
    contractError.detail.exitCode ??
    (contractError.code === "HOBO_CODEGEN_USAGE" ? 2 : contractError.code === "HOBO_CODEGEN_DRIFT" ? 1 : 1);

  if (request.json) {
    return {
      exitCode,
      stdout: stableStringify({
        ok: false,
        command: "codegen",
        code: contractError.code,
        message: contractError.message,
        drift: contractError.code === "HOBO_CODEGEN_DRIFT",
        layout: GENERATED_LAYOUT,
        detail: contractError.detail,
      }),
      stderr: "",
    };
  }

  if (contractError.code === "HOBO_CODEGEN_DRIFT") {
    return {
      exitCode,
      stdout: "",
      stderr: `Generated tree drift:\n${renderDrift(contractError.detail.drift)}\n`,
    };
  }

  return {
    exitCode,
    stdout: "",
    stderr: `${contractError.message}\n`,
  };
}

function renderDrift(drift) {
  return drift
    .map((entry) => {
      const digests = [entry.expectedDigest && `expected ${entry.expectedDigest}`, entry.actualDigest && `actual ${entry.actualDigest}`]
        .filter(Boolean)
        .join("; ");
      return `${entry.status.toUpperCase()} ${entry.path}${digests ? ` (${digests})` : ""}`;
    })
    .join("\n");
}

function normalizeSourceModel(sources) {
  const rawSources = {
    wit: sources.wit,
    zod: stableStringify(sources.zod),
    allow: stableStringify(sources.allow),
    bindle: stableStringify(sources.bindle),
  };

  assertValidWitSource(sources.wit);
  const zod = toStableValue(sources.zod);
  const allow = toStableValue(sources.allow);
  const bindle = toStableValue(sources.bindle);

  const resources = Object.entries(zod.resources )
    .map(([name, resource]) => ({
      name,
      typeName: pascalCase(name),
      fields: Object.entries(resource.fields ).map(([fieldName, field]) => ({
        name: fieldName,
        type: renderFieldType(field),
      })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (resources.length === 0) {
    throw new CodegenContractError("HOBO_CODEGEN_SOURCE_PARSE", "resources.json must define at least one resource", {
      file: SOURCE_LAYOUT.zod,
    });
  }

  const scopes = Object.entries(allow.scopes )
    .map(([name, scope]) => ({
      name,
      grants: [...(scope.grants ?? [])].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  const bindles = [...(bindle.bindles ?? [])]
    .map((entry) => ({
      name: entry.name,
      provider: entry.provider,
      resources: [...(entry.resources ?? [])].sort(),
      steps: [...(entry.steps ?? [])].sort(),
      workflows: [...(entry.workflows ?? [])].sort(),
      with: Object.entries(entry.with )
        .map(([name, values]) => ({ name, values: [...values].sort() }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    rawSources,
    resources,
    scopes,
    bindles,
  };
}

function assertValidWitSource(source) {
  if (!/^package\s+hobo:sdk@0\.1\.0;/m.test(source)) {
    throw new CodegenContractError("HOBO_CODEGEN_SOURCE_PARSE", `${SOURCE_LAYOUT.wit} must declare package hobo:sdk@0.1.0`, {
      file: SOURCE_LAYOUT.wit,
    });
  }
  if (!/^world\s+app\s+\{/m.test(source)) {
    throw new CodegenContractError("HOBO_CODEGEN_SOURCE_PARSE", `${SOURCE_LAYOUT.wit} must declare world app`, {
      file: SOURCE_LAYOUT.wit,
    });
  }
}

function renderApiTree(model) {
  const rows = model.resources
    .map((resource) => {
      const scope = findScopeForResource(model, resource.name);
      const bindle = findBindleForResource(model, resource.name);
      return `    ${resource.name}: { type: ${resource.typeName}; query: "${resource.name}.query"; subscribe: "${resource.name}.subscribe"; scope: "${scope}"; bindle: "${bindle}"; };`;
    })
    .join("\n");

  return `import type { ${model.resources.map((resource) => resource.typeName).join(", ")} } from "./bindings.js";\n\n` +
    `export interface HoboApiTree {\n  resources: {\n${rows}\n  };\n}\n\n` +
    `export declare const api: HoboApiTree;\n`;
}

function renderBindings(model) {
  const interfaces = model.resources
    .map((resource) => {
      const fields = resource.fields.map((field) => `  ${field.name}: ${field.type};`).join("\n");
      return `export interface ${resource.typeName} {\n${fields}\n}`;
    })
    .join("\n\n");
  const resourceNames = union(model.resources.map((resource) => resource.name));

  return `${interfaces}\n\nexport type ResourceName = ${resourceNames};\n`;
}

function renderHooks(model) {
  const imports = `import type { ${model.resources.map((resource) => resource.typeName).join(", ")} } from "./bindings.js";`;
  const hooks = model.resources
    .flatMap((resource) => [
      `export declare function use${resource.typeName}Query(input?: { limit?: number }): Promise<readonly ${resource.typeName}[]>;`,
      `export declare function use${resource.typeName}Subscription(handler: (event: ${resource.typeName}) => void): () => void;`,
    ])
    .join("\n");

  return `${imports}\n\n${hooks}\n`;
}

function renderStepSignatures(model) {
  const imports = `import type { ${model.resources.map((resource) => resource.typeName).join(", ")} } from "./bindings.js";`;
  const entries = model.bindles
    .flatMap((bindle) =>
      bindle.steps.map((step) => {
        const resource = model.resources.find((candidate) => step.startsWith(`${candidate.name}.`)) ?? model.resources[0];
        return `  "${step}": { input: ${resource.typeName}; output: ${resource.typeName}; };`;
      }),
    )
    .join("\n");

  return `${imports}\n\nexport interface StepSignatures {\n${entries}\n}\n`;
}

function renderWorkflowSignatures(model) {
  const imports = `import type { ResourceName } from "./bindings.js";`;
  const entries = model.bindles
    .flatMap((bindle) =>
      bindle.workflows.map(
        (workflow) => `  "${workflow}": { resources: readonly ResourceName[]; provider: "${bindle.provider}"; };`,
      ),
    )
    .join("\n");

  return `${imports}\n\nexport interface WorkflowSignatures {\n${entries}\n}\n`;
}

function renderWithOptions(model) {
  const providerEntries = model.bindles
    .map((bindle) => {
      const options = bindle.with
        .map((entry) => `    ${entry.name}: ${union(entry.values)};`)
        .join("\n");
      return `  | { provider: "${bindle.provider}"; options: {\n${options}\n    } }`;
    })
    .join("\n");

  return `export type ProviderWithOptions =\n${providerEntries};\n`;
}

function findScopeForResource(model, resourceName) {
  return model.scopes.find((scope) => scope.grants.some((grant) => grant.startsWith(`${resourceName}.`)))?.name ?? "none";
}

function findBindleForResource(model, resourceName) {
  return model.bindles.find((bindle) => bindle.resources.includes(resourceName))?.name ?? "none";
}

function renderFieldType(field) {
  if (field.type === "string") return "string";
  if (field.type === "number") return "number";
  if (field.type === "boolean") return "boolean";
  if (field.type === "enum") return union(field.values ?? []);
  return "unknown";
}

async function readGeneratedTree(projectRoot) {
  const files = new Map();
  for (const root of GENERATED_LAYOUT) {
    const absoluteRoot = join(projectRoot, root);
    if (!existsSync(absoluteRoot)) continue;
    for (const path of await listFiles(absoluteRoot)) {
      const fullPath = join(absoluteRoot, path);
      files.set(normalizePath(join(root, path)), normalizeText(await readFile(fullPath, "utf8")));
    }
  }
  return files;
}

async function listFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      files.push(relative(root, path).replace(/\\/g, "/"));
    }
  }

  await visit(root);
  return files.sort();
}

async function readTextSource(projectRoot, path) {
  try {
    return await readFile(join(projectRoot, path), "utf8");
  } catch (error) {
    throw new CodegenContractError("HOBO_CODEGEN_SOURCE_PARSE", `Cannot read ${path}: ${error.message}`, {
      file: path,
    });
  }
}

async function readJsonSource(projectRoot, path) {
  const source = await readTextSource(projectRoot, path);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new CodegenContractError("HOBO_CODEGEN_SOURCE_PARSE", `Cannot parse ${path}: ${error.message}`, {
      file: path,
    });
  }
}

async function writeJson(path, value) {
  await writeText(path, stableStringify(value));
}

async function writeText(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function digestSources(sources) {
  return Object.fromEntries(
    Object.entries(sources)
      .map(([name, source]) => [name, digest(source)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function digest(value) {
  return `sha256:${createHash("sha256").update(normalizeText(String(value)), "utf8").digest("hex")}`;
}

function normalizeText(value) {
  return `${String(value).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/u, "")}\n`;
}

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function toStableValue(value) {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()]
        .map(([key, entry]) => [String(key), toStableValue(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  if (value instanceof Set) {
    return [...value].map(toStableValue).sort(stableCompare);
  }

  if (Array.isArray(value)) {
    return value.map(toStableValue).sort(stableCompare);
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, toStableValue(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }

  return value;
}

function stableCompare(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function pascalCase(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function union(values) {
  const entries = [...values].sort();
  return entries.length > 0 ? entries.map((value) => JSON.stringify(value)).join(" | ") : "never";
}

function mapFromEntries(entries, reverse = false) {
  return new Map(reverse ? [...entries].toReversed() : entries);
}

function setFrom(entries, reverse = false) {
  return new Set(reverse ? [...entries].toReversed() : entries);
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CodegenContractError("HOBO_CODEGEN_USAGE", `Option "${flag}" requires a value.`, {
      exitCode: 2,
    });
  }
  return value;
}

function codegenHelp() {
  return `Usage: hobo codegen [--check] [--json] [--guest-language ts]\n`;
}
