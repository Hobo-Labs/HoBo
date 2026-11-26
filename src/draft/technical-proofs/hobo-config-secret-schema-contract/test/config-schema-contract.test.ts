import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  secret,
  secretRef,
  serializeConfigManifest
} from "../src/config-schema.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..", "..", "..");

test("config declarations emit refs-only varlock-style schema entries", () => {
  const cfg = config({
    DB: fromBinding("db"),
    STRIPE: secretRef("stripe/api-key"),
    LOG_LEVEL: env("info")
  });

  const manifest = emitConfigManifest(cfg);

  assert.deepEqual(manifest.entries.DB, {
    type: "string",
    required: true,
    sensitivity: "secretless",
    source: {
      kind: "binding",
      ref: "db",
      devOnly: false
    }
  });
  assert.deepEqual(manifest.entries.STRIPE, {
    type: "string",
    required: true,
    sensitivity: "secret",
    source: {
      kind: "secret-ref",
      ref: "stripe/api-key",
      devOnly: false
    }
  });
  assert.deepEqual(manifest.entries.LOG_LEVEL, {
    type: "string",
    required: false,
    sensitivity: "config",
    source: {
      kind: "camp-env",
      ref: "LOG_LEVEL",
      devOnly: false
    },
    defaultType: "string"
  });

  const serialized = serializeConfigManifest(manifest);
  assert.equal(serialized.includes("sk_live_123"), false);
  assert.equal(serialized.includes("info"), false);
});

test("ctx.config accessors are generated only for declared keys", async () => {
  const cfg = config({
    STRIPE: secretRef("stripe/api-key")
  });
  const ctx = createConfigContext(cfg, async (key) => `${key}:resolved`);

  assert.equal(ctx.config.STRIPE instanceof Function, true);
  assert.equal("MISSING" in ctx.config, false);
  assert.equal(await ctx.config.STRIPE(), "STRIPE:resolved");
});

test("type declarations prove declared keys callable and undeclared keys rejected", () => {
  const args = [
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    path.join(packageRoot, "types", "config-surface.types.ts")
  ];
  const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

  execFileSync(
    process.execPath,
    [tscPath, ...args],
    { cwd: packageRoot, stdio: "pipe" }
  );
});

test("secretRef and catalog secret are distinct authoring exports", () => {
  const secretStore = secret("payments");
  const stripe = secretRef("stripe/api-key");

  assert.notEqual(secret, secretRef);
  assert.equal(secretStore.kind, "managed-secret-store");
  assert.equal(secretStore.portRef, "hobo:secrets");
  assert.equal(stripe.kind, "secret-ref");
});

test("plaintext values are detected before schema can be serialized into a manifest", () => {
  const cfg = config({
    STRIPE: secretRef("stripe/api-key"),
    LOG_LEVEL: env("info")
  });
  const manifest = emitConfigManifest(cfg);

  assert.deepEqual(
    scanSerializedManifestForValues(manifest, ["sk_live_123", "info"]),
    []
  );

  manifest.entries.STRIPE.value = "sk_live_123";
  assert.deepEqual(scanSerializedManifestForValues(manifest, ["sk_live_123"]), [
    "sk_live_123"
  ]);
});

test("secretRef declarations survive even when never read", () => {
  const cfg = config({
    STRIPE: secretRef("stripe/api-key")
  });

  const manifest = emitConfigManifest(cfg);

  assert.equal(manifest.entries.STRIPE.source.ref, "stripe/api-key");
});

test("dev-only resolution sources carry a production rejection marker", () => {
  const cfg = config({
    STRIPE: secretRef("stripe/api-key", { devOnly: true })
  });

  const manifest = emitConfigManifest(cfg);

  assert.equal(manifest.entries.STRIPE.source.devOnly, true);
  assert.equal(manifest.entries.STRIPE.productionDeployable, false);
});

test("published declarations describe the config contract surface", () => {
  const declarations = readFileSync(
    path.join(packageRoot, "src", "config-schema.d.mts"),
    "utf8"
  );

  assert.match(declarations, /export declare function config/);
  assert.match(declarations, /export declare function secretRef/);
  assert.match(declarations, /ConfigContext/);
});
