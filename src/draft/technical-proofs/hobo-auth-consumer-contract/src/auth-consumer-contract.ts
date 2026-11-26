import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION = "hobo.auth.consumer-contract/v1";
export const AUTH_CONSUMER_CONTRACT_SCHEMA_ID =
  "https://hobo.dev/schemas/auth/consumer-contract.v1.json";
export const JWT_VERIFICATION_GAP = Object.freeze([
  "jwks",
  "jwt.alg",
  "issuer",
  "audience",
  "expiry",
  "revocation",
]);

const TOP_LEVEL_FIELDS = new Set([
  "port",
  "subject",
  "sessionOverrides",
  "grantedCapabilities",
  "canDeployGate",
]);

export function defineAuthConsumerContract(input) {
  assertObject(input, "auth consumer contract");
  if ("jwtVerification" in input) {
    throw new Error("JWT verification fields belong to the fixture IdP gate, not the auth contract");
  }
  assertAllowedProperties(input, "auth consumer contract", TOP_LEVEL_FIELDS);

  const port = assertLiteral(input.port, "port", "hobo:auth");
  const subject = normalizeSubject(input.subject);
  const sessionOverrides = normalizeSessionOverrides(input.sessionOverrides, subject);
  const grantedCapabilities = normalizeGrantedCapabilities(input.grantedCapabilities);
  const canDeployGate = normalizeCanDeployGate(input.canDeployGate);

  return deepFreeze({
    schemaVersion: AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION,
    port,
    subject,
    sessionOverrides,
    grantedCapabilities,
    canDeployGate,
    verificationBoundary: {
      devModeAsserts: [
        "principal-claim",
        "claims-claim",
        "roles",
        "tenancy",
        "scopes",
      ],
      notAssertedByContract: [...JWT_VERIFICATION_GAP],
      requiredGate: canDeployGate.fixtureIdpSuite,
    },
  });
}

export function generateDevPrincipalFixture(contract, overrides = {}) {
  const normalizedContract = ensureContract(contract);
  assertAllowedProperties(overrides, "session overrides", new Set(["roles", "tenant", "claims"]));

  const tenant = normalizeTenantOverride(normalizedContract, overrides.tenant);
  const claims = buildClaims(normalizedContract, tenant, overrides.claims ?? {});
  const roles = normalizeRoleOverrides(normalizedContract, overrides.roles ?? []);
  const scopes = [...normalizedContract.subject.requiredScopes];

  return {
    source: "contract-asserted-dev-principal",
    authPort: normalizedContract.port,
    contractDigest: contractDigest(normalizedContract),
    ctxUser: {
      kind: normalizedContract.subject.kind,
      id: claims[normalizedContract.subject.idClaim],
      roles,
      scopes,
      tenant: {
        platform: normalizedContract.subject.tenancy.platformTenant,
        app: tenant,
      },
      claims,
    },
  };
}

export function assertAuthFixtureSatisfiesContract(contract, fixture) {
  const normalizedContract = ensureContract(contract);
  assertObject(fixture, "fixture");
  if (fixture.source !== "contract-asserted-dev-principal") {
    throw new Error("fixture source must be contract-asserted-dev-principal");
  }
  if (fixture.authPort !== normalizedContract.port) {
    throw new Error("fixture authPort must match contract port");
  }
  if (fixture.contractDigest !== contractDigest(normalizedContract)) {
    throw new Error("fixture contract digest does not match auth contract");
  }

  const ctxUser = fixture.ctxUser;
  assertObject(ctxUser, "ctx.user");
  if (ctxUser.kind !== normalizedContract.subject.kind) {
    throw new Error("ctx.user kind does not satisfy auth contract");
  }
  assertClaimContract(normalizedContract, ctxUser.claims);
  assertIncludes(ctxUser.roles, normalizedContract.subject.requiredRoles, "role");
  assertIncludes(ctxUser.scopes, normalizedContract.subject.requiredScopes, "scope");
  if (ctxUser.tenant?.platform !== normalizedContract.subject.tenancy.platformTenant) {
    throw new Error("ctx.user platform tenant does not satisfy auth contract");
  }
  if (!normalizedContract.sessionOverrides.tenants.includes(ctxUser.tenant?.app)) {
    throw new Error("ctx.user app tenant is outside the auth contract");
  }
  return true;
}

export function canonicalDevContractBytes(contract) {
  return canonicalContractBytes(ensureContract(contract));
}

export function canonicalCanDeployContractBytes(contract) {
  return canonicalContractBytes(ensureContract(contract));
}

export function requireGrantedCapability(contract, fixture, call) {
  const normalizedContract = ensureContract(contract);
  assertAuthFixtureSatisfiesContract(normalizedContract, fixture);
  assertObject(call, "capability call");
  const port = assertNonEmptyString(call.port, "capability call port");
  const resource = assertNonEmptyString(call.resource, "capability call resource");
  const action = assertNonEmptyString(call.action, "capability call action");

  const granted = normalizedContract.grantedCapabilities.some(
    (capability) =>
      capability.port === port &&
      capability.resource === resource &&
      capability.actions.includes(action),
  );

  if (!granted) {
    throw new Error(
      `capability call denied by default: ${port}:${resource}.${action} is not linked or granted`,
    );
  }
  return true;
}

function ensureContract(contract) {
  if (contract?.schemaVersion === AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION) {
    return contract;
  }
  return defineAuthConsumerContract(contract);
}

function normalizeSubject(subject) {
  assertAllowedProperties(
    subject,
    "subject",
    new Set([
      "kind",
      "idClaim",
      "requiredClaims",
      "requiredRoles",
      "requiredScopes",
      "tenancy",
    ]),
  );
  const kind = assertLiteral(subject.kind, "subject.kind", "user");
  const idClaim = assertNonEmptyString(subject.idClaim, "subject.idClaim");
  const requiredClaims = normalizeRequiredClaims(subject.requiredClaims, idClaim);
  const requiredRoles = normalizeStringSet(subject.requiredRoles, "subject.requiredRoles");
  const requiredScopes = normalizeStringSet(subject.requiredScopes, "subject.requiredScopes");
  const tenancy = normalizeTenancy(subject.tenancy);

  return {
    kind,
    idClaim,
    requiredClaims,
    requiredRoles,
    requiredScopes,
    tenancy,
  };
}

function normalizeRequiredClaims(claims, idClaim) {
  assertObject(claims, "subject.requiredClaims");
  if (!Object.hasOwn(claims, idClaim)) {
    throw new Error(`subject.requiredClaims must include idClaim '${idClaim}'`);
  }

  const normalized = {};
  for (const [name, claim] of Object.entries(claims).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    assertObject(claim, `subject.requiredClaims.${name}`);
    if (claim.type === "string") {
      assertAllowedProperties(claim, `subject.requiredClaims.${name}`, new Set(["type"]));
      normalized[name] = { type: "string" };
      continue;
    }
    if (Array.isArray(claim.enum)) {
      assertAllowedProperties(claim, `subject.requiredClaims.${name}`, new Set(["enum"]));
      normalized[name] = { enum: normalizeStringSet(claim.enum, `subject.requiredClaims.${name}.enum`) };
      continue;
    }
    throw new Error(`claim '${name}' must declare type:string or enum`);
  }
  return normalized;
}

function normalizeTenancy(tenancy) {
  assertAllowedProperties(
    tenancy,
    "subject.tenancy",
    new Set(["platformTenant", "appTenantClaim", "defaultAppTenant"]),
  );
  return {
    platformTenant: assertNonEmptyString(
      tenancy.platformTenant,
      "subject.tenancy.platformTenant",
    ),
    appTenantClaim: assertNonEmptyString(
      tenancy.appTenantClaim,
      "subject.tenancy.appTenantClaim",
    ),
    defaultAppTenant: assertNonEmptyString(
      tenancy.defaultAppTenant,
      "subject.tenancy.defaultAppTenant",
    ),
  };
}

function normalizeSessionOverrides(overrides, subject) {
  assertAllowedProperties(
    overrides,
    "sessionOverrides",
    new Set(["roles", "tenants", "claims"]),
  );
  const roles = normalizeStringSet(
    [...subject.requiredRoles, ...(overrides.roles ?? [])],
    "sessionOverrides.roles",
  );
  const tenants = normalizeStringSet(
    [subject.tenancy.defaultAppTenant, ...(overrides.tenants ?? [])],
    "sessionOverrides.tenants",
  );
  const claims = {};
  assertObject(overrides.claims ?? {}, "sessionOverrides.claims");
  for (const [name, allowedValues] of Object.entries(overrides.claims ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!Object.hasOwn(subject.requiredClaims, name)) {
      throw new Error(`claim override '${name}' is not part of the auth contract`);
    }
    claims[name] = normalizeStringSet(allowedValues, `sessionOverrides.claims.${name}`);
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
  return capabilities
    .map((capability, index) => {
      assertAllowedProperties(
        capability,
        `grantedCapabilities[${index}]`,
        new Set(["port", "resource", "actions"]),
      );
      return {
        port: assertNonEmptyString(capability.port, `grantedCapabilities[${index}].port`),
        resource: assertNonEmptyString(
          capability.resource,
          `grantedCapabilities[${index}].resource`,
        ),
        actions: normalizeStringSet(
          capability.actions,
          `grantedCapabilities[${index}].actions`,
        ),
      };
    })
    .sort((left, right) => `${left.port}:${left.resource}`.localeCompare(`${right.port}:${right.resource}`));
}

function normalizeCanDeployGate(gate) {
  assertAllowedProperties(gate, "canDeployGate", new Set(["fixtureIdpSuite"]));
  return {
    fixtureIdpSuite: assertNonEmptyString(gate.fixtureIdpSuite, "canDeployGate.fixtureIdpSuite"),
  };
}

function normalizeTenantOverride(contract, override) {
  const tenant = override ?? contract.subject.tenancy.defaultAppTenant;
  assertNonEmptyString(tenant, "session tenant override");
  if (!contract.sessionOverrides.tenants.includes(tenant)) {
    throw new Error(`tenant override '${tenant}' is outside the auth contract`);
  }
  return tenant;
}

function normalizeRoleOverrides(contract, roleOverrides) {
  const overrides = normalizeStringSet(roleOverrides, "session role overrides");
  for (const role of overrides) {
    if (!contract.sessionOverrides.roles.includes(role)) {
      throw new Error(`role override '${role}' is outside the auth contract`);
    }
  }
  return normalizeStringSet(
    [...contract.subject.requiredRoles, ...overrides],
    "ctx.user.roles",
  );
}

function buildClaims(contract, tenant, overrides) {
  assertObject(overrides, "session claim overrides");
  const claims = {};
  for (const [name, claim] of Object.entries(contract.subject.requiredClaims)) {
    const value = Object.hasOwn(overrides, name)
      ? normalizeClaimOverride(contract, name, overrides[name])
      : defaultClaimValue(name, claim);
    claims[name] = value;
  }
  claims[contract.subject.tenancy.appTenantClaim] = tenant;
  return claims;
}

function normalizeClaimOverride(contract, name, value) {
  const allowedValues = contract.sessionOverrides.claims[name];
  if (!allowedValues) {
    throw new Error(`claim override '${name}' is outside the auth contract`);
  }
  if (!allowedValues.includes(value)) {
    throw new Error(`claim override '${name}' value '${value}' is outside the auth contract`);
  }
  return value;
}

function defaultClaimValue(name, claim) {
  if (name === "sub") {
    return "fixture-user";
  }
  if (name === "email") {
    return "fixture@example.test";
  }
  if (claim.enum) {
    return claim.enum[0];
  }
  return `${name}-fixture`;
}

function assertClaimContract(contract, claims) {
  assertObject(claims, "ctx.user.claims");
  for (const [name, claim] of Object.entries(contract.subject.requiredClaims)) {
    const value = claims[name];
    if (claim.type === "string") {
      if (!isJsonString(value) || value.length === 0) {
        throw new Error(`claim '${name}' must be a string`);
      }
      continue;
    }
    if (!claim.enum.includes(value)) {
      throw new Error(`claim '${name}' must be one of ${claim.enum.join(", ")}`);
    }
  }
}

function assertIncludes(actualValues, requiredValues, label) {
  const actual = new Set(normalizeStringSet(actualValues, `ctx.user.${label}s`));
  for (const required of requiredValues) {
    if (!actual.has(required)) {
      throw new Error(`ctx.user ${label} '${required}' is required by the auth contract`);
    }
  }
}

function canonicalContractBytes(contract) {
  return canonicalJson(contract);
}

function contractDigest(contract) {
  return `sha256:${createHash("sha256").update(canonicalContractBytes(contract)).digest("hex")}`;
}

function canonicalJson(value) {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortForJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortForJson(value[key])]),
    );
  }
  return value;
}

function normalizeStringSet(values, field) {
  if (!Array.isArray(values)) {
    throw new Error(`${field} must be an array`);
  }
  const normalized = [...new Set(values.map((value, index) => {
    if (!isJsonString(value) || value.length === 0) {
      throw new Error(`${field}[${index}] must be a non-empty string`);
    }
    return value;
  }))].sort();
  return normalized;
}

function assertLiteral(value, field, expected) {
  if (value !== expected) {
    throw new Error(`${field} must be ${expected}`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function assertObject(value, field) {
  if (!isJsonObject(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function assertAllowedProperties(value, field, allowedProperties) {
  assertObject(value, field);
  for (const property of Object.keys(value)) {
    if (!allowedProperties.has(property)) {
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
