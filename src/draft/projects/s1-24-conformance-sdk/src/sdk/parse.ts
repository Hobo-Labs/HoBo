import { canonicalJson } from "./canonical-json.js";
import {
  SEMANTICS_ANNEX_SPEC_VERSION,
  type AnnexCategory,
  type CancellationSignal,
  type CollectionFact,
  type LoweringFixture,
  type LowerProgram,
  type LaneStatus,
  type ManifestIr,
  type SdkConformanceReport,
  type SemanticsAnnexVector,
  type VectorCaseResult,
  type WitCall,
  type WitResult,
} from "./types.js";
import { asJsonObject, isJsonNumber, isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "../json.js";


const ANNEX_CATEGORIES = new Set<AnnexCategory>([
  "error-mapping",
  "cancellation",
  "async-ordering",
  "ifc-side-effects",
]);

const REQUIRED_LANES = [
  "golden-ir-lowering-equivalence",
  "semantics-annex",
] as const;

export function parseSemanticsAnnexVectors(raw: JsonValue): SemanticsAnnexVector[] {
  const envelope = readObject(raw, "semantics annex vectors");
  const vectors = readArray(envelope.semantics ?? envelope, "semantics annex vectors");

  return vectors.map((entry, index) => parseSemanticsAnnexVector(entry, index));
}

interface SemanticsAnnexVectorDraft {
  name: string;
  category: AnnexCategory;
  specVersion: typeof SEMANTICS_ANNEX_SPEC_VERSION;
  result?: WitResult<JsonValue>;
  expectedThrow?: { name: string; tag: string };
  signal?: CancellationSignal;
  expected?: WitResult<JsonValue>;
  facts?: readonly CollectionFact[];
  expectedError?: string;
}

function parseSemanticsAnnexVector(raw: JsonValue, index: number): SemanticsAnnexVector {
  const record = readObject(raw, `semantics annex vector[${index}]`);
  const name = readNonEmptyString(record.name, `semantics annex vector[${index}].name`);
  const category = parseAnnexCategory(record.category, index);

  const specVersion = record.spec_version ?? record.specVersion ?? SEMANTICS_ANNEX_SPEC_VERSION;
  if (specVersion !== SEMANTICS_ANNEX_SPEC_VERSION) {
    throw new TypeError(
      `CUE #SpecVersion: semantics annex vector[${index}] must use ${SEMANTICS_ANNEX_SPEC_VERSION}`,
    );
  }

  const vector: SemanticsAnnexVectorDraft = {
    name,
    category,
    specVersion: SEMANTICS_ANNEX_SPEC_VERSION,
  };

  if (record.result !== undefined) {
    vector.result = parseWitResult(record.result, `semantics annex vector[${index}].result`);
  }
  if (record.expectedThrow !== undefined) {
    vector.expectedThrow = parseExpectedThrow(
      record.expectedThrow,
      `semantics annex vector[${index}].expectedThrow`,
    );
  }
  if (record.signal !== undefined) {
    vector.signal = parseCancellationSignal(record.signal, `semantics annex vector[${index}].signal`);
  }
  if (record.expected !== undefined) {
    vector.expected = parseWitResult(record.expected, `semantics annex vector[${index}].expected`);
  }
  if (record.facts !== undefined) {
    vector.facts = readArray(record.facts, `semantics annex vector[${index}].facts`).map((entry, factIndex) =>
      parseCollectionFact(entry, `semantics annex vector[${index}].facts[${factIndex}]`),
    );
  }
  if (isJsonString(record.expectedError)) {
    vector.expectedError = record.expectedError;
  }

  return Object.freeze(vector);
}

function parseAnnexCategory(value: JsonValue | undefined, index: number): AnnexCategory {
  if (value === "error-mapping" || value === "cancellation" || value === "async-ordering" || value === "ifc-side-effects") {
    return value;
  }
  throw new TypeError(
    `CUE #AnnexCategory: semantics annex vector[${index}].category must be one of ${[...ANNEX_CATEGORIES].join(", ")}`,
  );
}

export function parseLoweringCorpus(raw: JsonValue): LoweringFixture[] {
  const fixtures = readArray(raw, "lowering corpus");
  if (fixtures.length === 0) {
    throw new TypeError("lowering corpus must be non-empty");
  }

  return fixtures.map((entry, index) => {
    const record = readObject(entry, `lowering fixture[${index}]`);
    const name = readNonEmptyString(record.name, `lowering fixture[${index}].name`);
    const program = readObject(record.program, `lowering fixture[${index}].program`);
    const expectedWitCalls = readArray(
      record.expectedWitCalls,
      `lowering fixture[${index}].expectedWitCalls`,
    );
    const expectedManifest = readObject(
      record.expectedManifest,
      `lowering fixture[${index}].expectedManifest`,
    );

    if (expectedManifest.schema !== "hobo.manifest/v1") {
      throw new TypeError(
        `lowering fixture[${index}].expectedManifest.schema must be hobo.manifest/v1`,
      );
    }

    return Object.freeze({
      name,
      program: parseLowerProgram(program, `lowering fixture[${index}].program`),
      expectedWitCalls: expectedWitCalls.map((call, callIndex) =>
        parseWitCall(call, `lowering fixture[${index}].expectedWitCalls[${callIndex}]`),
      ),
      expectedManifest: parseManifestIr(expectedManifest, `lowering fixture[${index}].expectedManifest`),
    });
  });
}

export function parseSdkConformanceReport(raw: JsonValue): SdkConformanceReport {
  const record = readObject(raw, "sdk conformance report");

  if (record.suite !== "@hobo/conformance/sdk") {
    throw new TypeError('CUE #SdkConformanceReport: suite must be "@hobo/conformance/sdk"');
  }
  if (record.contract !== "hobo:sdk@0.1.0") {
    throw new TypeError('CUE #SdkConformanceReport: contract must be "hobo:sdk@0.1.0"');
  }
  if (record.status !== "passed" && record.status !== "failed") {
    throw new TypeError('CUE #LaneStatus: report.status must be "passed" or "failed"');
  }
  if (
    !isJsonString(record.corpusClaim) ||
    !record.corpusClaim.includes("bounded by the checked corpus")
  ) {
    throw new TypeError("CUE #SdkConformanceReport: corpus_claim must include bounded-by-corpus text");
  }

  const lanes = readArray(record.lanes, "sdk conformance report.lanes").map((lane, index) =>
    parseLaneReport(lane, index),
  );

  for (const requiredLane of REQUIRED_LANES) {
    if (!lanes.some((lane) => lane.lane === requiredLane)) {
      throw new TypeError(`CUE #SdkConformanceReport: missing required lane ${requiredLane}`);
    }
  }

  return Object.freeze({
    suite: "@hobo/conformance/sdk",
    contract: "hobo:sdk@0.1.0",
    layerName: readNonEmptyString(record.layerName, "sdk conformance report.layerName"),
    authorship: record.authorship === "generated" ? "generated" : "hand-authored",
    status: record.status,
    corpusClaim: record.corpusClaim,
    lanes,
  });
}

function parseLaneReport(raw: JsonValue, index: number) {
  const record = readObject(raw, `sdk conformance report.lanes[${index}]`);
  const lane = readNonEmptyString(record.lane, `sdk conformance report.lanes[${index}].lane`);
  const status = record.status;
  if (status !== "passed" && status !== "failed") {
    throw new TypeError(`CUE #LaneStatus: lanes[${index}].status must be passed or failed`);
  }

  const cases = readArray(record.cases, `sdk conformance report.lanes[${index}].cases`).map(
    (entry, caseIndex) => parseVectorCaseResult(entry, index, caseIndex),
  );

  return Object.freeze({
    lane,
    status,
    ...(record.boundedByCorpus === true ? { boundedByCorpus: true as const } : undefined),
    cases,
  });
}

interface VectorCaseDraft {
  name: string;
  category?: string;
  status: LaneStatus;
  reason?: string;
  expectedJson?: string;
  actualJson?: string;
  diffPaths?: string[];
}

function parseVectorCaseResult(raw: JsonValue, laneIndex: number, caseIndex: number): VectorCaseResult {
  const record = readObject(raw, `lanes[${laneIndex}].cases[${caseIndex}]`);
  const status = record.status;
  if (status !== "passed" && status !== "failed") {
    throw new TypeError(
      `CUE #LaneStatus: lanes[${laneIndex}].cases[${caseIndex}].status must be passed or failed`,
    );
  }

  const base: VectorCaseDraft = {
    name: readNonEmptyString(record.name, `lanes[${laneIndex}].cases[${caseIndex}].name`),
    status,
  };

  if (isJsonString(record.category)) {
    base.category = record.category;
  }
  if (isJsonString(record.reason)) {
    base.reason = record.reason;
  }
  const expectedJson =
    isJsonString(record.expectedJson)
      ? record.expectedJson
      : isJsonString(record.expected_json)
        ? record.expected_json
        : undefined;
  if (expectedJson !== undefined) {
    base.expectedJson = expectedJson;
  }
  const actualJson =
    isJsonString(record.actualJson)
      ? record.actualJson
      : isJsonString(record.actual_json)
        ? record.actual_json
        : undefined;
  if (actualJson !== undefined) {
    base.actualJson = actualJson;
  }
  const rawDiffPaths = Array.isArray(record.diffPaths)
    ? record.diffPaths
    : Array.isArray(record.diff_paths)
      ? record.diff_paths
      : undefined;
  if (rawDiffPaths !== undefined) {
    base.diffPaths = readStringArray(
      rawDiffPaths,
      `lanes[${laneIndex}].cases[${caseIndex}].diffPaths`,
    );
  }

  if (status === "failed") {
    if (!base.reason) {
      throw new TypeError(
        `CUE #VectorCaseResult: failed case lanes[${laneIndex}].cases[${caseIndex}] must include reason`,
      );
    }
    if (!base.expectedJson || !base.actualJson || !base.diffPaths || base.diffPaths.length === 0) {
      throw new TypeError(
        `CUE #VectorCaseResult: failed case lanes[${laneIndex}].cases[${caseIndex}] must include expected_json, actual_json, and diff_paths`,
      );
    }
  }

  return Object.freeze(base);
}

function parseWitResult(value: JsonValue | undefined, label: string): WitResult<JsonValue> {
  const record = readObject(value, label);
  const result: WitResult<JsonValue> = {};
  if (record.ok !== undefined) {
    result.ok = record.ok;
  }
  if (record.err !== undefined) {
    const err = readObject(record.err, `${label}.err`);
    const parsedErr: WitErrorRecord = {
      tag: readNonEmptyString(err.tag, `${label}.err.tag`),
    };
    if (isJsonString(err.message)) {
      parsedErr.message = err.message;
    }
    if (isJsonNumber(err.deadlineMs)) {
      parsedErr.deadlineMs = err.deadlineMs;
    }
    if (isJsonString(err.retry)) {
      parsedErr.retry = err.retry;
    }
    result.err = parsedErr;
  }
  return result;
}

interface ExpectedThrow {
  name: string;
  tag: string;
}

interface WitErrorRecord {
  tag: string;
  message?: string;
  deadlineMs?: number;
  retry?: string;
}

interface ManifestResource {
  kind: string;
  name: string;
  allow?: JsonValue;
}

function parseExpectedThrow(value: JsonValue | undefined, label: string): ExpectedThrow {
  const record = readObject(value, label);
  return {
    name: readNonEmptyString(record.name, `${label}.name`),
    tag: readNonEmptyString(record.tag, `${label}.tag`),
  };
}

function parseCancellationSignal(value: JsonValue | undefined, label: string): CancellationSignal {
  const record = readObject(value, label);
  const signal: CancellationSignal = {
    reason: readNonEmptyString(record.reason, `${label}.reason`),
  };
  if (isJsonNumber(record.deadlineMs)) {
    signal.deadlineMs = record.deadlineMs;
  }
  return signal;
}

function parseCollectionFact(value: JsonValue | undefined, label: string): CollectionFact {
  const record = readObject(value, label);
  if (record.kind !== "resource" && record.kind !== "handler") {
    throw new TypeError(`${label}.kind must be resource or handler`);
  }
  if (!isJsonNumber(record.sequence)) {
    throw new TypeError(`${label}.sequence must be a number`);
  }
  const fact: CollectionFact = {
    sequence: record.sequence,
    kind: record.kind,
  };
  if (isJsonString(record.name)) {
    fact.name = record.name;
  }
  if (isJsonString(record.resource)) {
    fact.resource = record.resource;
  }
  if (isJsonString(record.event)) {
    fact.event = record.event;
  }
  return fact;
}

function parseLowerProgram(value: JsonObject, label: string): LowerProgram {
  const resources = readArray(value.resources, `${label}.resources`).map((entry, index) => {
    const record = readObject(entry, `${label}.resources[${index}]`);
    return {
      kind: readNonEmptyString(record.kind, `${label}.resources[${index}].kind`),
      name: readNonEmptyString(record.name, `${label}.resources[${index}].name`),
    };
  });
  if (value.handlers === undefined) {
    return {
      bindle: readNonEmptyString(value.bindle, `${label}.bindle`),
      resources,
    };
  }
  return {
    bindle: readNonEmptyString(value.bindle, `${label}.bindle`),
    resources,
    handlers: parseHandlers(value.handlers, `${label}.handlers`),
  };
}

function parseHandlers(value: JsonValue | undefined, label: string): NonNullable<LowerProgram["handlers"]> {
  return readArray(value, label).map((entry, index) => {
    const record = readObject(entry, `${label}[${index}]`);
    return {
      resource: readNonEmptyString(record.resource, `${label}[${index}].resource`),
      event: readNonEmptyString(record.event, `${label}[${index}].event`),
      exportName: readNonEmptyString(record.exportName, `${label}[${index}].exportName`),
    };
  });
}

function parseWitCall(value: JsonValue | undefined, label: string): WitCall {
  const record = readObject(value, label);
  return {
    interface: readNonEmptyString(record.interface, `${label}.interface`),
    function: readNonEmptyString(record.function, `${label}.function`),
    args: readObject(record.args === undefined ? {} : record.args, `${label}.args`),
  };
}

function parseManifestIr(value: JsonObject, label: string): ManifestIr {
  const resources = readArray(value.resources, `${label}.resources`).map((entry, index) => {
    const record = readObject(entry, `${label}.resources[${index}]`);
    const resource: ManifestResource = {
      kind: readNonEmptyString(record.kind, `${label}.resources[${index}].kind`),
      name: readNonEmptyString(record.name, `${label}.resources[${index}].name`),
    };
    if (record.allow !== undefined) {
      resource.allow = record.allow;
    }
    return resource;
  });
  const extra: JsonBag = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key !== "schema" && key !== "bindle" && key !== "resources" && key !== "handlers") {
      extra[key] = nested;
    }
  }
  return {
    ...extra,
    schema: "hobo.manifest/v1",
    bindle: readNonEmptyString(value.bindle, `${label}.bindle`),
    resources,
    ...(value.handlers !== undefined
      ? { handlers: parseHandlers(value.handlers, `${label}.handlers`) }
      : undefined),
  };
}

function readStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be a string array`);
  }
  const entries: string[] = [];
  for (const entry of value) {
    if (!isJsonString(entry)) {
      throw new TypeError(`${label} must be a string array`);
    }
    entries.push(entry);
  }
  return entries;
}

function readObject(value: JsonValue | undefined, label: string): JsonObject {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  // SAFETY: `return value as JsonObject;` is required at this I/O or test boundary.
  return value as JsonObject;
}

function readArray(value: JsonValue | undefined, label: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function readNonEmptyString(value: JsonValue | undefined, label: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function serializeReportForPact(report: SdkConformanceReport): JsonObject {
  return asJsonObject(report);
}

export function canonicalizeReportJson(report: SdkConformanceReport): string {
  return canonicalJson(serializeReportForPact(report));
}
