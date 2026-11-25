import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DX_BACKBONE_RECORD,
  DOWNSTREAM_CONSUMER_GATES,
  REQUIRED_DESIGN_ANCHORS,
  REQUIRED_PROOF_MODES,
  classifyBackboneRequest,
  findSequencingViolations,
  parseDxBackboneRecord,
  validateDxBackboneRecord,
} from "../src/dx-backbone.ts";

test("HOBO-566 record maps the DX backbone to the authoritative design anchors", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  assert.equal(parsed.issue, "HOBO-566");
  assert.equal(parsed.targetPackage, "src/draft/exp-proofs/dx/dx-backbone-resource-lifecycle-vibe");
  assert.equal(
    parsed.proofNote,
    "docs/design/proofs/dx-backbone-resource-lifecycle-vibe/README.md",
  );
  assert.deepEqual(
    parsed.designAnchors.map((anchor) => anchor.source),
    REQUIRED_DESIGN_ANCHORS,
  );
});

test("child slices cover scenario, SDK, API, CLI/MCP, envelope, fixture, transcript, and quickstart responsibilities", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  assert.deepEqual(
    parsed.childSlices.map((slice) => slice.issue),
    [
      "HOBO-567",
      "HOBO-568",
      "HOBO-569",
      "HOBO-570",
      "HOBO-571",
      "HOBO-572",
      "HOBO-573",
      "HOBO-574",
      "HOBO-575",
      "HOBO-576",
      "HOBO-577",
    ],
  );
  assert.deepEqual(
    [...new Set(parsed.childSlices.flatMap((slice) => slice.coverage))].sort(),
    [
      "api-shape",
      "cli-mcp-shape",
      "deploy-transcript",
      "deterministic-fixtures",
      "manage-transcript",
      "migration-transcript",
      "proof-mode-labels",
      "quickstart",
      "result-envelope",
      "scenario-matrix",
      "sdk-shape",
      "support-handoff",
    ],
  );
});

test("each child slice names an isolated exp proof package and a matching design proof note", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  for (const slice of parsed.childSlices) {
    assert.match(slice.targetPackage, /^src\/draft\/exp-proofs\/(dx|ux|cx|ax|api)\/[a-z0-9-]+$/);
    assert.equal(
      slice.proofNote,
      `docs/design/proofs/${slice.targetPackage.split("/").at(-1)}/README.md`,
    );
  }
});

test("M2 transcript and quickstart work is blocked on the M1 shape and fixture foundation", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  assert.deepEqual(findSequencingViolations(parsed), []);

  const broken = structuredClone(DX_BACKBONE_RECORD);
  broken.childSlices.find((slice) => slice.issue === "HOBO-573")!.dependsOn = ["HOBO-567"];

  assert.match(
    findSequencingViolations(broken).join("\n"),
    /HOBO-573.*HOBO-568.*HOBO-569.*HOBO-570.*HOBO-571.*HOBO-572/,
  );
});

test("downstream visual, support, dashboard, launch, docs, and accessibility artifacts consume the DX quickstart instead of inventing behavior", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  assert.deepEqual(
    DOWNSTREAM_CONSUMER_GATES.map((gate) => gate.consumer),
    [
      "Docs Portal",
      "Tutorials & Walkthroughs",
      "Troubleshooting Guides",
      "V1 Launch Site, Messaging & Demo Assets",
      "Workspace & Onboarding UX",
      "Plan/Diff Viewer",
      "Deployment Dashboard & Topology Explorer",
      "Marketplace UX",
      "Support Workflow",
      "Accessibility & Usability Quality",
    ],
  );
  assert.equal(
    DOWNSTREAM_CONSUMER_GATES.every((gate) => gate.mustConsume.includes("HOBO-577")),
    true,
  );
  assert.equal(parsed.downstreamGates.every((gate) => gate.inventBehavior === false), true);
});

test("proof-mode labels are closed and scope-out requests fail closed", () => {
  const parsed = parseDxBackboneRecord(DX_BACKBONE_RECORD);

  assert.deepEqual(parsed.proofModes, REQUIRED_PROOF_MODES);
  assert.deepEqual(validateDxBackboneRecord(parsed).errors, []);

  assert.deepEqual(classifyBackboneRequest("define SDK and CLI fixture examples"), {
    owner: "HOBO-566",
    inScope: true,
  });
  assert.deepEqual(classifyBackboneRequest("build the production hobo CLI parser"), {
    owner: "CLI implementation",
    inScope: false,
  });
  assert.deepEqual(classifyBackboneRequest("call a live AWS provider with real credentials"), {
    owner: "provider/runtime implementation",
    inScope: false,
  });
  assert.deepEqual(classifyBackboneRequest("publish launch claims based on a dashboard mockup"), {
    owner: "launch/docs artifacts",
    inScope: false,
  });
  assert.deepEqual(classifyBackboneRequest("use customer data in a fixture"), {
    owner: "security/privacy boundary",
    inScope: false,
  });
});

test("malformed untrusted records fail closed with validation errors", () => {
  const empty = validateDxBackboneRecord({});

  assert.equal(empty.ok, false);
  assert.match(empty.errors.join("\n"), /child slices must be an array/);
  assert.throws(() => parseDxBackboneRecord({}), /child slices must be an array/);

  // SAFETY: `const malformed = structuredClone(DX_BACKBONE_RECORD) as typeof DX_BACKBONE_RECO` is required at this I/O or test boundary.
  const malformed = structuredClone(DX_BACKBONE_RECORD) as typeof DX_BACKBONE_RECORD & {
    childSlices: Array<{ scopeOut?: string[] }>;
  };
  delete malformed.childSlices[0]!.scopeOut;

  const result = validateDxBackboneRecord(malformed);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /HOBO-567 scope out must be an array/);
});
