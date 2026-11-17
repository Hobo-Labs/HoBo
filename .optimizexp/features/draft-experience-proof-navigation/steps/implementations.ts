import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function runInventory(...args: string[]) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/list-experience-proofs.mts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
