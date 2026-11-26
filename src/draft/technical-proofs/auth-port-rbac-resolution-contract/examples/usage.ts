/**
 * Runnable example for auth-port-rbac-resolution-contract. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Proves HOBO-238: the hobo:auth port resolves SCIM groups to RBAC roles on the
 * subject, authorizes actions via bound role grants, and a SCIM group revocation
 * invalidates the cached subject WITHIN the propagation bound — before the subject
 * cache TTL would have expired. Deterministic manual clock.
 */
import { strict as assert } from "node:assert";

import {
	AUTH_PORT_RBAC_NFR,
	BUILT_IN_ROLES,
	bindScimGroupToRole,
	createAuthPortRbacResolver,
	createAuthPortSnapshot,
	defineCustomRole,
	grantAction,
} from "../src/auth-port-rbac-resolution.ts";

// 1) A fixture SCIM group maps to Org-Admin and populates subject.roles.
const adminResolver = createAuthPortRbacResolver({
	bindings: [bindScimGroupToRole({ groupId: "scim:org-admins", roleId: BUILT_IN_ROLES.ORG_ADMIN })],
});
const adminSnapshot = createAuthPortSnapshot({
	principal: { kind: "user", id: "user:alice" },
	auth: { adapter: "workos", scimGroups: ["scim:org-admins"], snapshotSeq: "auth-snapshot:1" },
});
const resolved = adminResolver.resolveSubject(adminSnapshot);
assert.deepEqual(resolved.subject.roles, [BUILT_IN_ROLES.ORG_ADMIN]);
assert.equal(resolved.subject.roleSources[0].source, "hobo:auth/scim");
assert.equal(adminResolver.authorize(adminSnapshot, grantAction("role", "bind")).decision.effect, "allow");
console.log(`scim mapping: roles=${resolved.subject.roles.join(",")} source=${resolved.subject.roleSources[0].source}`);
console.log("authorize role/bind: allow");

// 2) Custom roles compose action grants; unmatched actions deny with a reason.
const resolver = createAuthPortRbacResolver({
	roles: [
		defineCustomRole({
			id: "custom:release-observer",
			grants: [grantAction("deployment", "read"), grantAction("audit", "read")],
		}),
	],
	bindings: [
		bindScimGroupToRole({ groupId: "scim:release-observers", roleId: "custom:release-observer" }),
	],
});
const observerSnapshot = createAuthPortSnapshot({
	principal: { kind: "user", id: "user:release-observer" },
	auth: { adapter: "entra", scimGroups: ["scim:release-observers"], snapshotSeq: "auth-snapshot:2" },
});
assert.equal(resolver.authorize(observerSnapshot, grantAction("audit", "read")).decision.effect, "allow");
const denied = resolver.authorize(observerSnapshot, grantAction("policy-pack", "approve")).decision;
assert.deepEqual(denied, { effect: "deny", reason: "no-bound-role-grants-action", matchedRoles: [] });
console.log(`custom role: audit/read=allow policy-pack/approve=${denied.effect} reason=${denied.reason}`);

// 3) Revocation beats the cache TTL: a revoked SCIM group stops granting within
//    the propagation bound even though the cached subject had not expired.
const securityResolver = createAuthPortRbacResolver({
	bindings: [
		bindScimGroupToRole({
			groupId: "scim:security-admins",
			roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
		}),
	],
});
const securitySnapshot = createAuthPortSnapshot({
	principal: { kind: "user", id: "user:security-admin" },
	auth: { adapter: "okta", scimGroups: ["scim:security-admins"], snapshotSeq: "auth-snapshot:3" },
});
const first = securityResolver.authorize(securitySnapshot, grantAction("policy-pack", "approve"));
assert.equal(first.decision.effect, "allow");
console.log(
	`nfr: cacheTtlMs=${AUTH_PORT_RBAC_NFR.subjectCacheTtlMs} revocationBoundMs=${AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs}`,
);
console.log(`before revocation: policy-pack/approve=${first.decision.effect}`);

const revokedAtMs = 1_000;
const observedAtMs = revokedAtMs + AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs;
securityResolver.clock.set(observedAtMs);
securityResolver.observeScimGroupRevocation({
	principalId: "user:security-admin",
	groupId: "scim:security-admins",
	roleId: BUILT_IN_ROLES.SECURITY_POLICY_ADMIN,
	revokedAtMs,
	observedAtMs,
	sequence: "scim-revocation:42",
});
assert.ok(securityResolver.clock.nowMs() < first.cacheExpiresAtMs, "cache TTL not yet expired");
const afterRevocation = securityResolver.authorize(securitySnapshot, grantAction("policy-pack", "approve"));
assert.equal(afterRevocation.cacheHit, false);
assert.deepEqual(afterRevocation.subject.roles, []);
assert.deepEqual(afterRevocation.decision, {
	effect: "deny",
	reason: "unbound-principal",
	matchedRoles: [],
});
console.log(
	`after revocation (ttl not expired): cacheHit=${afterRevocation.cacheHit} roles=[] decision=${afterRevocation.decision.effect} reason=${afterRevocation.decision.reason}`,
);
console.log(`revocation evidence: sequence=${afterRevocation.roleRevocations[0].sequence}`);

console.log("CONTRACT HELD: scim->role resolution, grant-scoped authorize, revocation beats TTL");
