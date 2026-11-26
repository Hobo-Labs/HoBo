import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject, cloneAsJson, type JsonValue, type JsonObject, type JsonBag } from "./json.js";


export const POLICY_IR_SCHEMA_VERSION = "hobo.policy-ir/v1" as const;
export const POLICY_DECIDED_EVENT_TYPE = "policy.Decided" as const;

export const SUBJECT_KINDS = Object.freeze(["user", "service", "agent", "system"] as const);
export const PHASES = Object.freeze([
  "author",
  "local",
  "test",
  "plan",
  "apply",
  "runtime",
  "observe",
  "train",
  "promote",
  "repair",
] as const);
export const EFFECTS = Object.freeze([
  "allow",
  "allow-degraded",
  "deny",
  "warn",
  "mutate",
  "require-approval",
] as const);

export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export type Phase = (typeof PHASES)[number];
export type Effect = (typeof EFFECTS)[number];
export type Sha256Hash = `sha256:${string}`;

export interface PrincipalRef {
  kind: SubjectKind;
  id: string;
}

export interface DecisionSubject extends PrincipalRef {
  roles?: string[];
  scopes?: string[];
  delegatedBy?: PrincipalRef | string;
}

export interface DecisionResource {
  kind: string;
  id: string;
}

export interface DecisionRequest {
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  subject: DecisionSubject;
  action: string;
  resource: DecisionResource;
  phase: Phase;
  context: JsonObject;
  inputHash: Sha256Hash;
}

export interface DecisionEvidence {
  policyIds: string[];
  inputHash: Sha256Hash;
  engine: string;
}

export interface Decision {
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  effect: Effect;
  reason: string;
  violations: JsonValue[];
  mutations: JsonValue[];
  approvals: JsonValue[];
  obligations: Array<{ kind: string; [key: string]: JsonValue }>;
  evidence: DecisionEvidence;
}

export interface PolicyDecidedEvent {
  id: string;
  type: typeof POLICY_DECIDED_EVENT_TYPE;
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  subject: DecisionSubject;
  action: string;
  resource: DecisionResource;
  phase: Phase;
  data: Decision;
}

const SUBJECT_KIND_SET = new Set<string>(SUBJECT_KINDS);
const PHASE_SET = new Set<string>(PHASES);
const EFFECT_SET = new Set<string>(EFFECTS);

export class PolicyIrValidationError extends Error {
  code: string;
  path: string;

  constructor(code: string, message: string, path = "$") {
    super(`${code} at ${path}: ${message}`);
    this.name = "PolicyIrValidationError";
    this.code = code;
    this.path = path;
  }
}

export function createDecisionRequest<T>(input: T): DecisionRequest {
  return parseDecisionRequest(input);
}

export function parseDecisionRequest<T>(input: T): DecisionRequest {
  const source = expectObject(cloneAsJson(input), "$");
  assertVersion(source.schemaVersion, "$.schemaVersion");

  if (!Object.hasOwn(source, "subject")) {
    throw new PolicyIrValidationError(
      "missing-subject",
      "policy requests must name a subject explicitly",
      "$.subject",
    );
  }

  const request = {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: parseSubject(source.subject, "$.subject"),
    action: expectNonEmptyString(source.action, "$.action"),
    resource: parseResource(source.resource, "$.resource"),
    phase: parsePhase(source.phase, "$.phase"),
    context: parseDecisionContext(source.context),
  };
  const inputHash = hashDecisionRequest(request);

  if (source.inputHash !== undefined && source.inputHash !== inputHash) {
    throw new PolicyIrValidationError(
      "input-hash-mismatch",
      "provided inputHash does not match canonical request",
      "$.inputHash",
    );
  }

  return { ...request, inputHash };
}

export function createDecision<TRequest, TDecision>(requestInput: TRequest, decisionInput: TDecision): Decision {
  const request = parseDecisionRequest(cloneAsJson(requestInput));
  const decisionSource = expectObject(cloneAsJson(decisionInput), "$");
  return parseDecision(
    {
      schemaVersion: POLICY_IR_SCHEMA_VERSION,
      violations: [],
      mutations: [],
      approvals: [],
      obligations: [],
      ...decisionSource,
      evidence: {
        policyIds: [],
        // SAFETY: assertion to `...(decisionSource.evidence as JsonObject | undefined),` is required at this boundary.
        ...(decisionSource.evidence as JsonObject | undefined),
        inputHash: request.inputHash,
      },
    },
    request,
  );
}

export function parseDecision<TInput, TRequest>(input: TInput, requestInput?: TRequest): Decision {
  const source = expectObject(cloneAsJson(input), "$");
  assertVersion(source.schemaVersion, "$.schemaVersion");
  const request = requestInput === undefined ? undefined : parseDecisionRequest(requestInput);

  const decision: Decision = {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    effect: parseEffect(source.effect, "$.effect"),
    reason: expectNonEmptyString(source.reason, "$.reason"),
    violations: parseJsonArray(source.violations ?? [], "$.violations"),
    mutations: parseJsonArray(source.mutations ?? [], "$.mutations"),
    approvals: parseJsonArray(source.approvals ?? [], "$.approvals"),
    obligations: parseObligations(source.obligations ?? [], "$.obligations"),
    evidence: parseEvidence(source.evidence, request, "$.evidence"),
  };

  return decision;
}

export function serializePolicyIrDocument(documentInput: JsonValue): string {
  const document = parsePolicyIrDocument(documentInput);
  return canonicalJson(document);
}

export interface PolicyIrDocument {
  request: DecisionRequest;
  decision: Decision;
}

export function parsePolicyIrDocument(documentInput: JsonValue): PolicyIrDocument {
  const source =
    isJsonString(documentInput)
      ? expectObject(JSON.parse(documentInput), "$")
      : expectObject(documentInput, "$");
  const request = parseDecisionRequest(source.request);
  const decision = parseDecision(source.decision, request);
  return { request, decision };
}

export function migratePolicyIrDocument(documentInput: JsonValue): DecisionRequest {
  const source = expectObject(documentInput, "$");
  if (source.schemaVersion === POLICY_IR_SCHEMA_VERSION) {
    return parseDecisionRequest(source);
  }
  if (source.schemaVersion !== "hobo.policy-ir/v0") {
    throw new PolicyIrValidationError(
      "unsupported-version",
      `cannot migrate ${String(source.schemaVersion)}`,
      "$.schemaVersion",
    );
  }

  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: source.subjectKind,
      id: source.subjectId,
    },
    action: source.action,
    resource: {
      kind: source.resourceKind,
      id: source.resourceId,
    },
    phase: source.lifecycle,
    context: source.context ?? {},
  });
}

export function createPolicyDecidedEvent<TRequest, TDecision>({
  request: requestInput,
  decision: decisionInput,
  id,
}: {
  request: TRequest;
  decision: TDecision;
  id?: string;
}): PolicyDecidedEvent {
  const request = parseDecisionRequest(requestInput);
  const decision = parseDecision(decisionInput, request);
  return {
    id: id ?? `policy-decided-${decision.evidence.inputHash.slice("sha256:".length, 18)}`,
    type: POLICY_DECIDED_EVENT_TYPE,
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: request.subject,
    action: request.action,
    resource: request.resource,
    phase: request.phase,
    data: decision,
  };
}

export interface WitDecisionRecord {
  schema_version: typeof POLICY_IR_SCHEMA_VERSION | string;
  effect: Effect;
  reason: string;
  violations: JsonValue[];
  mutations: JsonValue[];
  approvals: JsonValue[];
  obligations: Array<{ kind: string; [key: string]: JsonValue }>;
  evidence: {
    policy_ids: string[];
    input_hash: Sha256Hash;
    engine: string;
  };
}

export function toWitDecisionRecord(decisionInput: JsonValue): WitDecisionRecord {
  const decision = parseDecision(decisionInput);
  return {
    schema_version: decision.schemaVersion,
    effect: decision.effect,
    reason: decision.reason,
    violations: decision.violations,
    mutations: decision.mutations,
    approvals: decision.approvals,
    obligations: decision.obligations,
    evidence: {
      policy_ids: decision.evidence.policyIds,
      input_hash: decision.evidence.inputHash,
      engine: decision.evidence.engine,
    },
  };
}

export function fromWitDecisionRecord(recordInput: JsonValue, requestInput?: JsonValue): Decision {
  const record = expectObject(recordInput, "$");
  return parseDecision(
    {
      schemaVersion: record.schema_version,
      effect: record.effect,
      reason: record.reason,
      violations: record.violations,
      mutations: record.mutations,
      approvals: record.approvals,
      obligations: record.obligations,
      evidence: {
        policyIds: expectObject(record.evidence, "$.evidence").policy_ids,
        inputHash: expectObject(record.evidence, "$.evidence").input_hash,
        engine: expectObject(record.evidence, "$.evidence").engine,
      },
    },
    requestInput,
  );
}

export function hashDecisionRequest<T>(requestInput: T): Sha256Hash {
  const source = expectObject(cloneAsJson(requestInput), "$");
  const request = {
    schemaVersion: source.schemaVersion,
    subject: source.subject,
    action: source.action,
    resource: source.resource,
    phase: source.phase,
    context: source.context ?? {},
  };
  const digest = createHash("sha256").update(canonicalJson(request)).digest("hex");
  return `sha256:${digest}`;
}

export function canonicalJson<T>(value: T): string {
  return JSON.stringify(canonicalJsonValue(cloneAsJson(value)));
}

function assertVersion(version: JsonValue, path: string): asserts version is typeof POLICY_IR_SCHEMA_VERSION {
  if (version !== POLICY_IR_SCHEMA_VERSION) {
    throw new PolicyIrValidationError(
      "unsupported-version",
      `expected ${POLICY_IR_SCHEMA_VERSION}`,
      path,
    );
  }
}

function parseSubject(input: JsonValue, path: string): DecisionSubject {
  const subject = expectObject(input, path);
  const kind = expectNonEmptyString(subject.kind, `${path}.kind`);
  if (!SUBJECT_KIND_SET.has(kind)) {
    throw new PolicyIrValidationError("unknown-subject-kind", kind, `${path}.kind`);
  }
  const parsed: DecisionSubject = {
    // SAFETY: assertion to `kind: kind as SubjectKind,` is required at this boundary.
    kind: kind as SubjectKind,
    id: expectNonEmptyString(subject.id, `${path}.id`),
  };
  if (subject.roles !== undefined) {
    parsed.roles = parseStringArray(subject.roles, `${path}.roles`);
  }
  if (subject.scopes !== undefined) {
    parsed.scopes = parseStringArray(subject.scopes, `${path}.scopes`);
  }
  if (subject.delegatedBy !== undefined) {
    parsed.delegatedBy = parseDelegatedBy(subject.delegatedBy, `${path}.delegatedBy`);
  }
  return parsed;
}

function parseDelegatedBy(input: JsonValue, path: string): PrincipalRef | string {
  if (isJsonString(input)) {
    return expectNonEmptyString(input, path);
  }
  const delegatedBy = expectObject(input, path);
  return {
    kind: parseSubjectKind(delegatedBy.kind, `${path}.kind`),
    id: expectNonEmptyString(delegatedBy.id, `${path}.id`),
  };
}

function parseSubjectKind(input: JsonValue, path: string): SubjectKind {
  const kind = expectNonEmptyString(input, path);
  if (!SUBJECT_KIND_SET.has(kind)) {
    throw new PolicyIrValidationError("unknown-subject-kind", kind, path);
  }
  // SAFETY: assertion to `return kind as SubjectKind;` is required at this boundary.
  return kind as SubjectKind;
}

function parseResource(input: JsonValue, path: string): DecisionResource {
  const resource = expectObject(input, path);
  return {
    kind: expectNonEmptyString(resource.kind, `${path}.kind`),
    id: expectNonEmptyString(resource.id, `${path}.id`),
  };
}

function parsePhase(input: JsonValue, path: string): Phase {
  const phase = expectNonEmptyString(input, path);
  if (!PHASE_SET.has(phase)) {
    throw new PolicyIrValidationError("unknown-phase", phase, path);
  }
  // SAFETY: assertion to `return phase as Phase;` is required at this boundary.
  return phase as Phase;
}

function parseEffect(input: JsonValue, path: string): Effect {
  const effect = expectNonEmptyString(input, path);
  if (!EFFECT_SET.has(effect)) {
    throw new PolicyIrValidationError("unknown-effect", effect, path);
  }
  // SAFETY: assertion to `return effect as Effect;` is required at this boundary.
  return effect as Effect;
}

function parseEvidence(
  input: JsonValue,
  request: DecisionRequest | undefined,
  path: string,
): DecisionEvidence {
  const evidence = expectObject(input, path);
  const inputHash = expectNonEmptyString(evidence.inputHash, `${path}.inputHash`);
  if (!/^sha256:[a-f0-9]{64}$/.test(inputHash)) {
    throw new PolicyIrValidationError("invalid-input-hash", inputHash, `${path}.inputHash`);
  }
  const parsed: DecisionEvidence = {
    policyIds: parseStringArray(evidence.policyIds, `${path}.policyIds`),
    // SAFETY: assertion to `inputHash: inputHash as Sha256Hash,` is required at this boundary.
    inputHash: inputHash as Sha256Hash,
    engine: expectNonEmptyString(evidence.engine, `${path}.engine`),
  };
  if (request !== undefined && parsed.inputHash !== request.inputHash) {
    throw new PolicyIrValidationError(
      "input-hash-mismatch",
      "decision evidence must cite the request hash",
      `${path}.inputHash`,
    );
  }
  return parsed;
}

function parseObligations(input: JsonValue, path: string): Decision["obligations"] {
  const obligations = parseJsonArray(input, path);
  return obligations.map((obligation, index) => {
    const parsed = expectObject(obligation, `${path}[${index}]`);
    expectNonEmptyString(parsed.kind, `${path}[${index}].kind`);
    // SAFETY: assertion to `return parsed as { kind: string; [key: string]: JsonValue };` is required at this boundary.
    return parsed as { kind: string; [key: string]: JsonValue };
  });
}

function parseJsonArray(input: JsonValue, path: string): JsonValue[] {
  if (!Array.isArray(input)) {
    throw new PolicyIrValidationError("expected-array", "expected an array", path);
  }
  return input.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
}

function parseStringArray(input: JsonValue, path: string): string[] {
  if (!Array.isArray(input)) {
    throw new PolicyIrValidationError("expected-array", "expected an array", path);
  }
  return input.map((item, index) => expectNonEmptyString(item, `${path}[${index}]`));
}

function expectNonEmptyString(input: JsonValue, path: string): string {
  if (!isJsonString(input) || input.trim() === "") {
    throw new PolicyIrValidationError("expected-string", "expected a non-empty string", path);
  }
  return input;
}

function parseDecisionContext(input: JsonValue | undefined): JsonObject {
  if (input === undefined) {
    return {};
  }
  // SAFETY: canonical JSON of the context object is a JsonObject at this boundary.
  const context: JsonObject = canonicalJsonValue(input, "$.context") as JsonObject;
  return context;
}

function expectObject(input: JsonValue, path: string): JsonObject {
  if (!isPlainObject(input)) {
    throw new PolicyIrValidationError("expected-object", "expected a JSON object", path);
  }
  return input;
}

function isPlainObject(input: JsonValue): input is JsonObject {
  return (
    input !== null &&
    isJsonObject(input) &&
    !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
  );
}

function canonicalJsonValue(input: JsonValue, path = "$"): JsonValue {
  if (input === null) {
    return null;
  }
  if (isJsonString(input) || isJsonBoolean(input)) {
    return input;
  }
  if (isJsonNumber(input)) {
    if (!Number.isFinite(input)) {
      throw new PolicyIrValidationError("invalid-json-number", "number must be finite", path);
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item, index) => canonicalJsonValue(item, `${path}[${index}]`));
  }
  if (isPlainObject(input)) {
    const output: JsonBag = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) {
        throw new PolicyIrValidationError(
          "invalid-json-value",
          "undefined is not valid JSON",
          `${path}.${key}`,
        );
      }
      output[key] = canonicalJsonValue(input[key], `${path}.${key}`);
    }
    return output;
  }
  throw new PolicyIrValidationError("invalid-json-value", "expected a JSON value", path);
}
