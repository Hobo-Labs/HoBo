import assert from "node:assert/strict";
import { test } from "vitest";

import {
  authorizeTenantScopedAccess,
  exerciseGenesisOnlyEscalation,
  proveFederatedMandatoryOrderingCannotWiden,
  simulateCappedOperatorRepairLoop,
  simulateRoleBindChainEscalation,
  tryChildMandatoryUndeny,
} from "../src/no-privilege-escalation-policy.js";

test("child pack un-denying a parent mandatory deny is rejected at compose time", () => {
  const result = tryChildMandatoryUndeny();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "mandatory-deny-ceiling-widening");
  assert.match(result.violations.join("\n"), /attempts to allow hobo:policy-pack:approve:prod/);
  assert.deepEqual(result.effectiveMandatoryDenies, ["hobo:policy-pack:approve:prod"]);
});

test("federated mandatory ordering tricks cannot widen a parent deny-ceiling", () => {
  const proof = proveFederatedMandatoryOrderingCannotWiden();

  assert.equal(proof.ok, false);
  assert.equal(proof.sameEffectiveDenySetForEveryOrder, true);
  assert.equal(proof.sameViolationForEveryOrder, true);
  assert.deepEqual(proof.effectiveMandatoryDenies, [
    "hobo:policy-pack:approve:prod",
    "hobo:provider:register:prod",
  ]);
  assert.match(proof.violations.join("\n"), /attempts to allow hobo:policy-pack:approve:prod/);
});

test("role:bind cannot grant privileges the binder lacks, even through chained binds", () => {
  const chain = simulateRoleBindChainEscalation();

  assert.equal(chain.directBind.effect, "deny");
  assert.equal(chain.directBind.reason, "role-grants-exceed-binder");
  assert.deepEqual(chain.directBind.missingGrantIds, ["hobo:policy-pack:update"]);
  assert.equal(chain.firstBind.effect, "allow");
  assert.equal(chain.secondBind.effect, "deny");
  assert.equal(chain.secondBind.reason, "role-grants-exceed-binder");
  assert.deepEqual(chain.secondBind.missingGrantIds, ["hobo:policy-pack:update"]);
});

test("Crew operator repair loop cannot accumulate privileges beyond its capped role", () => {
  const loop = simulateCappedOperatorRepairLoop();

  assert.equal(loop.dispatch.effect, "allow");
  assert.equal(loop.roleBind.effect, "deny");
  assert.equal(loop.policyUpdate.effect, "deny");
  assert.deepEqual(
    loop.iterations.map((iteration) => iteration.effect),
    ["deny", "deny", "deny"],
  );
  assert.ok(loop.iterations.every((iteration) => iteration.reason === "no-bound-role-grants-action"));
});

test("unresolved ctx.tenant fails closed instead of becoming cross-tenant-admin", () => {
  const droppedTenant = authorizeTenantScopedAccess({
    subject: {
      kind: "user",
      id: "user:dropped-tenant",
      roleBindings: { "user:dropped-tenant": ["org-admin"] },
      tenant: { platform: "platform-acme" },
    },
    targetTenant: "app-globex",
  });

  const explicitCrossTenant = authorizeTenantScopedAccess({
    subject: {
      kind: "user",
      id: "user:tenant-admin",
      roleBindings: { "user:tenant-admin": ["org-admin"] },
      tenant: { platform: "platform-acme" },
      ctxTenants: ["app-acme", "app-globex"],
    },
    targetTenant: "app-globex",
    crossTenantScopeToken: {
      kind: "cross-tenant-admin",
      tenants: ["app-globex"],
    },
  });

  assert.deepEqual(droppedTenant, {
    effect: "deny",
    reason: "ctx-tenant-unresolved-fail-closed",
    path: "tenant-scoped",
  });
  assert.deepEqual(explicitCrossTenant, {
    effect: "allow",
    reason: "explicit-cross-tenant-admin-scope",
    path: "cross-tenant-admin",
  });
});

test("genesis bootstrap is the only escalation path and it is one-time", () => {
  const proof = exerciseGenesisOnlyEscalation();

  assert.equal(proof.genesis.ok, true);
  assert.equal(proof.replay.ok, false);
  assert.equal(proof.replay.code, "GENESIS_ALREADY_CONSUMED");
  assert.equal(proof.selfGrant.ok, false);
  assert.equal(proof.selfGrant.code, "SELF_GRANT_BLOCKED");
  assert.deepEqual(proof.currentOrgAdmins, ["user:founder"]);
  assert.deepEqual(proof.genesisEventTypes, ["identity.GenesisAdmin"]);
});
