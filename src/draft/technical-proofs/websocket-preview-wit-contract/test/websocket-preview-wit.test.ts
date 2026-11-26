import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  assertPreviewWebsocketContract,
  buildManifestFragment,
  staticFeedbackForImports,
  validatePreviewUpgrade
} from "../src/websocket-preview-contract.js";

const packageRoot = join(import.meta.dirname, "..");

async function readGeneratedFiles(...segments) {
  return readdir(join(packageRoot, "generated", ...segments), { recursive: true });
}

test("WIT contracts pin preview wasi:websocket and stable hobo:websocket extension", async () => {
  const contract = await assertPreviewWebsocketContract(packageRoot);

  assert.deepEqual(contract.packages.map((entry) => entry.id), [
    "wasi:websocket@0.0.1-draft",
    "hobo:websocket@0.1.0"
  ]);
  assert.equal(contract.packages[0].stability, "preview");
  assert.equal(contract.packages[1].stability, "stable");
  assert.deepEqual(contract.wasi.functions["incoming-handler"], ["handle"]);
  assert.deepEqual(contract.wasi.functions.outgoing, ["connect"]);
  assert.deepEqual(contract.hobo.functions.extension, [
    "principal",
    "send-to",
    "join",
    "leave",
    "broadcast"
  ]);
});

test("jco emits guest bindings for both websocket WIT packages", async () => {
  const wasiGenerated = await readGeneratedFiles("wasi-websocket", "guest");
  const hoboGenerated = await readGeneratedFiles("hobo-websocket", "guest");

  assert.ok(
    wasiGenerated.some((file) => file.endsWith("wasi-websocket-incoming-handler.d.ts")),
    "wasi websocket incoming-handler binding missing"
  );
  assert.ok(
    hoboGenerated.some((file) => file.endsWith("hobo-websocket-extension.d.ts")),
    "hobo websocket extension binding missing"
  );
});

test("guest server stub exports incoming-handler and imports extension types", async () => {
  const guest = await readFile(join(packageRoot, "test", "guest-server.ts"), "utf8");

  assert.match(guest, /handle\(request: AcceptRequest\)/);
  assert.match(guest, /sendTo/);
  assert.match(guest, /PrincipalRef/);
});

test("manifest fragment records interface versions, stability tiers, and source digests", async () => {
  const manifest = await buildManifestFragment(packageRoot);

  assert.equal(manifest.schema, "hobo.manifest.fragment/websocket-preview/v1");
  assert.deepEqual(
    manifest.imports.map((entry) => `${entry.interface}@${entry.version}@${entry.stability}`),
    [
      "wasi:websocket/outgoing@0.0.1-draft@preview",
      "hobo:websocket/extension@0.1.0@stable"
    ]
  );
  assert.deepEqual(
    manifest.exports.map((entry) => `${entry.interface}@${entry.version}@${entry.stability}`),
    ["wasi:websocket/incoming-handler@0.0.1-draft@preview"]
  );
  assert.ok(manifest.imports.every((entry) => /^sha256:[0-9a-f]{64}$/.test(entry.digest)));
});

test("static feedback warns on preview websocket imports with precise remediation", () => {
  const feedback = staticFeedbackForImports([
    { interface: "wasi:websocket/outgoing", version: "0.0.1-draft", stability: "preview" },
    { interface: "hobo:websocket/extension", version: "0.1.0", stability: "stable" }
  ]);

  assert.deepEqual(feedback, [
    {
      code: "interface.preview.pinned",
      severity: "warning",
      interface: "wasi:websocket/outgoing",
      version: "0.0.1-draft",
      message: "wasi:websocket/outgoing@0.0.1-draft is preview: pinned, may change before ratification.",
      remediation: "Keep the exact manifest pin and require an upcaster for any preview version bump."
    }
  ]);
});

test("preview version bump without an upcaster fails closed while hobo extension stays stable", () => {
  const failed = validatePreviewUpgrade({
    from: "wasi:websocket@0.0.1-draft",
    to: "wasi:websocket@0.0.2-draft",
    upcasters: []
  });
  const accepted = validatePreviewUpgrade({
    from: "wasi:websocket@0.0.1-draft",
    to: "wasi:websocket@0.0.2-draft",
    upcasters: ["wasi:websocket@0.0.1-draft->wasi:websocket@0.0.2-draft"]
  });

  assert.deepEqual(failed, {
    ok: false,
    code: "upcaster-required",
    from: "wasi:websocket@0.0.1-draft",
    to: "wasi:websocket@0.0.2-draft",
    hoboExtension: "hobo:websocket@0.1.0"
  });
  assert.deepEqual(accepted, {
    ok: true,
    code: "upcaster-present",
    from: "wasi:websocket@0.0.1-draft",
    to: "wasi:websocket@0.0.2-draft",
    hoboExtension: "hobo:websocket@0.1.0"
  });
});
