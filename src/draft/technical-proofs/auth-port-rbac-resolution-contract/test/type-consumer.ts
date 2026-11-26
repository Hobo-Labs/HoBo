import type {
  AuthPortRbacResolver,
  AuthPortSnapshot,
  ResolvedAuthPortSubject,
  ScimGroupRevocation,
} from "../src/auth-port-rbac-resolution.d.mts";
import type * as AuthPortRbac from "../src/auth-port-rbac-resolution.d.mts";

declare const AUTH_PORT_RBAC_NFR: typeof AuthPortRbac.AUTH_PORT_RBAC_NFR;
declare const BUILT_IN_ROLES: typeof AuthPortRbac.BUILT_IN_ROLES;
declare const bindPrincipalToRole: typeof AuthPortRbac.bindPrincipalToRole;
declare const bindScimGroupToRole: typeof AuthPortRbac.bindScimGroupToRole;
declare const createAuthPortRbacResolver: typeof AuthPortRbac.createAuthPortRbacResolver;
declare const createAuthPortSnapshot: typeof AuthPortRbac.createAuthPortSnapshot;
declare const defineCustomRole: typeof AuthPortRbac.defineCustomRole;
declare const grantAction: typeof AuthPortRbac.grantAction;

function assertAuthPortRbacTypes() {
  const releaseObserver = defineCustomRole({
    id: "custom:typed-release-observer",
    grants: [grantAction("audit", "read")],
  });

  const resolver: AuthPortRbacResolver = createAuthPortRbacResolver({
    roles: [releaseObserver],
    bindings: [
      bindScimGroupToRole({
        groupId: "scim:typed-admins",
        roleId: BUILT_IN_ROLES.ORG_ADMIN,
      }),
      bindPrincipalToRole({
        principalId: "agent:typed-operator",
        roleId: BUILT_IN_ROLES.OPERATOR_SUPERVISOR,
      }),
    ],
  });

  const snapshot: AuthPortSnapshot = createAuthPortSnapshot({
    principal: { kind: "user", id: "user:typed-admin" },
    auth: {
      adapter: "workos",
      scimGroups: ["scim:typed-admins"],
      assertedRoles: [BUILT_IN_ROLES.AUDITOR],
      snapshotSeq: "auth-snapshot:typed",
    },
  });

  const resolved: ResolvedAuthPortSubject = resolver.resolveSubject(snapshot);
  const roles: string[] = resolved.subject.roles;
  const decision = resolver.authorize(snapshot, grantAction("role", "bind")).decision;
  const bindingDecisionReason: string = resolver.canBind(snapshot, {
    targetPrincipalId: "user:target",
    roleId: BUILT_IN_ROLES.AUDITOR,
  }).decision.reason;

  resolver.clock.set(AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs);
  const revocation: ScimGroupRevocation = resolver.observeScimGroupRevocation({
    principalId: snapshot.principal.id,
    groupId: "scim:typed-admins",
    roleId: BUILT_IN_ROLES.ORG_ADMIN,
    revokedAtMs: 0,
    observedAtMs: AUTH_PORT_RBAC_NFR.revocationPropagationBoundMs,
  });

  // @ts-expect-error resolved role ids are strings, not numbers.
  const invalidRoleId: number = resolved.subject.roles[0];

  // @ts-expect-error action id must be a string.
  resolver.authorize(snapshot, 42);

  void roles;
  void decision;
  void bindingDecisionReason;
  void revocation;
  void invalidRoleId;
}

void assertAuthPortRbacTypes;
