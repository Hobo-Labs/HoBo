export type PrincipalKind = "user" | "agent" | "service";
export type RoleKind = "built-in" | "custom";
export type BindingKind = "principal" | "scim-group";
export type AuthorizationEffect = "allow" | "deny";

export interface RoleDefinition {
  id: string;
  name: string;
  kind: RoleKind;
  grants: string[];
}

export interface PrincipalRoleBinding {
  kind: "principal";
  principalId: string;
  roleId: string;
}

export interface ScimGroupRoleBinding {
  kind: "scim-group";
  groupId: string;
  roleId: string;
}

export type RoleBinding = PrincipalRoleBinding | ScimGroupRoleBinding;

export interface RbacPrincipal {
  kind: PrincipalKind;
  id: string;
}

export interface AuthPortClaims {
  port?: "hobo:auth";
  adapter?: string;
  scimGroups?: string[];
}

export interface RbacRoleSource {
  roleId: string;
  source: "direct-binding" | "hobo:auth/scim";
  principalId?: string;
  groupId?: string;
  adapter?: string;
}

export interface RbacSubject {
  kind: PrincipalKind;
  id: string;
  roles: string[];
  roleSources: RbacRoleSource[];
}

export interface AuthorizationDecision {
  effect: AuthorizationEffect;
  reason?: string;
  matchedRoles?: string[];
}

export interface BindRoleDecision {
  effect: AuthorizationEffect;
  reason: string;
  missingGrantIds?: string[];
}

export const BUILT_IN_ROLE_DEFINITIONS: Record<string, RoleDefinition>;

export function grantAction(resource: string, verb: string): string;
export function defineCustomRole(input: { id: string; name?: string; grants: string[] }): RoleDefinition;
export function bindPrincipalToRole(input: { principalId: string; roleId: string }): PrincipalRoleBinding;
export function bindScimGroupToRole(input: { groupId: string; roleId: string }): ScimGroupRoleBinding;
export function resolveRbacSubject(input: {
  principal: RbacPrincipal;
  requestedRoles?: string[];
  auth?: AuthPortClaims;
  bindings?: RoleBinding[];
}): RbacSubject;
export function authorizeControlPlaneAction(input: {
  subject: RbacSubject;
  actionId: string;
  roles?: RoleDefinition[];
}): AuthorizationDecision;
export function canBindRole(input: {
  binder: RbacSubject;
  targetPrincipalId: string;
  roleId: string;
  roles?: RoleDefinition[];
}): BindRoleDecision;
