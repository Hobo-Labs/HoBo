import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  STREAMER_RUNTIME_PORT_CONTRACT_VERSION,
  StreamerBackpressureError,
  StreamerClosedError,
  createRuntimeLocalStreamer,
  runStreamerConformance,
} from "../src/streamer-runtime-port.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const declarationsUrl = new URL("../src/streamer-runtime-port.d.mts", import.meta.url);
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url),
);

test("runtime-local Streamer writes chunks and reads them back in run order", async () => {
  const runtime = createRuntimeLocalStreamer({ bufferLimit: 8 });
  const run = runtime.createRun({ runId: "run:checkout-1" });
  const output = run.getWritable("stdout");

  await output.write("reserved");
  await output.write("charged");
  await output.write("confirmed");
  runtime.teardownRun(run.runId);

  assert.deepEqual(await collect(run.readable), [
    frame("run:checkout-1", 1, "stdout", "reserved"),
    frame("run:checkout-1", 2, "stdout", "charged"),
    frame("run:checkout-1", 3, "stdout", "confirmed"),
  ]);
});

test("start returns a runId and readable yielding workflow output", async () => {
  const runtime = createRuntimeLocalStreamer({ runIdPrefix: "run:test" });

  const run = runtime.start(async (ctx) => {
    const output = ctx.getWritable("ui");
    await output.write({ status: "started" });
    await output.write({ status: "done" });
  });

  assert.equal(run.runId, "run:test-1");
  assert.deepEqual(await collect(run.readable), [
    frame("run:test-1", 1, "ui", { status: "started" }),
    frame("run:test-1", 2, "ui", { status: "done" }),
  ]);
  assert.deepEqual(await run.done, {
    runId: "run:test-1",
    status: "completed",
    reason: "workflow completed",
  });
});

test("named streams multiplex over one run readable without reordering", async () => {
  const runtime = createRuntimeLocalStreamer();
  const run = runtime.createRun({ runId: "run:mux" });
  const stdout = run.getWritable("stdout");
  const logs = run.getWritable("logs");

  await stdout.write("chunk-1");
  await logs.write({ level: "info", message: "started" });
  await stdout.write("chunk-2");
  runtime.teardownRun(run.runId);

  assert.deepEqual(
    (await collect(run.readable)).map(({ seq, stream, chunk }) => ({ seq, stream, chunk })),
    [
      { seq: 1, stream: "stdout", chunk: "chunk-1" },
      { seq: 2, stream: "logs", chunk: { level: "info", message: "started" } },
      { seq: 3, stream: "stdout", chunk: "chunk-2" },
    ],
  );
});

test("slow consumers hit bounded backpressure instead of unbounded buffering", async () => {
  const runtime = createRuntimeLocalStreamer({ bufferLimit: 2 });
  const run = runtime.createRun({ runId: "run:slow-consumer" });
  const output = run.getWritable("stdout");

  await output.write("one");
  await output.write("two");
  await assert.rejects(() => output.write("three"), StreamerBackpressureError);
  runtime.teardownRun(run.runId);

  assert.deepEqual(
    (await collect(run.readable)).map((event) => event.chunk),
    ["one", "two"],
  );
});

test("rejected backpressure writes do not consume sequence numbers", async () => {
  const runtime = createRuntimeLocalStreamer({ bufferLimit: 1 });
  const run = runtime.createRun({ runId: "run:retry-after-backpressure" });
  const output = run.getWritable("stdout");
  const reader = run.readable[Symbol.asyncIterator]();

  await output.write("first");
  await assert.rejects(() => output.write("rejected"), StreamerBackpressureError);
  assert.deepEqual(await reader.next(), {
    value: frame("run:retry-after-backpressure", 1, "stdout", "first"),
    done: false,
  });

  await output.write("after-drain");
  runtime.teardownRun(run.runId);

  assert.deepEqual(await reader.next(), {
    value: frame("run:retry-after-backpressure", 2, "stdout", "after-drain"),
    done: false,
  });
  assert.deepEqual(await reader.next(), { value: undefined, done: true });
});

test("teardown closes the run stream and rejects writes after teardown", async () => {
  const runtime = createRuntimeLocalStreamer();
  const run = runtime.createRun({ runId: "run:teardown" });
  const output = run.getWritable("stdout");

  await output.write("before-close");
  const closed = runtime.teardownRun(run.runId, "run completed");

  assert.deepEqual(closed, {
    runId: "run:teardown",
    status: "closed",
    reason: "run completed",
  });
  await assert.rejects(() => output.write("after-close"), StreamerClosedError);
  assert.deepEqual(
    (await collect(run.readable)).map((event) => event.chunk),
    ["before-close"],
  );
});

test("runtime-local passes the Streamer conformance subset", async () => {
  const report = await runStreamerConformance(() =>
    createRuntimeLocalStreamer({ runIdPrefix: "run:conf" }),
  );

  assert.deepEqual(report, {
    contract: STREAMER_RUNTIME_PORT_CONTRACT_VERSION,
    backend: "runtime-local",
    assertions: {
      orderedRunReadable: "pass",
      startReturnsReadable: "pass",
      multiplexedStreamsOrdered: "pass",
      boundedBackpressure: "pass",
      teardownClosesStream: "pass",
    },
  });
});

test("TypeScript declarations publish the generic Streamer producer and consumer surface", async () => {
  const declarations = await readFile(declarationsUrl, "utf8");

  assert.match(declarations, /export interface StreamerFrame<TChunk = unknown>/);
  assert.match(declarations, /getWritable<TWritableChunk = TChunk>/);
  assert.match(declarations, /readable: AsyncIterable<StreamerFrame<TChunk>>/);
  assert.match(declarations, /start<TChunk = unknown>/);

  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
    },
  );

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "TypeScript exited non-zero",
  );
});

async function collect(readable) {
  const frames = [];
  for await (const event of readable) {
    frames.push(event);
  }
  return frames;
}

function frame(runId, seq, stream, chunk) {
  return { runId, seq, stream, chunk };
}
