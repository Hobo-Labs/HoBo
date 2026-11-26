export type PrincipalKind = "user" | "agent" | "service";

export interface AuthPortSnapshot {
  principal: {
    kind: PrincipalKind;
    id: string;
  };
  auth: {
    port: "hobo:auth" | string;
    adapter?: string;
    scimGroups: string[];
    assertedRoles: string[];
    snapshotSeq: string;
  };
}

export interface ScimGroupRevocation {
  principalId: string;
  groupId: string;
  roleId: string;
  revokedAtMs: number;
  observedAtMs: number;
  effectiveAtMs: number;
  sequence: string;
  propagationBoundMs: number;
}

export interface ResolvedAuthPortSubject {
  subject: {
    kind: PrincipalKind;
    id: string;
    roles: string[];
    roleSources: Array<{
      roleId: string;
      source: "direct-binding" | "hobo:auth/scim";
      principalId?: string;
      groupId?: string;
      adapter?: string;
    }>;
  };
  cacheHit: boolean;
  cacheExpiresAtMs: number;
  roleRevocations: ScimGroupRevocation[];
}

export interface AuthPortSnapshotInput {
  principal?: {
    kind?: string;
    id?: string;
  };
  auth?: {
    port?: string;
    adapter?: string;
    scimGroups?: readonly string[];
    assertedRoles?: readonly string[];
    snapshotSeq?: string;
  };
}

export interface AuthPortClock {
  nowMs(): number;
  set(nextMs: number): number;
  advance(deltaMs: number): number;
}

export interface AuthPortRbacResolverInput {
  clock?: AuthPortClock;
  bindings?: readonly object[];
  roles?: readonly object[];
  nfr?: {
    subjectCacheTtlMs: number;
    revocationPropagationBoundMs: number;
  };
}

export interface AuthPortRbacResolver {
  contractVersion: string;
  nfr: {
    subjectCacheTtlMs: number;
    revocationPropagationBoundMs: number;
  };
  clock: AuthPortClock;
  resolveSubject(snapshot: AuthPortSnapshotInput): ResolvedAuthPortSubject;
  authorize(snapshot: AuthPortSnapshotInput, actionId: string): ResolvedAuthPortSubject & {
    decision: {
      effect: "allow" | "deny";
      reason?: string;
      matchedRoles?: string[];
    };
  };
  canBind(snapshot: AuthPortSnapshotInput, input: { targetPrincipalId: string; roleId: string }): ResolvedAuthPortSubject & {
    decision: {
      effect: "allow" | "deny";
      reason: string;
      missingGrantIds?: string[];
    };
  };
  observeScimGroupRevocation(input: {
    principalId: string;
    groupId: string;
    roleId: string;
    revokedAtMs: number;
    observedAtMs?: number;
    sequence?: string;
  }): ScimGroupRevocation;
  cacheSize(): number;
}

export const AUTH_PORT_RBAC_CONTRACT_VERSION: string;
export const AUTH_PORT_RBAC_NFR: {
  subjectCacheTtlMs: number;
  revocationPropagationBoundMs: number;
};
export const BUILT_IN_ROLES: Record<string, string>;

export function createAuthPortSnapshot(input: AuthPortSnapshotInput): AuthPortSnapshot;
export function createAuthPortRbacResolver(input?: AuthPortRbacResolverInput): AuthPortRbacResolver;
export function bindPrincipalToRole(input: { principalId: string; roleId: string }): object;
export function bindScimGroupToRole(input: { groupId: string; roleId: string }): object;
export function defineCustomRole(input: { id: string; name?: string; grants: string[] }): object;
export function grantAction(resource: string, verb: string): string;
