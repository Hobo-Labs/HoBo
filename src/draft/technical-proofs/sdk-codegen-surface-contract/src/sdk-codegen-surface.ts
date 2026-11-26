import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { isJsonObject } from "./json.js";


const GENERATED_ROOTS = [".hobo/generated", "src/_generated"];

export class CodegenSurfaceError extends Error {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = "CodegenSurfaceError";
    this.code = code;
    this.path = path;
  }
}

export function fixtureSdkSources(overrides = {}) {
  const reverse = Boolean(overrides.reverse);
  const allowScopes = overrides.allowScopes ?? {
    db: ["read", "write", "query"],
    uploads: ["read"],
  };
  const records = [
    {
      name: "Ticket",
      fields: [
        { name: "id", type: "string" },
        { name: "title", type: "string" },
        { name: "status", type: '"open" | "closed"', zod: 'z.enum(["closed", "open"])' },
      ],
    },
    {
      name: "TicketDraft",
      fields: [
        { name: "title", type: "string" },
        { name: "body", type: "string" },
      ],
    },
    {
      name: "TicketEmailInput",
      fields: [
        { name: "ticketId", type: "string" },
        { name: "recipient", type: "string" },
      ],
    },
    {
      name: "TicketEmailResult",
      fields: [{ name: "sent", type: "boolean" }],
    },
    {
      name: "CloseTicketInput",
      fields: [{ name: "ticketId", type: "string" }],
    },
    {
      name: "CloseTicketResult",
      fields: [{ name: "closed", type: "boolean" }],
    },
  ];
  const _resources = [
    {
      name: "db",
      kind: "data",
      clientType: "DataClient",
      port: "hobo:data",
      allow: allowScopes.db ?? [],
    },
    {
      name: "uploads",
      kind: "bucket",
      clientType: "BlobClient",
      port: "wasi:blobstore",
      allow: allowScopes.uploads ?? [],
    },
  ];
  const api = [
    {
      path: "api.tickets.create",
      kind: "mutation",
      name: "createTicket",
      input: "TicketDraft",
      returns: "Ticket",
    },
    {
      path: "api.tickets.list",
      kind: "query",
      name: "listTickets",
      returns: "Ticket",
    },
  ];
  const steps = [
    {
      name: "sendTicketEmail",
      input: "TicketEmailInput",
      returns: "TicketEmailResult",
    },
  ];
  const workflows = [
    {
      name: "closeTicket",
      input: "CloseTicketInput",
      returns: "CloseTicketResult",
    },
  ];
  const providerOptions = [
    {
      annotation: "aws.rds",
      typeName: "AwsRdsOptions",
      fields: [
        { name: "multiAz", type: "boolean" },
        { name: "backupRetentionDays", type: "number" },
      ],
    },
  ];
  const rawEscapes = [
    {
      name: "legacyRows",
      resource: "db",
      type: "unknown",
      portability: "flagged",
    },
  ];

  return {
    wit: {
      interfaces: maybeReverse(
        [
          { name: "hobo:data", operations: ["read", "write", "query"] },
          { name: "wasi:blobstore", operations: ["read"] },
          { name: "hobo:workflow", operations: ["closeTicket"] },
        ],
        reverse,
      ),
      records: maybeReverse(records, reverse),
    },
    zodSchemas: {
      records: maybeReverse(records, reverse),
    },
    allowScopes: reverseObject(allowScopes, reverse),
    bindleGraph: {
      components: maybeReverse(
        [
          {
            name: "api",
            bindings: reverseObject({ db: "db", uploads: "uploads" }, reverse),
          },
        ],
        reverse,
      ),
      api: maybeReverse(api, reverse),
      steps: maybeReverse(steps, reverse),
      workflows: maybeReverse(workflows, reverse),
    },
    providerOptions: maybeReverse(providerOptions, reverse),
    rawEscapes: maybeReverse(rawEscapes, reverse),
    coverage: overrides.coverage ?? { ok: true, unobservedResources: [] },
  };
}

export function generateSdkCodegenArtifacts({ sources }) {
  const normalized = normalizeSources(sources);
  assertCoverage(normalized.coverage);

  const artifacts = [
    artifact(".hobo/generated/codegen-manifest.json", generateManifest(normalized)),
    artifact(".hobo/generated/domain.pb.json", generateProtobufDescriptor(normalized)),
    artifact(".hobo/generated/mcp-codegen-tool.json", generateMcpToolManifest(normalized)),
    artifact("src/_generated/api-tree.d.ts", generateApiTree(normalized)),
    artifact("src/_generated/bindings.d.ts", generateBindings(normalized)),
    artifact("src/_generated/domain.d.ts", generateDomainTypes(normalized)),
    artifact("src/_generated/domain.zod.ts", generateZodSchemas(normalized)),
    artifact("src/_generated/hooks.d.ts", generateHooks(normalized)),
    artifact("src/_generated/steps.d.ts", generateSteps(normalized)),
    artifact("src/_generated/with-options.d.ts", generateProviderOptions(normalized)),
    artifact("src/_generated/workflows.d.ts", generateWorkflows(normalized)),
  ];

  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export async function withTempSdkProject(callback) {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-sdk-codegen-"));
  try {
    await mkdir(join(projectRoot, "src"), { recursive: true });
    await callback(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

export async function writeGeneratedTree(projectRoot, artifacts) {
  for (const { path, content } of artifacts) {
    const target = join(projectRoot, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

export async function compareGeneratedTree(projectRoot, artifacts) {
  const expected = new Map(artifacts.map((entry) => [entry.path, entry.content]));
  const actualPaths = await listGeneratedPaths(projectRoot);
  const drift = [];

  for (const actualPath of actualPaths) {
    if (!expected.has(actualPath)) {
      drift.push({ status: "deleted", path: actualPath });
    }
  }

  for (const [expectedPath, expectedContent] of expected) {
    const target = join(projectRoot, ...expectedPath.split("/"));
    let actualContent;
    try {
      actualContent = await readFile(target, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        drift.push({ status: "added", path: expectedPath });
        continue;
      }
      throw error;
    }
    if (actualContent !== expectedContent) {
      drift.push({ status: "changed", path: expectedPath });
    }
  }

  const order = { deleted: 0, changed: 1, added: 2 };
  return drift.sort((left, right) => {
    const byStatus = order[left.status] - order[right.status];
    return byStatus || left.path.localeCompare(right.path);
  });
}

export function createSdkCodegenCommand({ sources }) {
  return {
    async run(args, { cwd }) {
      if (!Array.isArray(args) || args[0] !== "codegen") {
        return result(1, "", "usage: hobo codegen [--check] [--json]\n");
      }

      try {
        const check = args.includes("--check");
        const json = args.includes("--json");
        const artifacts = generateSdkCodegenArtifacts({ sources });
        if (check) {
          const drift = await compareGeneratedTree(cwd, artifacts);
          if (drift.length > 0) {
            return result(
              1,
              json ? `${JSON.stringify({ ok: false, code: "HOBO_CODEGEN_DRIFT", drift })}\n` : "",
              json ? "" : `Generated tree drift\n${formatDrift(drift)}\n`,
            );
          }
          return result(
            0,
            json ? `${JSON.stringify({ ok: true, drift: [], generatedPaths: artifactPaths(artifacts) })}\n` : "",
            "",
          );
        }

        await writeGeneratedTree(cwd, artifacts);
        return result(
          0,
          json ? `${JSON.stringify({ ok: true, written: artifactPaths(artifacts) })}\n` : "",
          "",
        );
      } catch (error) {
        if (error instanceof CodegenSurfaceError) {
          return result(1, "", `${error.code}: ${error.message}\n`);
        }
        throw error;
      }
    },
  };
}

export function createMcpCodegenTool({ sources }) {
  return {
    async invoke({ cwd, check = false }) {
      const artifacts = generateSdkCodegenArtifacts({ sources });
      const generatedPaths = artifactPaths(artifacts);
      if (!check) {
        await writeGeneratedTree(cwd, artifacts);
        return { ok: true, drift: [], generatedPaths };
      }
      const drift = await compareGeneratedTree(cwd, artifacts);
      return { ok: drift.length === 0, drift, generatedPaths };
    },
  };
}

function normalizeSources(sources) {
  if (!sources || !isJsonObject(sources)) {
    throw new CodegenSurfaceError("HOBO_CODEGEN_BAD_INPUT", "sources", "must be an object");
  }
  const records = sortByName(sources.wit?.records ?? []);
  const resources = sortByName(
    Object.entries(sources.allowScopes ?? {}).map(([name, allow]) => {
      const fixture = (sources.bindleGraph?.components ?? [])
        .flatMap((component) => Object.entries(component.bindings ?? {}))
        .find(([, resource]) => resource === name);
      return {
        name,
        allow: [...allow],
        clientType: name === "uploads" ? "BlobClient" : "DataClient",
        kind: name === "uploads" ? "bucket" : "data",
        port: name === "uploads" ? "wasi:blobstore" : "hobo:data",
        bindingAlias: fixture?.[0] ?? name,
      };
    }),
  );

  return {
    wit: {
      interfaces: sortByName(sources.wit?.interfaces ?? []).map((entry) => ({
        ...entry,
        operations: [...(entry.operations ?? [])].sort(),
      })),
      records,
    },
    zodSchemas: {
      records: sortByName(sources.zodSchemas?.records ?? records),
    },
    resources,
    bindleGraph: {
      components: sortByName(sources.bindleGraph?.components ?? []),
      api: sortByPath(sources.bindleGraph?.api ?? []),
      steps: sortByName(sources.bindleGraph?.steps ?? []),
      workflows: sortByName(sources.bindleGraph?.workflows ?? []),
    },
    providerOptions: sortByAnnotation(sources.providerOptions ?? []).map((entry) => ({
      ...entry,
      fields: sortByName(entry.fields ?? []),
    })),
    rawEscapes: sortByName(sources.rawEscapes ?? []),
    coverage: sources.coverage ?? { ok: true, unobservedResources: [] },
  };
}

function assertCoverage(coverage) {
  if (coverage?.ok === false) {
    const resources = [...(coverage.unobservedResources ?? [])].sort();
    throw new CodegenSurfaceError(
      "HOBO_CODEGEN_COVERAGE_GAP",
      "coverage",
      `collection coverage gap for ${resources.join(", ")}`,
    );
  }
}

function generateManifest(sources) {
  return json({
    schema: "hobo.codegen/v1",
    sourceDigest: stableDigest(sources),
    sources: {
      wit: {
        interfaces: sources.wit.interfaces.map((entry) => entry.name),
        records: sources.wit.records.map((entry) => entry.name),
      },
      zodSchemas: sources.zodSchemas.records.map((entry) => entry.name),
      allowScopes: Object.fromEntries(
        sources.resources.map((resource) => [resource.name, resource.allow]),
      ),
      bindleGraph: {
        components: sources.bindleGraph.components.map((entry) => entry.name),
        api: sources.bindleGraph.api.map((entry) => entry.path),
      },
    },
    generated: [
      "typed ctx.bindings clients",
      "typed hooks",
      "typed workflow and step signatures",
      "typed provider .with options",
      "typed api function tree",
      "protobuf descriptors",
      "zod validators",
    ],
    rawEscapes: sources.rawEscapes,
  });
}

function generateProtobufDescriptor(sources) {
  return json({
    syntax: "proto3",
    package: "hobo.generated",
    messages: Object.fromEntries(
      sources.wit.records.map((record) => [
        record.name,
        {
          fields: Object.fromEntries(
            record.fields.map((field, index) => [
              field.name,
              {
                id: index + 1,
                type: protobufType(field.type),
              },
            ]),
          ),
        },
      ]),
    ),
  });
}

function generateMcpToolManifest(sources) {
  return json({
    name: "hobo.codegen",
    parity: "cli",
    checkMode: true,
    generatedPaths: [
      ".hobo/generated/codegen-manifest.json",
      ".hobo/generated/domain.pb.json",
      "src/_generated/api-tree.d.ts",
      "src/_generated/bindings.d.ts",
      "src/_generated/domain.d.ts",
      "src/_generated/domain.zod.ts",
      "src/_generated/hooks.d.ts",
      "src/_generated/steps.d.ts",
      "src/_generated/with-options.d.ts",
      "src/_generated/workflows.d.ts",
    ],
    sourceDigest: stableDigest(sources),
  });
}

function generateDomainTypes(sources) {
  return [
    generatedHeader(),
    ...sources.wit.records.map((record) => {
      const fields = record.fields
        .map((field) => `  readonly ${field.name}: ${field.type};`)
        .join("\n");
      return `export interface ${record.name} {\n${fields}\n}`;
    }),
    "",
  ].join("\n\n");
}

function generateZodSchemas(sources) {
  const records = sources.zodSchemas.records.map((record) => {
    const fields = record.fields
      .map((field) => `  ${field.name}: ${field.zod ?? zodFor(field.type)},`)
      .join("\n");
    return `export const ${record.name}Schema = z.object({\n${fields}\n});`;
  });
  return [generatedHeader(), 'import { z } from "zod";', ...records, ""].join("\n\n");
}

function generateBindings(sources) {
  const bindingLines = sources.resources.map((resource) => {
    const verbs = union(resource.allow);
    if (resource.clientType === "BlobClient") {
      return `  readonly ${resource.bindingAlias}: BlobClient<"${resource.name}", ${verbs}>;`;
    }
    return `  readonly ${resource.bindingAlias}: DataClient<"${resource.name}", ${verbs}>;`;
  });
  const rawLines = sources.rawEscapes.map(
    (escape) => `  readonly ${escape.name}: RawQuery<"${escape.resource}", ${escape.type}>;`,
  );

  return [
    generatedHeader(),
    `export interface DataClient<Name extends string, Verbs extends string> {
  readonly name: Name;
  read(id: string): Verbs extends "read" ? Promise<JsonValue> : never;
  write(id: string, value: JsonValue): Verbs extends "write" ? Promise<void> : never;
  query(filter: JsonValue): Verbs extends "query" ? Promise<readonly unknown[]> : never;
}`,
    `export interface BlobClient<Name extends string, Verbs extends string> {
  readonly name: Name;
  read(key: string): Verbs extends "read" ? Promise<Uint8Array> : never;
}`,
    `export interface RawQuery<Resource extends string, Result> {
  readonly resource: Resource;
  readonly portability: "flagged";
  execute(statement: string): Result;
}`,
    `export interface CtxBindings {\n${[...bindingLines, ...rawLines].join("\n")}\n}`,
    "",
  ].join("\n\n");
}

function generateApiTree(sources) {
  const imports = `import type { ${recordNames(sources).join(", ")} } from "./domain";`;
  const refs = sources.bindleGraph.api.map((entry) => {
    if (entry.kind === "mutation") {
      return `  readonly "${entry.path}": MutationRef<"${entry.name}", ${entry.input}, ${entry.returns}>;`;
    }
    return `  readonly "${entry.path}": QueryRef<"${entry.name}", ${entry.returns}>;`;
  });

  return [
    generatedHeader(),
    imports,
    `export interface QueryRef<Name extends string, Returns> {
  readonly name: Name;
  readonly returns: Returns;
}`,
    `export interface MutationRef<Name extends string, Input, Returns> {
  readonly name: Name;
  readonly input: Input;
  readonly returns: Returns;
}`,
    `export interface ApiTree {\n${refs.join("\n")}\n}`,
    "",
  ].join("\n\n");
}

function generateHooks(sources) {
  const queryNames = sources.bindleGraph.api
    .filter((entry) => entry.kind === "query")
    .map((entry) => entry.name);
  return [
    generatedHeader(),
    `import type { ApiTree } from "./api-tree";`,
    `export declare function useQuery<Name extends ${union(queryNames)}>(name: Name): ApiTree[keyof ApiTree]["returns"];`,
    `export declare function useSubscription<Name extends ${union(queryNames)}>(name: Name): AsyncIterable<ApiTree[keyof ApiTree]["returns"]>;`,
    "",
  ].join("\n\n");
}

function generateSteps(sources) {
  return [
    generatedHeader(),
    `import type { ${recordNames(sources).join(", ")} } from "./domain";`,
    ...sources.bindleGraph.steps.map(
      (step) =>
        `export declare function ${step.name}(input: ${step.input}): Promise<${step.returns}>;`,
    ),
    "",
  ].join("\n\n");
}

function generateWorkflows(sources) {
  return [
    generatedHeader(),
    `import type { ${recordNames(sources).join(", ")} } from "./domain";`,
    ...sources.bindleGraph.workflows.map(
      (workflow) =>
        `export declare function ${workflow.name}(input: ${workflow.input}): Promise<${workflow.returns}>;`,
    ),
    "",
  ].join("\n\n");
}

function generateProviderOptions(sources) {
  return [
    generatedHeader(),
    ...sources.providerOptions.map((option) => {
      const fields = option.fields
        .map((field) => `  readonly ${field.name}?: ${field.type};`)
        .join("\n");
      return `export interface ${option.typeName} {\n${fields}\n}`;
    }),
    `export interface ProviderWithOptions {
${sources.providerOptions
  .map((option) => `  readonly "${option.annotation}": ${option.typeName};`)
  .join("\n")}
}`,
    "",
  ].join("\n\n");
}

async function listGeneratedPaths(projectRoot) {
  const found = [];
  for (const root of GENERATED_ROOTS) {
    const absoluteRoot = join(projectRoot, ...root.split("/"));
    await collectFiles(projectRoot, absoluteRoot, found);
  }
  return found.sort();
}

async function collectFiles(projectRoot, directory, found) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(projectRoot, absolute, found);
    } else if (entry.isFile()) {
      found.push(toPosix(relative(projectRoot, absolute)));
    }
  }
}

function artifact(path, content) {
  return { path, content };
}

function artifactPaths(artifacts) {
  return artifacts.map((entry) => entry.path);
}

function result(exitCode, stdout, stderr) {
  return { exitCode, stdout, stderr };
}

function formatDrift(drift) {
  return drift.map((entry) => `${entry.status.toUpperCase()} ${entry.path}`).join("\n");
}

function generatedHeader() {
  return "/* Generated by hobo codegen. Do not edit by hand. */";
}

function json(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

function sortByName(entries) {
  return [...entries].sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function sortByPath(entries) {
  return [...entries].sort((left, right) => String(left.path).localeCompare(String(right.path)));
}

function sortByAnnotation(entries) {
  return [...entries].sort((left, right) =>
    String(left.annotation).localeCompare(String(right.annotation)),
  );
}

function maybeReverse(values, reverse) {
  const copy = [...values];
  return reverse ? copy.reverse() : copy;
}

function reverseObject(value, reverse) {
  const entries = Object.entries(value);
  if (reverse) {
    entries.reverse();
  }
  return Object.fromEntries(entries);
}

function union(values) {
  const normalized = [...values];
  if (normalized.length === 0) {
    return "never";
  }
  return normalized.map((value) => `"${value}"`).join(" | ");
}

function recordNames(sources) {
  return sources.wit.records.map((record) => record.name);
}

function zodFor(type) {
  if (type === "boolean") {
    return "z.boolean()";
  }
  if (type === "number") {
    return "z.number()";
  }
  return "z.string()";
}

function protobufType(type) {
  if (type === "boolean") {
    return "bool";
  }
  if (type === "number") {
    return "double";
  }
  return "string";
}

function toPosix(path) {
  return path.replaceAll("\\", "/");
}
