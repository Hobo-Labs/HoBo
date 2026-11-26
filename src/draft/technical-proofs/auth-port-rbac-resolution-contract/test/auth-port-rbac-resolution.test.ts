import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  AUTH_PORT_RBAC_NFR,
  BUILT_IN_ROLES,
  bindPrincipalToRole,
  bindScimGroupToRole,
  createAuthPortRbacResolver,
  createAuthPortSnapshot,
  defineCustomRole,
  grantAction,
} from "../src/auth-port-rbac-resolution.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url),
);

describe("auth port RBAC resolution contract", () => {
  it("maps a fixture SCIM group to Org-Admin and populates subject.roles", () => {
    const resolver = createAuthPortRbacResolver({
      bindings: [
        bindScimGroupToRole({
          groupId: "scim:org-admins",
          roleId: BUILT_IN_ROLES.ORG_ADMIN,
        }),
      ],
    });
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "user", id: "user:alice" },
      auth: {
        adapter: "workos",
        scimGroups: ["scim:org-admins"],
        snapshotSeq: "auth-snapshot:1",
      },
    });
    const resolved = resolver.resolveSubject(snapshot);

    assert.deepEqual(resolved.subject.roles, [BUILT_IN_ROLES.ORG_ADMIN]);
    assert.deepEqual(resolved.subject.roleSources, [
      {
        roleId: BUILT_IN_ROLES.ORG_ADMIN,
        source: "hobo:auth/scim",
        groupId: "scim:org-admins",
        adapter: "workos",
      },
    ]);
    assert.equal(resolver.authorize(snapshot, grantAction("role", "bind")).decision.effect, "allow");
  });

  it("resolves a custom role composed from action ids", () => {
    const releaseObserver = defineCustomRole({
      id: "custom:release-observer",
      grants: [grantAction("deployment", "read"), grantAction("audit", "read")],
    });
    const resolver = createAuthPortRbacResolver({
      roles: [releaseObserver],
      bindings: [
        bindScimGroupToRole({
          groupId: "scim:release-observers",
          roleId: "custom:release-observer",
        }),
      ],
    });
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "user", id: "user:release-observer" },
      auth: { adapter: "entra", scimGroups: ["scim:release-observers"], snapshotSeq: "auth-snapshot:2" },
    });

    assert.equal(resolver.authorize(snapshot, grantAction("audit", "read")).decision.effect, "allow");
    assert.deepEqual(resolver.authorize(snapshot, grantAction("policy-pack", "approve")).decision, {
      effect: "deny",
      reason: "no-bound-role-grants-action",
      matchedRoles: [],
    });
  });

  it("stops granting a revoked SCIM role within the propagation bound before cache TTL expiry", () => {
    const resolver = createAuthPortRbacResolver({
      bindings: [
        bindScimGroupToRole({
          groupId: "scim:security-admins",
          roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
        }),
      ],
    });
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "user", id: "user:security-admin" },
      auth: { adapter: "okta", scimGroups: ["scim:security-admins"], snapshotSeq: "auth-snapshot:3" },
    });
    const first = resolver.authorize(snapshot, grantAction("policy-pack", "approve"));

    assert.equal(first.decision.effect, "allow");
    assert.equal(first.cacheExpiresAtMs, AUTH_PORT_RBAC_NFR.subjectCacheTtlMs);

    const revokedAtMs = 1_000;
    const observedAtMs = revokedAtMs + AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs;
    resolver.clock.set(observedAtMs);
    resolver.observeScimGroupRevocation({
      principalId: "user:security-admin",
      groupId: "scim:security-admins",
      roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
      revokedAtMs,
      observedAtMs,
      sequence: "scim-revocation:42",
    });

    assert.ok(resolver.clock.nowMs() < first.cacheExpiresAtMs, "subject cache TTL had not expired");
    const afterRevocation = resolver.authorize(snapshot, grantAction("policy-pack", "approve"));

    assert.equal(afterRevocation.cacheHit, false);
    assert.deepEqual(afterRevocation.subject.roles, []);
    assert.equal(afterRevocation.roleRevocations.at(0).sequence, "scim-revocation:42");
    assert.deepEqual(afterRevocation.decision, {
      effect: "deny",
      reason: "unbound-principal",
      matchedRoles: [],
    });
  });

  it("removes every role from a revoked SCIM group even when the group maps multiple roles", () => {
    const resolver = createAuthPortRbacResolver({
      bindings: [
        bindScimGroupToRole({
          groupId: "scim:platform-team",
          roleId: BUILT_IN_ROLES.AUDITOR,
        }),
        bindScimGroupToRole({
          groupId: "scim:platform-team",
          roleId: BUILT_IN_ROLES.DEPLOYER,
        }),
      ],
    });
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "user", id: "user:platform-member" },
      auth: { adapter: "okta", scimGroups: ["scim:platform-team"], snapshotSeq: "auth-snapshot:3b" },
    });

    assert.equal(resolver.authorize(snapshot, grantAction("audit", "read")).decision.effect, "allow");
    assert.equal(resolver.authorize(snapshot, grantAction("delta", "promote")).decision.effect, "allow");

    resolver.clock.set(AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs);
    resolver.observeScimGroupRevocation({
      principalId: "user:platform-member",
      groupId: "scim:platform-team",
      roleId: BUILT_IN_ROLES.AUDITOR,
      revokedAtMs: 0,
      observedAtMs: AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs,
      sequence: "scim-revocation:multi-role-group",
    });
    const afterRevocation = resolver.authorize(snapshot, grantAction("delta", "promote"));

    assert.deepEqual(afterRevocation.subject.roles, []);
    assert.deepEqual(afterRevocation.decision, {
      effect: "deny",
      reason: "unbound-principal",
      matchedRoles: [],
    });
  });

  it("ignores self-asserted roles that are not backed by an auth-port binding", () => {
    const resolver = createAuthPortRbacResolver();
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "user", id: "user:mallory" },
      auth: {
        adapter: "custom-jwt",
        scimGroups: [],
        assertedRoles: [BUILT_IN_ROLES.ORG_ADMIN],
        snapshotSeq: "auth-snapshot:4",
      },
    });
    const resolved = resolver.resolveSubject(snapshot);

    assert.deepEqual(resolved.subject.roles, []);
    assert.deepEqual(resolver.authorize(snapshot, grantAction("provider", "register")).decision, {
      effect: "deny",
      reason: "unbound-principal",
      matchedRoles: [],
    });
  });

  it("keeps Crew operator principals capped to their bound role", () => {
    const resolver = createAuthPortRbacResolver({
      bindings: [
        bindPrincipalToRole({
          principalId: "agent:crew-repair",
          roleId: BUILT_IN_ROLES.OPERATOR_SUPERVISOR,
        }),
        bindScimGroupToRole({
          groupId: "scim:org-admins",
          roleId: BUILT_IN_ROLES.ORG_ADMIN,
        }),
      ],
    });
    const snapshot = createAuthPortSnapshot({
      principal: { kind: "agent", id: "agent:crew-repair" },
      auth: {
        adapter: "workload-svid",
        scimGroups: ["scim:org-admins"],
        assertedRoles: [BUILT_IN_ROLES.ORG_ADMIN],
        snapshotSeq: "auth-snapshot:5",
      },
    });

    assert.deepEqual(resolver.resolveSubject(snapshot).subject.roles, [BUILT_IN_ROLES.OPERATOR_SUPERVISOR]);
    assert.equal(resolver.authorize(snapshot, grantAction("operator", "dispatch")).decision.effect, "allow");
    assert.equal(resolver.authorize(snapshot, grantAction("provider", "register")).decision.effect, "deny");
    assert.equal(
      resolver.canBind(snapshot, {
        targetPrincipalId: "agent:crew-repair",
        roleId: BUILT_IN_ROLES.ORG_ADMIN,
      }).decision.reason,
      "self-escalation",
    );
  });

  it("fails closed when revocation propagation misses its bound", () => {
    const resolver = createAuthPortRbacResolver();

    assert.throws(
      () =>
        resolver.observeScimGroupRevocation({
          principalId: "user:late",
          groupId: "scim:auditors",
          roleId: BUILT_IN_ROLES.AUDITOR,
          revokedAtMs: 0,
          observedAtMs: AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs + 1,
        }),
      /SCIM revocation propagation exceeded bound/,
    );
  });

  it("publishes a typed auth-port RBAC resolution surface", async () => {
    const declaration = await readFile(new URL("../src/auth-port-rbac-resolution.d.mts", import.meta.url), "utf8");

    assert.match(declaration, /export interface AuthPortSnapshot/);
    assert.match(declaration, /export interface AuthPortRbacResolver/);
    assert.match(declaration, /observeScimGroupRevocation/);

    const result = spawnSync(
      process.execPath,
      [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
      {
        cwd: packageRoot,
        encoding: "utf8",
        shell: false,
      },
    );

    assert.equal(
      result.status,
      0,
      [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
        "TypeScript exited non-zero",
    );
  });
});
