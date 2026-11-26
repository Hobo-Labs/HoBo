import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  createLocalProvider,
  createLocalRuntime,
  createProviderLocalFixturePlan,
  local,
  runLocalProviderConformance
} from "../src/provider-local.js";

test("factory publishes local-tagged capabilities and default resource definitions", () => {
  const provider = createLocalProvider({ root: "local://workspace" });

  assert.equal(provider.id, "@hobo/provider-local");
  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["database", "objectStore", "compute", "queue"]
  );

  const manifest = provider.capabilityManifest();
  assert.equal(manifest.provider, "@hobo/provider-local");
  assert.equal(manifest.fidelity, "local");
  assert.equal(manifest.claimsCampFidelity, false);
  assert.deepEqual(
    manifest.capabilities.map((capability) => ({
      port: capability.port,
      fidelity: capability.fidelity,
      tags: capability.conformance.tags
    })),
    [
      { port: "database", fidelity: "local", tags: ["local"] },
      { port: "objectStore", fidelity: "local", tags: ["local"] },
      { port: "compute", fidelity: "local", tags: ["local"] },
      { port: "queue", fidelity: "mock", tags: ["local"] }
    ]
  );
  assert.match(manifest.capabilities.find((capability) => capability.port === "queue").limitations[0], /in-memory/);

  const registry = [];
  provider.registerDefaultDefinitions(registry);
  assert.deepEqual(
    registry.map((definition) => definition.id),
    [
      "local.database.postgres",
      "local.objectStore.filesystem",
      "local.compute.container",
      "local.queue.inMemory"
    ]
  );
  assert.deepEqual(local.with.database({ name: "main", version: "16" }), {
    port: "database",
    engine: "postgres",
    name: "main",
    version: "16",
    fidelity: "local"
  });
  assert.deepEqual(runLocalProviderConformance(provider), {
    ok: true,
    checked: ["database", "objectStore", "compute", "queue"]
  });
});

test("fixture plan realizes to IacProgram and provisions local DB plus object store clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "hobo-provider-local-"));
  const provider = createLocalProvider({ root });
  const runtime = createLocalRuntime({ root });

  try {
    const emission = provider.realize(createProviderLocalFixturePlan());
    const validation = validateEmission(emission);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.deepEqual(
      emission.iac.nodes.map((node) => node.id),
      ["db", "assets", "jobs", "worker"]
    );
    assert.equal(emission.iac.links.length, 3);

    const provisioned = await runtime.provision(emission);
    assert.equal(provisioned.deploymentId, "local-provider-fixture");
    assert.match(provisioned.outputs.db.connectionString, /^local-postgres:\/\//);

    const db = provider.client("database", provisioned.outputs.db);
    assert.deepEqual(db.describe(), {
      kind: "database",
      engine: "postgres",
      fidelity: "local",
      connectionString: provisioned.outputs.db.connectionString
    });

    const bucket = provider.client("objectStore", provisioned.outputs.assets);
    await bucket.put("hello.txt", "works offline");
    assert.equal(await bucket.get("hello.txt"), "works offline");

    const queue = provider.client("queue", provisioned.outputs.jobs);
    queue.publish({ id: "job-1" });
    assert.deepEqual(queue.drain(), [{ id: "job-1" }]);

    const compute = provider.client("compute", provisioned.outputs.worker);
    assert.equal(compute.describe().image, "local://gallery-worker:dev");

    const destroyed = await runtime.destroy(provisioned.deploymentId);
    assert.equal(destroyed.residue, false);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("conformance fails closed when a local provider claims camp fidelity", () => {
  const provider = createLocalProvider({ root: "local://workspace" });
  const dishonest = {
    ...provider,
    capabilityManifest() {
      const manifest = provider.capabilityManifest();
      manifest.claimsCampFidelity = true;
      manifest.capabilities[0].conformance.tags.push("camp");
      return manifest;
    }
  };

  assert.throws(() => runLocalProviderConformance(dishonest), /must not claim camp fidelity/);
});

test("shared local backend provisions are fenced instead of racing", async () => {
  const root = await mkdtemp(join(tmpdir(), "hobo-provider-local-race-"));
  const provider = createLocalProvider({ root });
  const runtime = createLocalRuntime({ root });
  const emission = provider.realize(createProviderLocalFixturePlan());

  try {
    const attempts = await Promise.allSettled([
      runtime.provision(emission, { holdMs: 25 }),
      runtime.provision(emission)
    ]);

    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    assert.match(
      attempts.find((attempt) => attempt.status === "rejected").reason.message,
      /shared local backend lock/
    );

    const fulfilled = attempts.find((attempt) => attempt.status === "fulfilled").value;
    await runtime.destroy(fulfilled.deploymentId);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
