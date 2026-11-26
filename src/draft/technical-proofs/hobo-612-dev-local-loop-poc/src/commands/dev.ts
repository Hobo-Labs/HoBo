import { resolve } from "node:path";

import { startDevSession, type DevSession } from "../dev-session.js";
import { COLD_BOOT_BUDGET_MS } from "../types.js";
import { isJsonObject, type JsonValue } from "../json.js";


export interface DevCommandOptions {
  port?: number;
  project?: string;
  json?: boolean;
  cwd?: string;
}

export interface DevCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runHoboDev(argv: string[], runOptions: { cwd?: string } = {}): Promise<DevCommandResult> {
  const options = parseDevArgv(argv, runOptions.cwd ?? process.cwd());
  try {
    const session = await startDevSession({
      projectRoot: options.project,
      port: options.port,
      resources: [],
      campOnlyCapabilities: [],
    });
    return renderDevSuccess(options, session);
  } catch (error) {
    return renderDevFailure(options, error);
  }
}

function parseDevArgv(argv: string[], cwd: string): Required<DevCommandOptions> {
  const options: Required<DevCommandOptions> = {
    port: 4000,
    project: cwd,
    json: false,
    cwd,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "dev") continue;
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--port") {
      options.port = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (token === "--project") {
      options.project = resolve(cwd, String(argv[index + 1]));
      index += 1;
      continue;
    }
    throw new Error(`Unknown hobo dev option "${token}"`);
  }
  return options;
}

function renderDevSuccess(options: Required<DevCommandOptions>, session: DevSession): DevCommandResult {
  const envelope = {
    ok: true,
    verb: "dev",
    status: "running",
    code: "HOBO_DEV_STARTED",
    localUrl: session.record.localUrl,
    bootMs: session.record.bootMs,
    coldBootBudgetMs: COLD_BOOT_BUDGET_MS,
    cloudAccountRequired: false,
    runtime: session.record.runtime,
    fidelityLabels: session.record.fidelityLabels,
    data: { state: session.currentState() },
  };

  if (options.json) {
    return { exitCode: 0, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: "" };
  }

  const fidelityTable = Object.entries(session.record.fidelityLabels)
    .map(([name, label]) => `  ${name}: ${label}`)
    .join("\n");
  const stdout = [
    `hobo dev`,
    `local: ${session.record.localUrl}`,
    `boot: ${session.record.bootMs}ms (budget ${COLD_BOOT_BUDGET_MS}ms)`,
    `runtime: ${session.record.runtime}`,
    `fidelity:`,
    fidelityTable || "  (none)",
    "",
  ].join("\n");
  return { exitCode: 0, stdout, stderr: "" };
}

function renderDevFailure(options: Required<DevCommandOptions>, error: JsonValue): DevCommandResult {
  const message = error instanceof Error ? error.message : "hobo dev failed";
  const code =
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    error && isJsonObject(error) && "code" in error ? String((error as { code: string }).code) : "HOBO_DEV_FAILED";
  const envelope = {
    ok: false,
    verb: "dev",
    status: "failed",
    code,
    message,
    remediation: ["Check .hobo/dev-state.json schema is hobo.dev-state/v1", "Ensure project root contains a Bindle marker"],
  };
  if (options.json) {
    return { exitCode: 1, stdout: `${JSON.stringify(envelope, null, 2)}\n`, stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `${message}\n` };
}
