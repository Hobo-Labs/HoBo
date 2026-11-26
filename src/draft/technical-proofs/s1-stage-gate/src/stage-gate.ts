import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runConformanceGate } from "./conformance-gate.js";
import { runOfflineHelloBindleGate } from "./offline-gate.js";
import { runReplayEqualsLiveGate } from "./replay-gate.js";
import {
  type StageGateS1Record,
  parseStageGateS1Record,
  toRecordJson,
} from "./record.js";

export type GateCheckTiming = {
  readonly checkId: StageGateS1Record["checks"][number]["checkId"];
  readonly status: "pass" | "fail";
  readonly durationMs: number;
  readonly reportRef: string;
};

export async function runS1StageGateRecord(options: {
  commitSha?: string;
  workflowRunUrl?: string;
  projectRoot?: string;
} = {}): Promise<StageGateS1Record> {
  const projectRoot = options.projectRoot ?? await mkdtemp(join(tmpdir(), "hobo-s1-gate-"));
  const startedAt = new Date().toISOString();
  const checks: GateCheckTiming[] = [];

  const conformanceStarted = Date.now();
  await runConformanceGate();
  checks.push({
    checkId: "runtime-port-conformance",
    status: "pass",
    durationMs: Date.now() - conformanceStarted,
    reportRef: "hobo.runtime-port-conformance/v1",
  });

  const offline = await runOfflineHelloBindleGate({ projectRoot });
  checks.push({
    checkId: "offline-hello-bindle",
    status: "pass",
    durationMs: offline.bootMs,
    reportRef: offline.timingArtifactPath,
  });

  const replayStarted = Date.now();
  await runReplayEqualsLiveGate(offline.eventLogPath);
  checks.push({
    checkId: "replay-equals-live",
    status: "pass",
    durationMs: Date.now() - replayStarted,
    reportRef: offline.eventLogPath,
  });

  return parseStageGateS1Record(toRecordJson({
    gateId: "s1-stage-gate",
    commitSha: options.commitSha ?? "local",
    workflowRunUrl: options.workflowRunUrl ?? "",
    recordedAt: startedAt,
    checks,
  }));
}

export { parseStageGateS1Record, toRecordJson };
