import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { runOfflineHelloBindleGate } from "../src/offline-gate.js";
import {
  ReplayLiveMismatchError,
  assertMutatedEventFails,
  runReplayEqualsLiveGate,
  summarizeReplayVector,
} from "../src/replay-gate.js";
import { readPersistedEventLog } from "../src/offline-gate.js";

test("replay equals live for persisted hello-bindle event log", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-replay-gate-"));
  const offline = await runOfflineHelloBindleGate({ projectRoot });
  const events = await readPersistedEventLog(offline.eventLogPath);
  const vector = summarizeReplayVector(events);

  const result = await runReplayEqualsLiveGate(offline.eventLogPath);

  assert.deepEqual(result.seq, vector);
  assert.equal(result.state.workflows, 1);
  assert.equal(result.state.actors, 1);
  assert.equal(result.state.compensationExercised, true);
});

test("mutated event payload fails replay equivalence", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "hobo-replay-negative-"));
  const offline = await runOfflineHelloBindleGate({ projectRoot });

  await assert.rejects(
    () => assertMutatedEventFails(offline.eventLogPath),
    ReplayLiveMismatchError,
  );
});
