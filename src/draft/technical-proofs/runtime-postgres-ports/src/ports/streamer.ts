import type { Pool } from "pg";
import type { IMemoryDb } from "pg-mem";

import {
  StreamerBackpressureError,
  StreamerClosedError,
} from "../../../streamer-runtime-port-contract/src/streamer-runtime-port.js";
import { clone, requireNonEmptyString } from "../postgres/json.js";
import { type JsonValue } from "../json.js";

export const POSTGRES_STREAMER_CONTRACT_VERSION = "hobo.streamer-runtime-port/v1";

const END_OF_STREAM = Symbol("streamer.end");

export function createPostgresStreamer(pool: Pool, options: { bufferLimit?: number; memDb?: IMemoryDb } = {}) {
  const bufferLimit = options.bufferLimit ?? 32;
  const runs = new Map<string, RunRecord>();
  let nextRunId = 1;

  return Object.freeze({
    backend: "runtime-postgres",
    contract: POSTGRES_STREAMER_CONTRACT_VERSION,
    createRun(runOptions: { runId?: string } = {}) {
      const runId = requireNonEmptyString(runOptions.runId ?? `run-${nextRunId++}`, "runId");
      if (runs.has(runId)) {
        throw new Error(`streamer run already exists: ${runId}`);
      }
      const record = createRunRecord({ runId, bufferLimit, pool, memDb: options.memDb });
      runs.set(runId, record);
      void pool.query(
        `INSERT INTO hobo_stream_runs (run_id, buffer_limit, status, reason)
         VALUES ($1, $2, 'open', NULL)`,
        [runId, bufferLimit],
      );
      return toRunHandle(record);
    },
    start(workflow: (ctx: { runId: string; getWritable: (name?: string) => WritableStream<JsonValue> }) => Promise<void> | void, runOptions = {}) {
      const run = this.createRun(runOptions);
      queueMicrotask(async () => {
        try {
          await workflow({
            runId: run.runId,
            getWritable: run.getWritable,
          });
          closeRun(recordFor(runs, run.runId), { status: "completed", reason: "workflow completed" });
        } catch (error) {
          failRun(recordFor(runs, run.runId), error);
        }
      });
      return run;
    },
    teardownRun(runId: string, reason = "teardown") {
      return closeRun(recordFor(runs, runId), { status: "closed", reason });
    },
    async listen(channel: string, handler: (payload: JsonValue) => void) {
      const client = await pool.connect();
      await client.query(`LISTEN ${sanitizeChannel(channel)}`);
      client.on("notification", (message) => {
        if (message.channel === sanitizeChannel(channel) && message.payload) {
          handler(JSON.parse(message.payload));
        }
      });
      return Object.freeze({
        async unsubscribe() {
          await client.query(`UNLISTEN ${sanitizeChannel(channel)}`);
          client.release();
        },
      });
    },
  });
}

type RunRecord = {
  runId: string;
  bufferLimit: number;
  status: "open" | "completed" | "failed" | "closed";
  reason?: string;
  chunks: Map<string, unknown[]>;
  pool: Pool;
  memDb?: IMemoryDb;
  done: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
};

function createRunRecord({
  runId,
  bufferLimit,
  pool,
  memDb,
}: {
  runId: string;
  bufferLimit: number;
  pool: Pool;
  memDb?: IMemoryDb;
}): RunRecord {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    runId,
    bufferLimit,
    status: "open",
    chunks: new Map(),
    pool,
    memDb,
    done: { promise, resolve, reject },
  };
}

function toRunHandle(record: RunRecord) {
  return Object.freeze({
    runId: record.runId,
    getReadable(streamName = "default") {
      return createReadableStream(record, streamName);
    },
    getWritable(streamName = "default") {
      return createWritableStream(record, streamName);
    },
    async done() {
      await record.done.promise;
      return Object.freeze({ runId: record.runId, status: record.status, reason: record.reason });
    },
  });
}

function createWritableStream(record: RunRecord, streamName: string): WritableStream<JsonValue> {
  const name = requireNonEmptyString(streamName, "streamName");
  let chunkSeq = 0;

  return new WritableStream({
    write(chunk) {
      if (record.status !== "open") {
        throw new StreamerClosedError({ runId: record.runId });
      }
      const chunks = record.chunks.get(name) ?? [];
      if (chunks.length >= record.bufferLimit) {
        throw new StreamerBackpressureError({ runId: record.runId, bufferLimit: record.bufferLimit });
      }
      chunkSeq += 1;
      const payload = clone(chunk);
      chunks.push(payload);
      record.chunks.set(name, chunks);
      const channel = streamChannel(record.runId, name);
      const notifyPayload = JSON.stringify({ runId: record.runId, streamName: name, chunkSeq, payload });
      if (record.memDb) {
        void record.pool.query(
          `INSERT INTO hobo_stream_chunks (run_id, stream_name, chunk_seq, payload)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [record.runId, name, chunkSeq, JSON.stringify(payload)],
        );
        void record.pool.query(`SELECT pg_notify($1, $2)`, [channel, notifyPayload]);
      } else {
        void record.pool.query(
          `INSERT INTO hobo_stream_chunks (run_id, stream_name, chunk_seq, payload)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [record.runId, name, chunkSeq, JSON.stringify(payload)],
        );
        void record.pool.query(`SELECT pg_notify($1, $2)`, [channel, notifyPayload]);
      }
    },
    close() {
      const chunks = record.chunks.get(name) ?? [];
      chunks.push(END_OF_STREAM);
      record.chunks.set(name, chunks);
    },
  });
}

function createReadableStream(record: RunRecord, streamName: string): ReadableStream<JsonValue> {
  const name = requireNonEmptyString(streamName, "streamName");
  let index = 0;
  const chunks = () => record.chunks.get(name) ?? [];

  return new ReadableStream({
    pull(controller) {
      const pending = chunks();
      if (index >= pending.length) {
        return;
      }
      const next = pending[index++];
      if (next === END_OF_STREAM) {
        controller.close();
        return;
      }
      controller.enqueue(clone(next));
    },
  });
}

function closeRun(record: RunRecord, close: { status: "completed" | "closed"; reason: string }) {
  record.status = close.status;
  record.reason = close.reason;
  void record.pool.query(`UPDATE hobo_stream_runs SET status = $2, reason = $3 WHERE run_id = $1`, [
    record.runId,
    close.status,
    close.reason,
  ]);
  record.done.resolve();
  return Object.freeze({ runId: record.runId, status: record.status, reason: record.reason });
}

function failRun(record: RunRecord, error: JsonValue) {
  record.status = "failed";
  record.reason = error instanceof Error ? error.message : String(error);
  record.done.reject(error instanceof Error ? error : new Error(String(error)));
}

function recordFor(runs: Map<string, RunRecord>, runId: string) {
  const record = runs.get(runId);
  if (!record) {
    throw new Error(`unknown streamer run: ${runId}`);
  }
  return record;
}

function streamChannel(runId: string, streamName: string) {
  return sanitizeChannel(`hobo_stream_${runId}_${streamName}`);
}

function sanitizeChannel(channel: string) {
  return channel.replace(/[^a-zA-Z0-9_]/g, "_");
}
