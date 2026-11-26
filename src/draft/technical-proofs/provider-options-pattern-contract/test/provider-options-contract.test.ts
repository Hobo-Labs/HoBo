import assert from "node:assert/strict";
import { test } from "vitest";

import {
  aws,
  azure,
  createManifest,
  database,
  projectAgnosticResource,
  resolvedProviderOptions,
  service
} from "../src/provider-options-contract.js";

test("stacked provider options serialize while non-resolved providers stay inert", () => {
  const db = database("db", { engine: "postgres" }).with(
    aws.rds({ multiAz: true }),
    azure.flexibleServer({ haMode: "zoneRedundant" })
  );
  const manifest = createManifest([db]);

  assert.deepEqual(manifest.resources.db.annotations.with, {
    "aws.rds": { multiAz: true },
    "azure.flexibleServer": { haMode: "zoneRedundant" }
  });
  assert.deepEqual(resolvedProviderOptions(manifest.resources.db, "aws"), {
    "aws.rds": { multiAz: true }
  });
  assert.deepEqual(resolvedProviderOptions(manifest.resources.db, "gcp"), {});
  assert.deepEqual(
    projectAgnosticResource(manifest.resources.db),
    projectAgnosticResource(createManifest([database("db", { engine: "postgres" })]).resources.db)
  );
});

test("prefer and require qualifiers produce distinct manifest markers", () => {
  const preferred = createManifest([database("db", { engine: "postgres", prefer: "managed" })]);
  const required = createManifest([database("db", { engine: "postgres", require: "managed" })]);

  assert.deepEqual(preferred.resources.db.requirement, {
    mode: "prefer",
    capability: "managed"
  });
  assert.deepEqual(required.resources.db.requirement, {
    mode: "require",
    capability: "managed"
  });
});

test("same provider options merge deterministically and conflicts fail closed", () => {
  const db = database("db", { engine: "postgres" }).with(
    aws.rds({ backupRetentionDays: 7 }),
    aws.rds({ multiAz: true })
  );
  const manifest = createManifest([db]);

  assert.deepEqual(Object.keys(manifest.resources.db.annotations.with["aws.rds"]), [
    "backupRetentionDays",
    "multiAz"
  ]);
  assert.throws(
    () => database("conflict", { engine: "postgres" }).with(aws.rds({ multiAz: true }), aws.rds({ multiAz: false })),
    /conflicting provider option aws\.rds\.multiAz/
  );
});

test("provider options record lock-in source markers for PortabilityReport readers", () => {
  const manifest = createManifest([
    database("db", { engine: "postgres" }).with(aws.rds({ multiAz: true }))
  ]);

  assert.deepEqual(manifest.resources.db.portability.lockInMarkers, [
    {
      source: ".with()",
      annotation: "aws.rds",
      provider: "aws",
      path: "resources.db.annotations.with.aws.rds",
      reason: "provider-specific option is additive but non-portable"
    }
  ]);
});

test("runtime pairing guard rejects an option for the wrong resource kind", () => {
  assert.throws(
    () => database("db", { engine: "postgres" }).with(aws.fargate({ cpu: 512 })),
    /aws\.fargate cannot annotate data resources/
  );
  assert.doesNotThrow(() => service("api").with(aws.fargate({ cpu: 512 })));
});
