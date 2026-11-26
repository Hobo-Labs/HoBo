import fs from "node:fs";
import path from "node:path";

const generatedDir = path.join(import.meta.dirname, "..", "generated");

for (const filePath of walk(generatedDir)) {
  if (!filePath.endsWith(".d.ts")) {
    continue;
  }

  const original = fs.readFileSync(filePath, "utf8");
  const stripped = original
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n");

  if (stripped !== original) {
    fs.writeFileSync(filePath, stripped, "utf8");
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(entryPath);
    } else {
      yield entryPath;
    }
  }
}
