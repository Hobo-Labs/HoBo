import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  createDevSecretsAdapter,
  SecretUnavailableError,
} from "../src/index.js";

test("dev ladder: .env.local beats keychain beats prompt", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hobo-secrets-"));
  const envLocalPath = path.join(dir, ".env.local");
  writeFileSync(envLocalPath, "HELLO_API_KEY=from-env-local\n", "utf8");

  const adapter = createDevSecretsAdapter({
    envLocalPath,
    keychain: () => "from-keychain",
    prompt: () => "from-prompt",
    isCi: false,
  });

  const secret = await adapter.get("hello/api-key", { camp: "local" });
  assert.equal(secret.reveal(), "from-env-local");
  assert.deepEqual(adapter.reads, [{ ref: "hello/api-key", source: "env-local" }]);
  assert.equal(adapter.productionDeployable, false);
});

test("dev ladder: keychain used when .env.local missing entry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hobo-secrets-"));
  const envLocalPath = path.join(dir, ".env.local");
  writeFileSync(envLocalPath, "OTHER_KEY=value\n", "utf8");

  const adapter = createDevSecretsAdapter({
    envLocalPath,
    keychain: (_service, account) => (account === "hello/api-key" ? "from-keychain" : undefined),
    prompt: () => "from-prompt",
    isCi: false,
  });

  const secret = await adapter.get("hello/api-key", { camp: "local" });
  assert.equal(secret.reveal(), "from-keychain");
  assert.deepEqual(adapter.reads[0]?.source, "keychain");
});

test("dev ladder: prompt used when .env.local and keychain miss", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hobo-secrets-"));
  const envLocalPath = path.join(dir, ".env.local");

  const adapter = createDevSecretsAdapter({
    envLocalPath,
    keychain: () => undefined,
    prompt: () => "from-prompt",
    isCi: false,
  });

  const secret = await adapter.get("hello/api-key", { camp: "local" });
  assert.equal(secret.reveal(), "from-prompt");
  assert.deepEqual(adapter.reads, [{ ref: "hello/api-key", source: "prompt" }]);
});

test("dev ladder: prompt skipped when CI=1", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hobo-secrets-"));
  const envLocalPath = path.join(dir, ".env.local");

  const adapter = createDevSecretsAdapter({
    envLocalPath,
    keychain: () => undefined,
    prompt: () => "should-not-run",
    isCi: true,
  });

  await assert.rejects(
    () => adapter.get("hello/api-key", { camp: "local" }),
    SecretUnavailableError,
  );
});

test("runtime-secrets-port pact shape: dev resolution metadata", async () => {
  const adapter = createDevSecretsAdapter({
    envLocalPath: path.join(mkdtempSync(path.join(tmpdir(), "hobo-pact-")), ".env.local"),
    keychain: () => "pact-secret",
    isCi: false,
  });

  const secret = await adapter.get("hello/api-key", { camp: "local" });
  assert.equal(String(secret), "[secret:redacted]");
  assert.equal(adapter.productionDeployable, false);
});
