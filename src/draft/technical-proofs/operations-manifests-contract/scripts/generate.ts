import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CANONICAL_VERBS } from "../../hobo-cli-shell-contract/src/cli-shell.js";
import { MCP_TOOL_SPECS } from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";
import { generateOperationsManifests } from "../src/operations-manifests.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const generatedRoot = path.join(packageRoot, "generated");
const manifests = generateOperationsManifests({
  verbs: CANONICAL_VERBS,
  tools: MCP_TOOL_SPECS,
});

await mkdir(generatedRoot, { recursive: true });
await Promise.all(
  Object.entries(manifests).map(([name, content]) => writeFile(path.join(generatedRoot, name), content)),
);
