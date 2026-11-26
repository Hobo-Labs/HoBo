import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ResourceKind = "api" | "cache" | "queue";
export type RelationshipVerb = "dependsOn";

export interface ClosureBuilderResource {
  readonly alias: string;
  readonly generatedId: string;
  readonly kind: ResourceKind;
  readonly fileName: string;
  readonly line: number;
}

export interface ClosureBuilderRelationship {
  readonly from: string;
  readonly to: string;
  readonly verb: RelationshipVerb;
}

export interface ClosureBuilderManifest {
  readonly schema: "hobo.manifest/v1";
  readonly name: string;
  readonly resources: readonly ClosureBuilderResource[];
  readonly relationships: readonly ClosureBuilderRelationship[];
}

export interface ClosureBuilderCoverage {
  readonly ok: boolean;
  readonly status: "pass" | "fail";
  readonly observedResourceIds: readonly string[];
  readonly unobservedResources: readonly ClosureBuilderResource[];
  readonly diagnostics: readonly ClosureBuilderDiagnostic[];
}

export interface ClosureBuilderDiagnostic {
  readonly code: string;
  readonly severity: "error";
  readonly alias: string;
  readonly generatedId: string;
  readonly fileName: string;
  readonly line: number;
  readonly message: string;
}

export interface ClosureBuilderToolingResult {
  readonly manifest: ClosureBuilderManifest;
  readonly coverage: ClosureBuilderCoverage;
  readonly codegen: {
    readonly declarations: string;
  };
}

export class ClosureBuilderToolingError extends Error {
  readonly code: string;
  readonly diagnostics: readonly ClosureBuilderDiagnostic[];

  constructor(code: string, message: string, diagnostics: readonly ClosureBuilderDiagnostic[] = []) {
    super(`${code}: ${message}`);
    this.name = "ClosureBuilderToolingError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const DECLARATION_CALL =
  /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*b\.(api|cache|queue)(?:<[^>]+>)?\s*\(/g;
const LEGACY_PATTERNS = [
  /\bb\.use\s*\(/,
  /\b(?:api|cache|queue)\s*\(\s*["'`][^"'`]+["'`]/,
  /\.(?:uses|bind|bindTo|requires)\s*\(/,
];

export function canonicalClosureBuilderSource(): string {
  return `import { bindle } from "@hobo/bindles";
import myApi from "./services/api";

export default bindle("shop", (b) => {
  const cache = b.cache();
  const api = b.api(() => myApi.run()).dependsOn(cache);
  const workQueue = b.queue<{ orderId: string }>().dependsOn(api);

  return { cache, api, workQueue };
});
`;
}

export interface ClosureBuilderScaffold {
  readonly files: { readonly [path: string]: string };
  readonly nextCommands: readonly string[];
}

export function canonicalClosureBuilderScaffold(name: string): ClosureBuilderScaffold {
  const safeName = parseProjectName(name);
  return {
    files: {
      "app.bindle.ts": canonicalClosureBuilderSource().replace('bindle("shop"', `bindle("${safeName}"`),
      "package.json": `${JSON.stringify({ name: safeName, private: true, type: "module" }, null, 2)}\n`,
    },
    nextCommands: ["hobo collect --json", "hobo codegen --check"],
  };
}

export function assertClosureBuilderTooling(input: {
  readonly sourceText: string;
  readonly observedResourceIds?: readonly string[];
  readonly fileName?: string;
}): ClosureBuilderToolingResult {
  const result = evaluateClosureBuilderTooling(input);
  if (!result.coverage.ok) {
    throw new ClosureBuilderToolingError(
      "CLOSURE_BUILDER_TOOLING_COVERAGE_GAP",
      result.coverage.diagnostics.map((diagnostic) => diagnostic.message).join(" "),
      result.coverage.diagnostics,
    );
  }
  return result;
}

export function evaluateClosureBuilderTooling(input: {
  readonly sourceText: string;
  readonly observedResourceIds?: readonly string[];
  readonly fileName?: string;
}): ClosureBuilderToolingResult {
  const fileName = input.fileName ?? "app.bindle.ts";
  assertNoLegacyClosureBuilderSyntax(input.sourceText);
  const resources = parseClosureBuilderResources(input.sourceText, fileName);
  assertReturnedAliases(input.sourceText, fileName, resources);
  const manifest = parseManifest(input.sourceText, fileName, resources);
  const coverage = evaluateCoverage(resources, input.observedResourceIds ?? resources.map((resource) => resource.generatedId));

  return {
    manifest,
    coverage,
    codegen: {
      declarations: renderGeneratedAliasDeclarations(manifest),
    },
  };
}

export function assertNoLegacyClosureBuilderSyntax(sourceText: string): string {
  for (const pattern of LEGACY_PATTERNS) {
    const match = pattern.exec(sourceText);
    if (match) {
      throw new ClosureBuilderToolingError(
        "CLOSURE_BUILDER_TOOLING_LEGACY_SYNTAX",
        `closure-builder tooling must not accept pre-v1 syntax ${match[0]}`,
      );
    }
  }
  return sourceText;
}

export async function typecheckGeneratedAliases(declarations: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "hobo-closure-builder-aliases-"));
  try {
    await writeFile(join(dir, "generated.d.ts"), declarations);
    await writeFile(
      join(dir, "consumer.ts"),
      `import type { ClosureBuilderAliases } from "./generated.js";\n\n` +
        `declare const aliases: ClosureBuilderAliases;\n` +
        `const cacheId: "res_0001" = aliases.cache.generatedId;\n` +
        `const apiKind: "api" = aliases.api.kind;\n` +
        `// @ts-expect-error alias names are not resource IDs\n` +
        `const aliasAsId: "cache" = aliases.cache.generatedId;\n` +
        `export const proof = { cacheId, apiKind, aliasAsId };\n`,
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
      "consumer.ts",
    ];
    // Resolve the workspace TypeScript compiler directly instead of a bare
    // `tsc` on PATH: test lanes that do not put node_modules/.bin on PATH
    // (the root sharded runner) otherwise fail with spawnSync tsc ENOENT.
    const tscJs = createRequire(import.meta.url).resolve(
      "typescript/lib/tsc.js",
    );
    execFileSync(process.execPath, [tscJs, ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseClosureBuilderResources(sourceText: string, fileName: string): ClosureBuilderResource[] {
  const resources: ClosureBuilderResource[] = [];
  for (const match of sourceText.matchAll(DECLARATION_CALL)) {
    resources.push({
      alias: match[1],
      generatedId: `res_${String(resources.length + 1).padStart(4, "0")}`,
      // SAFETY: assertion to `kind: match[2] as ResourceKind,` is required at this boundary.
      kind: match[2] as ResourceKind,
      fileName,
      line: lineAt(sourceText, match.index ?? 0),
    });
  }

  if (resources.length === 0) {
    throw new ClosureBuilderToolingError(
      "CLOSURE_BUILDER_TOOLING_NO_RESOURCES",
      "closure-builder tooling expected b.cache(), b.api(), or b.queue() resources",
    );
  }

  return resources;
}

function assertReturnedAliases(
  sourceText: string,
  fileName: string,
  resources: readonly ClosureBuilderResource[],
): void {
  const returnedAliases = parseReturnedAliases(sourceText);
  const returnedSet = new Set(returnedAliases);
  const declaredSet = new Set(resources.map((resource) => resource.alias));

  for (const resource of resources) {
    if (!returnedSet.has(resource.alias)) {
      throw new ClosureBuilderToolingError(
        "CLOSURE_BUILDER_TOOLING_UNRETURNED_RESOURCE",
        `${fileName}:${resource.line} closure-builder resource alias ${resource.alias} is declared but not returned`,
      );
    }
  }

  for (const alias of returnedAliases) {
    if (!declaredSet.has(alias)) {
      throw new ClosureBuilderToolingError(
        "CLOSURE_BUILDER_TOOLING_UNKNOWN_RETURN_ALIAS",
        `${fileName} return object contains unknown closure-builder alias ${alias}`,
      );
    }
  }
}

function parseReturnedAliases(sourceText: string): string[] {
  const match = /return\s*\{([^}]*)\}/m.exec(sourceText);
  if (!match) {
    throw new ClosureBuilderToolingError(
      "CLOSURE_BUILDER_TOOLING_RETURN_OBJECT",
      "closure-builder tooling expected return { ... } aliases",
    );
  }

  return match[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(":")[0]?.trim() ?? "")
    .filter(Boolean);
}

function parseManifest(
  sourceText: string,
  fileName: string,
  resources: readonly ClosureBuilderResource[],
): ClosureBuilderManifest {
  const bindleName = /bindle\(\s*["'`]([^"'`]+)["'`]/.exec(sourceText)?.[1];
  if (!bindleName) {
    throw new ClosureBuilderToolingError(
      "CLOSURE_BUILDER_TOOLING_BINDLE_NAME",
      "closure-builder tooling expected bindle(name, builderFn)",
    );
  }

  const byAlias = new Map(resources.map((resource) => [resource.alias, resource]));
  const relationships: ClosureBuilderRelationship[] = [];
  for (const from of resources) {
    const statement = declarationStatementForAlias(sourceText, from.alias);
    const dependsOn = /\.dependsOn\(([^)]*)\)/.exec(statement);
    if (!dependsOn) continue;

    const dependencies = dependsOn[1].split(",").map((dependency) => dependency.trim()).filter(Boolean);
    for (const dependency of dependencies) {
      const to = byAlias.get(dependency);
      if (!to) {
        throw new ClosureBuilderToolingError(
          "CLOSURE_BUILDER_TOOLING_UNKNOWN_DEPENDENCY",
          `${fileName}:${from.line} unknown dependsOn() alias ${dependency}`,
        );
      }
      relationships.push({ from: from.generatedId, to: to.generatedId, verb: "dependsOn" });
    }
  }

  return {
    schema: "hobo.manifest/v1",
    name: bindleName,
    resources,
    relationships,
  };
}

function evaluateCoverage(
  resources: readonly ClosureBuilderResource[],
  observedResourceIds: readonly string[],
): ClosureBuilderCoverage {
  const observed = [...new Set(observedResourceIds)];
  const observedSet = new Set(observed);
  const unobservedResources = resources.filter((resource) => !observedSet.has(resource.generatedId));
  const diagnostics = unobservedResources.map((resource) => ({
    code: "closureBuilder.coverage.unobserved-resource",
    severity: "error" as const,
    alias: resource.alias,
    generatedId: resource.generatedId,
    fileName: resource.fileName,
    line: resource.line,
    message: `Closure-builder resource alias ${resource.alias} (${resource.generatedId}) is statically declared but was not observed by collection.`,
  }));

  return {
    ok: diagnostics.length === 0,
    status: diagnostics.length === 0 ? "pass" : "fail",
    observedResourceIds: observed,
    unobservedResources,
    diagnostics,
  };
}

function renderGeneratedAliasDeclarations(manifest: ClosureBuilderManifest): string {
  const rows = manifest.resources
    .map(
      (resource) =>
        `  readonly ${resource.alias}: ResourceBinding<"${resource.generatedId}", "${resource.kind}">;`,
    )
    .join("\n");
  return `export interface ResourceBinding<GeneratedId extends string, Kind extends string> {
  readonly generatedId: GeneratedId;
  readonly kind: Kind;
}

export interface ClosureBuilderAliases {
${rows}
}
`;
}

function parseProjectName(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/i.test(name) || name.includes("..")) {
    throw new ClosureBuilderToolingError(
      "CLOSURE_BUILDER_TOOLING_PROJECT_NAME",
      `unsafe closure-builder scaffold name ${name}`,
    );
  }
  return name;
}

function declarationStatementForAlias(sourceText: string, alias: string): string {
  const start = sourceText.search(new RegExp(`\\bconst\\s+${escapeRegExp(alias)}\\s*=`));
  if (start === -1) return "";
  const end = sourceText.indexOf(";", start);
  return end === -1 ? sourceText.slice(start) : sourceText.slice(start, end + 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineAt(sourceText: string, index: number): number {
  return sourceText.slice(0, index).split("\n").length;
}
