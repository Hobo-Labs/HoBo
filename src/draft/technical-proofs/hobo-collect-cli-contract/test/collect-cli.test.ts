import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  createHoboCollectCli,
  sampleCollectProject,
  stableStringify,
} from "../src/collect-cli.js";

test("collect prints hobo.manifest/v1 with inferred allow sets and stable JSON envelope", async () => {
  const cli = createHoboCollectCli({ project: sampleCollectProject() });

  const first = await cli.run(["collect", "--json"]);
  const second = await cli.run(["collect", "--json"]);

  assert.equal(first.exitCode, 0);
  assert.equal(first.stderr, "");
  assert.equal(first.stdout, second.stdout);

  const envelope = JSON.parse(first.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "collect");
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.collection.coverageComplete, true);
  assert.equal(envelope.manifest.schema, "hobo.manifest/v1");
  assert.deepEqual(envelope.manifest.resources.catalog.allow, ["get", "set"]);
  assert.deepEqual(envelope.manifest.resources.images.allow, ["read", "write"]);
  assert.deepEqual(envelope.manifest.resources.api.links, [
    { import: "wasi:keyvalue", to: "catalog" },
    { import: "wasi:blobstore", to: "images" },
  ]);
});

test("coverage-incomplete collection is labeled and never presented as complete", async () => {
  const project = sampleCollectProject({ includeStaticUnhitBranch: true });
  const cli = createHoboCollectCli({ project });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "coverage-incomplete");
  assert.equal(envelope.collection.coverageComplete, false);
  assert.equal(envelope.collection.diagnostics[0].code, "collection.coverage.unobserved-resource");
  assert.equal(envelope.collection.diagnostics[0].resourceId, "dead-cache");
  assert.equal(envelope.manifest.resources["dead-cache"], undefined);

  const human = await cli.run(["collect"]);
  assert.match(human.stdout, /COLLECTION INCOMPLETE/);
  assert.doesNotMatch(human.stdout, /collection complete/i);
});

test("--out writes the manifest IR to a stable file and keeps stdout as a status envelope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-collect-out-"));
  try {
    const outPath = path.join(dir, "snapshop.manifest.json");
    const cli = createHoboCollectCli({ project: sampleCollectProject() });

    const result = await cli.run(["collect", "--out", outPath, "--json"]);

    assert.equal(result.exitCode, 0);
    const envelope = JSON.parse(result.stdout);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.equal(envelope.out, outPath);
    assert.deepEqual(written, envelope.manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--camp selects the camp in the stable read-only collect envelope", async () => {
  const cli = createHoboCollectCli({ project: sampleCollectProject() });

  const result = await cli.run(["collect", "--camp", "dev", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.camp, "dev");
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.manifest.schema, "hobo.manifest/v1");
});

test("collection failure reports context and never emits a partial manifest", async () => {
  const cli = createHoboCollectCli({
    project: sampleCollectProject({
      define() {
        throw new Error("route module crashed");
      },
    }),
  });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "HOBO_COLLECT_FAILED");
  assert.match(envelope.message, /snapshop.ts: route module crashed/);
  assert.equal(envelope.partialManifest, false);
  assert.equal(envelope.manifest, undefined);
});

test("non-TypeScript guests get a static-analysis-required diagnostic", async () => {
  const cli = createHoboCollectCli({
    project: sampleCollectProject({ guestLanguage: "rust" }),
  });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.code, "HOBO_COLLECT_STATIC_ANALYSIS_REQUIRED");
  assert.match(envelope.message, /static analysis required for non-TypeScript guest "rust"/);
  assert.equal(envelope.partialManifest, false);
});

test("secret values are redacted while secret refs remain inspectable", async () => {
  const cli = createHoboCollectCli({
    project: sampleCollectProject({
      secretRefs: [
        { name: "stripe", ref: "env:STRIPE_SECRET", value: "sk_live_should_not_print" },
      ],
    }),
  });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.secretRefs, [{ name: "stripe", ref: "env:STRIPE_SECRET" }]);
  assert.doesNotMatch(result.stdout, /sk_live_should_not_print/);
});

test("stableStringify canonicalizes object keys for deterministic stdout", () => {
  assert.equal(
    stableStringify({ z: 1, a: { b: 2, a: 1 } }),
    "{\n  \"a\": {\n    \"a\": 1,\n    \"b\": 2\n  },\n  \"z\": 1\n}\n",
  );
});
