import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type StagedChange = "empty" | "package" | "skill";
export type CheckResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const runner = path.join(repoRoot, "scripts/run-relevant-checks.ts");
const tsx = import.meta.resolve("tsx");

export function inspectStagedChecks(change: StagedChange, base?: string): CheckResult {
  const directory = mkdtempSync(path.join(tmpdir(), "hobo-staged-check-"));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[name];
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, env, encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    };
    git("init", "--quiet");
    if (change !== "empty") {
      const file = change === "skill" ? ".agents/skills/example/SKILL.md" : "packages/cli/src/example.ts";
      const target = path.join(directory, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, change === "skill" ? "# Example skill\n" : "export const value = 1;\n");
      if (change === "package") writeFileSync(path.join(directory, "packages/cli/package.json"), '{"name":"@hobo/cli"}\n');
      git("add", file);
    }
    const args = ["--import", tsx, runner, "--staged", "--explain"];
    if (base) args.push(`--base=${base}`);
    const result = spawnSync(process.execPath, args, { cwd: directory, env, encoding: "utf8", timeout: 15_000 });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
