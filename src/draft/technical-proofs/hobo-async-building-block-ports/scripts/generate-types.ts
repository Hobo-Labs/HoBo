import { execFile } from "node:child_process";
import { rm, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");
const generated = join(root, "generated");
const jco = join(root, "node_modules", "@bytecodealliance", "jco", "src", "jco.js");

const packages = [
  ["queue", "wit/queue.wit", ["queue-guest", "queue-provider"]],
  ["scheduler", "wit/scheduler.wit", ["scheduler-guest", "scheduler-provider"]],
  ["blob-events", "wit/blob-events.wit", ["blob-events-guest", "blob-events-provider"]]
];

await rm(generated, { recursive: true, force: true });

for (const [name, witPath, worlds] of packages) {
  for (const world of worlds) {
    const worldKind = world.endsWith("-guest") ? "guest" : "provider";
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
}

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
