import { isJsonString } from "./json.js";
const RESOURCE_DECLARATION_CALLEES = new Set([
  "api",
  "auth",
  "bucket",
  "data",
  "database",
  "experiment",
  "flag",
  "kv",
  "objectStore",
  "queue",
  "rollout",
  "secret",
  "service",
  "slo",
  "topic",
  "trainable",
  "web",
  "websocket",
]);

const BIND_CALLEE = "bind";
const STATIC_RESOURCE_ID = /^["'`]([A-Za-z][A-Za-z0-9_-]*)["'`]$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CALL_EXPRESSION =
  /(?:(\b[A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*)?(\b[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
const NAMED_BINDLES_IMPORT =
  /import\s*\{([\s\S]*?)\}\s*from\s*["']@hobo\/bindles["']/g;
const NAMESPACE_BINDLES_IMPORT =
  /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*["']@hobo\/bindles["']/g;

export class CollectionCoverageError extends Error {
  constructor(result) {
    super(formatCoverageError(result.diagnostics));
    this.name = "CollectionCoverageError";
    this.result = result;
    this.diagnostics = result.diagnostics;
  }
}

export function assertCanDeployCollectionCoverage(input) {
  const result = evaluateCollectionCoverage(input);
  if (!result.ok) {
    throw new CollectionCoverageError(result);
  }

  return result;
}

export function evaluateCollectionCoverage({
  sourceText,
  observedResourceIds,
  observedBindKeys = [],
  fileName = "source.ts",
}) {
  const analysis = analyzeDeclaredResources(sourceText, { fileName });

  return reconcileCollectionCoverage({
    declaredResources: analysis.declaredResources,
    declaredBinds: analysis.declaredBinds,
    unresolvedDeclarations: analysis.unresolvedDeclarations,
    unresolvedBinds: analysis.unresolvedBinds,
    observedResourceIds,
    observedBindKeys,
  });
}

export function analyzeDeclaredResources(sourceText, { fileName = "source.ts" } = {}) {
  if (!isJsonString(sourceText)) {
    throw new TypeError("sourceText must be a string");
  }

  const bindlesImports = parseBindlesImports(sourceText);
  const lineStarts = findLineStarts(sourceText);
  const calls = findFunctionCalls(sourceText, lineStarts);
  attachBranchFacts(sourceText, calls);

  const declaredResources = [];
  const declaredBinds = [];
  const unresolvedDeclarations = [];
  const unresolvedBinds = [];
  const resourceVariables = new Map();

  for (const call of calls) {
    const canonicalCallee = bindlesCallee(call, bindlesImports);

    if (canonicalCallee === BIND_CALLEE) {
      collectDirectBind(call, fileName, declaredBinds, unresolvedBinds);
      continue;
    }

    if (!RESOURCE_DECLARATION_CALLEES.has(canonicalCallee)) {
      continue;
    }

    const staticId = STATIC_RESOURCE_ID.exec(call.firstArgument);
    if (!staticId) {
      unresolvedDeclarations.push({
        callee: canonicalCallee,
        argument: call.firstArgument,
        fileName,
        line: call.line,
        branch: call.branch,
        reason: "resource name is not a static string literal",
      });
      continue;
    }

    const resourceId = staticId[1];
    declaredResources.push({
      resourceId,
      callee: canonicalCallee,
      fileName,
      line: call.line,
      branch: call.branch,
      reachable: call.reachable,
      evidence: `${fileName}:${call.line}`,
    });

    const variableName = assignedVariableName(sourceText, call.start);
    if (variableName) {
      resourceVariables.set(variableName, resourceId);
    }

    collectBindOptionEdges({
      call,
      fileName,
      fromResourceId: resourceId,
      resourceVariables,
      declaredBinds,
      unresolvedBinds,
    });
  }

  return {
    declaredResources,
    declaredBinds,
    unresolvedDeclarations,
    unresolvedBinds,
  };
}

export function reconcileCollectionCoverage({
  declaredResources,
  declaredBinds = [],
  unresolvedDeclarations = [],
  unresolvedBinds = [],
  observedResourceIds,
  observedBindKeys = [],
}) {
  assertArray(declaredResources, "declaredResources");
  assertArray(declaredBinds, "declaredBinds");
  assertArray(unresolvedDeclarations, "unresolvedDeclarations");
  assertArray(unresolvedBinds, "unresolvedBinds");
  assertArray(observedResourceIds, "observedResourceIds");
  assertArray(observedBindKeys, "observedBindKeys");

  const observed = unique(observedResourceIds);
  const observedBinds = unique(observedBindKeys);
  const observedSet = new Set(observed);
  const observedBindSet = new Set(observedBinds);
  const reachableDeclarations = declaredResources.filter(
    (declaration) => declaration.reachable,
  );
  const unreachableDeclarations = declaredResources.filter(
    (declaration) => !declaration.reachable,
  );
  const unobservedDeclarations = reachableDeclarations.filter(
    (declaration) => !observedSet.has(declaration.resourceId),
  );
  const reachableBinds = declaredBinds.filter((bind) => bind.reachable);
  const unreachableBinds = declaredBinds.filter((bind) => !bind.reachable);
  const unobservedBinds = reachableBinds.filter(
    (bind) => !observedBindSet.has(bind.key),
  );

  const diagnostics = [
    ...unobservedDeclarations.map(unobservedDiagnostic),
    ...unobservedBinds.map(unobservedBindDiagnostic),
    ...unresolvedDeclarations.map(unresolvedDiagnostic),
    ...unresolvedBinds.map(unresolvedBindDiagnostic),
    ...unreachableDeclarations.map(unreachableDiagnostic),
    ...unreachableBinds.map(unreachableBindDiagnostic),
  ];
  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const hasWarnings = diagnostics.length > 0;

  return {
    ok: !hasErrors,
    canDeployDimension: "collectionCoverage",
    status: hasErrors ? "fail" : hasWarnings ? "pass-with-warnings" : "pass",
    observedResourceIds: observed,
    observedBindKeys: observedBinds,
    declaredResources,
    declaredBinds,
    unobservedDeclarations,
    unobservedBinds,
    unreachableDeclarations,
    unreachableBinds,
    unresolvedDeclarations,
    unresolvedBinds,
    diagnostics,
  };
}

function parseBindlesImports(sourceText) {
  const named = new Map();
  const namespaces = new Set();

  for (const match of sourceText.matchAll(NAMED_BINDLES_IMPORT)) {
    for (const specifier of match[1].split(",")) {
      const parsed = parseNamedImport(specifier);
      if (!parsed) {
        continue;
      }

      if (
        RESOURCE_DECLARATION_CALLEES.has(parsed.imported) ||
        parsed.imported === BIND_CALLEE
      ) {
        named.set(parsed.local, parsed.imported);
      }
    }
  }

  for (const match of sourceText.matchAll(NAMESPACE_BINDLES_IMPORT)) {
    namespaces.add(match[1]);
  }

  return { named, namespaces };
}

function parseNamedImport(specifier) {
  const withoutType = specifier.trim().replace(/^type\s+/, "");
  if (!withoutType) {
    return undefined;
  }

  const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(
    withoutType,
  );
  if (aliasMatch) {
    return { imported: aliasMatch[1], local: aliasMatch[2] };
  }

  if (!IDENTIFIER.test(withoutType)) {
    return undefined;
  }

  return { imported: withoutType, local: withoutType };
}

function bindlesCallee(call, bindlesImports) {
  if (call.qualifier) {
    if (
      bindlesImports.namespaces.has(call.qualifier) &&
      (RESOURCE_DECLARATION_CALLEES.has(call.callee) || call.callee === BIND_CALLEE)
    ) {
      return call.callee;
    }

    return undefined;
  }

  return bindlesImports.named.get(call.callee);
}

function findFunctionCalls(sourceText, lineStarts) {
  const calls = [];

  for (const match of sourceText.matchAll(CALL_EXPRESSION)) {
    const openIndex = match.index + match[0].length - 1;
    const balanced = readBalanced(sourceText, openIndex, "(", ")");
    if (!balanced) {
      continue;
    }

    const argumentList = splitTopLevelArguments(balanced.value);
    const position = lineAndColumnAt(lineStarts, match.index);
    calls.push({
      qualifier: match[1],
      callee: match[2],
      argumentText: balanced.value,
      arguments: argumentList,
      firstArgument: argumentList[0]?.trim() ?? "",
      start: match.index,
      end: balanced.end,
      line: position.line,
      column: position.column,
      branch: "top-level",
      reachable: true,
    });
  }

  return calls;
}

function attachBranchFacts(sourceText, calls) {
  const state = {
    branchStack: [],
    index: 0,
    lastClosedBranch: undefined,
  };

  for (const call of calls) {
    scanBranchTokensThrough(sourceText, state, call.start);
    call.branch = currentBranch(state.branchStack);
    call.reachable = currentReachability(state.branchStack);
  }
}

function scanBranchTokensThrough(sourceText, state, endIndex) {
  while (state.index < endIndex) {
    const skipped = skipStringOrComment(sourceText, state.index);
    if (skipped !== state.index) {
      state.index = Math.min(skipped, endIndex);
      continue;
    }

    if (sourceText[state.index] === "}") {
      if (shouldCloseBranch(sourceText, state.index)) {
        state.lastClosedBranch = state.branchStack.pop();
      }
      state.index += 1;
      continue;
    }

    if (isWordAt(sourceText, state.index, "else")) {
      const nextIndex = skipWhitespace(sourceText, state.index + "else".length);
      if (isWordAt(sourceText, nextIndex, "if")) {
        const parsed = parseIfBlock(sourceText, nextIndex);
        if (parsed && parsed.openBrace < endIndex) {
          pushBranch(
            state.branchStack,
            `else if ${parsed.condition}`,
            parsed.condition,
          );
          state.lastClosedBranch = undefined;
          state.index = parsed.openBrace + 1;
          continue;
        }
      }

      const openBrace = skipWhitespace(sourceText, nextIndex);
      if (sourceText[openBrace] === "{" && openBrace < endIndex) {
        const previousCondition = state.lastClosedBranch?.condition ?? "condition";
        pushBranch(
          state.branchStack,
          `else ${previousCondition}`,
          `!(${previousCondition})`,
        );
        state.lastClosedBranch = undefined;
        state.index = openBrace + 1;
        continue;
      }
    }

    if (isWordAt(sourceText, state.index, "if")) {
      const parsed = parseIfBlock(sourceText, state.index);
      if (parsed && parsed.openBrace < endIndex) {
        pushBranch(state.branchStack, `if ${parsed.condition}`, parsed.condition);
        state.lastClosedBranch = undefined;
        state.index = parsed.openBrace + 1;
        continue;
      }
    }

    state.index += 1;
  }
}

function parseIfBlock(sourceText, ifIndex) {
  const openParen = skipWhitespace(sourceText, ifIndex + "if".length);
  if (sourceText[openParen] !== "(") {
    return undefined;
  }

  const condition = readBalanced(sourceText, openParen, "(", ")");
  if (!condition) {
    return undefined;
  }

  const openBrace = skipWhitespace(sourceText, condition.end + 1);
  if (sourceText[openBrace] !== "{") {
    return undefined;
  }

  return {
    condition: condition.value.trim(),
    openBrace,
  };
}

function pushBranch(branchStack, branch, condition) {
  const normalizedCondition = condition.trim();
  const parentReachable = currentReachability(branchStack);
  let reachable = parentReachable;

  if (normalizedCondition === "false" || normalizedCondition === "!(true)") {
    reachable = false;
  }

  branchStack.push({
    branch,
    condition: normalizedCondition.replace(/^!\((.*)\)$/, "$1"),
    reachable,
  });
}

function collectDirectBind(call, fileName, declaredBinds, unresolvedBinds) {
  const [fromArgument, toArgument] = call.arguments;
  const from = STATIC_RESOURCE_ID.exec(fromArgument?.trim() ?? "");
  const to = STATIC_RESOURCE_ID.exec(toArgument?.trim() ?? "");

  if (!from || !to) {
    unresolvedBinds.push({
      from: fromArgument?.trim() ?? "",
      to: toArgument?.trim() ?? "",
      fileName,
      line: call.line,
      branch: call.branch,
      reason: "bind endpoints are not static string literals",
    });
    return;
  }

  declaredBinds.push(bindDeclaration({
    from: from[1],
    to: to[1],
    fileName,
    line: call.line,
    branch: call.branch,
    reachable: call.reachable,
  }));
}

function collectBindOptionEdges({
  call,
  fileName,
  fromResourceId,
  resourceVariables,
  declaredBinds,
  unresolvedBinds,
}) {
  for (const entry of extractBindOptionEntries(call.argumentText)) {
    if (entry.kind !== "identifier") {
      unresolvedBinds.push({
        from: fromResourceId,
        to: entry.value,
        fileName,
        line: call.line,
        branch: call.branch,
        reason: "bind option is not a static resource reference",
      });
      continue;
    }

    const targetResourceId = resourceVariables.get(entry.value);
    if (!targetResourceId) {
      unresolvedBinds.push({
        from: fromResourceId,
        to: entry.value,
        fileName,
        line: call.line,
        branch: call.branch,
        reason: "bind option references an unknown resource variable",
      });
      continue;
    }

    declaredBinds.push(bindDeclaration({
      from: fromResourceId,
      to: targetResourceId,
      fileName,
      line: call.line,
      branch: call.branch,
      reachable: call.reachable,
    }));
  }
}

function bindDeclaration({ from, to, fileName, line, branch, reachable }) {
  return {
    from,
    to,
    key: `${from}->${to}`,
    fileName,
    line,
    branch,
    reachable,
    evidence: `${fileName}:${line}`,
  };
}

function extractBindOptionEntries(argumentText) {
  const entries = [];
  const bindProperty = /\bbind\s*:\s*\{/g;

  for (const match of argumentText.matchAll(bindProperty)) {
    const openBrace = match.index + match[0].length - 1;
    const balanced = readBalanced(argumentText, openBrace, "{", "}");
    if (!balanced) {
      entries.push({ kind: "unresolved", value: "bind" });
      continue;
    }

    for (const property of splitTopLevelArguments(balanced.value)) {
      const value = bindPropertyValue(property.trim());
      if (IDENTIFIER.test(value)) {
        entries.push({ kind: "identifier", value });
      } else {
        entries.push({ kind: "unresolved", value });
      }
    }
  }

  return entries;
}

function bindPropertyValue(property) {
  const colon = findTopLevelColon(property);
  if (colon === -1) {
    return property;
  }

  return property.slice(colon + 1).trim();
}

function findTopLevelColon(value) {
  let depth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const skipped = skipStringOrComment(value, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }

    const character = value[index];
    if (character === "{" || character === "(" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === ")" || character === "]") {
      depth -= 1;
    } else if (character === ":" && depth === 0) {
      return index;
    }
  }

  return -1;
}

function assignedVariableName(sourceText, callStart) {
  const prefix = sourceText.slice(statementStart(sourceText, callStart), callStart);
  const match =
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.\s*)?(?:use\s*\(\s*)?$/.exec(
      prefix,
    );

  return match?.[1];
}

function statementStart(sourceText, index) {
  const candidates = [
    sourceText.lastIndexOf(";", index),
    sourceText.lastIndexOf("\n", index),
    sourceText.lastIndexOf("{", index),
  ];

  return Math.max(...candidates) + 1;
}

function readBalanced(sourceText, openIndex, openCharacter, closeCharacter) {
  let depth = 0;

  for (let index = openIndex; index < sourceText.length; index += 1) {
    const skipped = skipStringOrComment(sourceText, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }

    const character = sourceText[index];
    if (character === openCharacter) {
      depth += 1;
    } else if (character === closeCharacter) {
      depth -= 1;
      if (depth === 0) {
        return {
          value: sourceText.slice(openIndex + 1, index),
          end: index,
        };
      }
    }
  }

  return undefined;
}

function splitTopLevelArguments(argumentText) {
  const parts = [];
  let depth = 0;
  let partStart = 0;

  for (let index = 0; index < argumentText.length; index += 1) {
    const skipped = skipStringOrComment(argumentText, index);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }

    const character = argumentText[index];
    if (character === "{" || character === "(" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === ")" || character === "]") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      parts.push(argumentText.slice(partStart, index).trim());
      partStart = index + 1;
    }
  }

  const finalPart = argumentText.slice(partStart).trim();
  if (finalPart) {
    parts.push(finalPart);
  }

  return parts;
}

function skipStringOrComment(sourceText, index) {
  const character = sourceText[index];
  const nextCharacter = sourceText[index + 1];

  if (character === "/" && nextCharacter === "/") {
    const end = sourceText.indexOf("\n", index + 2);
    return end === -1 ? sourceText.length : end + 1;
  }

  if (character === "/" && nextCharacter === "*") {
    const end = sourceText.indexOf("*/", index + 2);
    return end === -1 ? sourceText.length : end + 2;
  }

  if (character !== '"' && character !== "'" && character !== "`") {
    return index;
  }

  for (let cursor = index + 1; cursor < sourceText.length; cursor += 1) {
    if (sourceText[cursor] === "\\") {
      cursor += 1;
      continue;
    }

    if (sourceText[cursor] === character) {
      return cursor + 1;
    }
  }

  return sourceText.length;
}

function findLineStarts(sourceText) {
  const lineStarts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function lineAndColumnAt(lineStarts, index) {
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

  return {
    line: high + 1,
    column: index - lineStarts[high] + 1,
  };
}

function currentBranch(branchStack) {
  return branchStack.at(-1)?.branch ?? "top-level";
}

function currentReachability(branchStack) {
  return branchStack.every((branch) => branch.reachable !== false);
}

function shouldCloseBranch(sourceText, index) {
  const previous = previousNonWhitespace(sourceText, index - 1);
  return previous === ";" || previous === ")" || previous === "{";
}

function previousNonWhitespace(sourceText, index) {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(sourceText[cursor])) {
      return sourceText[cursor];
    }
  }

  return "";
}

function isWordAt(sourceText, index, word) {
  if (sourceText.slice(index, index + word.length) !== word) {
    return false;
  }

  return !isIdentifierCharacter(sourceText[index - 1]) &&
    !isIdentifierCharacter(sourceText[index + word.length]);
}

function isIdentifierCharacter(character) {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character));
}

function skipWhitespace(sourceText, index) {
  let cursor = index;
  while (cursor < sourceText.length && /\s/.test(sourceText[cursor])) {
    cursor += 1;
  }

  return cursor;
}

function unobservedDiagnostic(declaration) {
  return {
    code: "collection.coverage.unobserved-resource",
    severity: "error",
    resourceId: declaration.resourceId,
    branch: declaration.branch,
    fileName: declaration.fileName,
    line: declaration.line,
    message: `Resource ${declaration.resourceId} is statically declared on ${declaration.branch} but was not observed by collection.`,
  };
}

function unresolvedDiagnostic(declaration) {
  return {
    code: "collection.coverage.cannot-prove-resource-name",
    severity: "error",
    callee: declaration.callee,
    branch: declaration.branch,
    fileName: declaration.fileName,
    line: declaration.line,
    message: `Static analysis cannot prove the ${declaration.callee} resource name on ${declaration.branch}; collection coverage must fail closed.`,
  };
}

function unobservedBindDiagnostic(bind) {
  return {
    code: "collection.coverage.unobserved-bind",
    severity: "error",
    bindKey: bind.key,
    from: bind.from,
    to: bind.to,
    branch: bind.branch,
    fileName: bind.fileName,
    line: bind.line,
    message: `Bind ${bind.key} is statically declared on ${bind.branch} but was not observed by collection.`,
  };
}

function unresolvedBindDiagnostic(bind) {
  return {
    code: "collection.coverage.cannot-prove-bind",
    severity: "error",
    branch: bind.branch,
    fileName: bind.fileName,
    line: bind.line,
    message: `Static analysis cannot prove bind endpoints on ${bind.branch}; collection coverage must fail closed.`,
  };
}

function unreachableDiagnostic(declaration) {
  return {
    code: "collection.coverage.unreachable-resource",
    severity: "warning",
    resourceId: declaration.resourceId,
    branch: declaration.branch,
    fileName: declaration.fileName,
    line: declaration.line,
    message: `Resource ${declaration.resourceId} is statically declared only in unreachable code and is reported separately from unobserved collection coverage.`,
  };
}

function unreachableBindDiagnostic(bind) {
  return {
    code: "collection.coverage.unreachable-bind",
    severity: "warning",
    bindKey: bind.key,
    from: bind.from,
    to: bind.to,
    branch: bind.branch,
    fileName: bind.fileName,
    line: bind.line,
    message: `Bind ${bind.key} is statically declared only in unreachable code and is reported separately from unobserved collection coverage.`,
  };
}

function formatCoverageError(diagnostics) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  return `Collection coverage failed: ${errors
    .map((diagnostic) => diagnostic.message)
    .join(" ")}`;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
}

function unique(values) {
  return [...new Set(values)];
}
