import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  planContentAddress as plannedEventContentAddress,
  validateControlPlaneEvent
} from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { validateDeploymentPlan } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import {
  PlannerValidationError,
  createFixtureManifestIr,
  plan
} from "../src/planner.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url)
);

test("declarations expose the planner boundary and compile for consumers", () => {
  const result = spawnSync(process.execPath, [tscPath, "--noEmit", "--project", "tsconfig.json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: false
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "TypeScript exited non-zero"
  );
});

test("plan turns fixture manifest IR into a dependency DAG and deployment.Planned event", () => {
  const result = plan(createFixtureManifestIr(), {
    deploymentId: "deploy-gallery-preview",
    context: previewContext(),
    coProvisioning: {
      assets: [
        {
          id: "assets-read-policy",
          port: {
            interface: "hobo:policy/iam",
            type: "iamPolicy",
            className: "standard"
          },
          outputs: ["policyRef"],
          inputs: {
            resourceArn: "${resources.data.postgres#assets.outputs.connectionString}"
          }
        }
      ]
    }
  });

  assert.deepEqual(
    result.deploymentPlan.resources.map((resource) => resource.id),
    ["assets", "api", "site", "assets-read-policy"]
  );
  assert.deepEqual(resource(result, "api").deps, ["assets"]);
  assert.deepEqual(resource(result, "site").deps, ["api"]);
  assert.deepEqual(resource(result, "assets-read-policy").deps, ["assets"]);
  assert.equal(resource(result, "assets-read-policy").coProvisionedFor, "assets");
  assert.deepEqual(
    result.deploymentPlan.edges.map((edge) => `${edge.from}->${edge.to}:${edge.reason}`),
    [
      "assets->api:link:hobo:data",
      "api->site:bind",
      "assets->assets-read-policy:co-provisioned-output"
    ]
  );

  const validation = validateDeploymentPlan(result.deploymentPlan);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(result.plannedEvent.type, "deployment.Planned");
  assert.equal(result.plannedEvent.data.planHash, plannedEventContentAddress(result.deploymentPlan));
  assert.equal(validateControlPlaneEvent(result.plannedEvent).ok, true);
  assert.equal(result.deploymentPlan.meta.provenance.sourceManifestHash, result.sourceManifestHash);
});

test("cyclic bind input is rejected with the precise cycle path", () => {
  const manifest = createFixtureManifestIr();
  manifest.resources.assets.bind = ["site"];

  assert.throws(
    () => plan(manifest, { context: previewContext() }),
    (error) =>
      error instanceof PlannerValidationError &&
      error.message === "dependency cycle: assets -> site -> api -> assets"
  );
});

test("adversarial manifest shapes fail closed before planning", () => {
  assert.throws(
    () => plan({ ...createFixtureManifestIr(), resources: {} }, { context: previewContext() }),
    /manifest\.resources must declare at least one resource/
  );

  assert.throws(
    () => plan({
      ...createFixtureManifestIr(),
      resources: [
        ["db", { type: "data.v1", port: "hobo:data" }],
        ["db", { type: "data.v1", port: "hobo:data" }]
      ]
    }, { context: previewContext() }),
    /duplicate resource id db/
  );

  const missing = createFixtureManifestIr();
  missing.resources.api.bind = ["missing"];
  assert.throws(
    () => plan(missing, { context: previewContext() }),
    /resource api binds missing resource missing/
  );

  const self = createFixtureManifestIr();
  self.resources.api.bind = ["api"];
  assert.throws(
    () => plan(self, { context: previewContext() }),
    /resource api cannot bind to itself/
  );
});

function previewContext() {
  return {
    envType: "ephemeral",
    app: "gallery",
    env: "preview",
    tenant: "tenant-acme"
  };
}

function resource(result, id) {
  return result.deploymentPlan.resources.find((entry) => entry.id === id);
}
