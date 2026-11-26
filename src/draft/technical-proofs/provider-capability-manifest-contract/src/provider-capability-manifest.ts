import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const CAPABILITY_MANIFEST_SCHEMA = "hobo.capability-manifest/v1";
export const CAPABILITIES_SCHEMA = "hobo.capabilities/v1";
export const AUTH_SCHEMA = "hobo.provider-auth/v1";
export const COST_SCHEMA = "hobo.cost/v1";

const STABILITY = new Set(["stable", "preview", "experimental", "deprecated"]);
const AUTH_MODES = new Set(["brokered-oidc", "svid-federation"]);

export function createFixtureProvider({
  id = "fixture-local-provider",
  regions = ["us-east-1", "us-west-2"],
  capabilities = defaultCapabilities()
} = {}) {
  const servedRegions = [...regions];
  const provider = {
    id,
    kind: "cloud-provider",
    package: `@hobo/${id}`,
    version: "0.1.0"
  };

  return {
    id,
    servedRegions,
    conformanceReport: {
      schema: "hobo.conformance-summary/v1",
      providerId: id,
      suite: "@hobo/conformance/provider-capability-manifest",
      suiteVersion: "0.1.0",
      capabilities: capabilities.map((capability) => ({
        port: capability.port,
        features: [...capability.features],
        reportRef: digestRef(`conformance:${id}:${capability.port}:${capability.features.join(",")}`)
      }))
    },
    capabilityManifest() {
      return sortKeys({
        schema: CAPABILITY_MANIFEST_SCHEMA,
        provider,
        publishedAt: "2026-06-25T00:00:00Z",
        regions: [...regions],
        capabilities: capabilities.map((capability) => sortKeys({
          ...capability,
          features: [...capability.features],
          regions: [...(capability.regions ?? regions)]
        })),
        auth: {
          schema: AUTH_SCHEMA,
          mode: "svid-federation",
          tokenAudience: `spiffe://hobo/providers/${id}`,
          broker: {
            issuer: "https://identity.hobo.local",
            tokenExchange: "urn:ietf:params:oauth:grant-type:token-exchange"
          },
          requiredClaims: ["sub", "aud", "exp", "scope"]
        },
        cost: {
          schema: COST_SCHEMA,
          currency: "USD",
          facts: [
            {
              sku: "runner.minutes",
              unit: "minute",
              marginalPrice: "0.0000",
              freeTier: {
                unit: "minute",
                included: 10000,
                reset: "monthly"
              },
              source: {
                type: "declared-provider",
                documentRef: digestRef(`cost:${id}:runner.minutes`),
                signedAt: "2026-06-25T00:00:00Z"
              }
            }
          ]
        }
      });
    }
  };
}

export function validateCapabilityManifest(manifest, {
  conformance = null,
  servedRegions = []
} = {}) {
  const errors = [];

  if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be an object"], manifest: null };
  }
  if (manifest.schema !== CAPABILITY_MANIFEST_SCHEMA) {
    errors.push(`schema must be ${CAPABILITY_MANIFEST_SCHEMA}`);
  }

  validateProvider(manifest.provider, errors);
  validateStringArray(manifest.regions, "regions", errors);

  const providerId = manifest.provider?.id ?? "<unknown>";
  const served = new Set(servedRegions);
  for (const region of manifest.regions ?? []) {
    if (served.size > 0 && !served.has(region)) {
      errors.push(`region ${region} is not served by provider ${providerId}`);
    }
  }

  const conformanceCoverage = buildCoverage(conformance);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    errors.push("capabilities must be a non-empty array");
  } else {
    manifest.capabilities.forEach((capability, index) => {
      validateCapability(capability, index, errors, served, providerId);
      if (!isCapabilityCovered(capability, conformanceCoverage)) {
        errors.push(`capability ${String(capability?.port)} is not covered by conformance`);
      }
    });
  }

  validateAuth(manifest.auth, errors);
  validateCost(manifest.cost, errors);

  return {
    ok: errors.length === 0,
    errors,
    manifest: errors.length === 0 ? sortKeys(manifest) : null
  };
}

export function serializeWellKnownManifest(manifest) {
  const providerId = manifest.provider.id;
  const capabilitiesDocument = {
    schema: CAPABILITIES_SCHEMA,
    providerId,
    capabilities: manifest.capabilities
  };
  const authDocument = {
    ...manifest.auth,
    providerId
  };
  const costDocument = {
    ...manifest.cost,
    providerId
  };
  const documents = [
    {
      path: "/.well-known/capability-manifest/capabilities.json",
      schema: CAPABILITIES_SCHEMA,
      digest: stableDigest(capabilitiesDocument)
    },
    {
      path: "/.well-known/capability-manifest/auth.json",
      schema: AUTH_SCHEMA,
      digest: stableDigest(authDocument)
    },
    {
      path: "/.well-known/capability-manifest/cost.json",
      schema: COST_SCHEMA,
      digest: stableDigest(costDocument)
    }
  ];
  const indexDocument = {
    schema: "hobo.capability-manifest-index/v1",
    providerId,
    manifestSchema: manifest.schema,
    documents
  };

  return {
    "/.well-known/capability-manifest/index.json": canonicalJson(indexDocument),
    "/.well-known/capability-manifest/capabilities.json": canonicalJson(capabilitiesDocument),
    "/.well-known/capability-manifest/auth.json": canonicalJson(authDocument),
    "/.well-known/capability-manifest/cost.json": canonicalJson(costDocument)
  };
}

export function negotiateCapability({
  manifest,
  request,
  registry = []
}) {
  const required = request?.require;
  const providerId = manifest?.provider?.id;
  const missing = missingFeatures(manifest, required);
  if (missing.length === 0) {
    return {
      ok: true,
      providerId,
      capability: required.port,
      warnings: []
    };
  }

  return {
    ok: false,
    providerId,
    reason: {
      code: "capability.unsupported",
      message: `provider ${providerId} ${required.port} requires ${missing.join(", ")} but the manifest does not advertise it`
    },
    remediation: findRemediation(registry, required)
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function defaultCapabilities() {
  return [
    {
      port: "hobo:runner",
      interface: "hobo:runner/job",
      version: "0.1.0",
      stability: "preview",
      features: ["ci-job"],
      regions: ["us-east-1", "us-west-2"]
    },
    {
      port: "hobo:build-machine",
      interface: "hobo:build-machine/host",
      version: "0.1.0",
      stability: "preview",
      features: ["wasm-component-build", "remote-cache"],
      regions: ["us-east-1", "us-west-2"]
    }
  ];
}

function validateProvider(provider, errors) {
  if (!provider || !isJsonObject(provider) || Array.isArray(provider)) {
    errors.push("provider must be an object");
    return;
  }
  for (const field of ["id", "kind", "package", "version"]) {
    if (!isNonEmptyString(provider[field])) {
      errors.push(`provider.${field} must be a non-empty string`);
    }
  }
}

function validateCapability(capability, index, errors, served, providerId) {
  const path = `capabilities.${index}`;
  if (!capability || !isJsonObject(capability) || Array.isArray(capability)) {
    errors.push(`${path} must be an object`);
    return;
  }

  for (const field of ["port", "interface", "version"]) {
    if (!isNonEmptyString(capability[field])) {
      errors.push(`${path}.${field} must be a non-empty string`);
    }
  }
  if (!STABILITY.has(capability.stability)) {
    errors.push(`${path}.stability must be one of ${[...STABILITY].join(", ")}`);
  }
  validateStringArray(capability.features, `${path}.features`, errors);
  validateStringArray(capability.regions, `${path}.regions`, errors);
  for (const region of capability.regions ?? []) {
    if (served.size > 0 && !served.has(region)) {
      errors.push(`region ${region} is not served by provider ${providerId}`);
    }
  }
}

function validateAuth(auth, errors) {
  if (!auth || !isJsonObject(auth) || Array.isArray(auth)) {
    errors.push("auth must be an object");
    return;
  }
  if (auth.schema !== AUTH_SCHEMA) {
    errors.push(`auth.schema must be ${AUTH_SCHEMA}`);
  }
  if (!AUTH_MODES.has(auth.mode)) {
    errors.push("auth.mode must be brokered-oidc or svid-federation");
  }
  if (!isNonEmptyString(auth.tokenAudience)) {
    errors.push("auth.tokenAudience must be a non-empty string");
  }
  if ("staticKey" in auth || "clientSecret" in auth) {
    errors.push("auth must not publish static secrets");
  }
}

function validateCost(cost, errors) {
  if (!cost || !isJsonObject(cost) || Array.isArray(cost)) {
    errors.push("cost must be an object");
    return;
  }
  if (cost.schema !== COST_SCHEMA) {
    errors.push(`cost.schema must be ${COST_SCHEMA}`);
  }
  if (!isNonEmptyString(cost.currency)) {
    errors.push("cost.currency must be a non-empty string");
  }
  if (!Array.isArray(cost.facts) || cost.facts.length === 0) {
    errors.push("cost.facts must be a non-empty array");
    return;
  }

  cost.facts.forEach((fact, index) => {
    const path = `cost.facts.${index}`;
    for (const field of ["sku", "unit", "marginalPrice"]) {
      if (!isNonEmptyString(fact?.[field])) {
        errors.push(`${path}.${field} must be a non-empty string`);
      }
    }
    if (!isJsonNumber(fact?.freeTier?.included)) {
      errors.push(`${path}.freeTier.included must be a number`);
    }
    if (fact?.source?.type !== "declared-provider") {
      errors.push(`${path}.source.type must be declared-provider`);
    }
    if (!isNonEmptyString(fact?.source?.documentRef?.digest)) {
      errors.push(`${path}.source.documentRef.digest must be a non-empty string`);
    }
    if (!isNonEmptyString(fact?.source?.signedAt)) {
      errors.push(`${path}.source.signedAt must be a non-empty string`);
    }
  });
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      errors.push(`${path}.${index} must be a non-empty string`);
    }
  });
}

function buildCoverage(conformance) {
  const coverage = new Map();
  for (const capability of conformance?.capabilities ?? []) {
    coverage.set(capability.port, new Set(capability.features ?? []));
  }
  return coverage;
}

function isCapabilityCovered(capability, coverage) {
  if (coverage.size === 0) return false;
  const features = coverage.get(capability?.port);
  if (!features) return false;
  return (capability.features ?? []).every((feature) => features.has(feature));
}

function missingFeatures(manifest, required) {
  if (!required?.port || !Array.isArray(required.features)) {
    return ["<invalid-request>"];
  }
  const capability = manifest.capabilities.find((candidate) => candidate.port === required.port);
  const advertised = new Set(capability?.features ?? []);
  return required.features.filter((feature) => !advertised.has(feature));
}

function findRemediation(registry, required) {
  for (const candidate of registry) {
    const missing = missingFeatures(candidate, required);
    if (missing.length === 0) {
      return {
        action: "choose-provider",
        providerId: candidate.provider.id,
        port: required.port,
        satisfies: [...required.features]
      };
    }
  }
  return {
    action: "change-requirement",
    port: required.port,
    satisfies: []
  };
}

function digestRef(seed) {
  const digest = `sha256:${createHash("sha256").update(seed).digest("hex")}`;
  return {
    mediaType: "application/vnd.hobo.evidence.v1+json",
    uri: `oci://registry.example/hobo/evidence@${digest}`,
    digest
  };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
