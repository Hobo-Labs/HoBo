import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DOGFOOD_YARD_ACCEPTANCE,
  canCreateDogfoodFollowUp,
  validateDogfoodYardAcceptance,
} from "../src/dogfood-yard-acceptance.mjs";

test("M0 record states dogfood goal, personas, workflows, scenarios, and boundaries", () => {
  const result = validateDogfoodYardAcceptance(DOGFOOD_YARD_ACCEPTANCE);

  assert.deepEqual(result.errors, []);
  assert.equal(DOGFOOD_YARD_ACCEPTANCE.issue, "HOBO-403");
  assert.equal(DOGFOOD_YARD_ACCEPTANCE.phase, "M0");
  assert.match(DOGFOOD_YARD_ACCEPTANCE.goal, /dogfood yard/i);
  assert.deepEqual(
    DOGFOOD_YARD_ACCEPTANCE.personas.map((persona) => persona.role),
    [
      "platform engineer dogfooder",
      "hosted operations owner",
      "sre/support responder",
      "release readiness owner",
    ],
  );
  assert.deepEqual(
    DOGFOOD_YARD_ACCEPTANCE.scenarios.map((scenario) => scenario.id),
    [
      "hosted-yard-preview-path",
      "self-hosted-seed-handover",
      "yard-upgrade-and-rollback",
      "incident-debug-and-restore",
    ],
  );
});

test("M0 record maps dependencies to authoritative Yard and operations design sources", () => {
  assert.deepEqual(
    DOGFOOD_YARD_ACCEPTANCE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/control-plane.md#plan-04",
      "docs/design/walkthrough.md",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/operators-sre.md#plan-40",
      "docs/design/adr/01-architecture-core.md#adr-0092",
    ],
  );
});

test("M0 record defines required evidence channels and ownership categories", () => {
  assert.deepEqual(
    DOGFOOD_YARD_ACCEPTANCE.evidenceChannels.map((channel) => channel.id),
    ["logs", "traces", "status-views", "support-debug", "rollback-signals"],
  );
  assert.equal(
    DOGFOOD_YARD_ACCEPTANCE.evidenceChannels.every(
      (channel) => channel.ownerCategory && channel.proves && channel.redactionRule,
    ),
    true,
  );
  assert.deepEqual(
    DOGFOOD_YARD_ACCEPTANCE.ownerMappings.map((mapping) => mapping.category),
    ["operational", "admin", "bootstrap", "reliability"],
  );
  assert.equal(
    DOGFOOD_YARD_ACCEPTANCE.ownerMappings.every(
      (mapping) => mapping.ownerProject && mapping.consumes && mapping.scopeBoundary,
    ),
    true,
  );
});

test("validation rejects Yard build, live-provider, customer-data, or readiness scope creep", () => {
  const invalid = structuredClone(DOGFOOD_YARD_ACCEPTANCE);
  invalid.scopeIn = [
    "Build the hosted Yard runtime and mark beta readiness from production provider calls.",
  ];
  invalid.scenarios.push({
    id: "live-customer-debug",
    yardMode: "hosted",
    proves: "Debug a live customer deploy with production provider credentials.",
  });

  const result = validateDogfoodYardAcceptance(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("follow-up evidence issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateDogfoodFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateDogfoodFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateDogfoodFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateDogfoodFollowUp({ phase: "M0", m0Accepted: true }), false);
});
