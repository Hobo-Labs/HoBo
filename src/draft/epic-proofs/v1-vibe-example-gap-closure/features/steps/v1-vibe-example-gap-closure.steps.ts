/**
 * Executable step definitions for v1-vibe-example-gap-closure.feature.
 *
 * Drives the epic's real evaluation module (src/vibe-gap-closure.ts): the
 * checked-in child issue matrix and DX backbone graph are evaluated by the
 * same functions the acceptance tests use — no live Linear access.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  DX_BACKBONE_GRAPH,
  evaluateDxBackboneGraph,
  evaluateVibeGapClosure,
  rejectVibeScopeCreep,
  VIBE_GAP_CLOSURE_BACKLOG,
} from "../../src/vibe-gap-closure.js";

type VibeWorld = {
  dxResult?: ReturnType<typeof evaluateDxBackboneGraph>;
  closureResult?: ReturnType<typeof evaluateVibeGapClosure>;
  scopeRequests?: string[];
  rejections?: ReturnType<typeof rejectVibeScopeCreep>;
};

const world: VibeWorld = {};

// --- Scenario: The DX-first backbone graph is enforced -----------------------

Given(
  "the corrected HOBO-539 vibe backlog prioritizing API, SDK, CLI, and MCP examples",
  () => {
    assert.equal(VIBE_GAP_CLOSURE_BACKLOG.parentIssue, "HOBO-539");
    assert.equal(DX_BACKBONE_GRAPH.backboneIssue.id, "HOBO-566");
  },
);

When("the vibe DX backbone graph is evaluated", () => {
  world.dxResult = evaluateDxBackboneGraph();
});

Then(
  "HOBO-566 owns HOBO-567 through HOBO-577 with M1 foundations before M2 transcript work",
  () => {
    const result = world.dxResult;
    assert.ok(result, "the DX backbone evaluation must have run");
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.summary.backboneIssue, "HOBO-566");
    assert.equal(result.summary.childCount, 11);
    assert.deepEqual(result.summary.phases, { M1: 6, M2: 5 });
    assert.equal(result.summary.terminalErrorConsumer, "HOBO-558");
  },
);

// --- Scenario: Every vibe child targets an isolated exp proof ----------------

Given("the HOBO-539 vibe child issue matrix", () => {
  assert.equal(VIBE_GAP_CLOSURE_BACKLOG.childIssues.length, 26);
  assert.ok(
    VIBE_GAP_CLOSURE_BACKLOG.childIssues.every((issue) =>
      issue.targetPackagePath.startsWith("src/draft/exp-proofs/"),
    ),
    "every child in the fixture matrix targets an exp proof package",
  );
});

When("the vibe child matrix is evaluated", () => {
  world.closureResult = evaluateVibeGapClosure();
});

Then(
  "all 26 vibe children pass with isolated exp-proof packages and proof notes",
  () => {
    const result = world.closureResult;
    assert.ok(result, "the closure evaluation must have run");
    assert.equal(result.ok, true, `violations: ${JSON.stringify(result.violations)}`);
    assert.deepEqual(result.violations, []);
    assert.equal(result.summary.childCount, 26);
    assert.deepEqual(result.summary.contracts.missing, []);
  },
);

Then("the vibe quickstart consumers match the child matrix", () => {
  const result = world.closureResult;
  assert.ok(result);
  const childIds = VIBE_GAP_CLOSURE_BACKLOG.childIssues.map((issue) => issue.id);
  const consumers = VIBE_GAP_CLOSURE_BACKLOG.dxBackbone.quickstartConsumerIds;
  assert.equal(
    consumers.length,
    childIds.length - 1,
    "every child except the terminal-error consumer is a quickstart consumer",
  );
  assert.ok(
    consumers.every((id) => childIds.includes(id)),
    "quickstart consumers are all real children of the matrix",
  );
  assert.ok(!consumers.includes("HOBO-558"), "HOBO-558 stays gated by CLI/refusal foundations");
});

// --- Scenario: Production scope creep is rejected ----------------------------

Given("vibe change requests that reach for production behavior", () => {
  world.scopeRequests = [
    "wire live provider calls into the quickstart example",
    "polish the production UI for launch",
    "store customer data in the walkthrough fixture",
    "add real credentials to the demo recording",
    "keep iterating on mock copy states", // in-scope request; must survive the guard
  ];
});

When("the vibe scope guard evaluates the requests", () => {
  assert.ok(world.scopeRequests, "requests must be given");
  world.rejections = rejectVibeScopeCreep(world.scopeRequests);
});

Then("every production-reaching vibe request is rejected as outside HOBO-539", () => {
  const rejections = world.rejections;
  assert.ok(rejections, "the scope guard must have run");
  assert.equal(rejections.length, 4, "the four production-reaching requests are rejected");
  assert.ok(rejections.every((rejection) => rejection.decision === "reject"));
  assert.ok(
    rejections.every((rejection) => rejection.reason.includes("HOBO-539")),
    "each rejection cites the HOBO-539 coordination boundary",
  );
  assert.ok(
    !rejections.some((rejection) => rejection.request.includes("mock copy states")),
    "in-scope artifact work is not rejected",
  );
});
