import { type JsonValue, type JsonObject } from "./json.js";
export type AuthProviderKind = "oidc" | "customJwt" | "builtin";

export interface AuthProviderDeclaration<
  Id extends string = string,
  Kind extends AuthProviderKind = AuthProviderKind,
> {
  readonly id: Id;
  readonly kind: Kind;
  readonly productionEligible: boolean;
  readonly verification: {
    readonly issuer: string;
    readonly jwks: string;
    readonly alg: string;
  };
}

export type AuthProviderId<Providers extends readonly AuthProviderDeclaration[]> =
  Providers[number]["id"];

export interface AppTenantContext<TenantClaim extends string = string> {
  readonly claim: TenantClaim;
  readonly app: string;
  readonly unresolved: "fail-closed";
}

export interface PrincipalRef<
  Claims extends JsonObject = JsonObject,
  TenantClaim extends string = string,
> {
  readonly kind: "user";
  readonly id: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly claims: Claims;
  readonly tenant: AppTenantContext<TenantClaim>;
}

export type AuthState<
  Claims extends JsonObject,
  TenantClaim extends string,
> =
  | { readonly status: "anonymous"; readonly user: null }
  | { readonly status: "authenticated"; readonly user: PrincipalRef<Claims, TenantClaim> };

export interface AuthGeneratedSurface<
  Providers extends readonly AuthProviderDeclaration[],
  Claims extends JsonObject,
  TenantClaim extends string,
> {
  readonly ctx: {
    readonly user: PrincipalRef<Claims, TenantClaim>;
    readonly tenant: AppTenantContext<TenantClaim>;
  };
  useAuth(): AuthState<Claims, TenantClaim>;
  signIn(provider: AuthProviderId<Providers>): Promise<void>;
  signOut(): Promise<void>;
}

export interface AuthDeclarationInput {
  readonly providers: readonly AuthProviderDeclaration[];
  readonly subject: {
    readonly idClaim: string;
    readonly claims: Record<string, { type: "string" } | { enum: readonly string[] }>;
    readonly roles?: readonly string[];
    readonly scopes?: readonly string[];
    readonly tenancy: {
      readonly platformTenant: string;
      readonly appTenantClaim: string;
      readonly defaultAppTenant: string;
    };
  };
  readonly sessionOverrides?: {
    readonly roles?: readonly string[];
    readonly tenants?: readonly string[];
    readonly claims?: Record<string, readonly string[]>;
  };
  readonly grantedCapabilities?: ReadonlyArray<{
    readonly port: string;
    readonly resource: string;
    readonly actions: readonly string[];
  }>;
}

export interface AuthDeclaration {
  readonly kind: "auth";
  readonly port: "hobo:auth";
  readonly providers: readonly AuthProviderDeclaration[];
  readonly subject: AuthDeclarationInput["subject"] & {
    readonly roles: readonly string[];
    readonly scopes: readonly string[];
  };
  readonly sessionOverrides: Required<NonNullable<AuthDeclarationInput["sessionOverrides"]>>;
  readonly grantedCapabilities: NonNullable<AuthDeclarationInput["grantedCapabilities"]>;
}

export interface AuthProviderFactories {
  (input: AuthDeclarationInput): AuthDeclaration;
  oidc(input: {
    readonly id?: string;
    readonly issuer: string;
    readonly jwks?: string;
    readonly alg?: string;
  }): AuthProviderDeclaration<string, "oidc">;
  customJwt(input: {
    readonly id: string;
    readonly issuer: string;
    readonly jwks: string;
    readonly alg: string;
  }): AuthProviderDeclaration<string, "customJwt">;
  builtin(input?: { readonly id?: string }): AuthProviderDeclaration<string, "builtin">;
}

export const auth: AuthProviderFactories;
export function defineAuthDeclaration(input: AuthDeclarationInput): AuthDeclaration;
export function buildAuthManifestEntry(declaration: AuthDeclaration | AuthDeclarationInput): JsonValue;
export function emitAuthConsumerContract(
  declaration: AuthDeclaration | AuthDeclarationInput,
  options: { readonly fixtureIdpSuite: string },
): JsonValue;
export function evaluateAuthCanDeploy(
  declaration: AuthDeclaration | AuthDeclarationInput,
  options?: { readonly target?: "dev" | "air-gap" | "production" | string },
): { readonly ok: boolean; readonly target: string; readonly reason: string };
export function generateAuthSurfaceDeclaration(
  declaration: AuthDeclaration | AuthDeclarationInput,
  options?: { readonly interfaceName?: string },
): string;
