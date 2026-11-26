import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  TENANT_ISOLATION_QUOTAS_SCOPE,
  canCreateFollowUpIssue,
  classifyTenantIsolationDecision,
  validateTenantIsolationQuotasScope,
} from "../src/tenant-isolation-quotas.mjs";

test("M0 record states tenant isolation and quota goal, personas, scope, and boundaries", () => {
  assert.equal(TENANT_ISOLATION_QUOTAS_SCOPE.issue, "HOBO-415");
  assert.equal(TENANT_ISOLATION_QUOTAS_SCOPE.phase, "M0");
  assert.match(TENANT_ISOLATION_QUOTAS_SCOPE.goal, /tenant isolation/i);
  assert.match(TENANT_ISOLATION_QUOTAS_SCOPE.goal, /quota/i);
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.personas.map((persona) => persona.id),
    ["workspace-admin", "platform-engineer", "app-developer", "support-operator"],
  );
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(TENANT_ISOLATION_QUOTAS_SCOPE.scopeIn.some((item) => /platform tenant/i.test(item)));
  assert.ok(TENANT_ISOLATION_QUOTAS_SCOPE.scopeIn.some((item) => /app tenant/i.test(item)));
  assert.ok(TENANT_ISOLATION_QUOTAS_SCOPE.scopeOut.some((item) => /billing/i.test(item)));
});

test("M0 dependencies map owning initiatives and design sources for M1 proof", () => {
  assert.ok(
    TENANT_ISOLATION_QUOTAS_SCOPE.designRefs.includes(
      "docs/design/security-networking.md#plan-50",
    ),
  );
  assert.ok(
    TENANT_ISOLATION_QUOTAS_SCOPE.adrRefs.includes(
      "docs/design/adr/02-identity-security.md#adr-0079",
    ),
  );
  assert.ok(
    TENANT_ISOLATION_QUOTAS_SCOPE.adrRefs.includes(
      "docs/design/adr/02-identity-security.md#adr-0080",
    ),
  );
  assert.ok(
    TENANT_ISOLATION_QUOTAS_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Member/RBAC Administration" &&
        /owner and operator grants/i.test(dependency.boundary),
    ),
  );
  assert.ok(
    TENANT_ISOLATION_QUOTAS_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Billing & Credits" &&
        /showback only/i.test(dependency.boundary),
    ),
  );
});

test("tenant axes stay distinct and quota dimensions are explicit", () => {
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.tenantAxes.map((axis) => axis.id),
    ["platform-tenant", "project", "app-tenant", "end-user"],
  );
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.tenancyModels.map((model) => model.id),
    ["pooled", "region-pooled", "siloed", "bridge"],
  );
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.quotaDimensions.map((dimension) => dimension.id),
    [
      "request-rate",
      "concurrency",
      "projection-lag",
      "connection-pool",
      "sink-storage",
      "spend-reservation",
    ],
  );
});

test("M1 evidence gate blocks follow-up implementation issues until M0 is accepted", () => {
  assert.deepEqual(
    TENANT_ISOLATION_QUOTAS_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "tenant-axis-model",
      "cross-tenant-leak-gate",
      "quota-policy-fixture",
      "noisy-neighbor-fixture",
      "showback-support-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects productization creep and tenant-axis collapse", () => {
  assert.deepEqual(validateTenantIsolationQuotasScope(TENANT_ISOLATION_QUOTAS_SCOPE), {
    ok: true,
    errors: [],
  });

  const billingCreep = validateTenantIsolationQuotasScope({
    ...TENANT_ISOLATION_QUOTAS_SCOPE,
    scopeIn: [...TENANT_ISOLATION_QUOTAS_SCOPE.scopeIn, "Build the billing invoice engine."],
  });
  assert.equal(billingCreep.ok, false);
  assert.match(billingCreep.errors.join("\n"), /billing/i);

  const runtimeCreep = validateTenantIsolationQuotasScope({
    ...TENANT_ISOLATION_QUOTAS_SCOPE,
    scopeIn: [...TENANT_ISOLATION_QUOTAS_SCOPE.scopeIn, "Implement the runtime quota enforcer."],
  });
  assert.equal(runtimeCreep.ok, false);
  assert.match(runtimeCreep.errors.join("\n"), /runtime/i);

  const collapsedAxes = validateTenantIsolationQuotasScope({
    ...TENANT_ISOLATION_QUOTAS_SCOPE,
    tenantAxes: [{ id: "tenant", definition: "One generic tenant axis." }],
  });
  assert.equal(collapsedAxes.ok, false);
  assert.match(collapsedAxes.errors.join("\n"), /platform tenant and app tenant/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.equal(
    classifyTenantIsolationDecision("tenant leak conformance and quota fixture").owner,
    "Tenant Isolation & Quotas",
  );
  assert.equal(
    classifyTenantIsolationDecision("member role grant for tenant admin").owner,
    "Member/RBAC Administration",
  );
  assert.equal(
    classifyTenantIsolationDecision("invoice and subscription billing plan").owner,
    "Billing & Credits",
  );
  assert.equal(
    classifyTenantIsolationDecision("project environment lifecycle setting").owner,
    "Settings & Project Lifecycle",
  );
  assert.equal(
    classifyTenantIsolationDecision("support ticket escalation and status page").owner,
    "Support Workflow",
  );
});
