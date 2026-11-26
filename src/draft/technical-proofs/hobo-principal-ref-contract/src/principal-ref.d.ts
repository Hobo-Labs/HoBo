export type PrincipalKind = "user" | "agent" | "service";

export type BuiltInRole =
  | "org-admin"
  | "security-policy-admin"
  | "platform-engineer"
  | "deployer"
  | "operator-supervisor"
  | "auditor";

export interface TenantRef {
  platform: string;
  app?: string;
}

export interface PrincipalRef {
  kind: PrincipalKind;
  id: string;
  roles: BuiltInRole[];
  scopes: string[];
  tenant: TenantRef;
  ctxTenants: string[];
  delegatedBy?: Omit<PrincipalRef, "delegatedBy">;
}

export interface PrincipalRefInput {
  kind: PrincipalKind;
  id: string;
  requestedRoles?: BuiltInRole[];
  roleBindings?: Record<string, BuiltInRole[]>;
  scopes?: string[];
  tenant: TenantRef;
  ctxTenants?: string[];
  delegatedBy?: PrincipalRef;
}

export interface SerializedPrincipalRef {
  kind: PrincipalKind;
  id: string;
  roles: BuiltInRole[];
  scopes: string[];
  platformTenant: string;
  ctxTenant:
    | { kind: "resolved"; value: string }
    | { kind: "unresolved"; failClosed: true };
  ctxTenants:
    | { kind: "explicit-set"; values: string[] }
    | { kind: "none" };
  delegatedBy?: Omit<SerializedPrincipalRef, "delegatedBy">;
}

export const BUILT_IN_ROLES: Readonly<{
  ORG_ADMIN: "org-admin";
  SECURITY_POLICY_ADMIN: "security-policy-admin";
  PLATFORM_ENGINEER: "platform-engineer";
  DEPLOYER: "deployer";
  OPERATOR_SUPERVISOR: "operator-supervisor";
  AUDITOR: "auditor";
}>;

export function createPrincipalRef(input: PrincipalRefInput): PrincipalRef;
export function serializeAsPolicySubject(principal: PrincipalRef): SerializedPrincipalRef;
export function serializeAsEventActor(principal: PrincipalRef): SerializedPrincipalRef;
