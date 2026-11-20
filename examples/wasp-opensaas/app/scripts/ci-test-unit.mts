import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = join(root, "node_modules", "vitest", "package.json");
const reactTesting = join(root, "node_modules", "@testing-library", "react", "package.json");

if (!existsSync(marker) || !existsSync(reactTesting)) {
  const install = spawnSync(
    "npm",
    ["install", "--workspaces=false", "--include=dev", "--no-package-lock"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (install.status !== 0) process.exit(install.status ?? 1);
}

const vitest = spawnSync(
  "npx",
  ["vitest", "run", "--config", "vitest.config.ts"],
  { cwd: root, stdio: "inherit", env: { ...process.env, NODE_ENV: "development" } },
);
process.exit(vitest.status ?? 1);