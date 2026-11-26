import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import {
  BUILT_IN_ROLES,
  createPrincipalRef,
  serializeAsEventActor,
  serializeAsPolicySubject,
} from "../src/principal-ref.js";

describe("PrincipalRef contract", () => {
  it("serializes the same principal for policy subject and event actor", () => {
    const principal = createPrincipalRef({
      kind: "user",
      id: "user_123",
      requestedRoles: [BUILT_IN_ROLES.ORG_ADMIN],
      roleBindings: {
        user_123: [BUILT_IN_ROLES.DEPLOYER, BUILT_IN_ROLES.AUDITOR],
      },
      scopes: ["bindle:read"],
      tenant: {
        platform: "platform-acme",
        app: "app-acme",
      },
    });

    assert.deepEqual(serializeAsPolicySubject(principal), serializeAsEventActor(principal));
    assert.deepEqual(serializeAsPolicySubject(principal).roles, [
      BUILT_IN_ROLES.AUDITOR,
      BUILT_IN_ROLES.DEPLOYER,
    ]);
  });

  it("serializes an on-behalf-of user to agent chain", () => {
    const user = createPrincipalRef({
      kind: "user",
      id: "user_123",
      roleBindings: { user_123: [BUILT_IN_ROLES.DEPLOYER] },
      tenant: { platform: "platform-acme", app: "app-acme" },
    });
    const agent = createPrincipalRef({
      kind: "agent",
      id: "agent_release",
      roleBindings: { agent_release: [BUILT_IN_ROLES.OPERATOR_SUPERVISOR] },
      delegatedBy: user,
      tenant: { platform: "platform-acme", app: "app-acme" },
    });

    assert.equal(serializeAsPolicySubject(agent).delegatedBy.kind, "user");
    assert.equal(serializeAsPolicySubject(agent).delegatedBy.id, "user_123");
    assert.equal(serializeAsPolicySubject(agent).delegatedBy.delegatedBy, undefined);
  });

  it("keeps cross-tenant admin scope explicit and distinct from unresolved tenant", () => {
    const principal = createPrincipalRef({
      kind: "user",
      id: "admin_1",
      roleBindings: { admin_1: [BUILT_IN_ROLES.ORG_ADMIN] },
      tenant: { platform: "platform-acme" },
      ctxTenants: ["app-acme", "app-globex"],
    });

    const serialized = serializeAsPolicySubject(principal);

    assert.deepEqual(serialized.ctxTenant, {
      kind: "unresolved",
      failClosed: true,
    });
    assert.deepEqual(serialized.ctxTenants, {
      kind: "explicit-set",
      values: ["app-acme", "app-globex"],
    });
    assert.ok(!JSON.stringify(serialized).includes("*"));
  });

  it("marks unresolved tenant as fail closed instead of all tenants", () => {
    const principal = createPrincipalRef({
      kind: "service",
      id: "svc_runtime",
      roleBindings: { svc_runtime: [] },
      tenant: { platform: "platform-acme" },
    });

    assert.deepEqual(serializeAsPolicySubject(principal).ctxTenant, {
      kind: "unresolved",
      failClosed: true,
    });
  });

  it("ignores self-asserted roles that were not granted by a binding", () => {
    const principal = createPrincipalRef({
      kind: "user",
      id: "user_123",
      requestedRoles: [BUILT_IN_ROLES.ORG_ADMIN, BUILT_IN_ROLES.SECURITY_POLICY_ADMIN],
      roleBindings: { user_123: [BUILT_IN_ROLES.AUDITOR] },
      tenant: { platform: "platform-acme", app: "app-acme" },
    });

    assert.deepEqual(serializeAsPolicySubject(principal).roles, [BUILT_IN_ROLES.AUDITOR]);
  });

  it("rejects delegatedBy chains that point at a service principal", () => {
    const service = createPrincipalRef({
      kind: "service",
      id: "svc_runtime",
      roleBindings: { svc_runtime: [] },
      tenant: { platform: "platform-acme", app: "app-acme" },
    });

    assert.throws(
      () =>
        createPrincipalRef({
          kind: "agent",
          id: "agent_release",
          roleBindings: { agent_release: [BUILT_IN_ROLES.OPERATOR_SUPERVISOR] },
          delegatedBy: service,
          tenant: { platform: "platform-acme", app: "app-acme" },
        }),
      /delegatedBy cannot reference a service principal/,
    );
  });

  it("publishes a typed PrincipalRef declaration surface", async () => {
    const declaration = await readFile(new URL("../src/principal-ref.d.ts", import.meta.url), "utf8");

    assert.match(declaration, /export type PrincipalKind = "user" \| "agent" \| "service"/);
    assert.match(declaration, /export interface PrincipalRef/);
    assert.match(declaration, /export function serializeAsPolicySubject/);
    assert.match(declaration, /export function serializeAsEventActor/);
  });
});
