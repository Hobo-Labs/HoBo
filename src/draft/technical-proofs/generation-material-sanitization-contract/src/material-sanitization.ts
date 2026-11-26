import { createHash } from "node:crypto";

import { validateGenRequest } from "../../generation-pipeline-io-contract/src/contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const scrubReportSchema = "hobo.gen.material-scrub-report/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const materialEventTypes = new Set(["gen.MaterialSanitized", "gen.MaterialRefused"]);

const injectionRules = [
  {
    id: "material.ignore_previous_instructions",
    pattern: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|contract)\b/
  },
  {
    id: "material.network_egress_escalation",
    pattern: /\b(?:grant|allow|enable)\s+(?:network\s+)?egress\b/
  },
  {
    id: "material.admin_endpoint_escalation",
    pattern: /\b(?:add|create|expose)\s+(?:an?\s+)?admin\s+(?:endpoint|api|backdoor)\b/
  },
  {
    id: "material.port_claim_override",
    pattern: /\bclaim\s+(?:port\s+)?hobo:[a-z0-9_./-]+@[a-z0-9_.-]+\b/
  },
  {
    id: "material.conformance_bypass",
    pattern: /\bbypass\s+(?:conformance|certification|contract)\b/
  }
];

const confusables = new Map(
  Object.entries({
    "\u0430": "a",
    "\u0435": "e",
    "\u0456": "i",
    "\u043e": "o",
    "\u0440": "p",
    "\u0441": "c",
    "\u0445": "x",
    "\u0443": "y",
    "\u043C": "m",
    "\u0442": "t",
    "\u0410": "a",
    "\u0415": "e",
    "\u0406": "i",
    "\u041E": "o",
    "\u0420": "p",
    "\u0421": "c",
    "\u03BF": "o",
    "\u03B1": "a",
    "\u03B5": "e"
  })
);

export class MaterialSanitizationContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.name = "MaterialSanitizationContractError";
    this.code = code;
    this.path = path;
  }
}

export function sanitizeGenerationMaterials(request, materials, options = {}) {
  const parsedRequest = expectObject(request, "$.request");
  const parsedMaterials = parseMaterials(materials);
  const requestId = nonEmptyString(parsedRequest.requestId, "$.request.requestId");
  const findings = uniqueFindings(parsedMaterials.flatMap(scanMaterial));
  const decision = findings.length === 0 ? "allow" : "deny";
  const sanitizedBlocks =
    decision === "allow" ? parsedMaterials.map((item) => buildSanitizedBlock(item)) : [];
  const sanitizedRefs =
    decision === "allow"
      ? sanitizedBlocks.map((block, index) => ({
          kind: block.kind,
          ref: `draft://generation-material/${requestId}/${index}@${block.digest}`,
          trusted: false,
          sanitized: true,
          scrubbed: true
        }))
      : [];

  const reportPayload = {
    schema: scrubReportSchema,
    requestId,
    decision,
    sanitizedRefs,
    sanitizedBlocks,
    findings
  };
  const report = {
    ...reportPayload,
    ref: {
      uri: `draft://generation-material/${requestId}/scrub-report@${sha256Digest(reportPayload)}`,
      digest: sha256Digest(reportPayload)
    }
  };
  validateMaterialScrubReport(report);

  const event = buildMaterialEvent({
    requestId,
    type: decision === "allow" ? "gen.MaterialSanitized" : "gen.MaterialRefused",
    scrubReportRef: report.ref,
    sanitizedRefs,
    failingAssertions: findings.map((finding) => finding.ruleId),
    options
  });

  if (decision === "deny") {
    return {
      status: "material-refused",
      sanitizedRequest: null,
      scrubReport: report,
      event
    };
  }

  const sanitizedRequest = validateGenRequest({
    ...parsedRequest,
    materialRefs: sanitizedRefs
  });

  return {
    status: "material-sanitized",
    sanitizedRequest,
    scrubReport: report,
    event
  };
}

export function certifyCandidateAgainstMaterial(input) {
  const parsed = expectObject(input, "$");
  const request = expectObject(parsed.request, "$.request");
  const candidate = expectObject(parsed.candidate, "$.candidate");
  const scrubReport = validateMaterialScrubReport(parsed.scrubReport);
  const reasons = [];

  if (scrubReport.decision !== "allow") {
    reasons.push("material.injection_detected");
  }

  const targetWitPort = nonEmptyString(request.target?.witPort, "$.request.target.witPort");
  if (candidate.targetWitPort !== targetWitPort) {
    reasons.push("candidate.target_not_authoritative");
  }

  const allowedCapabilities = new Set(authoritativeCapabilities(request));
  const claimedCapabilities = Array.isArray(candidate.claimedCapabilities)
    ? candidate.claimedCapabilities
    : [];
  for (const capability of claimedCapabilities) {
    if (!allowedCapabilities.has(capability)) {
      reasons.push(`candidate.capability_not_authoritative:${capability}`);
    }
  }
  if (
    claimedCapabilities.includes("network-egress") &&
    request.capabilityManifest?.networkEgress !== true
  ) {
    reasons.push("candidate.network_egress_not_authoritative");
  }

  return {
    ok: reasons.length === 0,
    effect: reasons.length === 0 ? "certify" : "deny",
    reasons
  };
}

export function validateMaterialScrubReport(report) {
  const parsed = expectObject(report, "$");
  equal(parsed.schema, scrubReportSchema, "material.report_schema", "$.schema");
  nonEmptyString(parsed.requestId, "$.requestId");
  if (!["allow", "deny"].includes(parsed.decision)) {
    throw new MaterialSanitizationContractError("material.report_decision", "$.decision");
  }
  if (!Array.isArray(parsed.sanitizedRefs)) {
    throw new MaterialSanitizationContractError("material.report_sanitized_refs", "$.sanitizedRefs");
  }
  if (!Array.isArray(parsed.sanitizedBlocks)) {
    throw new MaterialSanitizationContractError("material.report_blocks", "$.sanitizedBlocks");
  }
  if (!Array.isArray(parsed.findings)) {
    throw new MaterialSanitizationContractError("material.report_findings", "$.findings");
  }
  for (const [index, finding] of parsed.findings.entries()) {
    validateFinding(finding, `$.findings[${index}]`);
  }
  validateDigestRef(parsed.ref, "$.ref");

  const { ref, ...payload } = parsed;
  if (ref.digest !== sha256Digest(payload)) {
    throw new MaterialSanitizationContractError("material.report_digest_mismatch", "$.ref.digest");
  }

  return parsed;
}

export function validateMaterialScrubEvent(event) {
  const parsed = expectObject(event, "$");
  nonEmptyString(parsed.id, "$.id");
  if (!materialEventTypes.has(parsed.type)) {
    throw new MaterialSanitizationContractError("material.event_type", "$.type");
  }
  equal(parsed.v, 1, "material.event_version", "$.v");
  nonEmptyString(parsed.streamId, "$.streamId");
  if (!Number.isInteger(parsed.seq) || parsed.seq <= 0) {
    throw new MaterialSanitizationContractError("material.event_seq", "$.seq");
  }
  nonEmptyString(parsed.ts, "$.ts");
  if (Number.isNaN(Date.parse(parsed.ts))) {
    throw new MaterialSanitizationContractError("material.event_ts", "$.ts");
  }
  expectObject(parsed.actor, "$.actor");
  nonEmptyString(parsed.actor.kind, "$.actor.kind");
  nonEmptyString(parsed.actor.id, "$.actor.id");
  nonEmptyString(parsed.tenant, "$.tenant");
  nonEmptyString(parsed.correlationId, "$.correlationId");
  const data = expectObject(parsed.data, "$.data");
  nonEmptyString(data.requestId, "$.data.requestId");
  if (parsed.correlationId !== data.requestId) {
    throw new MaterialSanitizationContractError("material.event_correlation", "$.correlationId");
  }
  validateDigestRef(data.scrubReportRef, "$.data.scrubReportRef");

  if (parsed.type === "gen.MaterialRefused") {
    stringArray(data.failingAssertions, "$.data.failingAssertions");
  } else {
    if (!Array.isArray(data.sanitizedMaterialRefs)) {
      throw new MaterialSanitizationContractError(
        "material.event_sanitized_refs",
        "$.data.sanitizedMaterialRefs"
      );
    }
  }

  return parsed;
}

function parseMaterials(materials) {
  if (!Array.isArray(materials) || materials.length === 0) {
    throw new MaterialSanitizationContractError("material.required", "$.materials");
  }

  return materials.map((material, index) => {
    const path = `$.materials[${index}]`;
    const parsed = expectObject(material, path);
    return {
      index,
      kind: nonEmptyString(parsed.kind, `${path}.kind`),
      ref: nonEmptyString(parsed.ref, `${path}.ref`),
      content: nonEmptyString(parsed.content, `${path}.content`)
    };
  });
}

function scanMaterial(material) {
  const layers = detectionLayers(material.content);
  const findings = [];

  for (const layer of layers) {
    for (const rule of injectionRules) {
      if (rule.pattern.test(layer.text)) {
        findings.push({
          id: `${material.kind}.${rule.id}.${layer.name}.${material.index}`,
          ruleId: rule.id,
          materialKind: material.kind,
          materialRef: material.ref,
          layer: layer.name,
          severity: "deny",
          evidenceDigest: sha256Digest(layer.text)
        });
      }
    }
  }

  return findings;
}

function detectionLayers(content) {
  const raw = content.normalize("NFKC").toLowerCase();
  const normalized = normalizeConfusables(raw);
  const layers = [{ name: raw === normalized ? "raw" : "normalized", text: normalized }];

  for (const token of content.match(/[A-Za-z0-9+/]{24,}={0,2}/g) ?? []) {
    const decoded = decodeBase64(token);
    if (decoded) {
      layers.push({ name: "base64", text: normalizeConfusables(decoded.normalize("NFKC").toLowerCase()) });
    }
  }

  return layers;
}

function normalizeConfusables(value) {
  let normalized = "";
  for (const char of value.replace(/[\u200B-\u200D\uFEFF]/g, "")) {
    normalized += confusables.get(char) ?? char;
  }
  return normalized;
}

function decodeBase64(token) {
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    if (!/^[\t\n\r\x20-\x7E]+$/.test(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function buildSanitizedBlock(material) {
  const text = [
    `BEGIN_UNTRUSTED_MATERIAL kind=${material.kind} ref=${material.ref}`,
    escapePromptDelimiters(material.content),
    "END_UNTRUSTED_MATERIAL"
  ].join("\n");
  return {
    kind: material.kind,
    sourceRef: material.ref,
    text,
    digest: sha256Digest(text)
  };
}

function escapePromptDelimiters(content) {
  return content
    .replaceAll("BEGIN_UNTRUSTED_MATERIAL", "[escaped:BEGIN_UNTRUSTED_MATERIAL]")
    .replaceAll("END_UNTRUSTED_MATERIAL", "[escaped:END_UNTRUSTED_MATERIAL]")
    .replaceAll("```", "`[escaped-fence]``");
}

function buildMaterialEvent({
  requestId,
  type,
  scrubReportRef,
  sanitizedRefs,
  failingAssertions,
  options
}) {
  const data =
    type === "gen.MaterialRefused"
      ? {
          requestId,
          scrubReportRef,
          failingAssertions: [...new Set(failingAssertions)]
        }
      : {
          requestId,
          scrubReportRef,
          sanitizedMaterialRefs: sanitizedRefs
        };
  const event = {
    id: `gen-material-${requestId}-${scrubReportRef.digest.slice("sha256:".length, "sha256:".length + 12)}`,
    type,
    v: 1,
    streamId: `generation:${requestId}`,
    seq: options.seq ?? 1,
    ts: options.ts ?? "2026-06-28T00:00:00.000Z",
    actor: options.actor ?? {
      kind: "agent",
      id: "agent:generation-material-sanitizer"
    },
    tenant: options.tenant ?? "tenant:demo",
    correlationId: requestId,
    data
  };

  return validateMaterialScrubEvent(event);
}

function authoritativeCapabilities(request) {
  if (Array.isArray(request.capabilityManifest?.claimedCapabilities)) {
    return request.capabilityManifest.claimedCapabilities;
  }

  const port = request.target?.witPort ?? "";
  const family = port.toLowerCase().split("@", 1)[0].split(":").at(-1)?.split("/", 1)[0];
  return family ? [family] : [];
}

function uniqueFindings(findings) {
  const seen = new Set();
  const unique = [];
  for (const finding of findings) {
    const key = `${finding.materialKind}:${finding.materialRef}:${finding.ruleId}:${finding.layer}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(finding);
    }
  }
  return unique;
}

function validateFinding(finding, path) {
  const parsed = expectObject(finding, path);
  nonEmptyString(parsed.id, `${path}.id`);
  nonEmptyString(parsed.ruleId, `${path}.ruleId`);
  nonEmptyString(parsed.materialKind, `${path}.materialKind`);
  nonEmptyString(parsed.materialRef, `${path}.materialRef`);
  nonEmptyString(parsed.layer, `${path}.layer`);
  equal(parsed.severity, "deny", "material.finding_severity", `${path}.severity`);
  digest(parsed.evidenceDigest, `${path}.evidenceDigest`);
}

function validateDigestRef(ref, path) {
  const parsed = expectObject(ref, path);
  nonEmptyString(parsed.uri, `${path}.uri`);
  digest(parsed.digest, `${path}.digest`);
}

function digest(value, path) {
  nonEmptyString(value, path);
  if (!digestPattern.test(value)) {
    throw new MaterialSanitizationContractError("material.digest", path);
  }
}

function stringArray(value, path) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => isJsonString(item) && item.length > 0)
  ) {
    throw new MaterialSanitizationContractError("material.string_array", path);
  }
}

function expectObject(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new MaterialSanitizationContractError("material.object", path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new MaterialSanitizationContractError("material.string", path);
  }
  return value;
}

function equal(actual, expected, code, path) {
  if (actual !== expected) {
    throw new MaterialSanitizationContractError(code, path);
  }
}

function sha256Digest(value) {
  const bytes = isJsonString(value) ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
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
