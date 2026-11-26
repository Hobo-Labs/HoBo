import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  createLocalActorHost,
  createManualClock,
  StaleFenceError,
} from "../src/actor-host-runtime-port.js";

test("actor-host pact contract pins consumer, provider, and boundary interactions", () => {
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/actor_host_runtime_port_contract.pact.json", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(pact.consumer.name, "@hobo/conformance");
  assert.equal(pact.provider.name, "@hobo/runtime-local");
  assert.equal(pact.interactions.length, 3);
  assert.match(pact.interactions[1].response.body.error, /StaleFenceError/);
});

test("actor-host pact provider replays append and stale-fence interactions", async () => {
  const clock = createManualClock("2026-06-25T12:00:00.000Z");
  const host = createLocalActorHost({ clock, leaseTtlMs: 1_000 });
  const state = host.state("cart-42", {
    initialState: { value: 0 },
    fold: (current, event) =>
      event.type === "counter.Added"
        ? { value: current.value + (event.amount ?? 0) }
        : current,
  });

  for (let fence = 1n; fence < 7n; fence += 1n) {
    const lease = await host.acquire("cart-42", { holderId: `worker-${fence}` });
    lease.release();
  }

  const lease = await host.acquire("cart-42", { holderId: "worker-7" });
  const receipt = await state.append(lease, { type: "counter.Added", amount: 1 });
  assert.equal(receipt.fenceToken, 7n);
  assert.equal(receipt.seq, 8);

  const forgedLease = {
    key: lease.key,
    holderId: lease.holderId,
    fenceToken: 6n,
    expiresAt: lease.expiresAt,
    renew() {},
    release() {},
  };
  await assert.rejects(
    () => state.append(forgedLease, { type: "counter.Added", amount: 99 }),
    StaleFenceError,
  );

  const projection = await state.read();
  assert.equal(projection.activatedFromSnapshotSeq, 0);
  assert.ok(projection.replayedEventCount >= 1);
});
