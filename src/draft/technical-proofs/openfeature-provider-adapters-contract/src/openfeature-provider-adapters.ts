import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
const valueTypes = Object.freeze({
  boolean: (value) => isJsonBoolean(value),
  string: (value) => isJsonString(value),
  number: (value) => isJsonNumber(value) && Number.isFinite(value),
  object: (value) => value !== null && isJsonObject(value) && isJsonSerializable(value)
});

const providerKinds = new Set(["flagd", "launchdarkly", "unleash"]);

export function createOpenFeatureAdapter({
  providerKind,
  client,
  timeoutMs = 100,
  hoboDefinedFlagKeys = [],
  vendorFlagKeys
} = {}) {
  assertProviderKind(providerKind);
  if (!client || !(client.resolve instanceof Function)) {
    throw new TypeError(`${providerKind} adapter requires a client.resolve function`);
  }
  detectFlagKeyCollisions({
    providerKind,
    hoboDefinedFlagKeys,
    vendorFlagKeys: vendorFlagKeys ?? (client.listFlagKeys instanceof Function ? client.listFlagKeys() : [])
  });

  return {
    providerKind,

    getBooleanValue: async (flagKey, defaultValue, context) =>
      (await evaluate({ providerKind, client, timeoutMs, valueType: "boolean", flagKey, defaultValue, context })).value,
    getBooleanDetails: (flagKey, defaultValue, context) =>
      evaluate({ providerKind, client, timeoutMs, valueType: "boolean", flagKey, defaultValue, context }),

    getStringValue: async (flagKey, defaultValue, context) =>
      (await evaluate({ providerKind, client, timeoutMs, valueType: "string", flagKey, defaultValue, context })).value,
    getStringDetails: (flagKey, defaultValue, context) =>
      evaluate({ providerKind, client, timeoutMs, valueType: "string", flagKey, defaultValue, context }),

    getNumberValue: async (flagKey, defaultValue, context) =>
      (await evaluate({ providerKind, client, timeoutMs, valueType: "number", flagKey, defaultValue, context })).value,
    getNumberDetails: (flagKey, defaultValue, context) =>
      evaluate({ providerKind, client, timeoutMs, valueType: "number", flagKey, defaultValue, context }),

    getObjectValue: async (flagKey, defaultValue, context) =>
      (await evaluate({ providerKind, client, timeoutMs, valueType: "object", flagKey, defaultValue, context })).value,
    getObjectDetails: (flagKey, defaultValue, context) =>
      evaluate({ providerKind, client, timeoutMs, valueType: "object", flagKey, defaultValue, context })
  };
}

export function createProviderRegistry(providers) {
  return {
    get(providerId) {
      const provider = providers?.[providerId];
      if (!provider) {
        throw new Error(`no feature-flag provider registered for ${providerId}`);
      }
      return provider;
    }
  };
}

export function createCampFeatureFlagEvaluator({
  camp,
  matching,
  registry,
  defaultProvider = "builtIn"
}) {
  const providerId =
    matching?.camps?.[camp]?.featureFlagProvider ??
    matching?.defaultFeatureFlagProvider ??
    defaultProvider;
  const provider = registry?.get instanceof Function ? registry.get(providerId) : registry?.[providerId];

  if (!provider) {
    throw new Error(`Matching selected missing feature-flag provider ${providerId} for Camp ${camp}`);
  }

  return {
    providerId,
    getBooleanValue: provider.getBooleanValue?.bind(provider),
    getBooleanDetails: provider.getBooleanDetails.bind(provider),
    getStringValue: provider.getStringValue?.bind(provider),
    getStringDetails: provider.getStringDetails.bind(provider),
    getNumberValue: provider.getNumberValue?.bind(provider),
    getNumberDetails: provider.getNumberDetails.bind(provider),
    getObjectValue: provider.getObjectValue?.bind(provider),
    getObjectDetails: provider.getObjectDetails.bind(provider)
  };
}

export function createFixtureVendorProvider(providerKind, flags) {
  assertProviderKind(providerKind);

  return {
    providerKind,

    listFlagKeys() {
      return Object.keys(flags ?? {});
    },

    async resolve({ flagKey, valueType, defaultValue, context }) {
      const flag = flags?.[flagKey];

      if (!flag) {
        return defaultResponse(flagKey, defaultValue);
      }
      if (!matchesTargeting(providerKind, flag.targeting ?? [], context)) {
        return defaultResponse(flagKey, defaultValue);
      }

      return {
        flagKey,
        value: cloneJson(flag.value),
        reason: flag.targeting?.length > 0 ? "targeting-match" : "static",
        variant: flag.variant ?? (flag.valueType === "boolean" && flag.value === true ? "on" : "selected"),
        valueType
      };
    }
  };
}

export function mapPrincipalRefToProviderContext(providerKind, hoboContext = {}) {
  assertProviderKind(providerKind);

  const user = hoboContext.user;
  const identity = hoboContext.identity;
  const userClaims = claimsToAttributes(user?.claims);
  const identityClaims = claimsToAttributes(identity?.claims);
  const looseAttributes = claimsToAttributes(hoboContext.attributes);
  const tenant = user?.tenant ?? identity?.tenant;

  switch (providerKind) {
    case "flagd":
      return {
        targetingKey: user?.id ?? identity?.id ?? "anonymous",
        kind: user?.kind ?? identity?.kind ?? "anonymous",
        attributes: compactObject({
          tenant,
          identityKey: identity?.id,
          identityKind: identity?.kind,
          ...userClaims,
          ...identityClaims,
          ...looseAttributes
        })
      };
    case "launchdarkly":
      return {
        kind: "multi",
        user: compactObject({
          key: user?.id ?? "anonymous",
          kind: user?.kind ?? "user",
          tenant: user?.tenant ?? tenant,
          ...userClaims
        }),
        service: compactObject({
          key: identity?.id ?? "anonymous-service",
          kind: identity?.kind ?? "service",
          tenant: identity?.tenant ?? tenant,
          ...identityClaims
        }),
        custom: compactObject({
          ...looseAttributes
        })
      };
    case "unleash":
      return {
        userId: user?.id ?? "anonymous",
        sessionId: identity?.id ?? user?.id ?? "anonymous",
        properties: compactObject({
          tenant,
          userKind: user?.kind,
          identityKind: identity?.kind,
          ...userClaims,
          ...identityClaims,
          ...looseAttributes
        })
      };
    default:
      throw new Error(`unsupported OpenFeature provider ${providerKind}`);
  }
}

export function detectFlagKeyCollisions({ providerKind, hoboDefinedFlagKeys = [], vendorFlagKeys = [] }) {
  const hoboKeys = new Set(hoboDefinedFlagKeys);
  const collisions = vendorFlagKeys.filter((key) => hoboKeys.has(key));

  if (collisions.length > 0) {
    throw new Error(`${providerKind} flag key collision: ${collisions.sort().join(", ")}`);
  }

  return [];
}

async function evaluate({ providerKind, client, timeoutMs, valueType, flagKey, defaultValue, context }) {
  const providerContext = mapPrincipalRefToProviderContext(providerKind, context);

  try {
    const response = await withTimeout(
      client.resolve({
        flagKey,
        valueType,
        defaultValue: cloneJson(defaultValue),
        context: providerContext
      }),
      timeoutMs,
      providerKind,
      flagKey
    );

    if (!valueTypes[valueType](response?.value)) {
      return errorResponse({
        flagKey,
        defaultValue,
        code: "provider-type-mismatch",
        message: `${providerKind} returned non-${valueType} value for ${flagKey}`
      });
    }

    return {
      flagKey: response.flagKey ?? flagKey,
      value: cloneJson(response.value),
      reason: response.reason ?? "static",
      variant: response.variant
    };
  } catch (cause) {
    return errorResponse({
      flagKey,
      defaultValue,
      code: cause?.code === "provider-timeout" ? "provider-timeout" : "provider-error",
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

async function withTimeout(promise, timeoutMs, providerKind, flagKey) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${providerKind} timed out resolving ${flagKey}`);
      error.code = "provider-timeout";
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function defaultResponse(flagKey, defaultValue) {
  return {
    flagKey,
    value: cloneJson(defaultValue),
    reason: "default",
    variant: "default"
  };
}

function errorResponse({ flagKey, defaultValue, code, message }) {
  return {
    flagKey,
    value: cloneJson(defaultValue),
    reason: "error",
    variant: "default",
    error: { code, message }
  };
}

function matchesTargeting(providerKind, rules, providerContext) {
  return rules.every((rule) => {
    const actual = readProviderAttribute(providerKind, providerContext, rule.attribute);

    switch (rule.op) {
      case "equals":
        return sameValue(actual, rule.value);
      case "notEquals":
        return !sameValue(actual, rule.value);
      case "in":
        return Array.isArray(rule.value) && rule.value.some((value) => sameValue(actual, value));
      case "exists":
        return actual !== undefined;
      default:
        return false;
    }
  });
}

function readProviderAttribute(providerKind, providerContext, attribute) {
  switch (providerKind) {
    case "flagd":
      return attribute === "targetingKey"
        ? providerContext.targetingKey
        : providerContext.attributes?.[attribute];
    case "launchdarkly":
      return (
        providerContext.user?.[attribute] ??
        providerContext.service?.[attribute] ??
        providerContext.custom?.[attribute]
      );
    case "unleash":
      if (attribute === "userId") {
        return providerContext.userId;
      }
      if (attribute === "sessionId") {
        return providerContext.sessionId;
      }
      return providerContext.properties?.[attribute];
    default:
      return undefined;
  }
}

function claimsToAttributes(claims = []) {
  return Object.fromEntries(
    claims.map((claim) => [claim.key, normalizeClaimValue(claim.value)])
  );
}

function normalizeClaimValue(value) {
  if (value && isJsonObject(value) && "tag" in value && "val" in value) {
    return value.val;
  }
  return value;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function isJsonSerializable(value) {
  if (value === null) {
    return true;
  }
  if (isJsonBoolean(value) || isJsonString(value)) {
    return true;
  }
  if (isJsonNumber(value)) {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonSerializable);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonSerializable);
  }
  return false;
}

function assertProviderKind(providerKind) {
  if (!providerKinds.has(providerKind)) {
    throw new Error(`unsupported OpenFeature provider ${providerKind}`);
  }
}
