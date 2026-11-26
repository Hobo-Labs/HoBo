import { buildConnectorManifestEntry } from "../../../../technical-proofs/connector-authoring-contract/src/connector-authoring.mjs";
import { isJsonString, isJsonObject } from "./json.js";


const CONNECTOR_DECLARATION =
  /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.\s*)?connector\s*\(\s*["']([A-Za-z][A-Za-z0-9_-]*)["']\s*\)/g;
const STATIC_CONNECTOR_CALL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*){2,})\s*\(/g;
const DYNAMIC_CONNECTOR_CALL =
  /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*((?:\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\[\s*[^\]]+\s*\]\s*\(/g;

export function inferConnectorScopes({ sourceText, bindings, fileName = "bindle.ts" }) {
  if (!isJsonString(sourceText)) {
    throw new TypeError("sourceText must be a string");
  }
  if (!bindings || !isJsonObject(bindings) || Array.isArray(bindings)) {
    throw new TypeError("bindings must be an object keyed by connector target");
  }

  const lineStarts = findLineStarts(sourceText);
  const declarations = findConnectorDeclarations(sourceText);
  const aliasToTarget = declarations.size > 0
    ? declarations
    : new Map(Object.keys(bindings).map((target) => [target, target]));
  const diagnostics = [];
  const observedOperations = [];
  const operationsByTarget = new Map(
    Object.keys(bindings).map((target) => [target, new Set()]),
  );

  for (const dynamic of findDynamicCalls(sourceText, aliasToTarget, lineStarts)) {
    diagnostics.push(dynamicOperationDiagnostic(dynamic));
  }

  for (const call of findStaticCalls(sourceText, aliasToTarget, lineStarts)) {
    const binding = bindings[call.target];
    if (!binding) {
      diagnostics.push(missingBindingDiagnostic(call));
      continue;
    }

    const scope = binding.operationScopes?.[call.operation];
    if (!scope) {
      diagnostics.push(unadvertisedOperationDiagnostic(call));
      continue;
    }

    if (!new Set(binding.advertisedScopes ?? []).has(scope)) {
      diagnostics.push(unadvertisedScopeDiagnostic({ ...call, scope }));
      continue;
    }

    operationsByTarget.get(call.target)?.add(call.operation);
    observedOperations.push({
      target: call.target,
      operation: call.operation,
      scope,
      line: call.line,
      onBehalfOf: "user",
    });
  }

  const connectors = {};
  const contractFailures = [];

  for (const [target, binding] of Object.entries(bindings)) {
    const operations = [...(operationsByTarget.get(target) ?? [])].sort();
    const entry = buildEntry(binding, operations);
    connectors[target] = entry;

    if (entry.usageContract?.usageExceedsDeclaredAllow) {
      contractFailures.push({
        code: "xaa.scope.exceeds-declared-allow",
        severity: "error",
        target,
        allowedScopes: [...entry.allow],
        observedScopes: [...entry.observedScopes],
        message: `connector ${target} observes scopes outside declared .allow().`,
      });
    }
  }

  const manifest = {
    schema: "hobo.manifest/v1",
    connectors,
  };

  return Object.freeze({
    ok: diagnostics.length === 0 && contractFailures.length === 0,
    fileName,
    observedOperations: Object.freeze(observedOperations),
    diagnostics: Object.freeze(diagnostics),
    contractFailures: Object.freeze(contractFailures),
    manifest: deepFreeze(manifest),
  });
}

function findConnectorDeclarations(sourceText) {
  const declarations = new Map();

  for (const match of sourceText.matchAll(CONNECTOR_DECLARATION)) {
    declarations.set(match[1], match[2]);
  }

  return declarations;
}

function findStaticCalls(sourceText, aliasToTarget, lineStarts) {
  const calls = [];

  for (const match of sourceText.matchAll(STATIC_CONNECTOR_CALL)) {
    const alias = match[1];
    const target = aliasToTarget.get(alias);
    if (!target) {
      continue;
    }

    const segments = match[2]
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const operation = segments.join(".");
    const line = lineAt(lineStarts, match.index);

    if (operation === "allow" || operation.startsWith("connection.")) {
      continue;
    }

    calls.push({ target, operation, line });
  }

  return calls;
}

function findDynamicCalls(sourceText, aliasToTarget, lineStarts) {
  const calls = [];

  for (const match of sourceText.matchAll(DYNAMIC_CONNECTOR_CALL)) {
    const alias = match[1];
    const target = aliasToTarget.get(alias);
    if (!target) {
      continue;
    }

    const segments = match[2]
      .split(".")
      .map((segment) => segment.trim())
      .filter(Boolean);
    calls.push({
      target,
      operationPrefix: segments.join(".") || "(root)",
      line: lineAt(lineStarts, match.index),
    });
  }

  return calls;
}

function buildEntry(binding, operations) {
  if (binding.allow instanceof Function) {
    return buildConnectorManifestEntry(binding, operations);
  }

  const observedScopes = [
    ...new Set(operations.map((operation) => binding.operationScopes[operation])),
  ].sort();
  return Object.freeze({
    type: "connector.v1",
    via: binding.via ?? "xaa",
    audience: binding.flow?.audience,
    onBehalfOf: "user",
    allow: observedScopes,
    observedScopes,
    declaredAllow: undefined,
    requestedScopeSource: "usage-inferred",
    usageContract: Object.freeze({
      compareObservedUsage: false,
      usageExceedsDeclaredAllow: false,
    }),
    fallbackFrom: undefined,
  });
}

function dynamicOperationDiagnostic(call) {
  return {
    code: "xaa.scope.cannot-prove-operation",
    severity: "error",
    target: call.target,
    operationPrefix: call.operationPrefix,
    line: call.line,
    message: `Static analysis cannot prove connector ${call.target} operation under ${call.operationPrefix}; XAA scope inference must fail closed.`,
  };
}

function missingBindingDiagnostic(call) {
  return {
    code: "xaa.scope.missing-binding",
    severity: "error",
    target: call.target,
    operation: call.operation,
    line: call.line,
    message: `connector ${call.target} has no Capability Manifest binding for scope inference.`,
  };
}

function unadvertisedOperationDiagnostic(call) {
  return {
    code: "xaa.scope.unadvertised-operation",
    severity: "error",
    target: call.target,
    operation: call.operation,
    line: call.line,
    message: `connector ${call.target} operation ${call.operation} is not advertised by auth.json.`,
  };
}

function unadvertisedScopeDiagnostic(call) {
  return {
    code: "xaa.scope.unadvertised-scope",
    severity: "error",
    target: call.target,
    operation: call.operation,
    scope: call.scope,
    line: call.line,
    message: `connector ${call.target} operation ${call.operation} maps to unadvertised scope ${call.scope}.`,
  };
}

function findLineStarts(sourceText) {
  const starts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return high + 1;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
