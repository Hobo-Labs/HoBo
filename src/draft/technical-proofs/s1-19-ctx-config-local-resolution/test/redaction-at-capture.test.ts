import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";

import {
  assertNoPlaintextConformance,
  clearSecretRegistry,
  config,
  createConfigResolver,
  createInMemoryEventStore,
  createRuntimeCtx,
  resetEventSeq,
  secretRef,
  SecretUnavailableError,
  SecretValue,
} from "../src/index.js";

test("redaction-at-capture: canary secret absent from all persisted surfaces", async () => {
  clearSecretRegistry();
  resetEventSeq();

  const canary = `s3cr3t-canary-${randomUUID()}`;
  const eventStore = createInMemoryEventStore();
  const secrets = {
    async get() {
      return new SecretValue(canary);
    },
  };

  const contract = config({ API_KEY: secretRef("test/api-key") });
  const resolver = createConfigResolver({
    camp: "local",
    campConfig: {},
    secrets,
    eventStore,
    isLocalCamp: true,
  });
  const ctx = createRuntimeCtx({ contract, resolver, eventStore });

  const apiKey = await ctx.config.API_KEY();
  assert.ok(apiKey instanceof SecretValue);
  assert.equal(apiKey.reveal(), canary);

  ctx.log("resolved secret", { apiKey });
  ctx.emit("test.SecretUsed", { apiKey, note: `value was ${canary}` });
  ctx.stream({ apiKey, canary });

  assertNoPlaintextConformance(
    {
      events: eventStore.events,
      logs: ctx.logs,
      spans: ctx.spans,
      streams: ctx.streamFrames,
    },
    [canary],
  );

  const resolvedEvents = eventStore.events.filter((event) => event.type === "config.Resolved");
  assert.equal(resolvedEvents.length, 1);
  assert.deepEqual(resolvedEvents[0]?.data, {
    key: "API_KEY",
    ref: "test/api-key",
    source: "dev-secret",
    camp: "local",
  });
  const resolvedData = resolvedEvents[0]?.data;
  assert.ok(resolvedData);
  assert.equal("value" in resolvedData, false);
});

test("unresolvable secretRef throws SecretUnavailableError and emits secret.Unavailable", async () => {
  clearSecretRegistry();
  resetEventSeq();

  const eventStore = createInMemoryEventStore();
  const secrets = {
    async get(ref: string, ctx: { camp: string }) {
      throw new SecretUnavailableError(ref, ctx.camp, "not found");
    },
  };

  const contract = config({ API_KEY: secretRef("missing/ref") });
  const resolver = createConfigResolver({
    camp: "local",
    campConfig: {},
    secrets,
    eventStore,
    isLocalCamp: true,
  });
  const ctx = createRuntimeCtx({ contract, resolver, eventStore });

  await assert.rejects(() => ctx.config.API_KEY(), SecretUnavailableError);

  const unavailable = eventStore.events.filter((event) => event.type === "secret.Unavailable");
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0]?.data.ref, "missing/ref");
  assert.equal(unavailable[0]?.data.camp, "local");
});

test("no-plaintext conformance fails if a secret would land in an event log", () => {
  assert.throws(
    () =>
      assertNoPlaintextConformance(
        { events: [{ type: "debug.Leaked", data: { message: "leaked sk_live_222" } }] },
        ["sk_live_222"],
      ),
    /events contains plaintext secret/,
  );
});
