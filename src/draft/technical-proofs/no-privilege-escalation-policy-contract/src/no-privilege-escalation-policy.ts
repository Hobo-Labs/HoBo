import { isJsonString } from "./json.js";
import {
  allowRule,
  canonicalJson,
  composePolicyPacks,
  definePolicyPack,
  denyRule,
} from "../../deny-ceiling-algebra-poc/src/deny-ceiling-algebra.js";
import {
  authorizeControlPlaneAction,
  bindPrincipalToRole,
  canBindRole,
  defineCustomRole,
  grantAction,
  resolveRbacSubject,
} from "../../rbac-role-binding-contract/src/rbac-role-binding.js";
import {
  createPrincipalRef,
  serializeAsPolicySubject,
} from "../../hobo-principal-ref-contract/src/principal-ref.js";
import {
  createYardGovernanceLedger,
  seedGenesisAdmin,
  selfGrantOrgAdmin,
} from "../../genesis-breakglass-contract/src/genesis-breakglass.js";

export function tryChildMandatoryUndeny() {
  const composition = composePolicyPacks([
    definePolicyPack({
      id: "junction-mandatory",
      scope: "junction",
      rules: [denyRule({ id: "no-prod-policy-approval", tuple: "hobo:policy-pack:approve:prod" })],
    }),
    definePolicyPack({
      id: "bindle-escape",
      scope: "bindle",
      rules: [allowRule({ id: "allow-prod-policy-approval", tuple: "hobo:policy-pack:approve:prod" })],
    }),
  ]);

  return summarizeComposition(composition);
}

export function proveFederatedMandatoryOrderingCannotWiden() {
  const parent = definePolicyPack({
    id: "junction-mandatory",
    scope: "junction",
    rules: [denyRule({ id: "no-prod-policy-approval", tuple: "hobo:policy-pack:approve:prod" })],
  });
  const federated = definePolicyPack({
    id: "federated-provider-baseline",
    scope: "junction",
    rules: [denyRule({ id: "no-provider-registration", tuple: "hobo:provider:register:prod" })],
  });
  const childEscape = definePolicyPack({
    id: "camp-ordering-escape",
    scope: "camp",
    rules: [allowRule({ id: "allow-prod-policy-approval", tuple: "hobo:policy-pack:approve:prod" })],
  });

  const attempts = permutations([parent, federated, childEscape]).map((packs) => summarizeComposition(composePolicyPacks(packs)));
  const first = attempts.at(0);

  return {
    ...first,
    sameEffectiveDenySetForEveryOrder: attempts.every(
      (attempt) => canonicalJson(attempt.effectiveMandatoryDenies) === canonicalJson(first.effectiveMandatoryDenies),
    ),
    sameViolationForEveryOrder: attempts.every(
      (attempt) => canonicalJson(attempt.violations) === canonicalJson(first.violations),
    ),
  };
}

export function simulateRoleBindChainEscalation() {
  const juniorBinder = defineCustomRole({
    id: "custom:junior-binder",
    grants: [grantAction("role", "bind"), grantAction("audit", "read")],
  });
  const auditReader = defineCustomRole({
    id: "custom:audit-reader",
    grants: [grantAction("audit", "read")],
  });
  const policyMutator = defineCustomRole({
    id: "custom:policy-mutator",
    grants: [grantAction("policy-pack", "update")],
  });
  const roles = [juniorBinder, auditReader, policyMutator];
  const binder = resolveRbacSubject({
    principal: { kind: "user", id: "user:binder" },
    bindings: [bindPrincipalToRole({ principalId: "user:binder", roleId: juniorBinder.id })],
  });
  const afterFirstBind = resolveRbacSubject({
    principal: { kind: "user", id: "user:binder" },
    bindings: [
      bindPrincipalToRole({ principalId: "user:binder", roleId: juniorBinder.id }),
      bindPrincipalToRole({ principalId: "user:binder", roleId: auditReader.id }),
    ],
  });

  return {
    directBind: canBindRole({
      binder,
      targetPrincipalId: "user:accomplice",
      roleId: policyMutator.id,
      roles,
    }),
    firstBind: canBindRole({
      binder,
      targetPrincipalId: binder.id,
      roleId: auditReader.id,
      roles,
    }),
    secondBind: canBindRole({
      binder: afterFirstBind,
      targetPrincipalId: "user:accomplice",
      roleId: policyMutator.id,
      roles,
    }),
  };
}

export function simulateCappedOperatorRepairLoop() {
  const subject = resolveRbacSubject({
    principal: { kind: "agent", id: "crew:sre-repair-loop" },
    bindings: [
      bindPrincipalToRole({
        principalId: "crew:sre-repair-loop",
        roleId: "operator-supervisor",
      }),
    ],
  });
  const deniedActionIds = [
    grantAction("role", "bind"),
    grantAction("policy-pack", "update"),
    grantAction("role", "bind"),
  ];

  return {
    dispatch: authorizeControlPlaneAction({
      subject,
      actionId: grantAction("operator", "dispatch"),
    }),
    roleBind: authorizeControlPlaneAction({
      subject,
      actionId: grantAction("role", "bind"),
    }),
    policyUpdate: authorizeControlPlaneAction({
      subject,
      actionId: grantAction("policy-pack", "update"),
    }),
    iterations: deniedActionIds.map((actionId, index) => ({
      index,
      requestedTransientRole: "org-admin",
      ...authorizeControlPlaneAction({ subject, actionId }),
    })),
  };
}

export function authorizeTenantScopedAccess({
  subject,
  targetTenant,
  crossTenantScopeToken,
}) {
  const serialized = serializeAsPolicySubject(createPrincipalRef(subject));
  const tokenTenants = normalizeTokenTenants(crossTenantScopeToken);

  if (serialized.ctxTenant.kind === "resolved" && serialized.ctxTenant.value === targetTenant) {
    return {
      effect: "allow",
      reason: "resolved-ctx-tenant-match",
      path: "tenant-scoped",
    };
  }

  if (
    crossTenantScopeToken?.kind === "cross-tenant-admin" &&
    serialized.ctxTenants.kind === "explicit-set" &&
    serialized.ctxTenants.values.includes(targetTenant) &&
    (tokenTenants.has("*") || tokenTenants.has(targetTenant))
  ) {
    return {
      effect: "allow",
      reason: "explicit-cross-tenant-admin-scope",
      path: "cross-tenant-admin",
    };
  }

  if (serialized.ctxTenant.kind === "unresolved") {
    return {
      effect: "deny",
      reason: "ctx-tenant-unresolved-fail-closed",
      path: "tenant-scoped",
    };
  }

  return {
    effect: "deny",
    reason: "ctx-tenant-mismatch",
    path: "tenant-scoped",
  };
}

export function exerciseGenesisOnlyEscalation() {
  const ledger = createYardGovernanceLedger({ yardId: "yard:prod" });
  const genesis = seedGenesisAdmin(ledger, {
    principalId: "user:founder",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001",
  });
  const replay = seedGenesisAdmin(ledger, {
    principalId: "user:attacker",
    actorId: "system:yard-bootstrap",
    requestId: "yard-up-001-replay",
  });
  const selfGrant = selfGrantOrgAdmin(ledger, {
    actorId: "user:attacker",
    targetPrincipalId: "user:attacker",
    requestId: "self-grant-001",
  });

  return {
    genesis,
    replay,
    selfGrant,
    currentOrgAdmins: ledger.currentOrgAdmins(),
    genesisEventTypes: ledger.events
      .filter((event) => event.type === "identity.GenesisAdmin")
      .map((event) => event.type),
  };
}

function summarizeComposition(composition) {
  return {
    ok: composition.ok,
    reason: composition.ok ? "composition-accepted" : "mandatory-deny-ceiling-widening",
    violations: [...composition.violations].sort(),
    effectiveMandatoryDenies: composition.effectiveDenySet
      .filter((entry) => entry.mode === "mandatory")
      .map((entry) => entry.tuple)
      .sort(),
  };
}

function normalizeTokenTenants(token) {
  if (!token || !Array.isArray(token.tenants)) {
    return new Set();
  }
  return new Set(token.tenants.filter((tenant) => isJsonString(tenant) && tenant.length > 0));
}

function permutations(values) {
  if (values.length <= 1) {
    return [values];
  }
  return values.flatMap((value, index) =>
    permutations(values.toSpliced(index, 1)).map((tail) => [value, ...tail]),
  );
}
