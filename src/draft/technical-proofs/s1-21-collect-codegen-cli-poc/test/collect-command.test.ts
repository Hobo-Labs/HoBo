import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  createHoboCollectCli,
  createHelloBindleCollectProject,
  sampleCollectProject,
  stableCollectStringify,
} from "../src/index.js";

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
  assert.equal(envelope.contract, "hobo.collect-cli/v1");
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.manifest.schema, "hobo.manifest/v1");
});

test("coverage-incomplete collection is labeled and never presented as complete", async () => {
  const project = sampleCollectProject({ includeStaticUnhitBranch: true });
  const cli = createHoboCollectCli({ project });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, "coverage-incomplete");
  assert.equal(envelope.collection.coverageComplete, false);
  assert.equal(envelope.manifest.resources["dead-cache"], undefined);

  const human = await cli.run(["collect"]);
  assert.match(human.stdout, /COLLECTION INCOMPLETE/);
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
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, "HOBO_COLLECT_FAILED");
  assert.equal(envelope.partialManifest, false);
  assert.equal(envelope.manifest, undefined);
});

test("non-TypeScript guests get a static-analysis-required diagnostic", async () => {
  const cli = createHoboCollectCli({
    project: createHelloBindleCollectProject({ guestLanguage: "rust" }),
  });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 1);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.code, "HOBO_COLLECT_STATIC_ANALYSIS_REQUIRED");
  assert.equal(envelope.partialManifest, false);
});

test("secret values are redacted while secret refs remain inspectable", async () => {
  const cli = createHoboCollectCli({
    project: sampleCollectProject({
      secretRefs: [{ name: "stripe", ref: "env:STRIPE_SECRET", value: "sk_live_should_not_print" }],
    }),
  });

  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.deepEqual(envelope.secretRefs, [{ name: "stripe", ref: "env:STRIPE_SECRET" }]);
  assert.doesNotMatch(result.stdout, /sk_live_should_not_print/);
});

test("unknown collect flags exit 2 with usage error", async () => {
  const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
  const result = await cli.run(["collect", "--bogus", "--json"]);
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.stdout).code, "HOBO_COLLECT_USAGE");
});

test("hello-bindle collect emits schema hobo.manifest/v1 with todos get/set allow", async () => {
  const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
  const result = await cli.run(["collect", "--json"]);

  assert.equal(result.exitCode, 0);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.manifest.schema, "hobo.manifest/v1");
  assert.deepEqual(envelope.manifest.resources.todos.allow, ["get", "set"]);
  assert.ok(envelope.manifest.resources.main.links.some((link: { to: string }) => link.to === "todos"));
});

test("stableStringify canonicalizes object keys for deterministic stdout", () => {
  assert.equal(
    stableCollectStringify({ z: 1, a: { b: 2, a: 1 } }),
    "{\n  \"a\": {\n    \"a\": 1,\n    \"b\": 2\n  },\n  \"z\": 1\n}\n",
  );
});

test("--out writes manifest to stable file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hobo-collect-out-"));
  try {
    const outPath = path.join(dir, "hello-bindle.manifest.json");
    const cli = createHoboCollectCli({ project: createHelloBindleCollectProject() });
    const result = await cli.run(["collect", "--out", outPath, "--json"]);
    assert.equal(result.exitCode, 0);
    const envelope = JSON.parse(result.stdout);
    const written = JSON.parse(await readFile(outPath, "utf8"));
    assert.deepEqual(written, envelope.manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
