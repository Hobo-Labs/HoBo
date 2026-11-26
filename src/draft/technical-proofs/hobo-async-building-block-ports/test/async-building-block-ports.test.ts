import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  getContractCatalog,
  parseWitFunctions,
  requireFunction,
  requireRecordField
} from "../src/contract.js";

const root = join(import.meta.dirname, "..");

async function readGenerated(...segments) {
  return readFile(join(root, "generated", ...segments), "utf8");
}

test("contract catalog exposes the three HoBo async building-block interfaces", async () => {
  const catalog = await getContractCatalog(root);

  assert.deepEqual(
    catalog.map((entry) => entry.package),
    ["hobo:queue@0.1.0", "hobo:scheduler@0.1.0", "hobo:blob-events@0.1.0"]
  );
  assert.deepEqual(
    catalog.map((entry) => entry.interface),
    ["queue", "scheduler", "blob-events"]
  );
  assert.ok(catalog.every((entry) => entry.stability === "experimental"));
});

test("jco emits guest bindings for queue, scheduler, and blob-events imports", async () => {
  const queueGuest = await readGenerated("queue", "guest", "interfaces", "hobo-queue-queue.d.ts");
  const schedulerGuest = await readGenerated(
    "scheduler",
    "guest",
    "interfaces",
    "hobo-scheduler-scheduler.d.ts"
  );
  const blobEventsGuest = await readGenerated(
    "blob-events",
    "guest",
    "interfaces",
    "hobo-blob-events-blob-events.d.ts"
  );

  assert.match(queueGuest, /enqueue\(/);
  assert.match(schedulerGuest, /every\(/);
  assert.match(schedulerGuest, /cron\(/);
  assert.match(blobEventsGuest, /downloadUrl\(/);
});

test("each WIT package defines guest import and provider export worlds", async () => {
  const packages = [
    ["queue", "queue"],
    ["scheduler", "scheduler"],
    ["blob-events", "blob-events"]
  ];

  for (const [name, worldPrefix] of packages) {
    const wit = await readFile(join(root, "wit", `${name}.wit`), "utf8");
    assert.match(wit, new RegExp(`world ${worldPrefix}-guest \\{\\s+import ${worldPrefix};`, "m"));
    assert.match(wit, new RegExp(`world ${worldPrefix}-provider \\{\\s+export ${worldPrefix};`, "m"));
  }
});

test("queue WIT carries at-least-once delivery, lease, and idempotency fields", async () => {
  const queueWit = await readFile(join(root, "wit", "queue.wit"), "utf8");
  const queue = parseWitFunctions(queueWit, "queue");

  requireFunction(queue, "enqueue");
  requireFunction(queue, "dequeue");
  requireFunction(queue, "complete");
  requireFunction(queue, "extend-lease");
  requireFunction(queue, "release");

  requireRecordField(queueWit, "queue-message", "idempotency-key");
  requireRecordField(queueWit, "dequeue-request", "visibility-timeout-ms");
  requireRecordField(queueWit, "leased-message", "lease-id");
  requireRecordField(queueWit, "leased-message", "lease-expires-at-ms");
  requireRecordField(queueWit, "leased-message", "delivery-attempt");
});

test("scheduler WIT distinguishes interval and cron triggers", async () => {
  const schedulerWit = await readFile(join(root, "wit", "scheduler.wit"), "utf8");
  const scheduler = parseWitFunctions(schedulerWit, "scheduler");
  const schedulerTypes = await readGenerated(
    "scheduler",
    "guest",
    "interfaces",
    "hobo-scheduler-scheduler.d.ts"
  );

  requireFunction(scheduler, "every");
  requireFunction(scheduler, "cron");
  assert.deepEqual([...scheduler].sort(), ["cron", "every"]);
  assert.match(schedulerTypes, /Every/);
  assert.match(schedulerTypes, /Cron/);
  assert.match(schedulerTypes, /everyMs/);
  assert.match(schedulerTypes, /timezone/);
});

test("blob-events WIT includes event filters and presigned URL contracts", async () => {
  const blobEventsWit = await readFile(join(root, "wit", "blob-events.wit"), "utf8");
  const blobEvents = await readGenerated(
    "blob-events",
    "guest",
    "interfaces",
    "hobo-blob-events-blob-events.d.ts"
  );

  assert.match(blobEvents, /BlobEventKind/);
  assert.match(blobEvents, /BlobEventFilter/);
  assert.match(blobEvents, /downloadUrl/);
  assert.match(blobEvents, /uploadUrl/);
  assert.match(blobEvents, /expiresInMs/);
  assert.doesNotMatch(blobEventsWit, /delivery-queue/);
});
