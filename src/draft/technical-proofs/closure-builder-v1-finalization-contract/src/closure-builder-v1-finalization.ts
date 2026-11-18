import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type ClosureBuilderFinalizationIssue =
  | "HOBO-532"
  | "HOBO-533"
  | "HOBO-534"
  | "HOBO-535"
  | "HOBO-536"
  | "HOBO-537"
  | "HOBO-538";

// domain-view:
export interface ClosureBuilderEvidenceEntry {
  readonly issueId: ClosureBuilderFinalizationIssue;
  readonly linearStatus: "Done";
  readonly proofPath: string;
  readonly evidenceRef: string;
  readonly acceptedScope: string;
}

// domain-view:
export interface ClosureBuilderV1FinalizationRecord {
  readonly parentIssue: "HOBO-531";
  readonly authoringPackage: "@hobo/bindles";
  readonly authoringModel: "closure-builder";
  readonly contractRef: "urn:hobo:requirement:closure-builder-public-api";
  readonly evidence: readonly ClosureBuilderEvidenceEntry[];
}

export class ClosureBuilderV1FinalizationError extends Error {
  readonly code: string;
  readonly details: JsonObject;

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(`${code}: ${message}`);
    this.name = "ClosureBuilderV1FinalizationError";
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_EVIDENCE: readonly ClosureBuilderFinalizationIssue[] = [
  "HOBO-532",
  "HOBO-533",
  "HOBO-534",
  "HOBO-535",
  "HOBO-536",
  "HOBO-537",
  "HOBO-538",
] as const;

const LEGACY_FINALIZATION_PATTERNS = [
  /\bb\.use\s*\(/,
  /\b(?:api|auth|bucket|cache|data|database|kv|objectStore|queue|secret|service|topic|web)\s*\(\s*["'`][^"'`]+["'`]/,
  /\.(?:uses|bind|bindTo|linkTo|requires|withReference)\s*\(/,
];

export function closureBuilderV1FinalizationRecord(): ClosureBuilderV1FinalizationRecord {
  return deepFreeze({
    parentIssue: "HOBO-531",
    authoringPackage: "@hobo/bindles",
    authoringModel: "closure-builder",
    contractRef: "urn:hobo:requirement:closure-builder-public-api",
    evidence: [
      {
        issueId: "HOBO-532",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-public-api-contract/README.md",
        evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
        acceptedScope: "public API vocabulary, package ownership, app-host boundary, and dependsOn relationship spelling",
      },
      {
        issueId: "HOBO-533",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-resource-handles-contract/README.md",
        evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
        acceptedScope: "anonymous builder handles, inert workloads, invalid dependency refusal, and dependsOn relationship emission",
      },
      {
        issueId: "HOBO-534",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-resource-handles-contract/README.md",
        evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
        acceptedScope: "generated resource identity stability and alias/physical-name separation",
      },
      {
        issueId: "HOBO-535",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-manifest-lowering-contract/README.md",
        evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
        acceptedScope: "closure-builder graph lowering to hobo:sdk calls and hobo.manifest/v1",
      },
      {
        issueId: "HOBO-536",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-tooling-contract/README.md",
        evidenceRef: "urn:hobo:requirement:closure-builder-public-api",
        acceptedScope: "collection coverage, collect, codegen, and scaffold consumption of closure-builder aliases",
      },
      {
        issueId: "HOBO-537",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-author-flow-contract/README.md",
        evidenceRef: "urn:hobo:requirement:worked-example",
        acceptedScope: "end-to-end author flow, public worked example, conformance corpus, and generated alias type proof",
      },
      {
        issueId: "HOBO-538",
        linearStatus: "Done",
        proofPath: "src/draft/closure-builder-resource-handles-contract/README.md",
        evidenceRef: "urn:hobo:proof:HOBO-538-closure-builder-identity-ledger",
        acceptedScope: "collector-owned generated identity ledger for ambiguous same-kind insertion edits",
      },
    ],
  });
}

export function assertClosureBuilderV1Finalization(raw: JsonValue): ClosureBuilderV1FinalizationRecord {
  const record = parseClosureBuilderV1Finalization(raw);
  const byIssue = new Map(record.evidence.map((entry) => [entry.issueId, entry]));

  const missing = REQUIRED_EVIDENCE.filter((issueId) => !byIssue.has(issueId));
  if (missing.length > 0) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_MISSING_EVIDENCE",
      "parent finalization must carry every accepted closure-builder child or RCR evidence record",
      { missing },
    );
  }

  return record;
}

export function assertNoLegacyClosureBuilderFinalizationSyntax(sourceText: string): string {
  for (const pattern of LEGACY_FINALIZATION_PATTERNS) {
    const match = sourceText.match(pattern);
    if (match) {
      throw new ClosureBuilderV1FinalizationError(
        "CLOSURE_BUILDER_V1_LEGACY_SYNTAX",
        "v1 closure-builder finalization rejects b.use(...), named resource factory arguments, and relationship verbs other than dependsOn()",
        { match: match[0] },
      );
    }
  }
  return sourceText;
}

function parseClosureBuilderV1Finalization(raw: JsonValue): ClosureBuilderV1FinalizationRecord {
  if (!isRecord(raw)) {
    throw new ClosureBuilderV1FinalizationError("CLOSURE_BUILDER_V1_PARSE", "finalization record must be an object");
  }
  if (raw.parentIssue !== "HOBO-531") {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_PARENT",
      "closure-builder v1 finalization belongs to HOBO-531",
      { parentIssue: raw.parentIssue },
    );
  }
  if (raw.authoringPackage !== "@hobo/bindles" || raw.authoringModel !== "closure-builder") {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_AUTHORING_MODEL",
      "v1 explicit Bindle authoring must lead with the @hobo/bindles closure-builder model",
      { authoringPackage: raw.authoringPackage, authoringModel: raw.authoringModel },
    );
  }
  if (raw.contractRef !== "urn:hobo:requirement:closure-builder-public-api") {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_CONTRACT_REF",
      "closure-builder finalization must identify the public API contract",
      { contractRef: raw.contractRef },
    );
  }
  if (!Array.isArray(raw.evidence)) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_EVIDENCE",
      "closure-builder finalization evidence must be an array",
    );
  }

  const evidence = raw.evidence.map(parseEvidenceEntry);
  const duplicates = duplicateIssueIds(evidence);
  if (duplicates.length > 0) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_DUPLICATE_EVIDENCE",
      "each child or RCR issue may appear once in the parent finalization record",
      { duplicates },
    );
  }

  return deepFreeze({
    parentIssue: "HOBO-531",
    authoringPackage: "@hobo/bindles",
    authoringModel: "closure-builder",
    contractRef: "urn:hobo:requirement:closure-builder-public-api",
    evidence,
  });
}

function parseEvidenceEntry(raw: JsonValue): ClosureBuilderEvidenceEntry {
  if (!isRecord(raw) || !isJsonString(raw.issueId)) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_EVIDENCE",
      "evidence entries must name a closure-builder issue",
    );
  }
  if (!isFinalizationIssue(raw.issueId)) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_UNKNOWN_ISSUE",
      "evidence entry is not part of the HOBO-531 closure-builder finalization set",
      { issueId: raw.issueId },
    );
  }
  if (raw.linearStatus !== "Done") {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_UNACCEPTED_EVIDENCE",
      "evidence entries must represent Done child or RCR issues",
      { issueId: raw.issueId, linearStatus: raw.linearStatus },
    );
  }
  if (!isJsonString(raw.proofPath) || !raw.proofPath.startsWith("src/draft/")) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_PROOF_PATH",
      "closure-builder child evidence must link a src/draft proof package",
      { issueId: raw.issueId, proofPath: raw.proofPath },
    );
  }
  if (!isJsonString(raw.evidenceRef) || !/^urn:hobo:(?:requirement|proof):/.test(raw.evidenceRef)) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_EVIDENCE_REF",
      "closure-builder child evidence must identify a requirement or proof",
      { issueId: raw.issueId, evidenceRef: raw.evidenceRef },
    );
  }
  if (!isJsonString(raw.acceptedScope) || raw.acceptedScope.trim().length === 0) {
    throw new ClosureBuilderV1FinalizationError(
      "CLOSURE_BUILDER_V1_ACCEPTED_SCOPE",
      "closure-builder child evidence must state the accepted scope",
      { issueId: raw.issueId },
    );
  }

  return {
    issueId: raw.issueId,
    linearStatus: "Done",
    proofPath: raw.proofPath,
    evidenceRef: raw.evidenceRef,
    acceptedScope: raw.acceptedScope,
  };
}

function isFinalizationIssue(issueId: string): issueId is ClosureBuilderFinalizationIssue {
  return REQUIRED_EVIDENCE.includes(issueId as ClosureBuilderFinalizationIssue);
}

function duplicateIssueIds(evidence: readonly ClosureBuilderEvidenceEntry[]): ClosureBuilderFinalizationIssue[] {
  const seen = new Set<ClosureBuilderFinalizationIssue>();
  const duplicates = new Set<ClosureBuilderFinalizationIssue>();
  for (const entry of evidence) {
    if (seen.has(entry.issueId)) duplicates.add(entry.issueId);
    seen.add(entry.issueId);
  }
  return [...duplicates];
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  return value;
}
