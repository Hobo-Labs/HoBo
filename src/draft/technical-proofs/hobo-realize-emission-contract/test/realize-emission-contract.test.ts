import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canonicalJson,
  createReferenceIacBackend,
  realizeFixtureProvider,
  stableDigest,
  validateEmission,
  wireBuildOutputs
} from "../src/realize-emission-contract.js";

test("fixture provider emits an IacProgram, BuildSpec, placeholders, co-provisioned edge, and runtime link", () => {
  const emission = realizeFixtureProvider();
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.deepEqual(
    emission.iac.nodes.map((node) => node.id),
    ["assets", "assets-read-policy", "api"]
  );
  assert.equal(emission.iac.nodes.find((node) => node.id === "assets-read-policy").coProvisionedFor, "assets");
  assert.equal(emission.build.artifacts[0].id, "api-image");
  assert.equal(emission.iac.outputPlaceholders.length, 2);
  assert.deepEqual(emission.iac.links[0], {
    component: "api",
    import: "wasi:blobstore/blobstore",
    providerNode: "assets",
    capability: "objectStore"
  });
});

test("canonical golden snapshot digest is stable", () => {
  const emission = realizeFixtureProvider();

  assert.equal(canonicalJson(emission), canonicalJson(realizeFixtureProvider()));
  assert.equal(stableDigest(emission), "d32c9f99ad768328f576e0b67899a4c310ce97648e74c126f6770844adb7672a");
});

test("reference Iac backend accepts the program after BuildSpec ImageRef is wired back", () => {
  const emission = realizeFixtureProvider();
  const wired = wireBuildOutputs(emission, {
    "api-image": "oci://registry.example/hobo/gallery-api@sha256:abc123"
  });

  const apiNode = wired.iac.nodes.find((node) => node.id === "api");
  assert.deepEqual(apiNode.inputs.image, {
    artifactId: "api-image",
    imageRef: "oci://registry.example/hobo/gallery-api@sha256:abc123"
  });

  const acceptance = createReferenceIacBackend().accept(wired);
  assert.equal(acceptance.accepted, true, acceptance.errors.join("\n"));
});

test("placeholder references to missing outputs fail before apply", () => {
  const emission = realizeFixtureProvider();
  const apiNode = emission.iac.nodes.find((node) => node.id === "api");
  apiNode.inputs.env.ASSETS_BUCKET =
    "${resources.objectStore.standard#assets.outputs.missingBucketName}";

  const validation = validateEmission(emission);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /missing output missingBucketName/);
});

test("BuildSpec dependency cycles are rejected before an ImageRef can be consumed", () => {
  const emission = realizeFixtureProvider();
  emission.build.artifacts.push({
    id: "helper-image",
    source: "services/helper",
    target: "wasm-component",
    outputKind: "ImageRef",
    dependsOn: ["api-image"]
  });
  emission.build.artifacts.find((artifact) => artifact.id === "api-image").dependsOn = ["helper-image"];

  const validation = validateEmission(emission);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /build dependency cycle/);
});

test("driver dialect leakage is surfaced in the PortabilityReport and rejected", () => {
  const emission = realizeFixtureProvider();
  const assetsNode = emission.iac.nodes.find((node) => node.id === "assets");
  assetsNode.inputs.pulumiModule = "@pulumi/aws/s3/bucket";

  const validation = validateEmission(emission);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /driver-specific dialect leak/);
  assert.deepEqual(validation.portabilityReport.lockInMarkers, [
    {
      path: "nodes.0.inputs.pulumiModule",
      field: "pulumiModule",
      reason: "driver-specific dialect must be reported before a backend accepts the program"
    }
  ]);
});
