import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const generatedRoot = fileURLToPath(new URL("../generated", import.meta.url));

for (const file of await listFiles(generatedRoot)) {
  const content = await readFile(file, "utf8");
  const cleaned = content.replace(/[ \t]+$/gm, "");

  if (cleaned !== content) {
    await writeFile(file, cleaned);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else {
      files.push(path);
    }
  }

  return files;
}
