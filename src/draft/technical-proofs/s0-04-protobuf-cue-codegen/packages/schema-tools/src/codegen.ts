import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { discoverDataModelPackages, hydrateCueSchemas } from "./discover.js";
import { ensureCueBinary, vetCueConstraints } from "./cue.js";
import {
  createCodegenReport,
  type CodegenInvocation,
  type CodegenReport,
  type CueViolation,
  type DataModelPackage,
  type DriftEntry,
} from "./types.js";
import { isJsonNumber, isJsonString, type JsonObject } from "../../../src/json.js";


async function runCommand(
  command: string,
  args: readonly string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env,
      },
      (error, stdout, stderr) => {
        if (error && isJsonString(error.code) && error.code === "ENOENT") {
          reject(new Error(`command not found: ${command}`));
          return;
        }
        const code = isJsonNumber(error?.code) ? error.code : error ? 1 : 0;
        resolvePromise({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

function resolveBufCommand(repoRoot: string) {
  if (process.platform === "win32") {
    const entrypoints = [
      join(repoRoot, "node_modules", "@bufbuild", "buf", "bin", "buf"),
      join(
        repoRoot,
        "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/node_modules/@bufbuild/buf/bin/buf",
      ),
    ];
    for (const entrypoint of entrypoints) {
      if (existsSync(entrypoint)) return { command: process.execPath, args: [entrypoint] };
    }
  }

  const candidates = [
    join(repoRoot, "node_modules", "@bufbuild", "buf", "bin", "buf"),
    join(
      repoRoot,
      "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/node_modules/.bin",
      "buf",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { command: candidate, args: [] };
  }

  const pocPackageJson = join(
    repoRoot,
    "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/package.json",
  );
  if (existsSync(pocPackageJson)) {
    try {
      const requireFromPoc = createRequire(pocPackageJson);
      const bufPackageJson = requireFromPoc.resolve("@bufbuild/buf/package.json");
      const bufBin = join(dirname(bufPackageJson), "bin", "buf");
      if (existsSync(bufBin)) {
        if (process.platform === "win32") {
          return { command: process.execPath, args: [bufBin] };
        }
        return { command: bufBin, args: [] };
      }
    } catch {
      // fall through to PATH lookup
    }
  }
  return { command: "buf", args: [] };
}

async function listFilesRecursive(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  await walk(root);
  return files;
}

function pluginPathEnv(repoRoot: string): NodeJS.ProcessEnv {
  const bins = [
    join(repoRoot, "node_modules", ".bin"),
    join(repoRoot, "src/draft/technical-proofs/s0-04-protobuf-cue-codegen/node_modules/.bin"),
  ];
  const pathValue = [...bins, process.env.PATH ?? ""].join(delimiter);
  return { ...process.env, PATH: pathValue };
}

async function generatePackageProtos(
  pkg: DataModelPackage,
  invocation: CodegenInvocation,
  outputDir: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  const buf = resolveBufCommand(invocation.repoRoot);
  const result = await runCommand(
    buf.command,
    [...buf.args, "generate", pkg.dataModelsDir, "--template", invocation.bufTemplate, "-o", outputDir],
    invocation.repoRoot,
    pluginPathEnv(invocation.repoRoot),
  );
  if (result.code !== 0) {
    const message = result.stderr || result.stdout;
    const protoMatch = message.match(/([^\s:]+\.proto)/);
    throw new Error(protoMatch ? `protobuf parse failed in ${protoMatch[1]}: ${message}` : message);
  }
}

async function _copyGeneratedTree(sourceDir: string, targetDir: string): Promise<void> {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  if (!existsSync(sourceDir)) return;
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

async function compareTrees(expectedRoot: string, actualRoot: string, labelPrefix: string): Promise<DriftEntry[]> {
  const normalizeGeneratedText = (content: string) => content.replace(/\r\n/g, "\n");
  const [expectedFiles, actualFiles] = await Promise.all([
    listFilesRecursive(expectedRoot),
    listFilesRecursive(actualRoot),
  ]);
  const expectedRel = new Map(
    expectedFiles.map((file) => [relative(expectedRoot, file).replaceAll("\\", "/"), file]),
  );
  const actualRel = new Map(actualFiles.map((file) => [relative(actualRoot, file).replaceAll("\\", "/"), file]));
  const drift: DriftEntry[] = [];

  for (const [rel, expectedPath] of [...expectedRel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const actualPath = actualRel.get(rel);
    if (!actualPath) {
      drift.push({ path: `${labelPrefix}/${rel}`, kind: "removed" });
      continue;
    }
    const [expectedContent, actualContent] = await Promise.all([
      readFile(expectedPath, "utf8"),
      readFile(actualPath, "utf8"),
    ]);
    if (normalizeGeneratedText(expectedContent) !== normalizeGeneratedText(actualContent)) {
      drift.push({ path: `${labelPrefix}/${rel}`, kind: "changed" });
    }
    actualRel.delete(rel);
  }

  for (const [rel] of [...actualRel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    drift.push({ path: `${labelPrefix}/${rel}`, kind: "added" });
  }

  return drift;
}

async function collectCueViolations(
  packages: readonly DataModelPackage[],
  repoRoot: string,
): Promise<CueViolation[]> {
  const violations: CueViolation[] = [];
  for (const pkg of packages) {
    const result = await vetCueConstraints(pkg, repoRoot);
    violations.push(...result.violations);
  }
  return violations;
}

async function generateAll(
  packages: readonly DataModelPackage[],
  invocation: CodegenInvocation,
  write: boolean,
): Promise<{ drift: DriftEntry[]; cueViolations: CueViolation[] }> {
  const stagingRoot = write
    ? undefined
    : await mkdtemp(join(homedir(), "hobo-codegen-check-"));
  const drift: DriftEntry[] = [];

  try {
    for (const pkg of packages) {
      const stagingDir = write
        ? pkg.generatedDir
        : join(stagingRoot!, pkg.name, "src", "_generated");
      const outputDir = stagingDir;
      await generatePackageProtos(pkg, invocation, outputDir);

      if (!write) {
        const pkgDrift = await compareTrees(stagingDir, pkg.generatedDir, pkg.name);
        drift.push(...pkgDrift);
      }
    }

    const cueViolations = await collectCueViolations(packages, invocation.repoRoot);
    return { drift, cueViolations };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

function resolvePackages(invocation: CodegenInvocation): DataModelPackage[] {
  const discovered = discoverDataModelPackages(invocation.repoRoot, {
    packagesRoot: invocation.packagesRoot,
    filter: invocation.filter,
  });
  if (discovered.length === 0) {
    throw new Error(`no data-model packages found under ${invocation.packagesRoot}`);
  }
  return discovered;
}

export async function runCodegen(invocation: CodegenInvocation): Promise<CodegenReport> {
  const started = Date.now();
  const packages = await hydrateCueSchemas(resolvePackages(invocation));
  const { cueViolations } = await generateAll(packages, invocation, true);
  const status = cueViolations.length > 0 ? "ERROR" : "CLEAN";
  return createCodegenReport({ status, cueViolations, durationMs: Date.now() - started });
}

export async function checkCodegen(invocation: CodegenInvocation): Promise<CodegenReport> {
  const started = Date.now();
  const packages = await hydrateCueSchemas(resolvePackages(invocation));
  const { drift, cueViolations } = await generateAll(packages, invocation, false);
  let status: "CLEAN" | "DRIFT" | "ERROR" = "CLEAN";
  if (cueViolations.length > 0) status = "ERROR";
  else if (drift.length > 0) status = "DRIFT";
  return createCodegenReport({ status, drift, cueViolations, durationMs: Date.now() - started });
}

export async function sha256Directory(root: string): Promise<string> {
  const files = await listFilesRecursive(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

export async function writeManifest(path: string, content: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`);
}

export async function preflightBuf(invocation: CodegenInvocation): Promise<void> {
  await ensureCueBinary(invocation.repoRoot);
  if (!existsSync(invocation.bufTemplate)) {
    throw new Error(`buf template missing: ${invocation.bufTemplate}`);
  }
}
