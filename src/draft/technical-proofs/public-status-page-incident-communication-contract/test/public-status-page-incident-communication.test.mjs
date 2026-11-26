import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PUBLIC_STATUS_PAGE_CONTRACT,
  REQUIRED_DEPENDENCY_TARGETS,
  canCreateStatusPageFollowUp,
  validatePublicStatusPageContract,
} from "../src/public-status-page-incident-communication.mjs";

function cloneContract() {
  return structuredClone(PUBLIC_STATUS_PAGE_CONTRACT);
}

test("HOBO-497 M0 contract validates the public status page surface", () => {
  const result = validatePublicStatusPageContract(PUBLIC_STATUS_PAGE_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(PUBLIC_STATUS_PAGE_CONTRACT.issue, "HOBO-497");
  assert.equal(PUBLIC_STATUS_PAGE_CONTRACT.phase, "M0");
  assert.match(PUBLIC_STATUS_PAGE_CONTRACT.goal, /public status page/i);
  assert.match(PUBLIC_STATUS_PAGE_CONTRACT.goal, /incident communication/i);
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.statusPageScope.map((entry) => entry.area),
    ["public-components", "active-incidents", "planned-maintenance", "history-and-subscriptions"],
  );
});

test("component taxonomy, incident states, maintenance notices, cadence, and templates are explicit", () => {
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.componentTaxonomy.map((component) => component.id),
    ["control-plane-api", "deployments", "identity-auth", "runtime-camps", "docs-and-support"],
  );
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.incidentStates.map((state) => state.id),
    ["investigating", "identified", "monitoring", "resolved"],
  );
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.maintenanceNoticeStates.map((state) => state.id),
    ["scheduled", "in-progress", "completed", "canceled"],
  );
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.updateCadence.map((cadence) => cadence.state),
    ["investigating", "identified", "monitoring", "resolved", "scheduled-maintenance"],
  );
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.customerTemplates.map((template) => template.kind),
    ["initial-incident", "progress-update", "maintenance-notice", "resolution"],
  );
});

test("internal and external incident triggers are separated before publication", () => {
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.incidentTriggers.map((trigger) => `${trigger.source}:${trigger.visibility}`),
    [
      "slo-burn:internal",
      "synthetic-monitor:internal",
      "support-ticket:external-candidate",
      "customer-report:external-candidate",
      "planned-maintenance:external-candidate",
    ],
  );
  assert.equal(
    PUBLIC_STATUS_PAGE_CONTRACT.incidentTriggers.every((trigger) => trigger.publicationGate),
    true,
  );
});

test("unsupported status dimensions stay documented and fail closed", () => {
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.unsupportedStatusDimensions.map((dimension) => dimension.id),
    [
      "per-tenant-private-debug",
      "raw-provider-internal-topology",
      "unverified-root-cause",
      "contractual-response-sla",
      "customer-specific-data",
    ],
  );

  const result = validatePublicStatusPageContract({
    ...cloneContract(),
    unsupportedStatusDimensions: [],
  });

  assert.match(result.errors.join("\n"), /unsupported status dimensions/i);
});

test("support SLA, reliability evidence, and launch support escalation links are present", () => {
  assert.deepEqual(
    PUBLIC_STATUS_PAGE_CONTRACT.dependencies.map((dependency) => dependency.target),
    REQUIRED_DEPENDENCY_TARGETS,
  );
});

test("follow-up implementation issues remain blocked until M0 acceptance", () => {
  assert.equal(canCreateStatusPageFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateStatusPageFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateStatusPageFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("validation rejects live publishing, unapproved SLA promises, and customer-data leakage", () => {
  const result = validatePublicStatusPageContract({
    ...cloneContract(),
    statusPageScope: [
      ...PUBLIC_STATUS_PAGE_CONTRACT.statusPageScope,
      {
        area: "live-publishing",
        includes: "Implement live status-page publishing with customer-specific ticket details.",
        excludes: "none",
      },
    ],
    customerTemplates: [
      ...PUBLIC_STATUS_PAGE_CONTRACT.customerTemplates,
      {
        kind: "sla-promise",
        audience: "customers",
        channel: "status page",
        requiredFields: ["incident_id"],
        evidenceSource: "none",
        redactionGate: false,
        body: "Guaranteed 15 minute response for {{customer_email}}.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /live status-page publishing/i);
  assert.match(result.errors.join("\n"), /SLA/i);
  assert.match(result.errors.join("\n"), /customer data/i);
});
