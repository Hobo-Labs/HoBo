import type * as BlobEventsGuest from "../generated/blob-events/guest/blob-events-guest.js";
import type * as BlobEvents from "../generated/blob-events/guest/interfaces/hobo-blob-events-blob-events.js";
import type * as QueueGuest from "../generated/queue/guest/queue-guest.js";
import type * as Queue from "../generated/queue/guest/interfaces/hobo-queue-queue.js";
import type * as SchedulerGuest from "../generated/scheduler/guest/scheduler-guest.js";
import type * as Scheduler from "../generated/scheduler/guest/interfaces/hobo-scheduler-scheduler.js";

export type GuestWorldImports = [
  typeof QueueGuest,
  typeof SchedulerGuest,
  typeof BlobEventsGuest
];

export const queued: Queue.QueueMessage = {
  idempotencyKey: "order-123",
  body: new Uint8Array([1, 2, 3]),
  attributes: [{ key: "tenant", value: "acme" }],
  availableAtMs: 0n
};

export const interval: Scheduler.EverySpec = {
  everyMs: 60_000n,
  startAtMs: 0n,
  jitterMs: 1_000n
};

export const blobFilter: BlobEvents.BlobEventFilter = {
  bucket: "receipts",
  prefix: "orders/",
  events: ["created", "deleted"]
};
