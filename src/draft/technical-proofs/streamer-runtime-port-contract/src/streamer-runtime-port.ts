import assert from "node:assert/strict";
import { isJsonString } from "./json.js";


export const STREAMER_RUNTIME_PORT_CONTRACT_VERSION = "hobo.streamer-runtime-port/v1";

const DEFAULT_BUFFER_LIMIT = 32;
const DEFAULT_STREAM_NAME = "default";
const END_OF_STREAM = Symbol("streamer.end");

export class StreamerBackpressureError extends Error {
  constructor({ runId, bufferLimit }) {
    super(`streamer buffer limit reached for ${runId}; limit=${bufferLimit}`);
    this.name = "StreamerBackpressureError";
    this.code = "STREAMER_BACKPRESSURE";
    this.runId = runId;
    this.bufferLimit = bufferLimit;
  }
}

export class StreamerClosedError extends Error {
  constructor({ runId }) {
    super(`streamer run is closed: ${runId}`);
    this.name = "StreamerClosedError";
    this.code = "STREAMER_CLOSED";
    this.runId = runId;
  }
}

export function createRuntimeLocalStreamer(options = {}) {
  const bufferLimit = normalizeBufferLimit(options.bufferLimit);
  const runIdPrefix = normalizeNonEmptyString(options.runIdPrefix ?? "run", "runIdPrefix");
  const runs = new Map();
  let nextRunId = 1;

  return {
    backend: "runtime-local",
    contract: STREAMER_RUNTIME_PORT_CONTRACT_VERSION,
    createRun(runOptions = {}) {
      const runId = normalizeRunId(runOptions.runId ?? `${runIdPrefix}-${nextRunId++}`);
      if (runs.has(runId)) {
        throw new Error(`streamer run already exists: ${runId}`);
      }

      const record = createRunRecord({ runId, bufferLimit });
      runs.set(runId, record);
      return toRunHandle(record);
    },
    start(workflow, runOptions = {}) {
      if (!(workflow instanceof Function)) {
        throw new TypeError("workflow must be a function");
      }

      const run = this.createRun(runOptions);
      queueMicrotask(async () => {
        try {
          await workflow({
            runId: run.runId,
            getWritable: run.getWritable,
          });
          closeRun(getRecord(runs, run.runId), {
            status: "completed",
            reason: "workflow completed",
          });
        } catch (error) {
          failRun(getRecord(runs, run.runId), error);
        }
      });
      return run;
    },
    teardownRun(runId, reason = "teardown") {
      return closeRun(getRecord(runs, runId), {
        status: "closed",
        reason,
      });
    },
  };
}

export async function runStreamerConformance(createRuntime) {
  await provesOrderedRunReadable(createRuntime);
  await provesStartReturnsReadable(createRuntime);
  await provesMultiplexedStreamsOrdered(createRuntime);
  await provesBoundedBackpressure(createRuntime);
  await provesTeardownClosesStream(createRuntime);

  return {
    contract: STREAMER_RUNTIME_PORT_CONTRACT_VERSION,
    backend: "runtime-local",
    assertions: {
      orderedRunReadable: "pass",
      startReturnsReadable: "pass",
      multiplexedStreamsOrdered: "pass",
      boundedBackpressure: "pass",
      teardownClosesStream: "pass",
    },
  };
}

function createRunRecord({ runId, bufferLimit }) {
  const done = createDeferred();
  return {
    runId,
    bufferLimit,
    buffer: [],
    waiters: [],
    closed: false,
    closeResult: undefined,
    nextSeq: 1,
    done,
  };
}

function toRunHandle(record) {
  return {
    runId: record.runId,
    readable: toReadable(record),
    getWritable(stream = DEFAULT_STREAM_NAME) {
      return toWritable(record, stream);
    },
    done: record.done.promise,
  };
}

function toWritable(record, stream) {
  const streamName = normalizeNonEmptyString(stream, "stream");
  return {
    stream: streamName,
    async write(chunk) {
      writeChunk(record, streamName, chunk);
    },
  };
}

function toReadable(record) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (record.buffer.length > 0) {
            return { value: record.buffer.shift(), done: false };
          }

          if (record.closed) {
            return { value: undefined, done: true };
          }

          const waiter = createDeferred();
          record.waiters.push(waiter.resolve);
          const value = await waiter.promise;
          if (value === END_OF_STREAM) {
            return { value: undefined, done: true };
          }
          return { value, done: false };
        },
      };
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function writeChunk(record, stream, chunk) {
  if (record.closed) {
    throw new StreamerClosedError({ runId: record.runId });
  }

  if (record.waiters.length === 0 && record.buffer.length >= record.bufferLimit) {
    throw new StreamerBackpressureError({
      runId: record.runId,
      bufferLimit: record.bufferLimit,
    });
  }

  const frame = {
    runId: record.runId,
    seq: record.nextSeq++,
    stream,
    chunk,
  };

  const waiter = record.waiters.shift();
  if (waiter) {
    waiter(frame);
    return;
  }

  record.buffer.push(frame);
}

function closeRun(record, result) {
  if (record.closed) {
    return record.closeResult;
  }

  record.closed = true;
  record.closeResult = {
    runId: record.runId,
    status: result.status,
    reason: result.reason,
  };

  if (result.status === "failed") {
    record.done.reject(result.error);
  } else {
    record.done.resolve(record.closeResult);
  }

  for (const waiter of record.waiters.splice(0)) {
    waiter(END_OF_STREAM);
  }

  return record.closeResult;
}

function failRun(record, error) {
  return closeRun(record, {
    status: "failed",
    reason: error instanceof Error ? error.message : "workflow failed",
    error,
  });
}

function getRecord(runs, runId) {
  const normalizedRunId = normalizeRunId(runId);
  const record = runs.get(normalizedRunId);
  if (!record) {
    throw new Error(`unknown streamer run: ${normalizedRunId}`);
  }
  return record;
}

function normalizeRunId(runId) {
  return normalizeNonEmptyString(runId, "runId");
}

function normalizeNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function normalizeBufferLimit(value = DEFAULT_BUFFER_LIMIT) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("bufferLimit must be a positive integer");
  }
  return value;
}

async function collect(readable) {
  const frames = [];
  for await (const frame of readable) {
    frames.push(frame);
  }
  return frames;
}

async function provesOrderedRunReadable(createRuntime) {
  const runtime = createRuntime();
  const run = runtime.createRun({ runId: "run:ordered" });
  const writable = run.getWritable("stdout");

  await writable.write("first");
  await writable.write("second");
  runtime.teardownRun(run.runId);

  assert.deepEqual(await collect(run.readable), [
    { runId: "run:ordered", seq: 1, stream: "stdout", chunk: "first" },
    { runId: "run:ordered", seq: 2, stream: "stdout", chunk: "second" },
  ]);
}

async function provesStartReturnsReadable(createRuntime) {
  const runtime = createRuntime();
  const run = runtime.start(async ({ getWritable }) => {
    const writable = getWritable("events");
    await writable.write("alpha");
    await writable.write("omega");
  });

  assert.equal(isJsonString(run.runId), true);
  assert.deepEqual(
    (await collect(run.readable)).map(({ seq, stream, chunk }) => ({ seq, stream, chunk })),
    [
      { seq: 1, stream: "events", chunk: "alpha" },
      { seq: 2, stream: "events", chunk: "omega" },
    ],
  );
  assert.equal((await run.done).status, "completed");
}

async function provesMultiplexedStreamsOrdered(createRuntime) {
  const runtime = createRuntime();
  const run = runtime.createRun({ runId: "run:multiplexed" });
  const stdout = run.getWritable("stdout");
  const logs = run.getWritable("logs");

  await stdout.write("one");
  await logs.write({ level: "debug" });
  await stdout.write("two");
  runtime.teardownRun(run.runId);

  assert.deepEqual(
    (await collect(run.readable)).map(({ seq, stream, chunk }) => ({ seq, stream, chunk })),
    [
      { seq: 1, stream: "stdout", chunk: "one" },
      { seq: 2, stream: "logs", chunk: { level: "debug" } },
      { seq: 3, stream: "stdout", chunk: "two" },
    ],
  );
}

async function provesBoundedBackpressure(createRuntime) {
  const runtime = createRuntime();
  const run = runtime.createRun({ runId: "run:backpressure" });
  const writable = run.getWritable("stdout");

  let backpressured = false;
  for (let index = 0; index < 256; index += 1) {
    try {
      await writable.write(`held-${index}`);
    } catch (error) {
      assert.ok(error instanceof StreamerBackpressureError);
      backpressured = true;
      break;
    }
  }

  assert.equal(backpressured, true);
  runtime.teardownRun(run.runId);
}

async function provesTeardownClosesStream(createRuntime) {
  const runtime = createRuntime();
  const run = runtime.createRun({ runId: "run:closed" });
  const writable = run.getWritable("stdout");

  await writable.write("final");
  runtime.teardownRun(run.runId);

  await assert.rejects(() => writable.write("after"), StreamerClosedError);
  assert.deepEqual((await collect(run.readable)).map((frame) => frame.chunk), ["final"]);
}
