import { isJsonObject, type JsonObject } from "./json.js";
// domain-view: parse-produced draft-proof record; its wire form is the GuardrailMappingRow proto message in data-models/.
export interface GuardrailMappingRow {
  readonly platformGuardrail: string;
  readonly issueWorkerEnforcement: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the IssueWorkerGuardrailMappingRecord proto message in data-models/.
export interface IssueWorkerGuardrailMappingRecord {
  readonly parentIssue: "HOBO-702";
  readonly automationDocPath: "docs/automations/hobo-issue-worker.md";
  readonly rows: readonly GuardrailMappingRow[];
  readonly authoritativeRefs: readonly string[];
}

export class IssueWorkerGuardrailMappingError extends Error {
  readonly code: string;
  readonly details: JsonObject;

  constructor(code: string, message: string, details: JsonObject = {}) {
    super(`${code}: ${message}`);
    this.name = "IssueWorkerGuardrailMappingError";
    this.code = code;
    this.details = details;
  }
}

const REQUIRED_SECTION_HEADING = "## Agent-native guardrails";
const REQUIRED_REF_PATTERNS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: "BR-011", pattern: /BR-011/ },
  { id: "Plan 06", pattern: /Plan 06/ },
  { id: "FR-022", pattern: /FR-022/ },
  { id: "Plan 29", pattern: /Plan 29/ },
  { id: "ADR-0094", pattern: /ADR-0094/ },
] as const;

const REQUIRED_MAPPING_TOPICS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: "high-risk-gating", pattern: /require-approval|deny/i },
  { id: "spend-cap-quota", pattern: /spendCapUsd|quota/i },
  { id: "destroy-protection", pattern: /destroy|Scope \(out\)/i },
  { id: "tool-contract-bounds", pattern: /tool contract|owned issue/i },
  { id: "policy-obligations", pattern: /Adversarial|RCR|obligation/i },
  { id: "safety-envelope", pattern: /SafetyEnvelope/i },
] as const;

export function issueWorkerGuardrailMappingRecord(): IssueWorkerGuardrailMappingRecord {
  return deepFreeze({
    parentIssue: "HOBO-702",
    automationDocPath: "docs/automations/hobo-issue-worker.md",
    authoritativeRefs: REQUIRED_REF_PATTERNS.map((entry) => entry.id),
    rows: [
      {
        platformGuardrail: "High-risk actions gated (require-approval / deny)",
        issueWorkerEnforcement: "AUTO_MERGE=false; never push to main; never merge own PR",
      },
      {
        platformGuardrail: "spendCapUsd / quota gates",
        issueWorkerEnforcement: "One issue per run; narrow agent:check scope",
      },
      {
        platformGuardrail: "Destroy protection",
        issueWorkerEnforcement: "Scope (out) is a hard wall; preserve user work",
      },
      {
        platformGuardrail: "Agent tool contracts bound side effects",
        issueWorkerEnforcement: "Touch only owned issue/PR; claim protocol",
      },
      {
        platformGuardrail: "Unified policy decisions + obligations",
        issueWorkerEnforcement: "Adversarial bullets become guards/tests; RCR protocol",
      },
      {
        platformGuardrail: "SafetyEnvelope decision classes",
        issueWorkerEnforcement: "Isolated worktree; fail-closed when gates red",
      },
    ],
  });
}

export function assertIssueWorkerGuardrailMapping(docText: string): IssueWorkerGuardrailMappingRecord {
  if (!docText.includes(REQUIRED_SECTION_HEADING)) {
    throw new IssueWorkerGuardrailMappingError(
      "ISSUE_WORKER_GUARDRAIL_SECTION_MISSING",
      `automation doc must include ${REQUIRED_SECTION_HEADING}`,
    );
  }

  for (const ref of REQUIRED_REF_PATTERNS) {
    if (!ref.pattern.test(docText)) {
      throw new IssueWorkerGuardrailMappingError(
        "ISSUE_WORKER_GUARDRAIL_REF_MISSING",
        `automation doc must cite ${ref.id}`,
        { ref: ref.id },
      );
    }
  }

  for (const topic of REQUIRED_MAPPING_TOPICS) {
    if (!topic.pattern.test(docText)) {
      throw new IssueWorkerGuardrailMappingError(
        "ISSUE_WORKER_GUARDRAIL_TOPIC_MISSING",
        `automation doc must map ${topic.id}`,
        { topic: topic.id },
      );
    }
  }

  if (!/GUARDRAILS \(agent-native/i.test(docText)) {
    throw new IssueWorkerGuardrailMappingError(
      "ISSUE_WORKER_GUARDRAIL_PROMPT_TAG_MISSING",
      "embedded prompt GUARDRAILS block must reference agent-native mapping",
    );
  }

  return issueWorkerGuardrailMappingRecord();
}

function deepFreeze<T>(value: T): T {
  if (value && isJsonObject(value)) {
    // SAFETY: `for (const child of Object.values(value as JsonObject)) {` is required at this I/O or test boundary.
    for (const child of Object.values(value as JsonObject)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
