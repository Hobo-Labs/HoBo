import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { validateWasmComponentArtifact } from "./validate.js";
import type { SmokeReport, WasmComponentArtifact } from "./types.js";

export async function runComponentSmoke(
  artifact: WasmComponentArtifact,
  opts: { exportName: string },
): Promise<SmokeReport> {
  validateWasmComponentArtifact(artifact);

  const outDir = await mkdtemp(join(tmpdir(), "hobo-componentize-smoke-"));

  try {
    const { transpile } = await import("@bytecodealliance/jco");
    const { files } = await transpile(artifact.bytes, {
      name: "component",
      nodejsCompat: true,
      tlaCompat: true,
    });

    for (const [name, data] of Object.entries(files)) {
      const filePath = join(outDir, name);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, data);
    }

    const dts = await readFile(join(outDir, "component.d.ts"), "utf8");
    if (!dts.includes(`export function ${opts.exportName}(`)) {
      throw new Error(`componentize.unknown_export: ${opts.exportName}`);
    }

    await writeFile(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

    const packageRoot = fileURLToPath(new URL("..", import.meta.url));
    await symlink(join(packageRoot, "node_modules"), join(outDir, "node_modules"), "dir");

    const stdout = await runNodeSmoke(outDir, opts.exportName);
    return Object.freeze({
      exitCode: 0,
      stdout,
      command: `jco transpile ${artifact.path} && invoke ${opts.exportName}`,
    });
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

async function runNodeSmoke(outDir: string, exportName: string): Promise<string> {
  const invokePath = join(outDir, "invoke.mjs");
  await writeFile(
    invokePath,
    `import { ${exportName}, $init } from "./component.js";\nawait $init;\nprocess.stdout.write(${exportName}() + "\\n");\n`,
    "utf8",
  );

  return new Promise((resolve, reject) => {
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
        reject(new Error(`componentize.smoke_failed: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}
