import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createAdoptionGraph,
  createExternalResource,
  createFixtureIacState,
  createManagedResource,
  createPortabilityPlanFromGraph,
  createTerraformStateFixture,
  createUnsupportedTerraformStateFixture,
  detectAdoptedDrift,
  graphDigest,
  importIacState,
  planBrownfieldDeployment,
  planDestroy,
  planImportRoundTrip,
  planReconcile,
  resolveBindings,
} from "../src/adopt-in-place-contract.js";
import {
  realizeWithPortabilityReport,
  validatePortabilityReport,
} from "../../portability-report-contract/src/portability-report-contract.js";

test("hobo import turns fixture IaC state into adopted nodes and resource.Adopted facts", () => {
  const result = importIacState({
    graph: createAdoptionGraph(),
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });

  assert.equal(result.status, "imported");
  assert.equal(result.graph.nodes["legacy-db"].kind, "adopted");
  assert.equal(result.graph.nodes["legacy-db"].lifecycle.destroy, "retain");
  assert.equal(result.graph.nodes["legacy-db"].lifecycle.reconcile, "drift-detect-only");
  assert.deepEqual(result.events.map((event) => event.type), ["resource.Adopted"]);
  assert.deepEqual(result.events[0].data, {
    resourceId: "legacy-db",
    externalId: "urn:pulumi:prod::legacy::aws:rds/instance:Instance::legacy-db",
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });
});

test("adopted nodes reconcile by refresh/drift detection and are never destroy or recreate targets", () => {
  const { graph } = importIacState({
    graph: createAdoptionGraph(),
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });

  const reconcile = planReconcile({
    graph,
    observedOutputs: {
      "legacy-db": {
        endpoint: "postgres://legacy-db.internal:5432/shop",
        passwordRef: "secret://legacy-db/password",
      },
    },
  });

  assert.deepEqual(reconcile.actions, [
    { action: "refresh", resourceId: "legacy-db", mode: "drift-detect-only" },
  ]);
  assert.equal(
    reconcile.actions.some((action) => ["destroy", "provision", "recreate", "update"].includes(action.action)),
    false,
  );
});

test("managed resources bind across the boundary to external resource outputs", () => {
  const graph = createAdoptionGraph({
    nodes: [
      createExternalResource({
        id: "legacy-db",
        type: "database",
        declaredOutputs: ["endpoint", "passwordRef"],
        outputs: {
          endpoint: "postgres://legacy-db.internal:5432/shop",
          passwordRef: "secret://legacy-db/password",
        },
      }),
      createManagedResource({
        id: "api",
        binds: [
          { from: "legacy-db", output: "endpoint", as: "DATABASE_URL" },
          { from: "legacy-db", output: "passwordRef", as: "DATABASE_PASSWORD_REF" },
        ],
      }),
    ],
  });

  assert.deepEqual(resolveBindings(graph, "api"), {
    DATABASE_PASSWORD_REF: "secret://legacy-db/password",
    DATABASE_URL: "postgres://legacy-db.internal:5432/shop",
  });
});

test("destroy plans skip adopted and external nodes", () => {
  const imported = importIacState({
    graph: createAdoptionGraph({
      nodes: [
        createManagedResource({ id: "api", deps: ["legacy-db", "shared-vpc"] }),
        createExternalResource({
          id: "shared-vpc",
          type: "network",
          declaredOutputs: ["vpcId"],
          outputs: { vpcId: "vpc-123" },
        }),
      ],
    }),
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });

  const destroy = planDestroy(imported.graph);

  assert.deepEqual(destroy.actions, [{ action: "destroy", resourceId: "api" }]);
  assert.deepEqual(destroy.skipped, [
    { resourceId: "legacy-db", kind: "adopted", reason: "adopted resources are retained" },
    { resourceId: "shared-vpc", kind: "external", reason: "external resources are unmanaged" },
  ]);
});

test("import fails closed on an id collision with an existing managed node", () => {
  assert.throws(
    () =>
      importIacState({
        graph: createAdoptionGraph({
          nodes: [createManagedResource({ id: "legacy-db" })],
        }),
        state: createFixtureIacState(),
        source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
      }),
    {
      name: "AdoptInPlaceError",
      code: "import-id-collision",
    },
  );
});

test("external resources with wrong declared outputs fail the bind precisely", () => {
  const graph = createAdoptionGraph({
    nodes: [
      createExternalResource({
        id: "legacy-db",
        type: "database",
        declaredOutputs: ["endpoint"],
        outputs: { url: "postgres://legacy-db.internal:5432/shop" },
      }),
      createManagedResource({
        id: "api",
        binds: [{ from: "legacy-db", output: "endpoint", as: "DATABASE_URL" }],
      }),
    ],
  });

  assert.throws(() => resolveBindings(graph, "api"), {
    name: "AdoptInPlaceError",
    code: "external-output-missing",
  });
});

test("adopted resource drift is detect-only and does not auto-remediate by default", () => {
  const { graph } = importIacState({
    graph: createAdoptionGraph(),
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });

  const drift = detectAdoptedDrift({
    graph,
    observedOutputs: {
      "legacy-db": {
        endpoint: "postgres://moved-db.internal:5432/shop",
        passwordRef: "secret://legacy-db/password",
      },
    },
  });

  assert.deepEqual(drift.records, [
    {
      resourceId: "legacy-db",
      mode: "detect-only",
      changedOutputs: ["endpoint"],
      remediation: "manual",
    },
  ]);
  assert.deepEqual(drift.actions, [
    { action: "record-drift", resourceId: "legacy-db", mode: "detect-only" },
  ]);
});

test("re-importing the same state is idempotent", () => {
  const first = importIacState({
    graph: createAdoptionGraph(),
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });
  const second = importIacState({
    graph: first.graph,
    state: createFixtureIacState(),
    source: { kind: "pulumi", ref: "s3://legacy-estate/prod/pulumi-state.json" },
  });

  assert.equal(second.status, "noop");
  assert.deepEqual(second.events, []);
  assert.equal(graphDigest(second.graph), graphDigest(first.graph));
});

test("terraform state import produces adopted nodes and a no-op re-plan", () => {
  const source = { kind: "terraform", ref: "s3://legacy-estate/prod/terraform.tfstate" };
  const first = importIacState({
    graph: createAdoptionGraph(),
    state: createTerraformStateFixture(),
    source,
  });

  assert.equal(first.status, "imported");
  assert.equal(first.graph.nodes["legacy-network"].kind, "adopted");
  assert.equal(first.graph.nodes["legacy-network"].lifecycle.reconcile, "drift-detect-only");
  assert.deepEqual(first.events.map((event) => event.type), ["resource.Adopted"]);

  const replay = planImportRoundTrip({
    graph: first.graph,
    state: createTerraformStateFixture(),
    source,
  });

  assert.equal(replay.status, "noop");
  assert.deepEqual(replay.actions, []);
  assert.equal(graphDigest(replay.graph), graphDigest(first.graph));
});

test("brownfield deployment binds managed api to external db and reports portability plus zero-secret debt", () => {
  const source = { kind: "terraform", ref: "s3://legacy-estate/prod/terraform.tfstate" };
  const graph = createAdoptionGraph({
    nodes: [
      createExternalResource({
        id: "legacy-db",
        type: "database",
        declaredOutputs: ["endpoint"],
        outputs: { endpoint: "postgres://legacy-db.internal:5432/shop" },
        externalId: "terraform://prod/aws_db_instance.legacy",
        credentialRef: "env.LEGACY_DB_PASSWORD",
        federatedAlternative: "workload-identity",
      }),
      createManagedResource({
        id: "api",
        binds: [{ from: "legacy-db", output: "endpoint", as: "DATABASE_URL" }],
      }),
    ],
  });
  const imported = importIacState({
    graph,
    state: createTerraformStateFixture(),
    source,
  });

  const deployment = planBrownfieldDeployment({ graph: imported.graph, resourceId: "api" });

  assert.deepEqual(deployment.actions, [
    {
      action: "deploy",
      resourceId: "api",
      bindings: { DATABASE_URL: "postgres://legacy-db.internal:5432/shop" },
    },
  ]);
  assert.deepEqual(deployment.skipped, [
    {
      resourceId: "legacy-network",
      kind: "adopted",
      reason: "adopted resources are drift-detect only",
    },
    {
      resourceId: "legacy-db",
      kind: "external",
      reason: "external resources are unmanaged",
    },
  ]);

  const realized = realizeWithPortabilityReport(
    createPortabilityPlanFromGraph(imported.graph, { planId: "brownfield-api" }),
  );
  const validation = validatePortabilityReport(realized);
  const report = realized.deploymentPlanned.portabilityReport;

  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.deepEqual(report.entries.map((entry) => entry.category).sort(), [
    "adopted-dependency",
    "external-dependency",
    "static-key",
  ]);
  assert.deepEqual(report.zeroSecretExceptions.map((entry) => entry.category).sort(), [
    "adopted-dependency",
    "external-dependency",
    "static-key",
  ]);
});

test("unsupported Terraform resources are surfaced as external instead of force-adopted", () => {
  const result = importIacState({
    graph: createAdoptionGraph(),
    state: createUnsupportedTerraformStateFixture(),
    source: { kind: "terraform", ref: "s3://legacy-estate/prod/terraform.tfstate" },
    supportedTypes: ["database"],
  });

  const legacyBus = result.graph.nodes["legacy-bus"];

  assert.equal(result.status, "imported");
  assert.deepEqual(result.events, []);
  assert.equal(legacyBus.kind, "external");
  assert.equal(legacyBus.externalId, "terraform://prod/kafka.legacy");
  assert.deepEqual(legacyBus.declaredOutputs, ["brokerUrl"]);
  assert.deepEqual(legacyBus.outputs, { brokerUrl: "kafka://legacy-bus.internal:9092" });
});

test("partial or corrupt IaC state fails closed before graph mutation", () => {
  const graph = createAdoptionGraph();

  assert.throws(
    () =>
      importIacState({
        graph,
        state: {
          kind: "terraform-state",
          resources: [
            {
              id: "partial-db",
              type: "database",
              outputs: { endpoint: "postgres://partial.internal:5432/shop" },
            },
          ],
        },
        source: { kind: "terraform", ref: "s3://legacy-estate/prod/terraform.tfstate" },
      }),
    {
      name: "AdoptInPlaceError",
      code: "invalid-iac-state",
    },
  );
  assert.deepEqual(graph.nodes, {});
});
