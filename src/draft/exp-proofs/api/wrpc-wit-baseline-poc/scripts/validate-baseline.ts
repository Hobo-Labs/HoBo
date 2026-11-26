import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const lock = JSON.parse(await readFile(new URL("toolchain-lock.json", root), "utf8"));
// The workspace is pnpm-managed (single root lockfile), so pin-verify the
// installed jco against its resolved package manifest, not a per-package lock.
const jcoManifest = JSON.parse(
  await readFile(new URL("node_modules/@bytecodealliance/jco/package.json", root), "utf8"),
);

assert.equal(lock.decision, "ADR-0085");
assert.equal(lock.issue, "HOBO-12");
assert.equal(lock.toolchain.wasmtime.version, "46.0.1");
assert.equal(lock.toolchain.jco.version, "1.24.3");
assert.equal(lock.toolchain.componentizeJs.version, "0.21.0");
assert.equal(lock.toolchain.witBindgenCli.version, "0.58.0");
assert.equal(lock.toolchain.wrpc.version, "0.17.0");
assert.equal(lock.toolchain.wasmCloud.version, "2.4.0");
assert.equal(jcoManifest.version, lock.toolchain.jco.version);

assert.deepEqual(lock.manifestFloor.previewBumpsRequire, [
  "upcaster",
  "new-bindle-version",
  "deprecation-window",
]);

const vendored = lock.vendoredInterfaces[0];
assert.match(vendored.id, /^wasi:[a-z-]+\/[a-z-]+@\d+\.\d+\.\d+@(stable|preview|experimental|deprecated)$/);
assert.equal(vendored.upcasterRequiredOnBreakingChange, true);

const vendoredPath = new URL(vendored.path.replaceAll("\\", "/"), root);
const vendoredContent = await readFile(vendoredPath, "utf8");
const digest = createHash("sha256").update(vendoredContent).digest("hex");
assert.equal(digest, vendored.sha256);
assert.ok(lock.ciGuards.includes("wit-bindgen-cli-resolves-baseline-world"));

const world = await readFile(new URL("wit/world.wit", root), "utf8");
assert.match(world, /use wasi:clocks\/wall-clock@0\.2\.0/);
assert.match(world, /import wasi:clocks\/wall-clock@0\.2\.0/);
assert.match(world, /smoke-call: func/);

console.log(`wrpc-wit baseline ok: ${lock.toolchain.jco.package}@${lock.toolchain.jco.version}`);
