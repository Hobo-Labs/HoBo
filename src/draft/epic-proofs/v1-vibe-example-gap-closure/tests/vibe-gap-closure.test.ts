import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DX_BACKBONE_GRAPH,
  VIBE_GAP_CLOSURE_BACKLOG,
  evaluateDxBackboneGraph,
  evaluateVibeGapClosure,
  rejectVibeScopeCreep,
} from "../src/vibe-gap-closure.js";

test("HOBO-539 fixture closes the parent acceptance over DX backbone and child artifact issues", () => {
  const result = evaluateVibeGapClosure();

  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.summary.parentIssue, "HOBO-539");
  assert.equal(result.summary.childCount, 26);
  assert.deepEqual(result.summary.phases, { M1: 17, M2: 7, M5: 2 });
  assert.deepEqual(result.summary.dxBackbone.phases, { M1: 6, M2: 5 });
  assert.equal(result.summary.dxBackbone.quickstartConsumers, 25);
});

test("every child issue targets exp proof and proof note paths", () => {
  for (const issue of VIBE_GAP_CLOSURE_BACKLOG.childIssues) {
    assert.match(issue.targetPackagePath, /^src\/draft\/exp-proofs\/(dx|ux|cx|ax|api)\/[a-z0-9-]+$/);
    assert.match(issue.proofNotePath, /^docs\/design\/proofs\/hobo-\d+-[a-z0-9-]+\/README\.md$/);
    assert.equal(issue.artifactSlices.length > 0, true);
  }
});

test("every child issue carries common vibe scenario and proof-mode coverage", () => {
  for (const issue of VIBE_GAP_CLOSURE_BACKLOG.childIssues) {
    assert.deepEqual(issue.requiredScenarios, [
      "happy path",
      "blocked path",
      "stale/unknown evidence path",
      "support handoff",
      "accessibility notes",
    ]);
    assert.deepEqual(issue.proofModes, ["live", "simulated", "reference fixture", "scope-out"]);
    assert.equal(issue.scopeOut.some((entry) => /production CLI\/API\/SDK/i.test(entry)), true);
  }
});

test("DX backbone proves HOBO-566 and HOBO-567 through HOBO-577 are correctly shaped", () => {
  const result = evaluateDxBackboneGraph();

  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(result.summary.backboneIssue, "HOBO-566");
  assert.equal(result.summary.childCount, 11);
  assert.deepEqual(result.summary.phases, { M1: 6, M2: 5 });
  for (const label of ["dx-first", "api", "sdk", "cli", "contract"]) {
    assert.equal(result.summary.labels.includes(label), true);
  }
});

test("DX M2 transcript and quickstart slices remain blocked by accepted DX foundations", () => {
  const issueById = new Map(DX_BACKBONE_GRAPH.childSlices.map((issue) => [issue.id, issue]));

  for (const id of ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"]) {
    const issue = issueById.get(id);
    assert.equal(issue?.phase, "M2");
    assert.equal(issue?.blockedBy.some((blocker) => issueById.get(blocker)?.phase === "M1"), true);
  }
  assert.deepEqual(issueById.get("HOBO-577")?.blockedBy, ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"]);
  assert.equal(issueById.get("HOBO-577")?.blocks.includes("HOBO-555"), true);
  assert.equal(issueById.get("HOBO-570")?.blocks.includes("HOBO-558"), true);
});

test("HOBO-577 quickstart consumers match the downstream child backlog", () => {
  const expectedConsumers = VIBE_GAP_CLOSURE_BACKLOG.childIssues
    .map((issue) => issue.id)
    .filter((id) => id !== DX_BACKBONE_GRAPH.terminalErrorConsumer.id)
    .sort();

  assert.deepEqual([...DX_BACKBONE_GRAPH.quickstartConsumerIds].sort(), expectedConsumers);
});

test("launch-demo asset issues use M5 while non-launch children stay in M1 or M2", () => {
  const launchIssues = VIBE_GAP_CLOSURE_BACKLOG.childIssues.filter(
    (issue) => issue.project === "V1 Launch Site, Messaging & Demo Assets",
  );
  assert.deepEqual(
    launchIssues.map((issue) => issue.id),
    ["HOBO-555", "HOBO-556"],
  );
  assert.equal(launchIssues.every((issue) => issue.phase === "M5"), true);
  assert.equal(
    VIBE_GAP_CLOSURE_BACKLOG.childIssues
      .filter((issue) => issue.project !== "V1 Launch Site, Messaging & Demo Assets")
      .every((issue) => issue.phase === "M1" || issue.phase === "M2"),
    true,
  );
});

test("scope-out guard rejects production UI, provider, customer-data, credential, and launch-claim creep", () => {
  const denials = rejectVibeScopeCreep([
    "Implement the production UI for the first-run activation rail.",
    "Ship the production CLI implementation for the quickstart.",
    "Run live provider calls to capture the launch demo.",
    "Use live customer data and real credentials for support case fixtures.",
    "Publish final launch claims before proof-mode labels exist.",
  ]);

  assert.equal(denials.length, 5);
  assert.equal(denials.every((denial) => denial.decision === "reject"), true);
});

test("validation fails closed when a child loses required proof coverage", () => {
  const invalid = structuredClone(VIBE_GAP_CLOSURE_BACKLOG);
  invalid.childIssues[0].proofModes = ["live", "simulated"];
  invalid.childIssues[1].requiredScenarios = ["happy path"];
  invalid.childIssues[2].targetPackagePath = "src/draft/technical-proofs/not-an-exp-proof";
  invalid.childIssues[3].scopeOut = invalid.childIssues[3].scopeOut.filter(
    (entry) => !/production CLI\/API\/SDK/i.test(entry),
  );
  invalid.childIssues[15].phase = "M1";

  const result = evaluateVibeGapClosure(invalid);

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /missing proof mode label: reference fixture/);
  assert.match(result.violations.join("\n"), /missing scenario coverage: blocked path/);
  assert.match(result.violations.join("\n"), /must target src\/draft\/exp-proofs/);
  assert.match(result.violations.join("\n"), /CLI\/API\/SDK/);
  assert.match(result.violations.join("\n"), /launch-demo issue must use M5/);
});

test("DX validation fails closed when the rewritten acceptance graph drifts", () => {
  const invalid = structuredClone(DX_BACKBONE_GRAPH);
  invalid.childSlices = invalid.childSlices.filter((issue) => issue.id !== "HOBO-567");
  invalid.childSlices[0].labels = ["slice"];
  invalid.childSlices.find((issue) => issue.id === "HOBO-573")!.blockedBy = [];
  invalid.childSlices.find((issue) => issue.id === "HOBO-577")!.blocks = [];
  invalid.quickstartConsumerIds = invalid.quickstartConsumerIds.filter((id) => id !== "HOBO-540");

  const result = evaluateDxBackboneGraph(invalid);

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /missing HOBO-567|missing HOBO-566/);
  assert.match(result.violations.join("\n"), /must keep dx-first and contract labels/);
  assert.match(result.violations.join("\n"), /must be blocked by at least one M1 DX foundation slice/);
  assert.match(result.violations.join("\n"), /HOBO-577 must block downstream consumer/);
});

test("parent validation fails closed when quickstart consumer coverage drifts from children", () => {
  const invalid = structuredClone(VIBE_GAP_CLOSURE_BACKLOG);
  invalid.dxBackbone.quickstartConsumerIds = invalid.dxBackbone.quickstartConsumerIds.filter((id) => id !== "HOBO-540");

  const result = evaluateVibeGapClosure(invalid);

  assert.equal(result.ok, false);
  assert.match(result.violations.join("\n"), /HOBO-577 downstream child consumers missing HOBO-540/);
});
