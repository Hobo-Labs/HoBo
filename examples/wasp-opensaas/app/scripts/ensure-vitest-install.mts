import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specDir = join(root, ".wasp", "spec");
const specManifest = join(specDir, "package.json");
if (!existsSync(specManifest)) {
  mkdirSync(specDir, { recursive: true });
  writeFileSync(
    specManifest,
    `${JSON.stringify(
      {
        name: "@wasp.sh/spec",
        private: true,
        version: "0.0.0-vitest-stub",
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
}