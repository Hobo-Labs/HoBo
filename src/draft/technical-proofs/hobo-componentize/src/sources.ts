import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

import type { ComponentizeSpec, SourceFileDigest } from "./types.js";
import { stableStringify } from "./json.js";


const FORBIDDEN_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Date.now", /\bDate\.now\s*\(/],
  ["new Date", /\bnew\s+Date\s*\(/],
  ["Math.random", /\bMath\.random\s*\(/],
  ["process.cwd", /\bprocess\.cwd\s*\(/],
];

export type PreparedSources = Readonly<{
  canonicalRoot: string;
  sources: readonly SourceFileDigest[];
  sourceContents: ReadonlyMap<string, string>;
  entryJsPath: string;
  pathRemap: string;
}>;

export async function prepareSources(spec: ComponentizeSpec): Promise<PreparedSources> {
  const canonicalRoot = await mkdtemp(join(tmpdir(), `hobo-componentize-${spec.name}-`));

  const collected = await collectSources(spec.sourceRoot);
  assertDeterministicSources(collected);

  const sourceContents = new Map<string, string>();
  const digests: SourceFileDigest[] = [];

  for (const source of collected) {
    sourceContents.set(source.path, source.content);
    digests.push({
      path: source.path,
      digest: sha256Text(source.content),
    });
    const targetPath = join(canonicalRoot, source.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, source.content, "utf8");
  }

  const entryJsPath = join(
    canonicalRoot,
    spec.entrypoint.replace(/\.ts$/u, ".js"),
  );

  return Object.freeze({
    canonicalRoot,
    sources: Object.freeze(digests),
    sourceContents,
    entryJsPath,
    pathRemap: `${basename(spec.sourceRoot)}=>/workspace/${spec.name}`,
  });
}

export async function transpileEntry(spec: ComponentizeSpec, prepared: PreparedSources): Promise<void> {
  const typescript = await import("typescript");
  const entryTsPath = join(prepared.canonicalRoot, spec.entrypoint);
  const source = await readFile(entryTsPath, "utf8");
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
    },
    fileName: entryTsPath,
  });
  await mkdir(dirname(prepared.entryJsPath), { recursive: true });
  await writeFile(prepared.entryJsPath, output.outputText, "utf8");
}

export function inputsDigest(
  spec: ComponentizeSpec,
  sources: readonly SourceFileDigest[],
  pathRemap: string,
): string {
  return sha256Text(
    stableStringify({
      name: spec.name,
      sourceDateEpoch: spec.sourceDateEpoch,
      toolchain: spec.toolchain,
      pathRemap,
      sources,
      witDir: spec.witDir,
      worldName: spec.worldName,
      entrypoint: spec.entrypoint,
    }),
  );
}

async function collectSources(root: string) {
  const files = await listFiles(join(root, "src"));
  return Promise.all(
    files
      .filter((file) => file.endsWith(".ts"))
      .sort()
      .map(async (file) => ({
        path: normalizeRelativePath(relative(root, file)),
        content: await readFile(file, "utf8"),
      })),
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
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

function assertDeterministicSources(
  sources: ReadonlyArray<{ path: string; content: string }>,
) {
  for (const source of sources) {
    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      if (pattern.test(source.content)) {
        throw new Error(`componentize.nondeterministic_source: ${label} in ${source.path}`);
      }
    }
  }
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}
