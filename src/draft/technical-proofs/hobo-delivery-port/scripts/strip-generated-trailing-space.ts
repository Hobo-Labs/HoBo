import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const generatedDir = fileURLToPath(new URL("../generated", import.meta.url));

for (const file of await generatedFiles(generatedDir)) {
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace(/[ \t]+(?=\r?\n|$)/g, ""));
}

async function generatedFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await generatedFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }

  return files;
}
