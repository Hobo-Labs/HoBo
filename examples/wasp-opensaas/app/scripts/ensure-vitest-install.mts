import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const specDir = join(root, ".wasp", "spec");
mkdirSync(specDir, { recursive: true });
writeFileSync(
  join(specDir, "package.json"),
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