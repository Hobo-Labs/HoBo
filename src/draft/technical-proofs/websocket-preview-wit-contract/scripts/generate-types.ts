import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");
const generated = join(root, "generated");
const stagedWit = join(generated, ".wit");
const jco = join(root, "node_modules", "@bytecodealliance", "jco", "src", "jco.js");

await rm(generated, { recursive: true, force: true });

const packages = [
  [
    "wasi-websocket",
    await stageWitPackage("wasi-websocket", "wit/wasi-websocket.wit", [
      "wit/deps/wasi-io.wit"
    ]),
    "websocket",
    "guest"
  ],
  [
    "hobo-websocket",
    await stageWitPackage("hobo-websocket", "wit/hobo-websocket.wit", [
      "wit/wasi-websocket.wit",
      "wit/deps/hobo-auth-types.wit",
      "wit/deps/wasi-io.wit"
    ]),
    "websocket-extension",
    "guest"
  ]
];

for (const [name, witPath, world, worldKind] of packages) {
  await execFileAsync(
    process.execPath,
    [
      jco,
      "types",
      witPath,
      "--world-name",
      world,
      "--out-dir",
      join("generated", name, worldKind)
    ],
    { cwd: root }
  );
}

await rm(stagedWit, { recursive: true, force: true });

async function stripTrailingWhitespace(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await stripTrailingWhitespace(path);
      continue;
    }
    if (!entry.name.endsWith(".ts")) {
      continue;
    }

    const text = await readFile(path, "utf8");
    await writeFile(path, `${text.replace(/[ \t]+$/gm, "").replace(/\s+$/u, "")}\n`);
  }
}

await stripTrailingWhitespace(generated);

async function stageWitPackage(name, entryFile, dependencyFiles) {
  const directory = join(stagedWit, name);
  const depsDirectory = join(directory, "deps");

  await mkdir(depsDirectory, { recursive: true });
  await copyFile(join(root, entryFile), join(directory, "world.wit"));
  for (const dependencyFile of dependencyFiles) {
    await copyFile(join(root, dependencyFile), join(depsDirectory, basename(dependencyFile)));
  }

  return directory;
}
