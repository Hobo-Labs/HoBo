import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import { BUILT_IN_ROLES } from "../../hobo-principal-ref-contract/src/principal-ref.js";
import {
  BUILT_IN_ROLE_DEFINITIONS,
  authorizeControlPlaneAction,
  bindPrincipalToRole,
  bindScimGroupToRole,
  canBindRole,
  defineCustomRole,
  grantAction,
  resolveRbacSubject,
} from "../src/rbac-role-binding.js";

describe("RBAC role binding contract", () => {
  it("pins the six built-in roles with concrete control-plane grant sets", () => {
    const expectedRoleIds = Object.values(BUILT_IN_ROLES).sort();

    assert.deepEqual(Object.keys(BUILT_IN_ROLE_DEFINITIONS).sort(), expectedRoleIds);
    for (const roleId of expectedRoleIds) {
      const role = BUILT_IN_ROLE_DEFINITIONS[roleId];

      assert.equal(role.kind, "built-in");
      assert.equal(role.id, roleId);
      assert.ok(role.grants.length > 0, `${roleId} must have grants`);
      assert.ok(role.grants.every((grant) => grant.startsWith("hobo:")));
    }

    assert.ok(BUILT_IN_ROLE_DEFINITIONS[BUILT_IN_ROLES.ORG_ADMIN].grants.includes(grantAction("role", "bind")));
    assert.ok(BUILT_IN_ROLE_DEFINITIONS[BUILT_IN_ROLES.AUDITOR].grants.includes(grantAction("audit", "export")));
    assert.equal(BUILT_IN_ROLE_DEFINITIONS[BUILT_IN_ROLES.AUDITOR].grants.includes(grantAction("role", "bind")), false);
  });

  it("lets custom roles compose a validated subset of the action taxonomy", () => {
    const releaseObserver = defineCustomRole({
      id: "custom:release-observer",
      name: "Release Observer",
      grants: [
        grantAction("deployment", "read"),
        grantAction("delta", "read"),
        grantAction("delta", "read"),
      ],
    });

    assert.equal(releaseObserver.kind, "custom");
    assert.deepEqual(releaseObserver.grants, [
      grantAction("delta", "read"),
      grantAction("deployment", "read"),
    ]);
    assert.throws(
      () =>
        defineCustomRole({
          id: "custom:provider-blesser",
          grants: ["hobo:provider:bless"],
        }),
      /unknown RBAC grant/,
    );
    assert.throws(
      () =>
        defineCustomRole({
          id: BUILT_IN_ROLES.AUDITOR,
          grants: [grantAction("audit", "read")],
        }),
      /cannot shadow built-in role/,
    );
  });

  it("maps SSO/SCIM groups through the auth port into subject.roles", () => {
    const subject = resolveRbacSubject({
      principal: { kind: "user", id: "user:sec-admin" },
      auth: {
        port: "hobo:auth",
        adapter: "workos",
        scimGroups: ["scim:security-admins"],
      },
      bindings: [
        bindScimGroupToRole({
          groupId: "scim:security-admins",
          roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
        }),
      ],
    });

    assert.deepEqual(subject.roles, [BUILT_IN_ROLES.SECURITY_POLICY_ADMIN]);
    assert.deepEqual(subject.roleSources, [
      {
        roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
        source: "hobo:auth/scim",
        groupId: "scim:security-admins",
        adapter: "workos",
      },
    ]);
    assert.equal(
      authorizeControlPlaneAction({
        subject,
        actionId: grantAction("policy-pack", "approve"),
      }).effect,
      "allow",
    );
  });

  it("keeps Crew operator agents capped to their bound role during repair loops", () => {
    const subject = resolveRbacSubject({
      principal: { kind: "agent", id: "crew:sre-repair-loop" },
      requestedRoles: [BUILT_IN_ROLES.ORG_ADMIN],
      bindings: [
        bindPrincipalToRole({
          principalId: "crew:sre-repair-loop",
          roleId: BUILT_IN_ROLES.OPERATOR_SUPERVISOR,
        }),
      ],
    });

    assert.deepEqual(subject.roles, [BUILT_IN_ROLES.OPERATOR_SUPERVISOR]);
    assert.equal(
      authorizeControlPlaneAction({
        subject,
        actionId: grantAction("operator", "dispatch"),
      }).effect,
      "allow",
    );
    assert.deepEqual(
      authorizeControlPlaneAction({
        subject,
        actionId: grantAction("role", "bind"),
      }),
      {
        effect: "deny",
        reason: "no-bound-role-grants-action",
        matchedRoles: [],
      },
    );
  });

  it("blocks role:bind self-escalation and grants the binder lacks", () => {
    const providerAdmin = defineCustomRole({
      id: "custom:provider-admin",
      grants: [grantAction("provider", "register"), grantAction("provider", "update")],
    });
    const deployer = resolveRbacSubject({
      principal: { kind: "user", id: "user:deployer" },
      bindings: [bindPrincipalToRole({ principalId: "user:deployer", roleId: BUILT_IN_ROLES.DEPLOYER })],
    });
    const auditor = resolveRbacSubject({
      principal: { kind: "user", id: "user:auditor" },
      bindings: [bindPrincipalToRole({ principalId: "user:auditor", roleId: BUILT_IN_ROLES.AUDITOR })],
    });
    const orgAdmin = resolveRbacSubject({
      principal: { kind: "user", id: "user:org-admin" },
      bindings: [bindPrincipalToRole({ principalId: "user:org-admin", roleId: BUILT_IN_ROLES.ORG_ADMIN })],
    });

    assert.deepEqual(
      canBindRole({
        binder: deployer,
        targetPrincipalId: "user:someone-else",
        roleId: providerAdmin.id,
        roles: [providerAdmin],
      }),
      {
        effect: "deny",
        reason: "role-grants-exceed-binder",
        missingGrantIds: [grantAction("provider", "register"), grantAction("provider", "update")],
      },
    );
    assert.equal(
      canBindRole({
        binder: deployer,
        targetPrincipalId: "user:deployer",
        roleId: providerAdmin.id,
        roles: [providerAdmin],
      }).reason,
      "self-escalation",
    );
    assert.equal(
      canBindRole({
        binder: auditor,
        targetPrincipalId: "user:auditor-peer",
        roleId: BUILT_IN_ROLES.AUDITOR,
      }).reason,
      "missing-role-bind",
    );
    assert.equal(
      canBindRole({
        binder: orgAdmin,
        targetPrincipalId: "user:platform",
        roleId: providerAdmin.id,
        roles: [providerAdmin],
      }).effect,
      "allow",
    );
  });

  it("drops stale SCIM groups and denies unbound principals by default", () => {
    const bindings = [
      bindScimGroupToRole({
        groupId: "scim:auditors",
        roleId: BUILT_IN_ROLES.AUDITOR,
      }),
    ];
    const active = resolveRbacSubject({
      principal: { kind: "user", id: "user:auditor" },
      auth: { port: "hobo:auth", adapter: "entra", scimGroups: ["scim:auditors"] },
      bindings,
    });
    const afterRemoval = resolveRbacSubject({
      principal: { kind: "user", id: "user:auditor" },
      auth: { port: "hobo:auth", adapter: "entra", scimGroups: [] },
      bindings,
    });
    const unbound = resolveRbacSubject({
      principal: { kind: "user", id: "user:new" },
      bindings: [],
    });

    assert.equal(authorizeControlPlaneAction({ subject: active, actionId: grantAction("audit", "read") }).effect, "allow");
    assert.deepEqual(afterRemoval.roles, []);
    assert.deepEqual(
      authorizeControlPlaneAction({ subject: afterRemoval, actionId: grantAction("audit", "read") }),
      {
        effect: "deny",
        reason: "unbound-principal",
        matchedRoles: [],
      },
    );
    assert.deepEqual(
      authorizeControlPlaneAction({ subject: unbound, actionId: grantAction("role", "read") }),
      {
        effect: "deny",
        reason: "unbound-principal",
        matchedRoles: [],
      },
    );
  });

  it("publishes a typed RBAC declaration surface", async () => {
    const declaration = await readFile(new URL("../src/rbac-role-binding.d.ts", import.meta.url), "utf8");

    assert.match(declaration, /export interface RoleDefinition/);
    assert.match(declaration, /export function resolveRbacSubject/);
    assert.match(declaration, /export function canBindRole/);
  });
});
