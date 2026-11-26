import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import net from "node:net";

import { createHoboDevLoop } from "../../hobo-dev-loop-contract/src/dev-loop.js";
import { createSagaEngine } from "../../choreography-saga-engine-contract/src/choreography-saga-engine.js";
import { type JsonValue, type JsonObject } from "./json.js";


export const COLD_BOOT_BUDGET_MS = 60_000;
export const EVENT_LOG_FILE = "events.jsonl";
export const TIMING_ARTIFACT = "offline-timing.json";

export type OfflineGateResult = {
  readonly bootMs: number;
  readonly eventLogPath: string;
  readonly timingArtifactPath: string;
  readonly completionEvents: readonly string[];
};

export async function runOfflineHelloBindleGate(options: {
  projectRoot: string;
  bootMs?: number;
}): Promise<OfflineGateResult> {
  const projectRoot = options.projectRoot;
  const hoboDir = join(projectRoot, ".hobo");
  await mkdir(hoboDir, { recursive: true });

  const restoreGuard = installOfflineGuard(process.env.HOBO_OFFLINE_GUARD === "1");
  const started = Date.now();

  try {
    const devLoop = createHoboDevLoop({ bootMs: options.bootMs ?? 1_200, port: 4000 });
    const boot = await devLoop.start({ projectRoot });

    await devLoop.handleRequest({ path: "/workflow/checkout", body: { orderId: "bindle-1" } });
    await devLoop.handleRequest({ path: "/actor/inventory", body: { sku: "widget", qty: 1 } });

    const sagaEngine = createSagaEngine({
      now: () => "2026-07-01T00:00:00.000Z",
      idFactory: (prefix) => `${prefix}-${streamSeq("saga.checkout")}`,
    });

    const saga = await sagaEngine.runSaga({
      sagaId: "hello-bindle-checkout",
      tenantId: "local",
      correlationId: "corr-hello-bindle",
      steps: [
        { id: "reserve", run: () => ({ reserved: true }) },
        {
          id: "charge",
          run: () => {
            const error = new Error("payment declined");
            error.code = "PAYMENT_DECLINED";
            throw error;
          },
        },
      ],
    });

    const events = [
      event("workflow.checkout", 1, "workflow.Completed", { orderId: "bindle-1", bootMs: boot.bootedInMs }),
      event("actor.inventory", 1, "actor.SignalHandled", { sku: "widget", qty: 1 }),
      ...saga.events.map((entry, index) =>
        event("saga.checkout", index + 1, entry.type, entry.data ?? {}),
      ),
    ];

    const eventLogPath = join(hoboDir, EVENT_LOG_FILE);
    await writeFile(eventLogPath, `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

    const bootMs = Date.now() - started;
    if (bootMs >= COLD_BOOT_BUDGET_MS) {
      throw new Error(`cold boot exceeded budget: ${bootMs}ms >= ${COLD_BOOT_BUDGET_MS}ms`);
    }

    const timingArtifactPath = join(hoboDir, TIMING_ARTIFACT);
    await writeFile(timingArtifactPath, JSON.stringify({ bootMs, recordedAt: new Date().toISOString() }, null, 2));

    return Object.freeze({
      bootMs,
      eventLogPath,
      timingArtifactPath,
      completionEvents: Object.freeze(events.map((entry) => entry.type)),
    });
  } finally {
    restoreGuard();
  }
}

export async function readPersistedEventLog(eventLogPath: string) {
  const content = await readFile(eventLogPath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function installOfflineGuard(enabled: boolean): () => void {
  if (!enabled) {
    return () => {};
  }

  const originalConnect = net.Socket.prototype.connect;
  // SAFETY: `net.Socket.prototype.connect = function patchedConnect(...args: JsonValue[]) {` is required at this I/O or test boundary.
  net.Socket.prototype.connect = function patchedConnect(..._args: JsonValue[]) {
    throw new Error("HOBO_OFFLINE_GUARD blocked network socket");
  } as typeof net.Socket.prototype.connect;

  return () => {
    net.Socket.prototype.connect = originalConnect;
  };
}

function event(streamId: string, seq: number, type: string, data: JsonObject) {
  return Object.freeze({
    streamId,
    seq,
    id: `${streamId}:${seq}`,
    type,
    data: Object.freeze({ ...data }),
  });
}

const streamCounters = new Map<string, number>();

function streamSeq(streamId: string): number {
  const next = (streamCounters.get(streamId) ?? 0) + 1;
  streamCounters.set(streamId, next);
  return next;
}
