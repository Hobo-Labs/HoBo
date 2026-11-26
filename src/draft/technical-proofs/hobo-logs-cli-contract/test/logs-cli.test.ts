import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createHoboLogsCli,
  createRuntimeLogStreamer,
} from "../src/logs-cli.js";

test("logs --follow streams live lines from the Camp runtime Streamer", async () => {
  const streamer = createRuntimeLogStreamer({ resources: ["api"] });
  const yard = unreachableYard();
  const cli = createHoboLogsCli({ streamer, yard });
  const abort = new AbortController();

  const run = cli.run(["--follow"], { signal: abort.signal });

  await waitForSubscribers(streamer, 1);
  streamer.append({ runId: "run-1", resource: "api", level: "info", message: "request started" });
  streamer.append({ runId: "run-1", resource: "api", level: "info", message: "request done" });
  abort.abort();

  const result = await run;

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /api request started/);
  assert.match(result.stdout, /api request done/);
  assert.equal(yard.calls, 0);
  assert.equal(streamer.activeSubscriptions(), 0);
});

test("resource filters, --tail windows, and --json line envelopes are stable", async () => {
  const streamer = createRuntimeLogStreamer({ resources: ["api", "worker"] });
  const cli = createHoboLogsCli({ streamer, yard: unreachableYard() });

  streamer.append({ runId: "run-1", resource: "api", level: "info", message: "api old" });
  streamer.append({ runId: "run-1", resource: "worker", level: "info", message: "worker line" });
  streamer.append({ runId: "run-1", resource: "api", level: "warn", message: "api mid" });
  streamer.append({ runId: "run-1", resource: "api", level: "error", message: "api newest" });

  const result = await cli.run(["api", "--tail", "2", "--json"]);

  assert.equal(result.exitCode, 0);
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map(({ resource, level, message }) => ({ resource, level, message })),
    [
      { resource: "api", level: "warn", message: "api mid" },
      { resource: "api", level: "error", message: "api newest" },
    ],
  );
});

test("unknown resources fail explicitly instead of hanging on an empty stream", async () => {
  const streamer = createRuntimeLogStreamer({ resources: ["api"] });
  const cli = createHoboLogsCli({ streamer, yard: unreachableYard() });

  const result = await cli.run(["missing", "--follow"]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Unknown log resource "missing"/);
  assert.equal(streamer.activeSubscriptions(), 0);
});

test("transport drops and backpressure render visible gap markers", async () => {
  const streamer = createRuntimeLogStreamer({ resources: ["api"], subscriberQueueLimit: 2 });
  const cli = createHoboLogsCli({ streamer, yard: unreachableYard() });
  const abort = new AbortController();

  const run = cli.run(["api", "--follow"], { signal: abort.signal });

  await waitForSubscribers(streamer, 1);
  streamer.append({ runId: "run-1", resource: "api", level: "info", message: "first" });
  streamer.disconnectActiveSubscriptions("transport reset");
  for (let index = 0; index < 6; index += 1) {
    streamer.append({ runId: "run-1", resource: "api", level: "info", message: `burst-${index}` });
  }
  abort.abort();

  const result = await run;

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /log gap: transport reset/);
  assert.match(result.stdout, /log gap: client backpressure/);
  assert.equal(streamer.activeSubscriptions(), 0);
});

test("Ctrl-C tears down a follow subscription without orphaning it", async () => {
  const streamer = createRuntimeLogStreamer({ resources: ["api"] });
  const cli = createHoboLogsCli({ streamer, yard: unreachableYard() });
  const abort = new AbortController();

  const run = cli.run(["api", "--follow"], { signal: abort.signal });

  await waitForSubscribers(streamer, 1);
  assert.equal(streamer.activeSubscriptions(), 1);
  abort.abort();

  const result = await run;

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(streamer.activeSubscriptions(), 0);
});

function unreachableYard() {
  return {
    calls: 0,
    read() {
      this.calls += 1;
      throw new Error("Yard unreachable");
    },
  };
}

async function waitForSubscribers(streamer, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (streamer.activeSubscriptions() === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(streamer.activeSubscriptions(), expected);
}
