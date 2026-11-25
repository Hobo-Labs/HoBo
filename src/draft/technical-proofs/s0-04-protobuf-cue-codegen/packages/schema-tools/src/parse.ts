import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CodegenInvocation } from "./types.js";

const DRAFT_POC_PACKAGES = "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/packages";

function defaultSchemaToolsDir(repoRoot: string): string {
  return resolve(repoRoot, DRAFT_POC_PACKAGES, "schema-tools");
}

function defaultPackagesRoot(repoRoot: string): string {
  const production = resolve(repoRoot, "packages");
  const draft = resolve(repoRoot, DRAFT_POC_PACKAGES);
  // Promote to production packages only after S0-04 lands @hobo/schema-tools under packages/.
  if (existsSync(resolve(production, "schema-tools", "package.json"))) return production;
  if (existsSync(draft)) return draft;
  return production;
}

export function parseCodegenArgv(argv: readonly string[], cwd = process.cwd()): CodegenInvocation {
  const repoRoot = resolve(cwd);
  const schemaToolsPackageDir = defaultSchemaToolsDir(repoRoot);
  let check = false;
  let json = false;
  let filter: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") {
      check = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--filter") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("missing value for --filter <pkgDir>");
      }
      filter = resolve(repoRoot, value);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unknown flag: ${token}`);
    }
    throw new Error(`unexpected argument: ${token}`);
  }

  const packagesRoot = defaultPackagesRoot(repoRoot);
  const bufTemplate = resolve(repoRoot, "buf.gen.yaml");

  return Object.freeze({
    repoRoot,
    packagesRoot,
    check,
    json,
    filter,
    bufTemplate,
    schemaToolsPackageDir,
  });
}

export function resolveFromModule(moduleUrl: string): string {
  return fileURLToPath(moduleUrl);
}
