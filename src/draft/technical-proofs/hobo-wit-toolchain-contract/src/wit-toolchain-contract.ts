import { isJsonString } from "./json.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const WIT_SOURCE_PATH = join(PACKAGE_ROOT, "wit", "hobo-sdk.wit");
export const LOCK_PATH = join(PACKAGE_ROOT, "toolchain-lock.json");
export const GENERATED_ROOT = join(PACKAGE_ROOT, "generated");
export const JCO_PATH = join(
  PACKAGE_ROOT,
  "node_modules",
  "@bytecodealliance",
  "jco",
  "src",
  "jco.js",
);

export const EXPECTED_INTERFACES = Object.freeze([
  "workflow",
  "actor",
  "saga",
  "agent",
  "command",
  "subscribe",
  "capability",
  "data",
]);

export async function readWitSource(path = WIT_SOURCE_PATH) {
  return (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
}

export async function readToolchainLock(path = LOCK_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readPackageJson(path = join(PACKAGE_ROOT, "package.json")) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function parseHoboSdkSkeleton(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const packageMatch = normalized.match(/^package\s+hobo:sdk@([0-9]+\.[0-9]+\.[0-9]+);/m);
  if (!packageMatch) {
    throw new Error("wit_toolchain.missing_package: hobo:sdk@0.1.0");
  }

  const interfaces = {};
  const interfacePattern = /^interface\s+([a-z][a-z0-9-]*)\s+\{([\s\S]*?)^}/gm;
  let match;

  while ((match = interfacePattern.exec(normalized)) !== null) {
    const [, name, body] = match;
    const functions = [...body.matchAll(/^\s*([a-z][a-z0-9-]*):\s+func\(/gm)].map(
      (funcMatch) => funcMatch[1],
    );
    interfaces[name] = { functions };
  }

  const worldMatch = normalized.match(/^world\s+sdk\s+\{([\s\S]*?)^}/m);
  if (!worldMatch) {
    throw new Error("wit_toolchain.missing_world: sdk");
  }

  const imports = [...worldMatch[1].matchAll(/^\s*import\s+([a-z][a-z0-9-]*);/gm)].map(
    (importMatch) => importMatch[1],
  );

  const missing = EXPECTED_INTERFACES.filter((name) => !interfaces[name]);
  if (missing.length > 0) {
    throw new Error(`wit_toolchain.missing_interfaces: ${missing.join(",")}`);
  }

  const unexpectedFunctions = Object.entries(interfaces)
    .filter(([name, entry]) => EXPECTED_INTERFACES.includes(name) && entry.functions.length > 0)
    .map(([name]) => name);
  if (unexpectedFunctions.length > 0) {
    throw new Error(`wit_toolchain.scope_creep_filled_interfaces: ${unexpectedFunctions.join(",")}`);
  }

  if (imports.join(",") !== EXPECTED_INTERFACES.join(",")) {
    throw new Error(`wit_toolchain.world_import_drift: ${imports.join(",")}`);
  }

  return {
    package: "hobo:sdk",
    version: packageMatch[1],
    interfaces: Object.fromEntries(EXPECTED_INTERFACES.map((name) => [name, interfaces[name]])),
    world: {
      name: "sdk",
      imports,
    },
  };
}

export async function validateToolchainLock(lock, options = {}) {
  lock ??= await readToolchainLock();
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const packageJson = options.packageJson ?? (await readPackageJson(join(packageRoot, "package.json")));
  const errors = [];

  if (lock.schema !== "hobo.wit-toolchain-lock/v1") {
    errors.push("schema must be hobo.wit-toolchain-lock/v1");
  }
  if (lock.package !== "hobo:sdk@0.1.0") {
    errors.push("package must pin hobo:sdk@0.1.0");
  }
  if (lock.scripts?.witGen !== "pnpm wit:gen" || lock.scripts?.witCheck !== "pnpm wit:check") {
    errors.push("scripts must expose pnpm wit:gen and pnpm wit:check");
  }
  if (lock.canonicalGenerator?.name !== "@bytecodealliance/jco") {
    errors.push("canonical generator must be @bytecodealliance/jco");
  }
  if (!isExactVersion(lock.canonicalGenerator?.version)) {
    errors.push("canonical generator version must be exact semver");
  }
  if (packageJson.devDependencies?.["@bytecodealliance/jco"] !== lock.canonicalGenerator?.version) {
    errors.push("package.json must pin @bytecodealliance/jco to the lock version");
  }
  for (const generator of lock.smokeGenerators ?? []) {
    if (!isExactVersion(generator.version)) {
      errors.push(`${generator.name} version must be exact semver`);
    }
    if (generator.name === "@bytecodealliance/jco") {
      errors.push("jco must be the canonical generator, not smoke-only");
    }
  }

  for (const [name, version] of Object.entries(lock.compatFloor )) {
    if (name === "policy" || name === "baselineDecision") {
      continue;
    }
    if (!isExactVersion(version)) {
      errors.push(`${name} must be pinned to exact semver`);
    }
  }

  for (const dep of lock.witDeps ?? []) {
    if (!isExactVersion(dep.version)) {
      errors.push(`${dep.interface} dependency version must be exact semver`);
    }
    if (!["stable", "preview", "experimental", "deprecated"].includes(dep.stability)) {
      errors.push(`${dep.interface} must declare a stability tier`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(dep.digest ?? "")) {
      errors.push(`${dep.interface} must pin sha256 digest`);
      continue;
    }

    const source = await readFile(join(packageRoot, dep.path), "utf8");
    const digest = digestSource(source);
    if (digest !== dep.digest) {
      errors.push(`${dep.interface} digest drift: expected ${dep.digest}, got ${digest}`);
    }
  }

  if (!lock.guards?.includes("wit-gen-byte-identical")) {
    errors.push("lock must include wit-gen-byte-identical guard");
  }
  if (!lock.guards?.includes("vendored-wit-deps-match-lock")) {
    errors.push("lock must include vendored-wit-deps-match-lock guard");
  }

  if (errors.length > 0) {
    throw new Error(`wit_toolchain.lock_invalid: ${errors.join("; ")}`);
  }

  return {
    package: lock.package,
    canonicalGenerator: `${lock.canonicalGenerator.name}@${lock.canonicalGenerator.version}`,
    deps: lock.witDeps.length,
    guards: lock.guards.length,
  };
}

export async function writeGeneratedBindings(options = {}) {
  const outDir = options.outDir ?? GENERATED_ROOT;

  await rm(outDir, { recursive: true, force: true });
  await execFileAsync(
    process.execPath,
    [JCO_PATH, "types", "wit/hobo-sdk.wit", "--world-name", "sdk", "--out-dir", outDir],
    { cwd: PACKAGE_ROOT },
  );
  await normalizeGeneratedTree(outDir);

  return listDeclarationFiles(outDir);
}

export async function assertGeneratedMatches(options = {}) {
  const generatedRoot = options.generatedRoot ?? GENERATED_ROOT;
  const tempDir = await mkdtemp(join(tmpdir(), "hobo-wit-jco-"));

  try {
    const expectedFileNames = await writeGeneratedBindings({ outDir: tempDir });
    const actualFileNames = await listDeclarationFiles(generatedRoot);

    if (actualFileNames.join("\n") !== expectedFileNames.join("\n")) {
      throw new Error(
        `wit_toolchain.generated_file_drift: expected ${expectedFileNames.join(",")}, got ${actualFileNames.join(",")}`,
      );
    }

    for (const fileName of expectedFileNames) {
      const expected = (await readFile(join(tempDir, fileName), "utf8")).replace(/\r\n/g, "\n");
      const actual = (await readFile(join(generatedRoot, fileName), "utf8")).replace(/\r\n/g, "\n");
      if (actual !== expected) {
        throw new Error(`wit_toolchain.generated_content_drift: ${fileName}`);
      }
    }

    return {
      checked: expectedFileNames.length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function digestSource(source) {
  return `sha256:${createHash("sha256").update(source.replace(/\r\n/g, "\n"), "utf8").digest("hex")}`;
}

async function listDeclarationFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.name.endsWith(".d.ts")) {
        files.push(relative(root, path).replace(/\\/g, "/"));
      }
    }
  }

  await visit(root);
  return files.sort();
}

async function normalizeGeneratedTree(root) {
  for (const fileName of await listDeclarationFiles(root)) {
    const path = join(root, fileName);
    const text = await readFile(path, "utf8");
    const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\s+$/u, "");
    const moduleText = /\b(export|import)\b/.test(normalized) ? normalized : `${normalized}\nexport {};`;
    await writeFile(path, `${moduleText}\n`);
  }
}

function isExactVersion(version) {
  return isJsonString(version) && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version);
}
