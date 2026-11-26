import { existsSync, readdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DataModelPackage } from "./types.js";

async function listCueSchemas(dataModelsDir: string): Promise<string[]> {
  const entries = await readdir(dataModelsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".cue"))
    .map((entry) => join(dataModelsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export function discoverDataModelPackages(
  repoRoot: string,
  options: { packagesRoot?: string; filter?: string } = {},
): DataModelPackage[] {
  const packagesRoot = resolve(options.packagesRoot ?? join(repoRoot, "packages"));
  if (!existsSync(packagesRoot)) return [];

  const packageNames = readdirSyncSorted(packagesRoot);
  const discovered: DataModelPackage[] = [];

  for (const name of packageNames) {
    const packageDir = join(packagesRoot, name);
    const dataModelsDir = join(packageDir, "data-models");
    if (!existsSync(dataModelsDir)) continue;
    // A package opts into codegen by giving its data-models a buf module
    // marker; bare .proto/.cue folders are documentation-only until they do.
    if (!existsSync(join(dataModelsDir, "buf.yaml"))) continue;
    if (options.filter && !packageDir.startsWith(resolve(options.filter))) continue;

    discovered.push(
      Object.freeze({
        name,
        packageDir,
        dataModelsDir,
        generatedDir: join(packageDir, "src", "_generated"),
        cueSchemas: [],
      }),
    );
  }

  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

export async function hydrateCueSchemas(packages: readonly DataModelPackage[]): Promise<DataModelPackage[]> {
  const hydrated: DataModelPackage[] = [];
  for (const pkg of packages) {
    hydrated.push(
      Object.freeze({
        ...pkg,
        cueSchemas: Object.freeze(await listCueSchemas(pkg.dataModelsDir)),
      }),
    );
  }
  return hydrated;
}

function readdirSyncSorted(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}
