import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  createHoboCollectCli,
  createHelloBindleCollectProject,
  HELLO_BINDLE_MANIFEST_HASH,
  stableCollectStringify,
} from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const goldenPath = join(packageRoot, "contracts/manifests/hello-bindle.manifest.json");

test("hello-bindle-golden-manifest: collect output is byte-identical to golden fixture", async () => {
  const golden = await readFile(goldenPath, "utf8");
  const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.manifestHash, HELLO_BINDLE_MANIFEST_HASH);
  assert.equal(envelope.manifest.schema, "hobo.manifest/v1");
  assert.deepEqual(envelope.manifest.resources.todos.allow, ["get", "set"]);
  assert.equal(stableCollectStringify(envelope.manifest), golden);
});

test("hello-bindle-golden-manifest: repeated collect yields identical manifest hash", async () => {
  const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
  const first = await cli.run(["collect", "--json"]);
  const second = await cli.run(["collect", "--json"]);
  assert.equal(first.stdout, second.stdout);
  assert.equal(JSON.parse(first.stdout).manifestHash, HELLO_BINDLE_MANIFEST_HASH);
});

test("hello-bindle-golden-manifest: --out file matches golden fixture bytes", async () => {
  const golden = await readFile(goldenPath, "utf8");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");

  const dir = await mkdtemp(path.join(tmpdir(), "hello-bindle-golden-"));
  try {
    const outPath = path.join(dir, "hello-bindle.manifest.json");
    const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
    const result = await cli.run(["collect", "--out", outPath]);
    assert.equal(result.exitCode, 0);
    const written = await readFile(outPath, "utf8");
    assert.equal(written, golden);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
