import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPatternCatalog } from "../src/catalog.js";
import { buildVsCodeSnippets } from "../src/vscode-snippets.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = loadPatternCatalog({ root: join(root, "patterns") });
const built = buildVsCodeSnippets({ catalog });
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "hobo.code-snippets");
writeFileSync(out, `${JSON.stringify(built.snippets, null, "\t")}\n`);
process.stdout.write(`vscode snippets ${built.count} → ${out}\n`);
