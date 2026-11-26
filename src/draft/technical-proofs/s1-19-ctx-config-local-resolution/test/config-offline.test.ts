import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  assertNoPlaintextConformance,
  cfg,
  clearSecretRegistry,
  createConfigResolver,
  createDevSecretsAdapter,
  createInMemoryEventStore,
  createRuntimeCtx,
  helloHandler,
  resetEventSeq,
} from "../src/index.js";

test("hello-bindle boots offline and reads config + secret with redaction", async () => {
  clearSecretRegistry();
  resetEventSeq();

  const canary = `s3cr3t-canary-${randomUUID()}`;
  const dir = mkdtempSync(path.join(tmpdir(), "hello-bindle-"));
  const envLocalPath = path.join(dir, ".env.local");
  writeFileSync(envLocalPath, `HELLO_API_KEY=${canary}\n`, "utf8");

  const eventStore = createInMemoryEventStore();
  const secrets = createDevSecretsAdapter({ envLocalPath, isCi: true });
  const resolver = createConfigResolver({
    camp: "local",
    campConfig: { GREETING: "world", LOG_LEVEL: "debug" },
    secrets,
    eventStore,
    isLocalCamp: true,
  });
  const ctx = createRuntimeCtx({ contract: cfg, resolver, eventStore });

  const started = Date.now();
  const result = await helloHandler(ctx);
  const elapsed = Date.now() - started;

  assert.equal(result.greeting, "world");
  assert.equal(result.logLevel, "debug");
  assert.equal(result.apiKey, canary);

  const secretAccessed = eventStore.events.filter((event) => event.type === "secret.Accessed");
  assert.equal(secretAccessed.length, 1);
  assert.equal(secretAccessed[0]?.data.camp, "local");
  assert.equal(secretAccessed[0]?.data.source, "dev");
  assert.equal(secretAccessed[0]?.data.productionDeployable, false);

  const configResolved = eventStore.events.filter((event) => event.type === "config.Resolved");
  assert.equal(configResolved.length, 3);

  assertNoPlaintextConformance(
    {
      events: eventStore.events,
      logs: ctx.logs,
      spans: ctx.spans,
      streams: ctx.streamFrames,
    },
    [canary],
  );

  assert.ok(elapsed < 60_000, `boot-to-first-config-read took ${elapsed}ms`);
});
