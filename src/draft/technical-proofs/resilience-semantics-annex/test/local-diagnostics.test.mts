import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildLocalDiagnosticReport,
  renderLocalDiagnostics,
} from "../src/local-diagnostics.mts";

test("local diagnostics distinguish retry, denial, cancellation, and deadline facts", () => {
  const report = buildLocalDiagnosticReport();

  assert.deepEqual(
    report.scenarios.map((scenario) => scenario.outcome),
    ["transient-retry", "policy-denied", "caller-cancelled", "deadline-expired"],
  );
  assert.deepEqual(report.command, "npm.cmd --prefix src\\draft\\resilience-semantics-annex run diagnostics");

  const transient = report.scenarios.find((scenario) => scenario.outcome === "transient-retry");
  assert.deepEqual(transient?.retriedAttempts, [
    { from: 1, to: 2, delayMs: 100, causedBy: "provider.Failed" },
    { from: 2, to: 3, delayMs: 250, causedBy: "provider.Failed" },
  ]);

  const denial = report.scenarios.find((scenario) => scenario.outcome === "policy-denied");
  assert.equal(denial?.retriedAttempts.length, 0);
  assert.deepEqual(denial?.terminalCauses, ["policy.Decided"]);

  const cancellation = report.scenarios.find((scenario) => scenario.outcome === "caller-cancelled");
  assert.deepEqual(cancellation?.cleanupFacts, ["cleanup.Emitted"]);
  assert.deepEqual(cancellation?.terminalCauses, ["caller.Cancelled", "cleanup.Emitted"]);

  const deadline = report.scenarios.find((scenario) => scenario.outcome === "deadline-expired");
  assert.deepEqual(deadline?.escalationFacts, ["deadline.Expired", "workflow.Escalated"]);
  assert.equal(deadline?.freshAttemptAfterTerminal, false);

  assert.equal(report.source, "replay-derived-persisted-facts");
  assert.equal(report.guarantees.requiresEffectOrXState, false);
});

test("rendered local diagnostics do not imply retry after denial or stale memory authority", () => {
  const rendered = renderLocalDiagnostics();
  const denialSection = rendered.slice(
    rendered.indexOf("scenario=policy-denied"),
    rendered.indexOf("scenario=caller-cancelled"),
  );

  assert.match(rendered, /command=npm\.cmd --prefix src\\draft\\resilience-semantics-annex run diagnostics/);
  assert.match(rendered, /scenario=transient-retry/);
  assert.match(rendered, /retried=1->2\(100ms, causedBy=provider\.Failed\), 2->3\(250ms, causedBy=provider\.Failed\)/);
  assert.match(rendered, /scenario=policy-denied terminalCauses=policy\.Decided/);
  assert.doesNotMatch(denialSection, /retry/i);
  assert.match(rendered, /scenario=caller-cancelled terminalCauses=caller\.Cancelled, cleanup\.Emitted cleanup=cleanup\.Emitted/);
  assert.match(rendered, /scenario=deadline-expired escalation=deadline\.Expired, workflow\.Escalated freshAttemptAfterTerminal=false/);
  assert.match(rendered, /source=replay-derived-persisted-facts/);
  assert.doesNotMatch(rendered, /object-memory/);
});

test("local diagnostics reject stale in-memory inspection as authoritative", () => {
  assert.throws(
    () =>
      buildLocalDiagnosticReport([
        {
          name: "bad-stale-diagnostic",
          outcome: "policy-denied",
          source: "object-memory",
          facts: [{ type: "inspection.StateSnapshot", source: "object-memory", atMs: 1 }],
        },
      ]),
    /diagnostic\.stale_state_source/,
  );
});
