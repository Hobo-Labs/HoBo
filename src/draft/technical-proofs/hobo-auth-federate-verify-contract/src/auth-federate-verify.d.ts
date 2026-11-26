import { type JsonValue, type JsonObject } from "./json.js";
export interface HoboAuthPortConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly algorithms: readonly ["RS256", ...string[]];
  readonly jwks: {
    readonly keys: readonly JsonWebKey[];
  };
  readonly tenantClaim: string;
  readonly subjectClaim: string;
  readonly roleClaim: string;
  readonly scopeClaim: string;
  readonly providers?: readonly string[];
}

export interface HoboAuthUser {
  readonly kind: "user";
  readonly id: string;
  readonly provider: string;
  readonly roles: readonly string[];
  readonly scopes: readonly string[];
  readonly tenant: {
    readonly app: string;
  };
  readonly claims: Readonly<JsonObject>;
}

export interface ResolvedTenantContext {
  readonly kind: "resolved";
  readonly value: string;
}

export interface HoboAuthContext {
  readonly user: HoboAuthUser;
  readonly tenant: ResolvedTenantContext;
  readonly auth: {
    readonly issuer: string;
    readonly audience: string;
    readonly provider: string;
    readonly kid: string;
    readonly verifiedAt: "request";
    readonly mode: "stateless-jwks";
  };
}

export interface AuthVerifyRequest {
  readonly token: string;
  readonly provider?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
}

export type AuthVerifyResult =
  | {
      readonly ok: true;
      readonly ctx: HoboAuthContext;
      readonly header: Readonly<JsonObject>;
      readonly claims: Readonly<JsonObject>;
      readonly events: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

export interface HoboAuthVerifier {
  verifyRequest(request: AuthVerifyRequest): Promise<AuthVerifyResult>;
}

export interface FixtureIdentityProvider {
  readonly issuer: string;
  signJwt(claims: Readonly<JsonObject>): Promise<string>;
  jwks(): { readonly keys: readonly JsonWebKey[] };
  rotate(nextKeyId: string): FixtureIdentityProvider;
  makeUnsignedJwt(claims: Readonly<JsonObject>): string;
  signHmacJwt(claims: Readonly<JsonObject>, secret: string): string;
}

export function createFixtureIdentityProvider(input: {
  readonly issuer: string;
  readonly keyId: string;
}): FixtureIdentityProvider;

export function createHoboAuthVerifier(input: {
  readonly authPort: HoboAuthPortConfig;
  readonly now?: () => number;
  readonly eventSink?: (event: JsonValue) => void;
}): HoboAuthVerifier;

export function requireTenantAccess(ctx: HoboAuthContext, tenant: string): true;
