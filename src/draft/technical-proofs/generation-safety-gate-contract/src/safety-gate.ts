import { createHash } from "node:crypto";

import { validateGenerationEvent } from "../../generation-pipeline-io-contract/src/contract.js";
import {
  profileDigest,
  validateSandboxEvent,
  validateSandboxProfile
} from "../../no-egress-generation-sandbox-contract/src/contract.js";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


export const SAFETY_REPORT_SCHEMA = "hobo.gen.safety-report/v1";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const blockerSeverity = "blocker";

export class SafetyGateContractError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "SafetyGateContractError";
    this.code = code;
    this.path = path;
  }
}

export function runGenerationSafetyGate(input) {
  const parsed = parseInput(input);
  const findings = uniqueFindings([
    ...capabilityFindings(parsed.candidate),
    ...staticFindings(parsed.candidate, parsed.allowedReadPaths),
    ...dependencyFindings(parsed.candidate.dependencies, parsed.approvedDependencies),
    ...sandboxFindings(parsed.sandboxEvents, parsed.sandboxProfileDigest)
  ]);

  const reportPayload = {
    schema: SAFETY_REPORT_SCHEMA,
    requestId: parsed.requestId,
    candidateRef: parsed.candidate.candidateRef,
    validationReportRef: parsed.validationReport.ref,
    sandboxProfileDigest: parsed.sandboxProfileDigest,
    passed: findings.length === 0,
    findings
  };
  const reportDigest = sha256Digest(reportPayload);
  const report = {
    ...reportPayload,
    ref: {
      uri: `draft://generation-safety/${parsed.requestId}/report@${reportDigest}`,
      digest: reportDigest
    }
  };
  validateSafetyReport(report);

  if (report.passed) {
    return {
      outcome: "safety-passed",
      report,
      event: null
    };
  }

  const event = validateGenerationEvent({
    id: `gen-safety-${parsed.requestId}-${reportDigest.slice("sha256:".length, "sha256:".length + 12)}`,
    type: "gen.SafetyRejected",
    v: 1,
    streamId: parsed.streamId,
    seq: parsed.seq,
    ts: parsed.ts,
    actor: parsed.actor,
    tenant: parsed.tenant,
    correlationId: parsed.requestId,
    data: {
      requestId: parsed.requestId,
      candidateRef: parsed.candidate.candidateRef,
      validationReportRef: parsed.validationReport.ref,
      safetyReportRef: report.ref,
      failingAssertions: findings.map((finding) => finding.id)
    }
  });

  return {
    outcome: "safety-rejected",
    report,
    event
  };
}

export function validateSafetyReport(report) {
  const parsed = expectObject(report, "$");
  equal(parsed.schema, SAFETY_REPORT_SCHEMA, "safety.report_schema", "$.schema");
  nonEmptyString(parsed.requestId, "$.requestId");
  parseDigestRef(parsed.candidateRef, "$.candidateRef");
  parseDigestRef(parsed.validationReportRef, "$.validationReportRef");
  digest(parsed.sandboxProfileDigest, "$.sandboxProfileDigest");
  if (!isJsonBoolean(parsed.passed)) {
    throw new SafetyGateContractError("safety.report_passed", "$.passed");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new SafetyGateContractError("safety.findings_required", "$.findings");
  }
  for (const [index, finding] of parsed.findings.entries()) {
    parseFinding(finding, `$.findings[${index}]`);
  }
  if (parsed.passed !== (parsed.findings.length === 0)) {
    throw new SafetyGateContractError("safety.report_passed_mismatch", "$.passed");
  }
  parseDigestRef(parsed.ref, "$.ref");

  const { ref, ...payload } = parsed;
  if (ref.digest !== sha256Digest(payload)) {
    throw new SafetyGateContractError("safety.report_digest_mismatch", "$.ref.digest");
  }

  return parsed;
}

function parseInput(input) {
  const parsed = expectObject(input, "$");
  const requestId = nonEmptyString(parsed.requestId, "$.requestId");
  const candidate = parseCandidate(parsed.candidate, requestId);
  const validationReport = parseValidationReport(parsed.validationReport, requestId, candidate);
  const sandboxProfileDigest = profileDigest(validateSandboxProfile(parsed.sandboxProfile));

  return {
    requestId,
    candidate,
    validationReport,
    sandboxProfileDigest,
    sandboxEvents: arrayOrEmpty(parsed.sandboxEvents ?? [], "$.sandboxEvents"),
    approvedDependencies: stringArray(parsed.approvedDependencies ?? [], "$.approvedDependencies"),
    allowedReadPaths: stringArray(parsed.allowedReadPaths ?? [], "$.allowedReadPaths"),
    streamId: parsed.streamId ?? `generation:${requestId}`,
    seq: positiveInteger(parsed.seq ?? 1, "$.seq"),
    ts: isoTimestamp(parsed.ts ?? new Date(0).toISOString(), "$.ts"),
    actor: parseActor(
      parsed.actor ?? {
        kind: "agent",
        id: "agent:generation-safety"
      }
    ),
    tenant: nonEmptyString(parsed.tenant ?? "tenant:demo", "$.tenant")
  };
}

function parseCandidate(input, requestId) {
  const candidate = expectObject(input, "$.candidate");
  equal(candidate.requestId, requestId, "safety.candidate_request_mismatch", "$.candidate.requestId");
  const candidateRef = parseDigestRef(candidate.candidateRef, "$.candidate.candidateRef");
  const declaredAllow = parseCapabilities(candidate.declaredAllow, "$.candidate.declaredAllow");
  const requestedCapabilities = parseCapabilities(
    candidate.requestedCapabilities,
    "$.candidate.requestedCapabilities"
  );
  const sourceFiles = parseSourceFiles(candidate.sourceFiles);
  const dependencies = parseDependencies(candidate.dependencies ?? {});

  return {
    requestId,
    candidateRef,
    declaredAllow,
    requestedCapabilities,
    sourceFiles,
    dependencies
  };
}

function parseValidationReport(input, requestId, candidate) {
  const report = expectObject(input, "$.validationReport");
  equal(report.schema, "hobo.gen.validation-report/v1", "safety.validation_schema", "$.validationReport.schema");
  equal(report.requestId, requestId, "safety.validation_request_mismatch", "$.validationReport.requestId");
  if (report.passed !== true) {
    throw new SafetyGateContractError("safety.validation_not_green", "$.validationReport.passed");
  }
  const reportCandidateRef = parseDigestRef(report.candidateRef, "$.validationReport.candidateRef");
  equal(
    reportCandidateRef.digest,
    candidate.candidateRef.digest,
    "safety.validation_candidate_mismatch",
    "$.validationReport.candidateRef.digest"
  );
  const ref = parseDigestRef(report.ref, "$.validationReport.ref");
  return {
    schema: report.schema,
    requestId: report.requestId,
    candidateRef: reportCandidateRef,
    passed: true,
    ref
  };
}

function capabilityFindings(candidate) {
  return candidate.requestedCapabilities.flatMap((requested, index) => {
    const allowed = candidate.declaredAllow.some((declared) => capabilityCovers(declared, requested));
    if (allowed) {
      return [];
    }

    return [
      finding({
        id: "capability.overbroad_request",
        check: "capability-diff",
        path: `candidate.requestedCapabilities[${index}]`,
        evidence: `${requested.interface} requests verbs or scope outside declared .allow()`
      })
    ];
  });
}

function staticFindings(candidate, allowedReadPaths) {
  const findings = [];

  for (const file of candidate.sourceFiles) {
    if (/(^|[^\w])fetch\s*\(|\b(?:http|https)\.request\s*\(|\bnet\.connect\s*\(|new\s+WebSocket\s*\(/.test(file.text)) {
      findings.push(
        finding({
          id: "static.network_egress_sink",
          check: "static-scan",
          path: file.path,
          evidence: "source contains a direct network egress sink"
        })
      );
    }

    if (/process\.env(?:\.[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY)|\s*\[\s*["'][^"']*(?:SECRET|TOKEN|PASSWORD|KEY)[^"']*["']\s*\])/i.test(file.text)) {
      findings.push(
        finding({
          id: "static.secret_exfiltration",
          check: "static-scan",
          path: file.path,
          evidence: "source reads secret-like environment material"
        })
      );
    }

    for (const path of literalReadPaths(file.text)) {
      if (path.startsWith("/") && !allowedReadPaths.some((allowed) => isInside(allowed, path))) {
        findings.push(
          finding({
            id: "static.filesystem_out_of_scope",
            check: "static-scan",
            path: file.path,
            evidence: `source reads ${path} outside allowed scoped paths`
          })
        );
      }
    }

    if (/\bDate\.(?:now|parse)\s*\(|new\s+Date\s*\(|set(?:Timeout|Interval)\s*\(/.test(file.text)) {
      findings.push(
        finding({
          id: "hidden_trigger.time_bomb",
          check: "hidden-trigger-heuristic",
          path: file.path,
          evidence: "source gates behavior on wall-clock time"
        })
      );
    }

    if (/if\s*\([^)]*(?:input|request|event|payload)[^)]*(?:===|==|includes\s*\(|startsWith\s*\(|endsWith\s*\()[^)]*["'][^"']{4,}["'][^)]*\)/is.test(file.text)) {
      findings.push(
        finding({
          id: "hidden_trigger.input_backdoor",
          check: "hidden-trigger-heuristic",
          path: file.path,
          evidence: "source gates alternate behavior on a literal input trigger"
        })
      );
    }
  }

  return findings;
}

function dependencyFindings(dependencies, approvedDependencies) {
  const approved = new Set(approvedDependencies);
  const findings = [];

  for (const name of Object.keys(dependencies)) {
    if (approved.has(name)) {
      continue;
    }

    const nearest = approvedDependencies.find((approvedName) => isNearPackageName(name, approvedName));
    if (nearest) {
      findings.push(
        finding({
          id: "dependency.typosquat",
          check: "dependency-heuristic",
          path: `candidate.dependencies.${name}`,
          evidence: `${name} is near approved dependency ${nearest}`
        })
      );
    }
  }

  return findings;
}

function sandboxFindings(events, expectedProfileDigest) {
  const findings = [];

  for (const [index, event] of events.entries()) {
    const parsed = validateSandboxEvent(event);
    if (parsed.profileDigest !== expectedProfileDigest) {
      throw new SafetyGateContractError(
        "safety.sandbox_profile_mismatch",
        `$.sandboxEvents[${index}].profileDigest`
      );
    }
    if (parsed.type !== "sandbox.EscapeAttemptBlocked") {
      continue;
    }

    const idByKind = {
      network: "sandbox.network_egress_denied",
      filesystem: "sandbox.filesystem_escape_denied",
      capability: "sandbox.capability_escape_denied"
    };
    findings.push(
      finding({
        id: idByKind[parsed.attempt.kind],
        check: "sandbox-evidence",
        path: `sandboxEvents[${index}]`,
        evidence: `${parsed.attempt.kind} attempt denied for ${parsed.attempt.target}`
      })
    );
  }

  return findings;
}

function parseCapabilities(input, path) {
  if (!Array.isArray(input)) {
    throw new SafetyGateContractError("safety.capabilities_required", path);
  }
  return input.map((capability, index) => parseCapability(capability, `${path}[${index}]`));
}

function parseCapability(input, path) {
  const capability = expectObject(input, path);
  return {
    interface: nonEmptyString(capability.interface, `${path}.interface`),
    verbs: stringArray(capability.verbs, `${path}.verbs`),
    scope: expectObject(capability.scope, `${path}.scope`)
  };
}

function parseSourceFiles(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new SafetyGateContractError("safety.source_files_required", "$.candidate.sourceFiles");
  }
  return input.map((file, index) => {
    const path = `$.candidate.sourceFiles[${index}]`;
    const parsed = expectObject(file, path);
    return {
      path: nonEmptyString(parsed.path, `${path}.path`),
      text: nonEmptyString(parsed.text, `${path}.text`)
    };
  });
}

function parseDependencies(input) {
  const dependencies = expectObject(input, "$.candidate.dependencies");
  const parsed = {};
  for (const [name, version] of Object.entries(dependencies)) {
    nonEmptyString(name, "$.candidate.dependencies.name");
    parsed[name] = nonEmptyString(version, `$.candidate.dependencies.${name}`);
  }
  return parsed;
}

function parseActor(input) {
  const actor = expectObject(input, "$.actor");
  return {
    kind: nonEmptyString(actor.kind, "$.actor.kind"),
    id: nonEmptyString(actor.id, "$.actor.id")
  };
}

function parseFinding(input, path) {
  const parsed = expectObject(input, path);
  nonEmptyString(parsed.id, `${path}.id`);
  equal(parsed.severity, blockerSeverity, "safety.finding_severity", `${path}.severity`);
  nonEmptyString(parsed.check, `${path}.check`);
  nonEmptyString(parsed.path, `${path}.path`);
  nonEmptyString(parsed.evidence, `${path}.evidence`);
}

function finding({ id, check, path, evidence }) {
  return {
    id,
    severity: blockerSeverity,
    check,
    path,
    evidence
  };
}

function capabilityCovers(allowed, requested) {
  if (allowed.interface !== requested.interface) {
    return false;
  }
  if (!requested.verbs.every((verb) => allowed.verbs.includes(verb))) {
    return false;
  }
  return scopeCovers(allowed.scope, requested.scope);
}

function scopeCovers(allowedScope, requestedScope) {
  for (const [key, value] of Object.entries(requestedScope)) {
    if (!sameValue(allowedScope[key], value)) {
      return false;
    }
    if (value === "*") {
      return false;
    }
  }
  return Object.keys(requestedScope).length > 0;
}

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function literalReadPaths(source) {
  const paths = [];
  const readPattern = /\b(?:readFileSync|readFile|openSync|createReadStream)\s*\(\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(readPattern)) {
    paths.push(match[1]);
  }
  return paths;
}

function isInside(parent, child) {
  const normalizedParent = parent.replace(/\/$/, "");
  return child === normalizedParent || child.startsWith(`${normalizedParent}/`);
}

function isNearPackageName(name, approvedName) {
  return levenshtein(name, approvedName) <= 2 || levenshtein(normalizePackage(name), normalizePackage(approvedName)) <= 2;
}

function normalizePackage(name) {
  return name.replace(/^@[^/]+\//, "").replace(/[-_]/g, "");
}

function levenshtein(left, right) {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) {
    rows[0][column] = column;
  }
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row][column] = Math.min(
        rows[row - 1][column] + 1,
        rows[row][column - 1] + 1,
        rows[row - 1][column - 1] + cost
      );
    }
  }
  return rows[left.length][right.length];
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((current) => {
    const key = `${current.id}:${current.path}:${current.evidence}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseDigestRef(input, path) {
  const ref = expectObject(input, path);
  return {
    uri: nonEmptyString(ref.uri, `${path}.uri`),
    digest: digest(ref.digest, `${path}.digest`)
  };
}

function arrayOrEmpty(value, path) {
  if (!Array.isArray(value)) {
    throw new SafetyGateContractError("safety.expected_array", path);
  }
  return value;
}

function stringArray(value, path) {
  if (!Array.isArray(value)) {
    throw new SafetyGateContractError("safety.expected_array", path);
  }
  return value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SafetyGateContractError("safety.expected_positive_integer", path);
  }
  return value;
}

function isoTimestamp(value, path) {
  const parsed = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new SafetyGateContractError("safety.expected_iso_timestamp", path);
  }
  return parsed;
}

function digest(value, path) {
  const parsed = nonEmptyString(value, path);
  if (!digestPattern.test(parsed)) {
    throw new SafetyGateContractError("safety.expected_digest", path);
  }
  return parsed;
}

function equal(actual, expected, code, path) {
  if (actual !== expected) {
    throw new SafetyGateContractError(code, path);
  }
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new SafetyGateContractError("safety.expected_object", path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new SafetyGateContractError("safety.expected_string", path);
  }
  return value;
}

function sha256Digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
