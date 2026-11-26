import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/hello-bindle", import.meta.url));
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";
const TOOLCHAIN = Object.freeze({
  jco: "1.24.3",
  componentizeJs: "0.21.0",
  wasmTools: "1.235.0",
  wasmtime: "46.0.1",
});

export type BuildEvidence = Readonly<{
  digest: string;
  bytes: Uint8Array;
  inputsDigest: string;
  byteLength: number;
}>;

export async function buildHelloBindleEvidence(): Promise<BuildEvidence> {
  const canonicalRoot = await mkdtemp(join(tmpdir(), "hobo-603-componentize-"));
  const servicePath = join(FIXTURE_ROOT, "src", "service.ts");
  const serviceSource = await readFile(servicePath, "utf8");
  const relativePath = "src/service.ts";
  const sourceDigest = sha256Text(serviceSource);

  const targetTs = join(canonicalRoot, relativePath);
  await mkdir(dirname(targetTs), { recursive: true });
  await writeFile(targetTs, serviceSource, "utf8");

  const typescript = await import("typescript");
  const transpiled = typescript.transpileModule(serviceSource, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.ES2022,
      moduleResolution: typescript.ModuleResolutionKind.Bundler,
    },
    fileName: targetTs,
  });
  const entryJsPath = join(canonicalRoot, "src/service.js");
  await writeFile(entryJsPath, transpiled.outputText, "utf8");

  const inputsDigestValue = sha256Text(
    JSON.stringify({
      name: "hello-bindle",
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      toolchain: TOOLCHAIN,
      pathRemap: "hello-bindle=>/workspace/hello-bindle",
      sources: [{ path: relativePath, digest: sourceDigest }],
      witDir: join(FIXTURE_ROOT, "wit"),
      worldName: "hello-bindle",
      entrypoint: "src/service.ts",
    }),
  );

  const { componentize } = await import("@bytecodealliance/componentize-js");
  const epochSeconds = Math.floor(Date.parse(SOURCE_DATE_EPOCH) / 1000).toString();
  const output = await componentize({
    sourcePath: entryJsPath,
    witPath: join(FIXTURE_ROOT, "wit"),
    worldName: "hello-bindle",
    disableFeatures: ["random", "clocks", "stdio", "http"],
    env: { SOURCE_DATE_EPOCH: epochSeconds },
  });

  const bytes = output.component;
  return Object.freeze({
    digest: sha256Bytes(bytes),
    bytes,
    inputsDigest: inputsDigestValue,
    byteLength: bytes.length,
  });
}

export async function smokeHealthExport(bytes: Uint8Array): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "hobo-603-smoke-"));

  try {
    const { transpile } = await import("@bytecodealliance/jco");
    const { files } = await transpile(bytes, {
      name: "component",
      nodejsCompat: true,
      tlaCompat: true,
    });

    for (const [name, data] of Object.entries(files)) {
      const filePath = join(outDir, name);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
    }

    await writeFile(join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    await symlink(join(PACKAGE_ROOT, "node_modules"), join(outDir, "node_modules"), "dir");

    const invokePath = join(outDir, "invoke.mjs");
    await writeFile(
      invokePath,
      'import { health, $init } from "./component.js";\nawait $init;\nprocess.stdout.write(health() + "\\n");\n',
      "utf8",
    );

    const { spawn } = await import("node:child_process");
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [invokePath], {
        cwd: outDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`smoke_failed: ${stderr}`));
          return;
        }
        resolve(stdout);
      });
    });
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(outDir, { recursive: true, force: true });
  }
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
