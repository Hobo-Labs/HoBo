import { createGateEventLog, type GateEventLog } from "./events.js";
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

// domain-view: parse-produced draft-proof record; its wire form is the DeclaredResource proto message in data-models/.
export type DeclaredResource = {
  resourceId: string;
  callee: string;
  fileName: string;
  line: number;
  branch: string;
  reachable: boolean;
  evidence: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the DeclaredBind proto message in data-models/.
export type DeclaredBind = {
  from: string;
  to: string;
  key: string;
  fileName: string;
  line: number;
  branch: string;
  reachable: boolean;
  evidence: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the UnresolvedDeclaration proto message in data-models/.
export type UnresolvedDeclaration = {
  callee: string;
  argument: string;
  fileName: string;
  line: number;
  branch: string;
  reason: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the CoverageDiagnostic proto message in data-models/.
export type CoverageDiagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  resourceId?: string;
  bindKey?: string;
  from?: string;
  to?: string;
  branch?: string;
  fileName?: string;
  line?: number;
  callee?: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the CoverageResult proto message in data-models/.
export type CoverageResult = {
  ok: boolean;
  canDeployDimension: "collectionCoverage";
  status: "pass" | "pass-with-warnings" | "fail";
  observedResourceIds: readonly string[];
  observedBindKeys: readonly string[];
  declaredResources: readonly DeclaredResource[];
  declaredBinds: readonly DeclaredBind[];
  unobservedDeclarations: readonly DeclaredResource[];
  unobservedBinds: readonly DeclaredBind[];
  unreachableDeclarations: readonly DeclaredResource[];
  unreachableBinds: readonly DeclaredBind[];
  unresolvedDeclarations: readonly UnresolvedDeclaration[];
  unresolvedBinds: readonly UnresolvedDeclaration[];
  diagnostics: readonly CoverageDiagnostic[];
};

export type CoverageEvaluationResult = CoverageResult & {
  eventLog: GateEventLog;
};

export class CollectionCoverageError extends Error {
  readonly result: CoverageResult;
  readonly diagnostics: readonly CoverageDiagnostic[];

  constructor(result: CoverageResult) {
    super(formatCoverageError(result.diagnostics));
    this.name = "CollectionCoverageError";
    this.result = result;
    this.diagnostics = result.diagnostics;
  }
}

export function assertCanDeployCollectionCoverage(input: {
  sourceText: string;
  observedResourceIds: readonly string[];
  observedBindKeys?: readonly string[];
  fileName?: string;
}): CoverageEvaluationResult {
  const result = evaluateCollectionCoverage(input);
  if (!result.ok) {
    throw new CollectionCoverageError(result);
  }

  return result;
}

export function evaluateCollectionCoverage(input: {
  sourceText: string;
  observedResourceIds: readonly string[];
  observedBindKeys?: readonly string[];
  fileName?: string;
}): CoverageEvaluationResult {
  const fileName = input.fileName ?? "source.ts";
  const analysis = analyzeDeclaredResources(input.sourceText, { fileName });
  const eventLog = createGateEventLog();

  const result = reconcileCollectionCoverage({
    declaredResources: analysis.declaredResources,
    declaredBinds: analysis.declaredBinds,
    unresolvedDeclarations: analysis.unresolvedDeclarations,
    unresolvedBinds: analysis.unresolvedBinds,
    observedResourceIds: input.observedResourceIds,
    observedBindKeys: input.observedBindKeys ?? [],
  });

  const errorDiagnostics = result.diagnostics.filter((d) => d.severity === "error");
  if (errorDiagnostics.length > 0) {
    eventLog.append("coverage.Failed", {
      fileName,
      status: "fail",
      diagnostics: errorDiagnostics,
    });
  } else {
    eventLog.append("coverage.Evaluated", {
      fileName,
      status: result.status === "pass-with-warnings" ? "pass-with-warnings" : "pass",
      observedResourceIds: result.observedResourceIds,
      observedBindKeys: result.observedBindKeys,
    });
  }

  return { ...result, eventLog };
}

export type DeclaredResourceAnalysis = {
  declaredResources: DeclaredResource[];
  declaredBinds: DeclaredBind[];
  unresolvedDeclarations: UnresolvedDeclaration[];
  unresolvedBinds: UnresolvedDeclaration[];
};

export function analyzeDeclaredResources(
  sourceText: string,
  { fileName = "source.ts" }: { fileName?: string } = {},
): DeclaredResourceAnalysis {
  if (!isJsonString(sourceText)) {
    throw new TypeError("sourceText must be a string");
  }

  const bindlesImports = parseBindlesImports(sourceText);
  const lineStarts = findLineStarts(sourceText);
  const calls = findFunctionCalls(sourceText, lineStarts);
  attachBranchFacts(sourceText, calls);

  const declaredResources: DeclaredResource[] = [];
  const declaredBinds: DeclaredBind[] = [];
  const unresolvedDeclarations: UnresolvedDeclaration[] = [];
  const unresolvedBinds: UnresolvedDeclaration[] = [];
  const resourceVariables = new Map<string, string>();

  for (const call of calls) {
    const canonicalCallee = bindlesCallee(call, bindlesImports);

    if (canonicalCallee === BIND_CALLEE) {
      collectDirectBind(call, fileName, declaredBinds, unresolvedBinds);
      continue;
    }

    if (!canonicalCallee || !RESOURCE_DECLARATION_CALLEES.has(canonicalCallee)) {
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

    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    const resourceId = staticId[1] as string;
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

export function reconcileCollectionCoverage(input: {
  declaredResources: readonly DeclaredResource[];
  declaredBinds?: readonly DeclaredBind[];
  unresolvedDeclarations?: readonly UnresolvedDeclaration[];
  unresolvedBinds?: readonly UnresolvedDeclaration[];
  observedResourceIds: readonly string[];
  observedBindKeys?: readonly string[];
}): CoverageResult {
  const declaredBinds = input.declaredBinds ?? [];
  const unresolvedDeclarations = input.unresolvedDeclarations ?? [];
  const unresolvedBinds = input.unresolvedBinds ?? [];
  const observedBindKeys = input.observedBindKeys ?? [];

  assertArray(input.declaredResources, "declaredResources");
  assertArray(declaredBinds, "declaredBinds");
  assertArray(unresolvedDeclarations, "unresolvedDeclarations");
  assertArray(unresolvedBinds, "unresolvedBinds");
  assertArray(input.observedResourceIds, "observedResourceIds");
  assertArray(observedBindKeys, "observedBindKeys");

  const observed = unique(input.observedResourceIds);
  const observedBinds = unique(observedBindKeys);
  const observedSet = new Set(observed);
  const observedBindSet = new Set(observedBinds);
  const reachableDeclarations = input.declaredResources.filter((d) => d.reachable);
  const unreachableDeclarations = input.declaredResources.filter((d) => !d.reachable);
  const unobservedDeclarations = reachableDeclarations.filter(
    (d) => !observedSet.has(d.resourceId),
  );
  const reachableBinds = declaredBinds.filter((bind) => bind.reachable);
  const unreachableBinds = declaredBinds.filter((bind) => !bind.reachable);
  const unobservedBinds = reachableBinds.filter((bind) => !observedBindSet.has(bind.key));

  const diagnostics: CoverageDiagnostic[] = [
    ...unobservedDeclarations.map(unobservedDiagnostic),
    ...unobservedBinds.map(unobservedBindDiagnostic),
    ...unresolvedDeclarations.map(unresolvedDiagnostic),
    ...unresolvedBinds.map(unresolvedBindDiagnostic),
    ...unreachableDeclarations.map(unreachableDiagnostic),
    ...unreachableBinds.map(unreachableBindDiagnostic),
  ];
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  const hasWarnings = diagnostics.length > 0;

  return {
    ok: !hasErrors,
    canDeployDimension: "collectionCoverage",
    status: hasErrors ? "fail" : hasWarnings ? "pass-with-warnings" : "pass",
    observedResourceIds: observed,
    observedBindKeys: observedBinds,
    declaredResources: input.declaredResources,
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

type FunctionCall = {
  qualifier: string | undefined;
  callee: string;
  argumentText: string;
  arguments: string[];
  firstArgument: string;
  start: number;
  end: number;
  line: number;
  column: number;
  branch: string;
  reachable: boolean;
};

type BindlesImports = {
  named: Map<string, string>;
  namespaces: Set<string>;
};

type BranchFrame = {
  branch: string;
  condition: string;
  reachable: boolean;
};

function parseBindlesImports(sourceText: string): BindlesImports {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const match of sourceText.matchAll(NAMED_BINDLES_IMPORT)) {
    for (const specifier of (match[1] ?? "").split(",")) {
      const parsed = parseNamedImport(specifier);
      if (!parsed) continue;
      if (
        RESOURCE_DECLARATION_CALLEES.has(parsed.imported) ||
        parsed.imported === BIND_CALLEE
      ) {
        named.set(parsed.local, parsed.imported);
      }
    }
  }

  for (const match of sourceText.matchAll(NAMESPACE_BINDLES_IMPORT)) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    namespaces.add(match[1] as string);
  }

  return { named, namespaces };
}

function parseNamedImport(specifier: string): { imported: string; local: string } | undefined {
  const withoutType = specifier.trim().replace(/^type\s+/, "");
  if (!withoutType) return undefined;

  const aliasMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(
    withoutType,
  );
  if (aliasMatch) {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    return { imported: aliasMatch[1] as string, local: aliasMatch[2] as string };
  }

  if (!IDENTIFIER.test(withoutType)) return undefined;
  return { imported: withoutType, local: withoutType };
}

function bindlesCallee(call: FunctionCall, bindlesImports: BindlesImports): string | undefined {
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

function findFunctionCalls(sourceText: string, lineStarts: number[]): FunctionCall[] {
  const calls: FunctionCall[] = [];

  for (const match of sourceText.matchAll(CALL_EXPRESSION)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const balanced = readBalanced(sourceText, openIndex, "(", ")");
    if (!balanced) continue;

    const argumentList = splitTopLevelArguments(balanced.value);
    const position = lineAndColumnAt(lineStarts, match.index ?? 0);
    calls.push({
      qualifier: match[1],
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      callee: match[2] as string,
      argumentText: balanced.value,
      arguments: argumentList,
      firstArgument: argumentList[0]?.trim() ?? "",
      start: match.index ?? 0,
      end: balanced.end,
      line: position.line,
      column: position.column,
      branch: "top-level",
      reachable: true,
    });
  }

  return calls;
}

function attachBranchFacts(sourceText: string, calls: FunctionCall[]): void {
  const state = {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    branchStack: [] as BranchFrame[],
    index: 0,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    lastClosedBranch: undefined as BranchFrame | undefined,
  };

  for (const call of calls) {
    scanBranchTokensThrough(sourceText, state, call.start);
    call.branch = currentBranch(state.branchStack);
    call.reachable = currentReachability(state.branchStack);
  }
}

function scanBranchTokensThrough(
  sourceText: string,
  state: {
    branchStack: BranchFrame[];
    index: number;
    lastClosedBranch: BranchFrame | undefined;
  },
  endIndex: number,
): void {
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
          pushBranch(state.branchStack, `else if ${parsed.condition}`, parsed.condition);
          state.lastClosedBranch = undefined;
          state.index = parsed.openBrace + 1;
          continue;
        }
      }

      const openBrace = skipWhitespace(sourceText, nextIndex);
      if (sourceText[openBrace] === "{" && openBrace < endIndex) {
        const previousCondition = state.lastClosedBranch?.condition ?? "condition";
        pushBranch(state.branchStack, `else ${previousCondition}`, `!(${previousCondition})`);
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

function parseIfBlock(
  sourceText: string,
  ifIndex: number,
): { condition: string; openBrace: number } | undefined {
  const openParen = skipWhitespace(sourceText, ifIndex + "if".length);
  if (sourceText[openParen] !== "(") return undefined;

  const condition = readBalanced(sourceText, openParen, "(", ")");
  if (!condition) return undefined;

  const openBrace = skipWhitespace(sourceText, condition.end + 1);
  if (sourceText[openBrace] !== "{") return undefined;

  return { condition: condition.value.trim(), openBrace };
}

function pushBranch(branchStack: BranchFrame[], branch: string, condition: string): void {
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

function collectDirectBind(
  call: FunctionCall,
  fileName: string,
  declaredBinds: DeclaredBind[],
  unresolvedBinds: UnresolvedDeclaration[],
): void {
  const [fromArgument, toArgument] = call.arguments;
  const from = STATIC_RESOURCE_ID.exec(fromArgument?.trim() ?? "");
  const to = STATIC_RESOURCE_ID.exec(toArgument?.trim() ?? "");

  if (!from || !to) {
    unresolvedBinds.push({
      callee: BIND_CALLEE,
      argument: `${fromArgument ?? ""},${toArgument ?? ""}`,
      fileName,
      line: call.line,
      branch: call.branch,
      reason: "bind endpoints are not static string literals",
    });
    return;
  }

  declaredBinds.push(
    bindDeclaration({
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      from: from[1] as string,
      // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
      to: to[1] as string,
      fileName,
      line: call.line,
      branch: call.branch,
      reachable: call.reachable,
    }),
  );
}

function collectBindOptionEdges(input: {
  call: FunctionCall;
  fileName: string;
  fromResourceId: string;
  resourceVariables: Map<string, string>;
  declaredBinds: DeclaredBind[];
  unresolvedBinds: UnresolvedDeclaration[];
}): void {
  for (const entry of extractBindOptionEntries(input.call.argumentText)) {
    if (entry.kind !== "identifier") {
      input.unresolvedBinds.push({
        callee: "bind",
        argument: entry.value,
        fileName: input.fileName,
        line: input.call.line,
        branch: input.call.branch,
        reason: "bind option is not a static resource reference",
      });
      continue;
    }

    const targetResourceId = input.resourceVariables.get(entry.value);
    if (!targetResourceId) {
      input.unresolvedBinds.push({
        callee: "bind",
        argument: entry.value,
        fileName: input.fileName,
        line: input.call.line,
        branch: input.call.branch,
        reason: "bind option references an unknown resource variable",
      });
      continue;
    }

    input.declaredBinds.push(
      bindDeclaration({
        from: input.fromResourceId,
        to: targetResourceId,
        fileName: input.fileName,
        line: input.call.line,
        branch: input.call.branch,
        reachable: input.call.reachable,
      }),
    );
  }
}

function bindDeclaration(input: {
  from: string;
  to: string;
  fileName: string;
  line: number;
  branch: string;
  reachable: boolean;
}): DeclaredBind {
  return {
    from: input.from,
    to: input.to,
    key: `${input.from}->${input.to}`,
    fileName: input.fileName,
    line: input.line,
    branch: input.branch,
    reachable: input.reachable,
    evidence: `${input.fileName}:${input.line}`,
  };
}

function extractBindOptionEntries(
  argumentText: string,
): Array<{ kind: "identifier" | "unresolved"; value: string }> {
  const entries: Array<{ kind: "identifier" | "unresolved"; value: string }> = [];
  const bindProperty = /\bbind\s*:\s*\{/g;

  for (const match of argumentText.matchAll(bindProperty)) {
    const openBrace = (match.index ?? 0) + match[0].length - 1;
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

function bindPropertyValue(property: string): string {
  const colon = findTopLevelColon(property);
  if (colon === -1) return property;
  return property.slice(colon + 1).trim();
}

function findTopLevelColon(value: string): number {
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

function assignedVariableName(sourceText: string, callStart: number): string | undefined {
  const prefix = sourceText.slice(statementStart(sourceText, callStart), callStart);
  const match =
    /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\.\s*)?(?:use\s*\(\s*)?$/.exec(
      prefix,
    );

  return match?.[1];
}

function statementStart(sourceText: string, index: number): number {
  const candidates = [
    sourceText.lastIndexOf(";", index),
    sourceText.lastIndexOf("\n", index),
    sourceText.lastIndexOf("{", index),
  ];

  return Math.max(...candidates) + 1;
}

function readBalanced(
  sourceText: string,
  openIndex: number,
  openCharacter: string,
  closeCharacter: string,
): { value: string; end: number } | undefined {
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
        return { value: sourceText.slice(openIndex + 1, index), end: index };
      }
    }
  }

  return undefined;
}

function splitTopLevelArguments(argumentText: string): string[] {
  const parts: string[] = [];
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
  if (finalPart) parts.push(finalPart);

  return parts;
}

function skipStringOrComment(sourceText: string, index: number): number {
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

function findLineStarts(sourceText: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (sourceText[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

type LineColumn = {
  line: number;
  column: number;
};

function lineAndColumnAt(lineStarts: number[], index: number): LineColumn {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return {
    line: high + 1,
    column: index - (lineStarts[high] ?? 0) + 1,
  };
}

function currentBranch(branchStack: BranchFrame[]): string {
  return branchStack.at(-1)?.branch ?? "top-level";
}

function currentReachability(branchStack: BranchFrame[]): boolean {
  return branchStack.every((branch) => branch.reachable !== false);
}

function shouldCloseBranch(sourceText: string, index: number): boolean {
  const previous = previousNonWhitespace(sourceText, index - 1);
  return previous === ";" || previous === ")" || previous === "{";
}

function previousNonWhitespace(sourceText: string, index: number): string {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(sourceText[cursor] ?? "")) {
      return sourceText[cursor] ?? "";
    }
  }

  return "";
}

function isWordAt(sourceText: string, index: number, word: string): boolean {
  if (sourceText.slice(index, index + word.length) !== word) {
    return false;
  }

  return (
    !isIdentifierCharacter(sourceText[index - 1]) &&
    !isIdentifierCharacter(sourceText[index + word.length])
  );
}

function isIdentifierCharacter(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character));
}

function skipWhitespace(sourceText: string, index: number): number {
  let cursor = index;
  while (cursor < sourceText.length && /\s/.test(sourceText[cursor] ?? "")) {
    cursor += 1;
  }

  return cursor;
}

function unobservedDiagnostic(declaration: DeclaredResource): CoverageDiagnostic {
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

function unresolvedDiagnostic(declaration: UnresolvedDeclaration): CoverageDiagnostic {
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

function unobservedBindDiagnostic(bind: DeclaredBind): CoverageDiagnostic {
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

function unresolvedBindDiagnostic(bind: UnresolvedDeclaration): CoverageDiagnostic {
  return {
    code: "collection.coverage.cannot-prove-bind",
    severity: "error",
    branch: bind.branch,
    fileName: bind.fileName,
    line: bind.line,
    message: `Static analysis cannot prove bind endpoints on ${bind.branch}; collection coverage must fail closed.`,
  };
}

function unreachableDiagnostic(declaration: DeclaredResource): CoverageDiagnostic {
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

function unreachableBindDiagnostic(bind: DeclaredBind): CoverageDiagnostic {
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

function formatCoverageError(diagnostics: readonly CoverageDiagnostic[]): string {
  const errors = diagnostics.filter((d) => d.severity === "error");
  return `Collection coverage failed: ${errors.map((d) => d.message).join(" ")}`;
}

function assertArray<T>(value: T, name: string): void {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
