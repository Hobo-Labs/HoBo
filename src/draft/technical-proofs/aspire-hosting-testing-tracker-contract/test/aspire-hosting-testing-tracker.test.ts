import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertAspireHostingTestingTracker,
  evaluateAspireHostingTestingTracker,
  loadRepoAspireHostingTestingTracker,
} from "../src/aspire-hosting-testing-tracker.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const wholeGraphHook = `
### Whole-graph in-process test harness (iteration hook)

Aspire-shaped harness gap documented.
`;

describe("aspire hosting testing tracker contract", () => {
  it("fails when Aspire.Hosting.Testing is marked ✅ without a whole-graph harness spec", () => {
    const result = evaluateAspireHostingTestingTracker({
      aspireMarkdown:
        "| `Aspire.Hosting.Testing` | Conformance suites + E2E replay tests | ✅ | [09](../design/generated-stack.md#plan-09) |",
      generatedStackMarkdown: "## Plan 09\n\n### Testing strategy (the pyramid)\n",
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "overclaimed");
    assert.equal(result.hasWholeGraphHarnessSpec, false);
    assert.match(result.reason, /without a whole-graph harness spec/);
  });

  it("fails when Aspire.Hosting.Testing is marked ◐ without the Plan 09 iteration hook", () => {
    const result = evaluateAspireHostingTestingTracker({
      aspireMarkdown:
        "| `Aspire.Hosting.Testing` | Conformance suites + per-port replay | ◐ | [09](../design/generated-stack.md#plan-09) |",
      generatedStackMarkdown: "## Plan 09\n\n### Testing strategy (the pyramid)\n",
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "overclaimed");
    assert.equal(result.hasWholeGraphHarnessSpec, false);
    assert.match(result.reason, /without the Plan 09 whole-graph harness iteration hook/);
  });

  it("passes when the tracker row is ◐ and the Plan 09 iteration hook exists", () => {
    const result = assertAspireHostingTestingTracker({
      aspireMarkdown:
        "| `Aspire.Hosting.Testing` | Conformance suites + per-port replay; whole-graph in-process harness not yet specified | ◐ | [09](../design/generated-stack.md#plan-09), [whole-graph hook](../design/generated-stack.md#whole-graph-in-process-test-harness-iteration-hook) |",
      generatedStackMarkdown: `## Plan 09\n${wholeGraphHook}`,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "deferred");
    assert.equal(result.hasWholeGraphHarnessSpec, true);
  });

  it("acceptance: repo aspire.md and generated-stack.md satisfy HOBO-705", () => {
    const result = loadRepoAspireHostingTestingTracker(repoRoot);
    assert.equal(result.ok, true);
    assert.equal(result.status, "deferred");
    assert.equal(result.hasWholeGraphHarnessSpec, true);
  });

  it("architecture evidence names protobuf, CUE, PACT, and parsed evaluation boundary", () => {
    const proofRoot = path.dirname(fileURLToPath(import.meta.url));
    const architecture = readFileSync(path.join(proofRoot, "../ADR.md"), "utf8");
    const pact = JSON.parse(
      readFileSync(
        path.join(
          proofRoot,
          "../architecture/pacts/aspire_hosting_testing_tracker_contract.pact.json",
        ),
        "utf8",
      ),
    );
    const proto = readFileSync(
      path.join(proofRoot, "../architecture/aspire_hosting_testing_tracker_contract.proto"),
      "utf8",
    );
    const cue = readFileSync(
      path.join(proofRoot, "../architecture/aspire_hosting_testing_tracker_contract.cue"),
      "utf8",
    );

    assert.match(architecture, /Protobuf data shapes/i);
    assert.match(architecture, /CUE constraints/i);
    assert.match(architecture, /PACT contract/i);
    assert.equal(pact.consumer.name, "AspireHostingTestingTrackerContractConsumer");
    assert.equal(pact.provider.name, "AspireHostingTestingTrackerContractBoundary");
    assert.ok(pact.interactions.length >= 1);
    assert.match(proto, /AspireHostingTestingTrackerEvaluation/);
    assert.match(cue, /#AspireHostingTestingTrackerEvaluation/);
  });
});
