import { isJsonString, isJsonObject } from "./json.js";
const FLOW_PREFERENCE = ["oauth2-xaa", "oauth2-obo", "mcp-oauth2.1"];

export function createConnectorBinding(name, authJson, options = {}) {
  if (!name || !isJsonString(name)) {
    throw new TypeError("connector name must be a non-empty string");
  }

  const flow = selectExternalAppFlow(authJson);
  const operationScopes = normalizeOperations(flow);
  const declaredAllow = options.declaredAllow
    ? validateScopes(options.declaredAllow, flow.scopes, "allow")
    : undefined;

  const binding = {
    name,
    flow,
    via: flow.type === "oauth2-xaa" ? "xaa" : flow.type,
    advertisedScopes: Object.freeze([...flow.scopes]),
    operationScopes: Object.freeze({ ...operationScopes }),
    declaredAllow: declaredAllow ? Object.freeze([...declaredAllow]) : undefined,
    allow: (...scopes) => createConnectorBinding(name, authJson, { ...options, declaredAllow: scopes }),
    call: (operation, input) => {
      const scope = operationScopes[operation];
      if (!scope) {
        throw new Error(`Operation ${operation} is not advertised by ${name}`);
      }
      return Object.freeze({ target: name, operation, input, scope });
    },
  };

  return Object.freeze({
    ...binding,
    client: Object.freeze(buildClient(operationScopes, binding.call)),
  });
}

export function buildConnectorManifestEntry(binding, observedOperations = []) {
  const observedScopes = inferObservedScopes(binding, observedOperations);
  const allow = binding.declaredAllow ? [...binding.declaredAllow] : observedScopes;
  const usageExceedsDeclaredAllow = binding.declaredAllow
    ? observedScopes.some((scope) => !binding.declaredAllow.includes(scope))
    : false;

  return Object.freeze({
    type: "connector.v1",
    via: binding.via,
    audience: binding.flow.audience,
    onBehalfOf: "user",
    allow,
    observedScopes,
    declaredAllow: binding.declaredAllow ? [...binding.declaredAllow] : undefined,
    requestedScopeSource: binding.declaredAllow ? "declared-narrowing" : "usage-inferred",
    usageContract: Object.freeze({
      compareObservedUsage: Boolean(binding.declaredAllow),
      usageExceedsDeclaredAllow,
    }),
    fallbackFrom: binding.flow.type === "oauth2-xaa" ? undefined : "oauth2-xaa",
  });
}

export function generateConnectorClientDeclaration(binding) {
  const groups = groupOperations(binding.operationScopes);
  const groupLines = Object.entries(groups).map(([resource, operations]) => {
    const methods = Object.entries(operations)
      .map(
        ([method, scope]) =>
          `    ${method}(input: unknown): ConnectorCall<"${scope}">;`
      )
      .join("\n");

    return `  readonly ${resource}: {\n${methods}\n  };`;
  });

  return [
    `export type ConnectorCall<Scope extends string> = { readonly scope: Scope };`,
    `export interface ${pascalCase(binding.name)}Client {`,
    ...groupLines,
    `}`,
  ].join("\n");
}

export function selectExternalAppFlow(authJson) {
  if (!authJson || !Array.isArray(authJson.flows)) {
    throw new TypeError("auth.json must contain flows[]");
  }

  for (const type of FLOW_PREFERENCE) {
    const flow = authJson.flows.find((candidate) => candidate.type === type);
    if (flow) {
      return normalizeFlow(flow);
    }
  }

  throw new Error("auth.json does not advertise a supported external-dependency auth flow");
}

function normalizeFlow(flow) {
  const scopes = validateScopeList(flow.scopes ?? [], "scopes");
  const audience = isJsonString(flow.audience) && flow.audience.length > 0
    ? flow.audience
    : undefined;

  if (flow.type === "oauth2-xaa" && !audience) {
    throw new Error("oauth2-xaa flow must advertise an audience");
  }

  if (flow.type === "oauth2-xaa" && flow.idJag !== true) {
    throw new Error("oauth2-xaa flow must advertise idJag: true");
  }

  return Object.freeze({
    type: flow.type,
    idJag: Boolean(flow.idJag),
    audience,
    scopes: Object.freeze(scopes),
    operations: Object.freeze({ ...flow.operations }),
  });
}

function normalizeOperations(flow) {
  const entries = Object.entries(flow.operations);
  const operationScopes = {};

  for (const [operation, descriptor] of entries) {
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(operation)) {
      throw new Error(`Invalid connector operation name: ${operation}`);
    }

    const scope = descriptor?.scope;
    validateScopes([scope], flow.scopes, `operation ${operation}`);
    operationScopes[operation] = scope;
  }

  return operationScopes;
}

function buildClient(operationScopes, call) {
  const client = {};

  for (const operation of Object.keys(operationScopes)) {
    const parts = operation.split(".");
    let cursor = client;

    for (const part of parts.slice(0, -1)) {
      cursor[part] ??= {};
      cursor = cursor[part];
    }

    cursor[parts.at(-1)] = (input) => call(operation, input);
  }

  return deepFreeze(client);
}

function inferObservedScopes(binding, observedOperations) {
  const scopes = new Set();
  for (const operation of observedOperations) {
    const scope = binding.operationScopes[operation];
    if (!scope) {
      throw new Error(`Observed operation ${operation} is not advertised by ${binding.name}`);
    }
    scopes.add(scope);
  }
  return [...scopes].sort();
}

function groupOperations(operationScopes) {
  const grouped = {};

  for (const [operation, scope] of Object.entries(operationScopes).sort()) {
    const [resource, method] = operation.split(".");
    grouped[resource] ??= {};
    grouped[resource][method] = scope;
  }

  return grouped;
}

function validateScopeList(scopes, context) {
  if (!Array.isArray(scopes)) {
    throw new Error(`${context} must be an array`);
  }

  for (const scope of scopes) {
    if (!isJsonString(scope) || !/^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/.test(scope)) {
      throw new Error(`Invalid scope in ${context}: ${scope}`);
    }
  }

  return [...new Set(scopes)].sort();
}

function validateScopes(scopes, advertisedScopes, context) {
  const normalized = validateScopeList(scopes, context);
  const advertised = new Set(advertisedScopes);

  for (const scope of normalized) {
    if (!advertised.has(scope)) {
      throw new Error(`${context} contains scope not advertised by auth.json: ${scope}`);
    }
  }

  return normalized;
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && isJsonObject(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

function pascalCase(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}
