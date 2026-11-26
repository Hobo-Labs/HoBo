import { type JsonObject } from "../json.js";
import type { RuntimeDurabilityBackend } from "./types.js";

export async function proveCheckoutDurability(backend: RuntimeDurabilityBackend) {
  const runId = "checkout:run-1";
  const streamId = runId;
  const { eventStore, queue, clock, actorHost } = backend;

  await eventStore.append(
    streamId,
    [{ type: "checkout.Started", data: { runId } }],
    appendOptions(0, "checkout-started"),
  );

  const cart = actorHost.state(`cart:${runId}`, {
    // SAFETY: assertion to `[] as string[]` is required at this boundary.
    initialState: { reservedItems: [] as string[] },
    fold: (state: { reservedItems: string[] }, event: { type: string; sku?: string }) =>
      event.type === "cart.ItemReserved"
        ? { reservedItems: [...state.reservedItems, event.sku!] }
        : state,
  });
  const cartLease = actorHost.acquire(`cart:${runId}`, { holderId: "checkout-worker" });
  cart.append(cartLease, { type: "cart.ItemReserved", sku: "sku-hobo-mug" });

  await eventStore.append(
    streamId,
    [{ type: "checkout.ItemReserved", data: { sku: "sku-hobo-mug" } }],
    appendOptions(1, "checkout-reserved"),
  );

  clock.sleep(runId, 30_000, {
    idempotencyKey: `timeout:${runId}`,
    label: "payment-timeout",
  });
  const queued = await queue.enqueue(
    "payments",
    { runId, cents: 4200 },
    { idempotencyKey: `charge:${runId}` },
  );
  await queue.enqueue(
    "payments",
    { runId, cents: 4200 },
    { idempotencyKey: `charge:${runId}` },
  );

  const queueEffects: string[] = [];
  await queue.handle("payments", async (message: { idempotencyKey: string; body: { cents: number } }) => {
    queueEffects.push(message.idempotencyKey);
    await eventStore.append(
      streamId,
      [{ type: "checkout.PaymentCaptured", data: { cents: message.body.cents } }],
      appendOptions(2, "checkout-paid"),
    );
  });
  queue.simulateRedelivery(queued.messageId);
  await queue.handle("payments", async (message: { idempotencyKey: string }) => {
    queueEffects.push(message.idempotencyKey);
  });

  clock.advance(30_000);

  await eventStore.append(
    streamId,
    [{ type: "checkout.Completed", data: { status: "paid" } }],
    appendOptions(3, "checkout-completed"),
  );

  const live = await eventStore.fold(streamId, {
    initialState: checkoutInitialState(runId),
    handlers: checkoutHandlers(),
  });
  const events = await eventStore.read(streamId);
  const replayState = foldCheckoutEvents(events, runId);

  return Object.freeze({
    liveState: live.state,
    replayState,
    queueEffects: Object.freeze(queueEffects),
    clockTrace: Object.freeze(
      clock.trace().filter(
        (entry: { type: string }) => entry.type.startsWith("clock.") || entry.type.startsWith("timer."),
      ),
    ),
  });
}

function checkoutInitialState(runId: string) {
  return {
    runId,
    status: "pending",
    // SAFETY: assertion to `[] as string[]` is required at this boundary.
    reservedItems: [] as string[],
    chargedCents: 0,
    duplicateCharges: 0,
    timedOut: false,
  };
}

function checkoutHandlers() {
  return {
    "checkout.Started": (state: ReturnType<typeof checkoutInitialState>) => ({ ...state, status: "started" }),
    "checkout.ItemReserved": (state: ReturnType<typeof checkoutInitialState>, event: { data: { sku: string } }) => ({
      ...state,
      reservedItems: [...state.reservedItems, event.data.sku],
    }),
    "checkout.PaymentCaptured": (state: ReturnType<typeof checkoutInitialState>, event: { data: { cents: number } }) => ({
      ...state,
      status: "paid",
      duplicateCharges: state.chargedCents > 0 ? state.duplicateCharges + 1 : state.duplicateCharges,
      chargedCents: state.chargedCents + event.data.cents,
    }),
    "checkout.Completed": (state: ReturnType<typeof checkoutInitialState>, event: { data: { status: string } }) => ({
      ...state,
      status: event.data.status,
    }),
    "checkout.TimedOut": (state: ReturnType<typeof checkoutInitialState>) => ({
      ...state,
      status: "timed-out",
      timedOut: true,
    }),
  };
}

function foldCheckoutEvents(events: Array<{ type: string; seq: number; data?: JsonObject }>, runId: string) {
  const handlers = checkoutHandlers();
  let state = checkoutInitialState(runId);

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    // SAFETY: assertion to `event.type as keyof typeof handlers` is required at this boundary.
    const handler = handlers[event.type as keyof typeof handlers];
    if (handler) {
      // SAFETY: assertion to `event as never` is required at this boundary.
      state = handler(state, event as never);
    }
  }

  return state;
}

function appendOptions(expectedSeq: number, correlationId: string) {
  return {
    expectedSeq,
    actor: { kind: "system", id: "runtime-port-conformance" },
    tenant: "conformance-tenant",
    correlationId,
  };
}
