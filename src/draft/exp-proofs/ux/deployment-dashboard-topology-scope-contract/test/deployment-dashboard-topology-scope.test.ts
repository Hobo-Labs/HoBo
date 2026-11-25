import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE,
  REQUIRED_BOUNDARY_KEYS,
  DeploymentDashboardTopologyScopeParseError,
  canCreateDeploymentDashboardFollowUp,
  classifyDashboardTopologyGap,
  parseDeploymentDashboardTopologyScope,
  validateDeploymentDashboardTopologyScope,
} from "../src/deployment-dashboard-topology-scope.ts";

test("M0 scope record names goal, personas, scope, non-goals, and product boundaries", () => {
  const validation = validateDeploymentDashboardTopologyScope(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE);

  assert.deepEqual(validation.errors, []);
  assert.equal(validation.ok, true);
  assert.equal(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.issue, "HOBO-410");
  assert.equal(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.phase, "M0");
  assert.match(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.userBusinessGoal, /operator can trust deployment state/i);
  assert.ok(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.primaryPersonas.includes("platform operator"));
  assert.ok(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.primaryPersonas.includes("application developer"));
  assert.ok(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.scopeIn.length >= 5);
  assert.ok(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.scopeOut.length >= 5);
  assert.ok(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.nonGoals.length >= 3);
  assert.deepEqual(
    Object.keys(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.boundaries).sort(),
    [...REQUIRED_BOUNDARY_KEYS].sort(),
  );
});

test("owning initiatives, design docs, and ADR dependencies are explicit", () => {
  assert.deepEqual(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.owningInitiatives, [
    "Deployment Dashboard & Topology Explorer",
    "Developer Experience / CLI / MCP",
    "Control Plane",
    "Data Plane",
    "Reliability, Observability & Cost",
    "Security / RBAC",
    "Support Workflow",
  ]);

  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.designRefs.includes(
      "docs/design/developer-experience.md#plan-07",
    ),
  );
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.designRefs.includes(
      "docs/design/developer-experience.md#plan-49",
    ),
  );
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.designRefs.includes("docs/design/data-plane.md#plan-32"),
  );
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.adrRefs.includes(
      "docs/design/adr/02-identity-security.md#adr-0077",
    ),
  );
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.adrRefs.includes(
      "docs/design/adr/03-data-plane.md#adr-0050",
    ),
  );
});

test("surface taxonomy stays projection-only and covers dashboard and topology views", () => {
  const surfaceIds = DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.surfaceTaxonomy.map(
    (surface) => surface.id,
  );

  assert.deepEqual(surfaceIds, [
    "deployment-timeline",
    "topology-graph",
    "run-inspector",
    "project-environment-fleet",
    "health-cost-incident-rollups",
    "plan-diff-entrypoint",
  ]);
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.surfaceTaxonomy.every(
      (surface) => surface.source === "event-projection",
    ),
  );
  assert.ok(
    DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.surfaceTaxonomy.every(
      (surface) => surface.ownsRuntimeImplementation === false,
    ),
  );
});

test("M1 evidence is required before follow-up implementation issues are created", () => {
  const evidenceIds = DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.m1Evidence.map(
    (evidence) => evidence.id,
  );

  assert.deepEqual(evidenceIds, [
    "dashboard-surface-taxonomy",
    "projection-source-map",
    "topology-fixture",
    "tenant-rbac-staleness-rules",
    "cli-mcp-parity-map",
    "support-handoff-map",
  ]);
  assert.equal(canCreateDeploymentDashboardFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateDeploymentDashboardFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateDeploymentDashboardFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope parsing returns a derived domain type and rejects invalid records", () => {
  const parsed = parseDeploymentDashboardTopologyScope(DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE);

  assert.equal(parsed.issue, "HOBO-410");
  assert.throws(
    () =>
      parseDeploymentDashboardTopologyScope({
        ...DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE,
        scopeIn: [
          ...DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.scopeIn,
          "Implement the production dashboard React application.",
        ],
      }),
    DeploymentDashboardTopologyScopeParseError,
  );
});

test("adversarial scope creep is rejected instead of silently promoted to M0", () => {
  const invalid = validateDeploymentDashboardTopologyScope({
    ...DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE,
    scopeIn: [
      ...DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE.scopeIn,
      "Implement the production dashboard React application.",
      "Build the live provider topology resolver.",
    ],
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(
    invalid.errors.map((error) => error.code),
    ["scope-creep-production-ui", "scope-creep-live-provider"],
  );
});

test("adjacent work is routed to owning initiative instead of bloating the M0 record", () => {
  assert.equal(
    classifyDashboardTopologyGap("projection lag and read-store snapshot staleness"),
    "Data Plane",
  );
  assert.equal(classifyDashboardTopologyGap("topology link resolver for provider graph"), "Control Plane");
  assert.equal(classifyDashboardTopologyGap("SLO burn and cost rollup"), "Reliability, Observability & Cost");
  assert.equal(classifyDashboardTopologyGap("CLI inspect parity for dashboard field"), "Developer Experience / CLI / MCP");
  assert.equal(classifyDashboardTopologyGap("tenant RBAC redaction for public read"), "Security / RBAC");
  assert.equal(classifyDashboardTopologyGap("support handoff packet"), "Support Workflow");
});
