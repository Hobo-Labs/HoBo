import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  proveCheckoutDurability,
  runRuntimePortDurabilitySuite,
} from "../../runtime-port-conformance-contract/src/runtime-port-conformance.js";
import {
  RUNTIME_POSTGRES_PORTS_VERSION,
  createPostgresDurabilityBackend,
  createPostgresDurabilityBackendFactory,
} from "../src/runtime-postgres-ports.js";

test("runtime-postgres passes the runtime-port durability conformance suite", async () => {
  const report = await runRuntimePortDurabilitySuite(createPostgresDurabilityBackendFactory());

  assert.equal(report.contract, RUNTIME_PORT_CONFORMANCE_VERSION);
  assert.equal(report.backend, "runtime-postgres");
  assert.equal(report.status, "pass");
  assert.deepEqual(report.failures, []);
});

test("checkout durability proof replays the same final state on postgres", async () => {
  const backend = createPostgresDurabilityBackend();
  const proof = await proveCheckoutDurability(backend);

  assert.equal(backend.contract, RUNTIME_POSTGRES_PORTS_VERSION);
  assert.deepEqual(proof.liveState, proof.replayState);
  assert.deepEqual(proof.replayState, {
    runId: "checkout:run-1",
    status: "paid",
    reservedItems: ["sku-hobo-mug"],
    chargedCents: 4200,
    duplicateCharges: 0,
    timedOut: false,
  });
});

test("postgres streamer persists chunks to stream tables", async () => {
  const backend = createPostgresDurabilityBackend();
  const streamer = backend.streamer;
  const run = streamer.createRun({ runId: "notify-run-1" });

  const writer = run.getWritable("events");
  const writerStream = writer.getWriter();
  await writerStream.write({ seq: 1, value: "hello" });
  await writerStream.close();

  const reader = run.getReadable("events");
  const readerStream = reader.getReader();
  const chunk = await readerStream.read();
  assert.deepEqual(chunk.value, { seq: 1, value: "hello" });

  const persisted = await backend.pool.query(
    `SELECT payload FROM hobo_stream_chunks
     WHERE run_id = $1 AND stream_name = $2 AND chunk_seq = 1`,
    ["notify-run-1", "events"],
  );
  assert.deepEqual(persisted.rows[0]?.payload, { seq: 1, value: "hello" });
});
