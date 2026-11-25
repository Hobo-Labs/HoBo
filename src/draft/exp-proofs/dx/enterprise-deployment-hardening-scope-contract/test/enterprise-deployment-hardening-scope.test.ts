import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE,
  REQUIRED_BOUNDARIES,
  REQUIRED_DEPLOYMENT_POSTURES,
  REQUIRED_M1_EVIDENCE,
  canStartEnterpriseHardeningFollowUp,
  classifyEnterpriseReadinessClaim,
  validateEnterpriseDeploymentHardeningScope,
} from "../src/enterprise-deployment-hardening-scope.ts";

test("M0 scope record names the enterprise deployment hardening goal, personas, posture map, and boundaries", () => {
  const result = validateEnterpriseDeploymentHardeningScope(ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.issue, "HOBO-453");
  assert.equal(ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.phase, "M0");
  assert.match(ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.goal, /Enterprise Deployment Hardening/i);
  assert.deepEqual(
    ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.personas.map((persona) => persona.id),
    [
      "enterprise-platform-owner",
      "security-compliance-reviewer",
      "devops-operator",
      "support-lead",
      "release-owner",
    ],
  );
  assert.deepEqual(
    ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.deepEqual(
    ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.deploymentPostures.map((posture) => posture.id).sort(),
    [...REQUIRED_DEPLOYMENT_POSTURES].sort(),
  );
});

test("authoritative dependencies and M1 proof assets are explicit before follow-up work can start", () => {
  assert.deepEqual(
    ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.authoritativeDependencies.map((dependency) => dependency.record),
    [
      "docs/design/bootstrap-installer.md",
      "docs/design/upgrade-migration-engine.md",
      "docs/design/backup-restore.md",
      "docs/design/tenant-isolation-quotas.md",
      "docs/design/admin-console.md",
      "docs/design/support-sla-channels.md",
      "docs/design/security-verification.md",
      "docs/design/customer-assurance-evidence-packet.md",
    ],
  );
  assert.deepEqual(
    ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE.m1Evidence.map((evidence) => evidence.id).sort(),
    [...REQUIRED_M1_EVIDENCE].sort(),
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  for (const phase of ["M1", "M2", "M3", "M4"] as const) {
    assert.equal(canStartEnterpriseHardeningFollowUp({ phase, m0Accepted: false }).allowed, false);
    assert.equal(canStartEnterpriseHardeningFollowUp({ phase, m0Accepted: true }).allowed, true);
  }

  assert.equal(canStartEnterpriseHardeningFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects implementation creep into runtime, identity, backup, support, and legal work", () => {
  const invalid = structuredClone(ENTERPRISE_DEPLOYMENT_HARDENING_SCOPE);
  invalid.scopeIn.push("Implement the production installer and hosted control plane for enterprise tenants.");
  invalid.scopeIn.push("Build RBAC, SSO, SCIM, and tenant isolation enforcement.");
  invalid.scopeIn.push("Run backup restore jobs, upgrade migrations, rollback automation, and DR exercises.");
  invalid.scopeIn.push("Commit final SLA, legal, compliance, billing, and paid support guarantees.");

  const result = validateEnterpriseDeploymentHardeningScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /production deployment runtime/i);
  assert.match(result.errors.join("\n"), /identity and tenant-control implementation/i);
  assert.match(result.errors.join("\n"), /backup, restore, or upgrade execution/i);
  assert.match(result.errors.join("\n"), /commercial, legal, or support commitment/i);
});

test("customer-facing enterprise readiness claims require proof source and owner route", () => {
  assert.deepEqual(
    classifyEnterpriseReadinessClaim({
      audience: "customer-assurance",
      claim: "HoBo is enterprise deployment ready.",
    }),
    {
      allowed: false,
      reason: "Customer-facing enterprise readiness claims require proof source and owner route.",
    },
  );

  assert.equal(
    classifyEnterpriseReadinessClaim({
      audience: "customer-assurance",
      claim: "Enterprise deployment hardening M0 scope has accepted proof coverage.",
      proofSource: "src/draft/exp-proofs/dx/enterprise-deployment-hardening-scope-contract",
      ownerRoute: "V1 Release Program & Cutline",
    }).allowed,
    true,
  );
});

test("architecture evidence names protobuf, CUE, Pact, parsed types, command/event flow, and read projections", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/enterprise_deployment_hardening_scope_contract.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(
    new URL("../architecture/enterprise_deployment_hardening_scope_contract.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../architecture/enterprise_deployment_hardening_scope_contract.cue", import.meta.url),
    "utf8",
  );

  assert.equal(pact.consumer.name, "EnterpriseHardeningFollowUpGate");
  assert.equal(pact.provider.name, "EnterpriseDeploymentHardeningScopeRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "EnterpriseDeploymentHardeningScope",
    "EnterpriseDeploymentHardeningPersona",
    "EnterpriseDeploymentPosture",
    "EnterpriseHardeningBoundary",
    "EnterpriseHardeningEvidence",
    "EnterpriseHardeningGateDecision",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Events/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event-store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
