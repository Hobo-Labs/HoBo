import assert from "node:assert/strict";
import { test } from "vitest";

import {
  KNOWN_LIMITATIONS_REGISTER,
  classifyScopeOutClaim,
  createReleaseNoteView,
  parseKnownLimitationsRegister,
  validateKnownLimitationsRegister,
} from "../src/known-limitations-register.ts";

test("register lists limitation, persona, user impact, workaround, owner, and follow-up when needed", () => {
  const result = validateKnownLimitationsRegister(KNOWN_LIMITATIONS_REGISTER);

  assert.deepEqual(result.errors, []);
  assert.equal(KNOWN_LIMITATIONS_REGISTER.issue, "HOBO-485");
  assert.equal(KNOWN_LIMITATIONS_REGISTER.phase, "M0");

  for (const limitation of KNOWN_LIMITATIONS_REGISTER.limitations) {
    assert.ok(limitation.id, "limitation id");
    assert.ok(limitation.summary, limitation.id);
    assert.ok(limitation.affectedPersona, limitation.id);
    assert.ok(limitation.userVisibleImpact, limitation.id);
    assert.ok(limitation.workaround, limitation.id);
    assert.ok(limitation.owner, limitation.id);
    if (limitation.requiresFollowUp) {
      assert.ok(limitation.followUpIssue, limitation.id);
    }
  }
});

test("entries map to release notes, support scripts, docs, and launch messaging", () => {
  const register = validateKnownLimitationsRegister(KNOWN_LIMITATIONS_REGISTER).record;

  assert.deepEqual(
    register.handoffTargets.map((target) => target.id),
    ["release-notes", "support-scripts", "docs-portal", "launch-messaging"],
  );

  for (const target of register.handoffTargets) {
    assert.ok(target.owner, target.id);
    assert.ok(target.consumes.length > 0, target.id);
    assert.ok(target.requiredEvidence.length > 0, target.id);
  }
});

test("register includes Crew/MCP autonomy limitation (GAP-022 / HOBO-697)", () => {
  const crewMcpLimitation = KNOWN_LIMITATIONS_REGISTER.limitations.find(
    (limitation) =>
      limitation.id === "crew-mcp-write-actions-policy-gated" ||
      (/crew|mcp/i.test(limitation.summary) && /policy-gated|unsupervised/i.test(limitation.summary)),
  );

  assert.ok(crewMcpLimitation, "expected a Crew/MCP autonomy limitation row");
  assert.equal(crewMcpLimitation?.state, "real");
  assert.match(crewMcpLimitation?.userVisibleImpact ?? "", /approval|policy gate/i);
});

test("scope-out items cannot be marketed as supported v1 capability", () => {
  assert.deepEqual(classifyScopeOutClaim("live hosted dashboard is supported at v1"), {
    allowed: false,
    reason: "scope-out item cannot be marketed as supported v1 capability",
    route: "known-limitations-register",
  });
  assert.deepEqual(classifyScopeOutClaim("unsupported environment is supported at v1"), {
    allowed: false,
    reason: "scope-out item cannot be marketed as supported v1 capability",
    route: "known-limitations-register",
  });
  assert.deepEqual(classifyScopeOutClaim("post-ga roadmap ships in v1"), {
    allowed: false,
    reason: "scope-out item cannot be marketed as supported v1 capability",
    route: "known-limitations-register",
  });
  assert.deepEqual(classifyScopeOutClaim("fully unsupervised crew or mcp write autonomy ships in v1"), {
    allowed: false,
    reason: "scope-out item cannot be marketed as supported v1 capability",
    route: "known-limitations-register",
  });

  assert.deepEqual(classifyScopeOutClaim("reference fixture proof is beta-only"), {
    allowed: true,
    reason: "claim is framed as limited, beta, simulated, deferred, unsupported, or follow-up",
    route: "release-notes",
  });
});

test("beta and GA review checkpoints are explicit and block stale limitation records", () => {
  const register = validateKnownLimitationsRegister(KNOWN_LIMITATIONS_REGISTER).record;

  assert.deepEqual(
    register.reviewCheckpoints.map((checkpoint) => checkpoint.gate),
    ["beta", "ga"],
  );
  assert.ok(register.reviewCheckpoints.every((checkpoint) => checkpoint.requiredFields.includes("owner")));
  assert.ok(register.reviewCheckpoints.every((checkpoint) => checkpoint.requiredFields.includes("customerVisibleText")));
  assert.ok(register.reviewCheckpoints.every((checkpoint) => checkpoint.blocksPublicationWhenStale));
});

test("raw register input parses once into a derived type before projection", () => {
  const parsed = parseKnownLimitationsRegister(structuredClone(KNOWN_LIMITATIONS_REGISTER));

  assert.equal(parsed.issue, "HOBO-485");
  assert.throws(
    () =>
      parseKnownLimitationsRegister({
        ...KNOWN_LIMITATIONS_REGISTER,
        issue: "HOBO-999",
      }),
    /issue must be HOBO-485/,
  );
});

test("release-note view only publishes customer-safe fields and preserves limitation state", () => {
  const view = createReleaseNoteView(parseKnownLimitationsRegister(KNOWN_LIMITATIONS_REGISTER));

  assert.ok(view.entries.length >= 4);
  assert.ok(view.entries.every((entry) => !("internalNotes" in entry)));
  assert.ok(view.entries.some((entry) => entry.state === "real"));
  assert.ok(view.entries.some((entry) => entry.state === "simulated-reference"));
  assert.ok(view.entries.some((entry) => entry.state === "unsupported"));
  assert.ok(view.entries.some((entry) => entry.state === "deferred"));
  assert.ok(view.entries.some((entry) => entry.state === "post-ga"));
  assert.ok(view.entries.every((entry) => entry.owner && entry.userVisibleImpact));
});
