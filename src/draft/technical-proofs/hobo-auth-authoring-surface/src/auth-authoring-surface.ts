import { defineAuthConsumerContract } from "../../hobo-auth-consumer-contract/src/auth-consumer-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const PROVIDER_KINDS = new Set(["oidc", "customJwt", "builtin"]);
const PRODUCTION_TARGET = "production";

export function auth(input) {
  return defineAuthDeclaration(input);
}

auth.oidc = function oidcProvider(input) {
  assertAllowedProperties(input, "auth.oidc", ["id", "issuer", "jwks", "alg"]);
  const issuer = normalizeHttpsUrl(input.issuer, "auth.oidc.issuer");
  return freezeProvider({
    id: normalizeProviderId(input.id ?? providerIdFromIssuer(issuer), "auth.oidc.id"),
    kind: "oidc",
    verification: {
      issuer,
      jwks: normalizeHttpsUrl(input.jwks ?? defaultJwksUrl(issuer), "auth.oidc.jwks"),
      alg: normalizeJwtAlg(input.alg ?? "RS256", "auth.oidc.alg"),
    },
    productionEligible: true,
  });
};

auth.customJwt = function customJwtProvider(input) {
  assertAllowedProperties(input, "auth.customJwt", ["id", "issuer", "jwks", "alg"]);
  return freezeProvider({
    id: normalizeProviderId(input.id, "auth.customJwt.id"),
    kind: "customJwt",
    verification: {
      issuer: normalizeHttpsUrl(input.issuer, "auth.customJwt.issuer"),
      jwks: normalizeHttpsUrl(input.jwks, "auth.customJwt.jwks"),
      alg: normalizeJwtAlg(input.alg, "auth.customJwt.alg"),
    },
    productionEligible: true,
  });
};

auth.builtin = function builtinProvider(input = {}) {
  assertAllowedProperties(input, "auth.builtin", ["id"]);
  return freezeProvider({
    id: normalizeProviderId(input.id ?? "builtin", "auth.builtin.id"),
    kind: "builtin",
    environment: ["air-gap", "dev"],
    productionEligible: false,
    verification: {
      issuer: "urn:hobo:dev-builtin",
      jwks: "urn:hobo:dev-builtin:jwks",
      alg: "HOBO-BUILTIN-FIXTURE",
    },
  });
};

export function defineAuthDeclaration(input) {
  assertAllowedProperties(input, "auth declaration", [
    "providers",
    "subject",
    "sessionOverrides",
    "grantedCapabilities",
  ]);
  const providers = normalizeProviders(input.providers);
  const subject = normalizeSubject(input.subject);
  const sessionOverrides = normalizeSessionOverrides(input.sessionOverrides, subject);
  const grantedCapabilities = normalizeGrantedCapabilities(input.grantedCapabilities ?? []);

  return deepFreeze({
    kind: "auth",
    port: "hobo:auth",
    providers,
    subject,
    sessionOverrides,
    grantedCapabilities,
  });
}

export function buildAuthManifestEntry(declaration) {
  const normalized = ensureDeclaration(declaration);
  return deepFreeze({
    type: "auth.v1",
    port: "hobo:auth",
    providers: normalized.providers.map((provider) => {
      const base = {
        id: provider.id,
        kind: provider.kind,
      };
      if (provider.environment) {
        base.environment = [...provider.environment];
      }
      base.productionEligible = provider.productionEligible;
      base.verification = { ...provider.verification };
      return base;
    }),
    server: {
      ctxUser: {
        kind: "user",
        idClaim: normalized.subject.idClaim,
        claims: normalized.subject.claims,
      },
    },
    client: {
      providers: normalized.providers.map((provider) => provider.id),
      methods: ["useAuth", "signIn", "signOut"],
    },
    tenancy: {
      claim: normalized.subject.tenancy.appTenantClaim,
      defaultTenant: normalized.subject.tenancy.defaultAppTenant,
      unresolved: "fail-closed",
      enforcementMarker: "ctx.tenant.required",
    },
    consumerContract: {
      port: "hobo:auth",
      subjectKind: "user",
      requiredRoles: [...normalized.subject.roles],
      requiredScopes: [...normalized.subject.scopes],
    },
  });
}

export function emitAuthConsumerContract(declaration, options = {}) {
  const normalized = ensureDeclaration(declaration);
  return defineAuthConsumerContract({
    port: "hobo:auth",
    subject: {
      kind: "user",
      idClaim: normalized.subject.idClaim,
      requiredClaims: normalized.subject.claims,
      requiredRoles: normalized.subject.roles,
      requiredScopes: normalized.subject.scopes,
      tenancy: normalized.subject.tenancy,
    },
    sessionOverrides: normalized.sessionOverrides,
    grantedCapabilities: normalized.grantedCapabilities,
    canDeployGate: {
      fixtureIdpSuite: normalizeNonEmptyString(
        options.fixtureIdpSuite,
        "fixtureIdpSuite",
      ),
    },
  });
}

export function evaluateAuthCanDeploy(declaration, options = {}) {
  const normalized = ensureDeclaration(declaration);
  const target = options.target ?? PRODUCTION_TARGET;
  const hasProductionProvider = normalized.providers.some((provider) => provider.productionEligible);

  if (target === PRODUCTION_TARGET && !hasProductionProvider) {
    return {
      ok: false,
      target,
      reason: "builtin-auth-provider-is-not-production-eligible",
    };
  }

  if (!hasProductionProvider) {
    return {
      ok: true,
      target,
      reason: "dev-or-air-gap-builtin-provider",
    };
  }

  return {
    ok: true,
    target,
    reason: "production-provider-present",
  };
}

export function generateAuthSurfaceDeclaration(declaration, options = {}) {
  const normalized = ensureDeclaration(declaration);
  const interfaceName = options.interfaceName ?? "GeneratedAuthSurface";
  const providerUnion = normalized.providers.map((provider) => quote(provider.id)).join(" | ");
  const claimLines = Object.entries(normalized.subject.claims).map(([name, claim]) => {
    const type = claim.type === "string" ? "string" : claim.enum.map(quote).join(" | ");
    return `  readonly ${name}: ${type};`;
  });

  return [
    `export type AuthProviderId = ${providerUnion};`,
    `export interface AuthClaims {`,
    ...claimLines,
    `}`,
    `export interface AppTenantContext {`,
    `  readonly claim: ${quote(normalized.subject.tenancy.appTenantClaim)};`,
    `  readonly app: string;`,
    `  readonly unresolved: "fail-closed";`,
    `}`,
    `export interface PrincipalRef {`,
    `  readonly kind: "user";`,
    `  readonly id: string;`,
    `  readonly roles: readonly string[];`,
    `  readonly scopes: readonly string[];`,
    `  readonly claims: AuthClaims;`,
    `  readonly tenant: AppTenantContext;`,
    `}`,
    `export type AuthState =`,
    `  | { readonly status: "anonymous"; readonly user: null }`,
    `  | { readonly status: "authenticated"; readonly user: PrincipalRef };`,
    `export interface ${interfaceName} {`,
    `  readonly ctx: {`,
    `    readonly user: PrincipalRef;`,
    `    readonly tenant: AppTenantContext;`,
    `  };`,
    `  useAuth(): AuthState;`,
    `  signIn(provider: AuthProviderId): Promise<void>;`,
    `  signOut(): Promise<void>;`,
    `}`,
  ].join("\n");
}

function ensureDeclaration(declaration) {
  if (declaration?.kind === "auth" && declaration?.port === "hobo:auth") {
    return declaration;
  }
  return defineAuthDeclaration(declaration);
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error("auth declaration providers must be a non-empty array");
  }
  const seen = new Set();
  return providers.map((provider, index) => {
    assertObject(provider, `providers[${index}]`);
    if (!PROVIDER_KINDS.has(provider.kind)) {
      throw new Error(`providers[${index}].kind must be oidc, customJwt, or builtin`);
    }
    if (seen.has(provider.id)) {
      throw new Error(`duplicate auth provider id '${provider.id}'`);
    }
    seen.add(provider.id);
    return provider;
  });
}

function normalizeSubject(subject) {
  assertAllowedProperties(subject, "subject", [
    "idClaim",
    "claims",
    "roles",
    "scopes",
    "tenancy",
  ]);
  const idClaim = normalizeNonEmptyString(subject.idClaim, "subject.idClaim");
  const claims = normalizeClaimContracts(subject.claims, idClaim);
  const roles = normalizeStringSet(subject.roles ?? [], "subject.roles");
  const scopes = normalizeStringSet(subject.scopes ?? [], "subject.scopes");
  const tenancy = normalizeTenancy(subject.tenancy, claims);
  return {
    idClaim,
    claims,
    roles,
    scopes,
    tenancy,
  };
}

function normalizeClaimContracts(claims, idClaim) {
  assertObject(claims, "subject.claims");
  if (!Object.hasOwn(claims, idClaim)) {
    throw new Error(`subject.claims must include idClaim '${idClaim}'`);
  }
  const normalized = {};
  for (const [name, claim] of Object.entries(claims).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    assertObject(claim, `subject.claims.${name}`);
    if (claim.type === "string") {
      assertAllowedProperties(claim, `subject.claims.${name}`, ["type"]);
      normalized[name] = { type: "string" };
      continue;
    }
    if (Array.isArray(claim.enum)) {
      assertAllowedProperties(claim, `subject.claims.${name}`, ["enum"]);
      normalized[name] = { enum: normalizeStringSet(claim.enum, `subject.claims.${name}.enum`) };
      continue;
    }
    throw new Error(`subject.claims.${name} must declare type:string or enum`);
  }
  return normalized;
}

function normalizeTenancy(tenancy, claims) {
  assertAllowedProperties(tenancy, "subject.tenancy", [
    "platformTenant",
    "appTenantClaim",
    "defaultAppTenant",
  ]);
  const appTenantClaim = normalizeNonEmptyString(
    tenancy.appTenantClaim,
    "subject.tenancy.appTenantClaim",
  );
  if (!Object.hasOwn(claims, appTenantClaim)) {
    throw new Error(`subject.tenancy.appTenantClaim '${appTenantClaim}' must be a declared claim`);
  }
  return {
    platformTenant: normalizeNonEmptyString(
      tenancy.platformTenant,
      "subject.tenancy.platformTenant",
    ),
    appTenantClaim,
    defaultAppTenant: normalizeNonEmptyString(
      tenancy.defaultAppTenant,
      "subject.tenancy.defaultAppTenant",
    ),
  };
}

function normalizeSessionOverrides(overrides = {}, subject) {
  assertAllowedProperties(overrides, "sessionOverrides", ["roles", "tenants", "claims"]);
  const roles = normalizeStringSet(
    [...subject.roles, ...(overrides.roles ?? [])],
    "sessionOverrides.roles",
  );
  const tenants = normalizeStringSet(
    [subject.tenancy.defaultAppTenant, ...(overrides.tenants ?? [])],
    "sessionOverrides.tenants",
  );
  const claims = {};
  assertObject(overrides.claims ?? {}, "sessionOverrides.claims");
  for (const [claim, values] of Object.entries(overrides.claims ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!Object.hasOwn(subject.claims, claim)) {
      throw new Error(`sessionOverrides claim '${claim}' is not declared on ctx.user`);
    }
    claims[claim] = normalizeStringSet(values, `sessionOverrides.claims.${claim}`);
  }
  return {
    roles,
    tenants,
    claims,
  };
}

function normalizeGrantedCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new Error("grantedCapabilities must be an array");
  }
  return capabilities.map((capability, index) => {
    assertAllowedProperties(capability, `grantedCapabilities[${index}]`, [
      "port",
      "resource",
      "actions",
    ]);
    return {
      port: normalizeNonEmptyString(capability.port, `grantedCapabilities[${index}].port`),
      resource: normalizeNonEmptyString(
        capability.resource,
        `grantedCapabilities[${index}].resource`,
      ),
      actions: normalizeStringSet(
        capability.actions,
        `grantedCapabilities[${index}].actions`,
      ),
    };
  });
}

function freezeProvider(provider) {
  return deepFreeze(provider);
}

function normalizeProviderId(value, field) {
  const id = normalizeNonEmptyString(value, field);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`${field} must be lower-kebab-case`);
  }
  return id;
}

function normalizeJwtAlg(value, field) {
  const alg = normalizeNonEmptyString(value, field);
  if (alg.toLowerCase() === "none") {
    throw new Error(`${field} rejects alg:none`);
  }
  if (!/^[A-Z0-9-]+$/.test(alg)) {
    throw new Error(`${field} must be a registered uppercase JWT alg`);
  }
  return alg;
}

function providerIdFromIssuer(issuer) {
  return new URL(issuer).hostname.split(".").find(Boolean) ?? "oidc";
}

function defaultJwksUrl(issuer) {
  return `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
}

function normalizeHttpsUrl(value, field) {
  const raw = normalizeNonEmptyString(value, field);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${field} must use https:`);
  }
  if (url.pathname === "/" && !url.search && !url.hash) {
    return url.origin;
  }
  return url.href;
}

function normalizeStringSet(values, field) {
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array`);
  }
  return [...new Set(values.map((value, index) => {
    if (!isJsonString(value) || value.length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return value;
  }))].sort();
}

function quote(value) {
  return JSON.stringify(value);
}

function normalizeNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertObject(value, field) {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function assertAllowedProperties(value, field, allowedProperties) {
  assertObject(value, field);
  const allowed = new Set(allowedProperties);
  for (const property of Object.keys(value)) {
    if (!allowed.has(property)) {
      throw new Error(`${field} has unexpected property '${property}'`);
    }
  }
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
