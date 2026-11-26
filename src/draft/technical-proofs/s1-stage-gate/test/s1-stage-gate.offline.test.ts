import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  COLD_BOOT_BUDGET_MS,
  installOfflineGuard,
  runOfflineHelloBindleGate,
} from "../src/offline-gate.js";

test("offline hello-bindle gate boots workflow, actor, and compensated saga under budget", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-offline-gate-"));
  const result = await runOfflineHelloBindleGate({ projectRoot });

  assert.ok(result.bootMs < COLD_BOOT_BUDGET_MS);
  assert.ok(result.completionEvents.includes("workflow.Completed"));
  assert.ok(result.completionEvents.includes("actor.SignalHandled"));
  assert.ok(result.completionEvents.includes("saga.Compensating"));
  assert.ok(result.completionEvents.includes("saga.RolledBack"));
});

test("offline guard blocks network sockets when HOBO_OFFLINE_GUARD=1", () => {
  const restore = installOfflineGuard(true);

  try {
    assert.throws(
      () => net.connect({ host: "example.com", port: 443 }),
      /HOBO_OFFLINE_GUARD blocked network socket/,
    );
  } finally {
    restore();
  }
});
