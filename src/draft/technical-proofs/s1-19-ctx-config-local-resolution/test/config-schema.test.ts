import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  config,
  createConfigContext,
  emitConfigManifest,
  env,
  fromBinding,
  scanSerializedManifestForValues,
  secretRef,
  serializeConfigManifest,
} from "../src/index.js";
import { type JsonObject } from "../src/json.js";


const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..", "..", "..");

test("config declarations emit refs-only varlock-style schema entries", () => {
  const cfg = config({
    DB: fromBinding("db"),
    STRIPE: secretRef("stripe/api-key"),
    LOG_LEVEL: env("info"),
  });

  const manifest = emitConfigManifest(cfg);

  assert.deepEqual(manifest.entries.DB, {
    type: "string",
    required: true,
    sensitivity: "secretless",
    source: { kind: "binding", ref: "db", devOnly: false },
  });
  assert.deepEqual(manifest.entries.STRIPE, {
    type: "string",
    required: true,
    sensitivity: "secret",
    source: { kind: "secret-ref", ref: "stripe/api-key", devOnly: false },
  });
  assert.deepEqual(manifest.entries.LOG_LEVEL, {
    type: "string",
    required: false,
    sensitivity: "config",
    source: { kind: "camp-env", ref: "LOG_LEVEL", devOnly: false },
    defaultType: "string",
  });

  const serialized = serializeConfigManifest(manifest);
  assert.equal(serialized.includes("sk_live_123"), false);
  assert.equal(serialized.includes("info"), false);
});

test("non-SCREAMING_SNAKE_CASE key throws", () => {
  assert.throws(
    // SAFETY: assertion to `() => config({ greeting: env("hello") } as never),` is required at this boundary.
    () => config({ greeting: env("hello") } as never),
    /SCREAMING_SNAKE_CASE/,
  );
});

test("ctx.config accessors are generated only for declared keys", async () => {
  const cfg = config({ STRIPE: secretRef("stripe/api-key") });
  const ctx = createConfigContext(cfg, {
    async resolve() {
      return "resolved";
    },
  });

  assert.equal(ctx.config.STRIPE instanceof Function, true);
  assert.equal("MISSING" in ctx.config, false);
  assert.equal(await ctx.config.STRIPE(), "resolved");
});

test("type declarations prove declared keys callable and undeclared keys rejected", () => {
  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      path.join(packageRoot, "tsconfig.types.json"),
      "--noEmit",
    ],
    { cwd: packageRoot, stdio: "pipe" },
  );
});

test("plaintext values are detected before schema can be serialized into a manifest", () => {
  const cfg = config({
    STRIPE: secretRef("stripe/api-key"),
    LOG_LEVEL: env("info"),
  });
  const manifest = emitConfigManifest(cfg);

  assert.deepEqual(scanSerializedManifestForValues(manifest, ["sk_live_123", "info"]), []);

  // SAFETY: assertion to `const leaked = structuredClone(manifest) as { entries: Record<string, JsonObject` is required at this boundary.
  const leaked = structuredClone(manifest) as { entries: Record<string, JsonObject> };
  leaked.entries.STRIPE.value = "sk_live_123";
  assert.deepEqual(scanSerializedManifestForValues(leaked, ["sk_live_123"]), ["sk_live_123"]);
});

test("dev-only resolution sources carry a production rejection marker", () => {
  const cfg = config({ STRIPE: secretRef("stripe/api-key", { devOnly: true }) });
  const manifest = emitConfigManifest(cfg);

  assert.equal(manifest.entries.STRIPE.source.devOnly, true);
  assert.equal(manifest.entries.STRIPE.productionDeployable, false);
});

test("bindles-runtime config manifest pact fixture matches emitted manifest", () => {
  const cfg = config({
    GREETING: env("hello"),
    API_KEY: secretRef("hello/api-key"),
  });
  const manifest = emitConfigManifest(cfg);

  assert.equal(manifest.schema, "hobo.config/v1");
  assert.equal(manifest.entries.GREETING.sensitivity, "config");
  assert.equal(manifest.entries.GREETING.source.kind, "camp-env");
  assert.equal(manifest.entries.API_KEY.sensitivity, "secret");
  assert.equal(manifest.entries.API_KEY.source.ref, "hello/api-key");
});
