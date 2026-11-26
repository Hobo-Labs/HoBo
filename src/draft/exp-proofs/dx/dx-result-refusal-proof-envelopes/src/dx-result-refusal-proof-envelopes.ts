import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const REQUIRED_ENVELOPE_KINDS = [
  "success",
  "plan-warning",
  "gatekeeper-denial",
  "approval-required",
  "contract-incompatibility",
  "stale-projection",
  "unknown-evidence",
  "non-reactive-sink",
  "migration-blocked",
  "rollback-available",
  "support-handoff",
] as const;

const PROOF_MODES = ["live", "simulated", "reference-fixture", "scope-out"] as const;
const REDACTION_CLASSES = ["public-safe", "tenant-safe", "support-redacted", "internal-only"] as const;
const OUTCOMES = ["success", "warning", "refusal", "handoff"] as const;

export type EnvelopeKind = (typeof REQUIRED_ENVELOPE_KINDS)[number];
export type ProofMode = (typeof PROOF_MODES)[number];
export type RedactionClass = (typeof REDACTION_CLASSES)[number];
export type EnvelopeOutcome = (typeof OUTCOMES)[number];

// domain-view: parse-produced draft-proof record; its wire form is the DxResultEnvelope proto message in data-models/.
export interface DxResultEnvelope {
  kind: EnvelopeKind;
  outcome: EnvelopeOutcome;
  humanCopy: string;
  code: string;
  remediation: string;
  proofMode: ProofMode;
  fixtureId: string;
  traceId: string;
  correlationId: string;
  redactionClass: RedactionClass;
  accessibilityNotes: string[];
  copyNotes: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the DxResultRefusalProof proto message in data-models/.
export interface DxResultRefusalProof {
  issue: "HOBO-571";
  phase: "M1";
  audience: {
    personas: string[];
    accessibilityNeeds: string[];
    successCriteria: string[];
  };
  mockedBoundaries: string[];
  references: string[];
  envelopes: DxResultEnvelope[];
}

export interface SdkConsumerExample {
  kind: EnvelopeKind;
  outcome: EnvelopeOutcome;
  call: string;
  result: {
    ok: boolean;
    code: string;
    message: string;
    remediation: string;
    proofMode: ProofMode;
    fixtureId: string;
    traceId: string;
    correlationId: string;
    redactionClass: RedactionClass;
  };
}

export interface CliJsonExample {
  kind: EnvelopeKind;
  outcome: EnvelopeOutcome;
  command: string;
  json: {
    ok: boolean;
    code: string;
    message: string;
    remediation: string;
    proof_mode: ProofMode;
    fixture_id: string;
    trace_id: string;
    correlation_id: string;
    redaction_class: RedactionClass;
  };
}

export interface McpToolResultExample {
  kind: EnvelopeKind;
  outcome: EnvelopeOutcome;
  tool: string;
  toolResult: {
    isError: boolean;
    content: Array<{
      type: "json";
      code: string;
      message: string;
      remediation: string;
      proofMode: ProofMode;
      fixtureId: string;
      traceId: string;
      correlationId: string;
      redactionClass: RedactionClass;
    }>;
  };
}

export interface DeterministicFixtureRecord {
  kind: EnvelopeKind;
  code: string;
  fixtureId: string;
  proofMode: ProofMode;
  traceId: string;
  correlationId: string;
  redactionClass: RedactionClass;
}

// domain-view: parse-produced draft-proof record; its wire form is the DeterministicFixtureSet proto message in data-models/.
export interface DeterministicFixtureSet {
  schema: "hobo.dx-result-refusal-proof-envelopes/fixture-set/v1";
  issue: "HOBO-571";
  happyPaths: DeterministicFixtureRecord[];
  failClosedPaths: DeterministicFixtureRecord[];
  stableDigest: string;
}

export const DX_RESULT_REFUSAL_PROOF_ENVELOPES = {
  issue: "HOBO-571",
  phase: "M1",
  audience: {
    personas: [
      "app developer",
      "platform engineer",
      "GitOps operator",
      "SecOps reviewer",
      "DevOps release owner",
      "SRE",
      "agent/MCP caller",
    ],
    accessibilityNeeds: [
      "terminal output must be screen-reader friendly",
      "machine codes must not be encoded only in color",
      "copy must name state before remediation",
    ],
    successCriteria: [
      "same case shape appears in SDK, CLI JSON, and MCP tool result examples",
      "failure and uncertainty are explicit instead of optimistic",
      "every example names proof mode and deterministic fixture evidence",
    ],
  },
  mockedBoundaries: [
    "Production CLI/API/SDK execution",
    "Live provider calls",
    "Customer data",
    "Support routing systems",
    "Production telemetry",
  ],
  references: [
    "docs/design/developer-experience.md",
    "docs/design/sdk-api.md",
    "docs/design/control-plane.md",
    "docs/design/platform-engineering.md",
    "docs/design/data-plane.md",
  ],
  envelopes: [
    envelope("success", "success", {
      humanCopy: "Plan accepted from reference fixture evidence; no live deploy occurred.",
      code: "hobo.dx.success",
      remediation: "Continue with the next fixture-backed lifecycle step.",
      proofMode: "reference-fixture",
      redactionClass: "public-safe",
    }),
    envelope("plan-warning", "warning", {
      humanCopy: "Plan is usable but carries a portability, cost, or capability warning.",
      code: "hobo.dx.plan-warning",
      remediation: "Review the warning and decide whether to accept, pin, or change the resource request.",
      proofMode: "simulated",
      redactionClass: "tenant-safe",
    }),
    envelope("gatekeeper-denial", "refusal", {
      humanCopy: "Gatekeeper denied the action because policy, contract, eval, conformance, or cost evidence failed.",
      code: "hobo.dx.gatekeeper-denial",
      remediation: "Fix the denied evidence or request an explicit governed waiver.",
      proofMode: "reference-fixture",
      redactionClass: "tenant-safe",
    }),
    envelope("approval-required", "refusal", {
      humanCopy: "The action is understood but cannot continue until a required approval obligation is satisfied.",
      code: "hobo.dx.approval-required",
      remediation: "Route the approval request to the named approver role and retry after the obligation closes.",
      proofMode: "reference-fixture",
      redactionClass: "tenant-safe",
    }),
    envelope("contract-incompatibility", "refusal", {
      humanCopy: "The requested change is incompatible with a running consumer or provider contract.",
      code: "hobo.dx.contract-incompatibility",
      remediation: "Apply a compatible shim, update deployment order, or split the migration window.",
      proofMode: "reference-fixture",
      redactionClass: "tenant-safe",
    }),
    envelope("stale-projection", "refusal", {
      humanCopy: "The read model is stale or lagged, so HoBo cannot claim current state confidently.",
      code: "hobo.dx.stale-projection",
      remediation: "Wait for projection freshness or inspect the event-derived stale-state evidence.",
      proofMode: "simulated",
      redactionClass: "tenant-safe",
    }),
    envelope("unknown-evidence", "refusal", {
      humanCopy: "Required evidence is unknown, missing, or outside the accepted proof boundary.",
      code: "hobo.dx.unknown-evidence",
      remediation: "Attach accepted fixture evidence or route the gap to the owning slice.",
      proofMode: "scope-out",
      redactionClass: "internal-only",
    }),
    envelope("non-reactive-sink", "refusal", {
      humanCopy: "The sink can serve a snapshot but cannot prove reactive push behavior.",
      code: "hobo.dx.non-reactive-sink",
      remediation: "Use a change-feed-capable sink or label the view as snapshot-only.",
      proofMode: "simulated",
      redactionClass: "tenant-safe",
    }),
    envelope("migration-blocked", "refusal", {
      humanCopy: "The migration contract phase would break a still-running version.",
      code: "hobo.dx.migration-blocked",
      remediation: "Run an expand or compatibility phase before attempting the destructive contract phase.",
      proofMode: "reference-fixture",
      redactionClass: "tenant-safe",
    }),
    envelope("rollback-available", "warning", {
      humanCopy: "Rollback is available for this fixture and names the previous immutable Set.",
      code: "hobo.dx.rollback-available",
      remediation: "Use the named rollback target if the current change fails verification.",
      proofMode: "reference-fixture",
      redactionClass: "public-safe",
    }),
    envelope("support-handoff", "handoff", {
      humanCopy: "Support handoff can proceed with a redacted evidence pack and owner route.",
      code: "hobo.dx.support-handoff",
      remediation: "Attach the redacted support bundle and preserve customer-safe wording.",
      proofMode: "reference-fixture",
      redactionClass: "support-redacted",
    }),
  ],
} satisfies DxResultRefusalProof;

export function parseDxResultRefusalProof(input: JsonValue): DxResultRefusalProof {
  // SAFETY: `const record = requireObject(input, "record") as Partial<DxResultRefusalProof>;` is required at this I/O or test boundary.
  const record = requireObject(input, "record") as Partial<DxResultRefusalProof>;
  if (record.issue !== "HOBO-571") {
    throw new Error("issue must be HOBO-571");
  }
  if (record.phase !== "M1") {
    throw new Error("phase must be M1");
  }
  requireStringArray(record.mockedBoundaries, "mockedBoundaries");
  requireStringArray(record.references, "references");
  requireStringArray(record.audience?.personas, "audience.personas");
  requireStringArray(record.audience?.accessibilityNeeds, "audience.accessibilityNeeds");
  requireStringArray(record.audience?.successCriteria, "audience.successCriteria");
  if (!Array.isArray(record.envelopes)) {
    throw new TypeError("envelopes must be an array");
  }

  const byKind = new Map<string, unknown>();
  for (const rawEnvelope of record.envelopes) {
    // SAFETY: `const raw = requireObject(rawEnvelope, "envelope") as { kind?: unknown };` is required at this I/O or test boundary.
    const raw = requireObject(rawEnvelope, "envelope") as { kind?: unknown };
    const kind = requireString(raw.kind, "envelope.kind");
    if (byKind.has(kind)) {
      throw new Error(`duplicate envelope kind ${kind}`);
    }
    byKind.set(kind, rawEnvelope);
  }

  const envelopes = REQUIRED_ENVELOPE_KINDS.map((kind) => {
    const raw = byKind.get(kind);
    if (!raw) {
      throw new Error(`missing required envelope kind ${kind}`);
    }
    return parseEnvelope(raw, kind);
  });

  return {
    issue: "HOBO-571",
    phase: "M1",
    // SAFETY: `audience: record.audience as DxResultRefusalProof["audience"],` is required at this I/O or test boundary.
    audience: record.audience as DxResultRefusalProof["audience"],
    // SAFETY: `mockedBoundaries: record.mockedBoundaries as string[],` is required at this I/O or test boundary.
    mockedBoundaries: record.mockedBoundaries as string[],
    // SAFETY: `references: record.references as string[],` is required at this I/O or test boundary.
    references: record.references as string[],
    envelopes,
  };
}

export function buildSdkConsumerExamples(record: DxResultRefusalProof): SdkConsumerExample[] {
  return record.envelopes.map((result) => ({
    kind: result.kind,
    outcome: result.outcome,
    call: `await hobo.planOrExplain("${result.fixtureId}")`,
    result: {
      ok: !isFailureOutcome(result.outcome),
      code: result.code,
      message: result.humanCopy,
      remediation: result.remediation,
      proofMode: result.proofMode,
      fixtureId: result.fixtureId,
      traceId: result.traceId,
      correlationId: result.correlationId,
      redactionClass: result.redactionClass,
    },
  }));
}

export function buildCliJsonExamples(record: DxResultRefusalProof): CliJsonExample[] {
  return record.envelopes.map((result) => ({
    kind: result.kind,
    outcome: result.outcome,
    command: `hobo plan --fixture ${result.fixtureId} --json`,
    json: {
      ok: !isFailureOutcome(result.outcome),
      code: result.code,
      message: result.humanCopy,
      remediation: result.remediation,
      proof_mode: result.proofMode,
      fixture_id: result.fixtureId,
      trace_id: result.traceId,
      correlation_id: result.correlationId,
      redaction_class: result.redactionClass,
    },
  }));
}

export function buildMcpToolResultExamples(record: DxResultRefusalProof): McpToolResultExample[] {
  return record.envelopes.map((result) => ({
    kind: result.kind,
    outcome: result.outcome,
    tool: "hobo.plan_or_explain",
    toolResult: {
      isError: isFailureOutcome(result.outcome),
      content: [
        {
          type: "json",
          code: result.code,
          message: result.humanCopy,
          remediation: result.remediation,
          proofMode: result.proofMode,
          fixtureId: result.fixtureId,
          traceId: result.traceId,
          correlationId: result.correlationId,
          redactionClass: result.redactionClass,
        },
      ],
    },
  }));
}

export function createDeterministicFixtureSet(record: DxResultRefusalProof): DeterministicFixtureSet {
  const fixtures = record.envelopes.map((result) => ({
    kind: result.kind,
    code: result.code,
    fixtureId: result.fixtureId,
    proofMode: result.proofMode,
    traceId: result.traceId,
    correlationId: result.correlationId,
    redactionClass: result.redactionClass,
  }));

  const unsignedFixtureSet: Omit<DeterministicFixtureSet, "stableDigest"> = {
    schema: "hobo.dx-result-refusal-proof-envelopes/fixture-set/v1",
    issue: record.issue,
    happyPaths: fixtures.filter((fixture) =>
      ["success", "plan-warning", "rollback-available", "support-handoff"].includes(fixture.kind),
    ),
    failClosedPaths: fixtures.filter((fixture) =>
      [
        "gatekeeper-denial",
        "approval-required",
        "contract-incompatibility",
        "stale-projection",
        "unknown-evidence",
        "non-reactive-sink",
        "migration-blocked",
      ].includes(fixture.kind),
    ),
  };

  return {
    ...unsignedFixtureSet,
    stableDigest: stableFixtureDigest(unsignedFixtureSet),
  };
}

export function stableFixtureDigest(value: JsonValue): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function classifyOptimisticClaim(claim: string) {
  const normalized = claim.toLowerCase();
  const optimistic =
    /\b(success|succeeded|ready|green|production|live)\b/.test(normalized) &&
    !/\b(reference fixture|simulated|accepted fixture|accepted proof)\b/.test(normalized);
  const deniesEvidence = /\bwithout\b.*\b(fixture|evidence|proof)\b|\bno\b.*\b(evidence|proof)\b/.test(normalized);

  if (optimistic || deniesEvidence) {
    return {
      allowed: false,
      reason: "live or production success needs accepted fixture evidence before this proof may claim it",
      route: "dx-result-refusal-proof-envelopes",
    };
  }

  return {
    allowed: true,
    reason: "claim is scoped to accepted proof evidence",
    route: "dx-result-refusal-proof-envelopes",
  };
}

function isFailureOutcome(outcome: EnvelopeOutcome): boolean {
  return outcome === "refusal";
}

function envelope(
  kind: EnvelopeKind,
  outcome: EnvelopeOutcome,
  fields: Pick<DxResultEnvelope, "humanCopy" | "code" | "remediation" | "proofMode" | "redactionClass">,
): DxResultEnvelope {
  return {
    kind,
    outcome,
    ...fields,
    fixtureId: `fixture:dx-result:${kind}`,
    traceId: `trace-dx-${kind}`,
    correlationId: `corr-dx-${kind}`,
    accessibilityNotes: [
      "State appears before remediation.",
      "Machine code is visible in text and JSON.",
    ],
    copyNotes: [
      "Avoid optimistic success wording without proof evidence.",
      "Keep proof mode visible to humans and agents.",
    ],
  };
}

function parseEnvelope(input: JsonValue, expectedKind: EnvelopeKind): DxResultEnvelope {
  // SAFETY: `const envelopeRecord = requireObject(input, expectedKind) as Partial<DxResultEnv` is required at this I/O or test boundary.
  const envelopeRecord = requireObject(input, expectedKind) as Partial<DxResultEnvelope>;
  if (envelopeRecord.kind !== expectedKind) {
    throw new Error(`${expectedKind} kind mismatch`);
  }
  const outcome = requireEnum(envelopeRecord.outcome, OUTCOMES, `${expectedKind} outcome`);
  const proofMode = requireEnum(envelopeRecord.proofMode, PROOF_MODES, `${expectedKind} proofMode`);
  const redactionClass = requireEnum(
    envelopeRecord.redactionClass,
    REDACTION_CLASSES,
    `${expectedKind} redactionClass`,
  );
  const code = requireString(envelopeRecord.code, `${expectedKind} code`);
  if (!/^hobo\.dx\.[a-z0-9-]+$/.test(code)) {
    throw new Error(`${expectedKind} code must be hobo.dx.*`);
  }

  return {
    kind: expectedKind,
    outcome,
    humanCopy: requireString(envelopeRecord.humanCopy, `${expectedKind} humanCopy`),
    code,
    remediation: requireString(envelopeRecord.remediation, `${expectedKind} remediation`),
    proofMode,
    fixtureId: requirePrefixedString(envelopeRecord.fixtureId, `${expectedKind} fixtureId`, "fixture:dx-result:"),
    traceId: requirePrefixedString(envelopeRecord.traceId, `${expectedKind} traceId`, "trace-dx-"),
    correlationId: requirePrefixedString(envelopeRecord.correlationId, `${expectedKind} correlationId`, "corr-dx-"),
    redactionClass,
    accessibilityNotes: requireStringArray(envelopeRecord.accessibilityNotes, `${expectedKind} accessibilityNotes`),
    copyNotes: requireStringArray(envelopeRecord.copyNotes, `${expectedKind} copyNotes`),
  };
}

function requireObject(input: JsonValue, fieldName: string): JsonObject {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  // SAFETY: `return input as JsonObject;` is required at this I/O or test boundary.
  return input as JsonObject;
}

function requireString(input: JsonValue, fieldName: string): string {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be non-empty`);
  }
  return input;
}

function requirePrefixedString(input: JsonValue, fieldName: string, prefix: string): string {
  const value = requireString(input, fieldName);
  if (!value.startsWith(prefix)) {
    throw new Error(`${fieldName} must start with ${prefix}`);
  }
  return value;
}

function requireStringArray(input: JsonValue, fieldName: string): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function requireEnum<const T extends readonly string[]>(input: JsonValue, allowed: T, fieldName: string): T[number] {
  const value = requireString(input, fieldName);
  if (!allowed.includes(value)) {
    throw new Error(`${fieldName} must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function stableJson(value: JsonValue): string {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  // SAFETY: `const object = value as JsonObject;` is required at this I/O or test boundary.
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}
