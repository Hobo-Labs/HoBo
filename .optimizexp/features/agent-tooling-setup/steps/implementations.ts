import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  serverStarted: boolean;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function run(script: string, args: string[], env: NodeJS.ProcessEnv = process.env): CommandResult {
  const result = spawnSync("/bin/bash", [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, serverStarted: false };
}

export function agentSetupHelp(): CommandResult {
  return run("scripts/setup-agent-tools.sh", ["--help"]);
}

export function agentSetupMissingName(): CommandResult {
  return run("scripts/setup-agent-tools.sh", ["--agent"]);
}

function commandPath(name: string): string {
  const result = spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`required command not found: ${name}`);
  return result.stdout.trim();
}

export function gbrainWithoutProvider(): CommandResult {
  const directory = mkdtempSync(path.join(tmpdir(), "hobo-agent-mcp-"));
  try {
    const bin = path.join(directory, "bin");
    const marker = path.join(directory, "server-started");
    mkdirSync(bin);
    for (const name of ["cat", "grep"]) symlinkSync(commandPath(name), path.join(bin, name));
    writeFileSync(path.join(bin, "gbrain"), '#!/bin/sh\n: > "$TASK_GBRAIN_MARKER"\n', { mode: 0o755 });
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin, GBRAIN_HOME: directory, TASK_GBRAIN_MARKER: marker };
    for (const name of ["OPENAI_API_KEY", "ZEROENTROPY_API_KEY", "VOYAGE_API_KEY"]) delete env[name];
    const result = run("scripts/agent-mcp-gbrain.sh", [], env);
    return { ...result, serverStarted: existsSync(marker) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
