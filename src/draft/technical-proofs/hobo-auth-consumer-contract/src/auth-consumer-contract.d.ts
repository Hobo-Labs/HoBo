export declare const AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION = "hobo.auth.consumer-contract/v1";
export declare const AUTH_CONSUMER_CONTRACT_SCHEMA_ID = "https://hobo.dev/schemas/auth/consumer-contract.v1.json";
export declare const JWT_VERIFICATION_GAP: readonly [
  "jwks",
  "jwt.alg",
  "issuer",
  "audience",
  "expiry",
  "revocation",
];

export interface AuthConsumerContractInput {
  port: "hobo:auth";
  subject: {
    kind: "user";
    idClaim: string;
    requiredClaims: Record<string, { type: "string" } | { enum: string[] }>;
    requiredRoles: string[];
    requiredScopes: string[];
    tenancy: {
      platformTenant: string;
      appTenantClaim: string;
      defaultAppTenant: string;
    };
  };
  sessionOverrides: {
    roles: string[];
    tenants: string[];
    claims?: Record<string, string[]>;
  };
  grantedCapabilities: Array<{
    port: string;
    resource: string;
    actions: string[];
  }>;
  canDeployGate: {
    fixtureIdpSuite: string;
  };
}

export interface AuthConsumerContract extends AuthConsumerContractInput {
  schemaVersion: typeof AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION;
  verificationBoundary: {
    devModeAsserts: string[];
    notAssertedByContract: string[];
    requiredGate: string;
  };
}

export interface DevPrincipalFixture {
  source: "contract-asserted-dev-principal";
  authPort: "hobo:auth";
  contractDigest: string;
  ctxUser: {
    kind: "user";
    id: string;
    roles: string[];
    scopes: string[];
    tenant: {
      platform: string;
      app: string;
    };
    claims: Record<string, string>;
  };
}

export function defineAuthConsumerContract(
  input: AuthConsumerContractInput,
): Readonly<AuthConsumerContract>;
export function generateDevPrincipalFixture(
  contract: AuthConsumerContract | AuthConsumerContractInput,
  overrides?: {
    roles?: string[];
    tenant?: string;
    claims?: Record<string, string>;
  },
): DevPrincipalFixture;
export function assertAuthFixtureSatisfiesContract(
  contract: AuthConsumerContract | AuthConsumerContractInput,
  fixture: DevPrincipalFixture,
): true;
export function canonicalDevContractBytes(
  contract: AuthConsumerContract | AuthConsumerContractInput,
): string;
export function canonicalCanDeployContractBytes(
  contract: AuthConsumerContract | AuthConsumerContractInput,
): string;
export function requireGrantedCapability(
  contract: AuthConsumerContract | AuthConsumerContractInput,
  fixture: DevPrincipalFixture,
  call: { port: string; resource: string; action: string },
): true;
