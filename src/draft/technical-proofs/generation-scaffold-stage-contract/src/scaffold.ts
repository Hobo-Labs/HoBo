import { isJsonString, isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import {

  authoritativeContractFromRequest,
  validateGenRequest,
  validateGenerationEvent
} from "../../generation-pipeline-io-contract/src/contract.js";

const scaffoldCandidateSchema = "hobo.gen.scaffold-candidate/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

const templateRegistry = new Map([
  ["implementation:service", renderServiceImplementationTemplate],
  ["migration-importer:terraform-state", renderTerraformImporterTemplate],
  ["provider:database", renderDatabaseProviderTemplate],
  ["resource-definition:database", renderDatabaseResourceDefinitionTemplate],
  ["ui:reactive-view", renderReactiveViewTemplate]
]);

export class ScaffoldContractError extends Error {
  constructor(code, path = "$") {
    super(`${code} at ${path}`);
    this.code = code;
    this.path = path;
  }
}

export function listTemplateKeys() {
  return [...templateRegistry.keys()].sort();
}

export function scaffoldGenerationRequest(request, options = {}) {
  const validated = validateGenRequest(request);
  const templateKey = resolveTemplateKey(validated);

  if (!templateKey) {
    const event = buildEvent(
      validated,
      "gen.NeedsHuman",
      {
        requestId: validated.requestId,
        reason: "scaffold-template-missing",
        budgetExhausted: true,
        failingAssertions: ["scaffold.template.missing"]
      },
      options
    );

    return {
      status: "needs-human",
      event
    };
  }

  const contract = authoritativeContractFromRequest(validated);
  const bytes = templateRegistry.get(templateKey)(contract);
  const digest = sha256Digest(bytes);
  const candidate = {
    schema: scaffoldCandidateSchema,
    requestId: contract.requestId,
    artifactKind: contract.artifactKind,
    targetWitPort: contract.target.witPort,
    templateKey,
    bytes,
    ref: {
      uri: `draft://generation-scaffold/${contract.requestId}/${templateKey}@${digest}`,
      digest
    },
    authoritativeInputs: {
      witPort: contract.target.witPort,
      conformanceSuiteId: contract.conformanceSuiteId,
      capabilityManifestDigest: contract.capabilityManifestDigest,
      authoritativeRefCount: validated.authoritativeRefs.length,
      materialRefCount: 0
    },
    generatedRegion: {
      start: "// <hobo-fill>",
      end: "// </hobo-fill>"
    }
  };

  validateScaffoldCandidate(candidate);

  const event = buildEvent(
    validated,
    "gen.CandidateGenerated",
    {
      requestId: validated.requestId,
      candidateRef: candidate.ref,
      iteration: options.iteration ?? 0
    },
    options
  );

  return {
    status: "candidate-generated",
    candidate,
    event
  };
}

export function validateScaffoldCandidate(candidate) {
  assertObject(candidate, "scaffold.candidate", "$");
  assertEqual(candidate.schema, scaffoldCandidateSchema, "scaffold.schema", "$.schema");
  assertNonEmptyString(candidate.requestId, "scaffold.request_id", "$.requestId");
  assertNonEmptyString(candidate.artifactKind, "scaffold.artifact_kind", "$.artifactKind");
  assertNonEmptyString(candidate.targetWitPort, "scaffold.target_wit_port", "$.targetWitPort");
  if (!templateRegistry.has(candidate.templateKey)) {
    throw new ScaffoldContractError("scaffold.template_key", "$.templateKey");
  }
  const resolvedTemplateKey = resolveTemplateKey({
    artifactKind: candidate.artifactKind,
    target: { witPort: candidate.targetWitPort }
  });
  assertEqual(candidate.templateKey, resolvedTemplateKey, "scaffold.template_mismatch", "$.templateKey");
  assertNonEmptyString(candidate.bytes, "scaffold.bytes", "$.bytes");
  assertObject(candidate.ref, "scaffold.ref", "$.ref");
  assertNonEmptyString(candidate.ref.uri, "scaffold.ref_uri", "$.ref.uri");
  if (!digestPattern.test(candidate.ref.digest ?? "")) {
    throw new ScaffoldContractError("scaffold.ref_digest", "$.ref.digest");
  }
  if (candidate.ref.digest !== sha256Digest(candidate.bytes)) {
    throw new ScaffoldContractError("scaffold.digest_mismatch", "$.ref.digest");
  }
  assertObject(candidate.authoritativeInputs, "scaffold.authoritative_inputs", "$.authoritativeInputs");
  assertEqual(
    candidate.authoritativeInputs.materialRefCount,
    0,
    "scaffold.material_exclusion",
    "$.authoritativeInputs.materialRefCount"
  );

  return candidate;
}

function resolveTemplateKey(request) {
  const portFamily = parseWitPortFamily(request.target.witPort);
  const kind = request.artifactKind;

  if (kind === "provider" && ["database", "postgres"].includes(portFamily)) {
    return "provider:database";
  }
  if (kind === "resource-definition" && ["database", "postgres"].includes(portFamily)) {
    return "resource-definition:database";
  }
  if (kind === "implementation" && ["service", "function", "handler"].includes(portFamily)) {
    return "implementation:service";
  }
  if (kind === "migration-importer" && ["terraform", "opentofu", "state"].includes(portFamily)) {
    return "migration-importer:terraform-state";
  }
  if (kind === "ui" && ["ui", "view", "render"].includes(portFamily)) {
    return "ui:reactive-view";
  }

  return null;
}

function parseWitPortFamily(witPort) {
  const withoutVersion = witPort.toLowerCase().split("@", 1)[0];
  const withoutNamespace = withoutVersion.includes(":")
    ? withoutVersion.slice(withoutVersion.indexOf(":") + 1)
    : withoutVersion;

  return withoutNamespace.split("/", 1)[0];
}

function buildEvent(request, type, data, options) {
  const seq = options.seq ?? 1;
  const event = {
    id: `01JSCAF${seq}`,
    type,
    v: 1,
    streamId: `generation:${request.requestId}`,
    seq,
    ts: options.ts ?? "2026-06-25T00:00:00.000Z",
    actor: {
      kind: "agent",
      id: "agent:generation-scaffold"
    },
    tenant: options.tenant ?? "tenant:demo",
    correlationId: request.requestId,
    data
  };

  return validateGenerationEvent(event);
}

function renderDatabaseProviderTemplate(contract) {
  return normalizeTemplate(`
// Generated by HoBo scaffold stage. Fill capability logic only.
export const artifactKind = "provider";
export const targetWitPort = "${contract.target.witPort}";
export const conformanceSuiteId = "${contract.conformanceSuiteId}";
export const capabilityManifestDigest = "${contract.capabilityManifestDigest}";

export function createProvider() {
  return {
    targetWitPort,
    capabilities: ["database"],
    connect() {
      // <hobo-fill>
      throw new Error("scaffold-placeholder:connect");
      // </hobo-fill>
    },
    query() {
      // <hobo-fill>
      throw new Error("scaffold-placeholder:query");
      // </hobo-fill>
    }
  };
}
`);
}

function renderDatabaseResourceDefinitionTemplate(contract) {
  return normalizeTemplate(`
// Generated by HoBo scaffold stage. Fill mapping details only.
export const artifactKind = "resource-definition";
export const targetWitPort = "${contract.target.witPort}";
export const conformanceSuiteId = "${contract.conformanceSuiteId}";

export function defineDatabaseResource() {
  return {
    type: "database",
    targetWitPort,
    driver: "template",
    mapping() {
      // <hobo-fill>
      throw new Error("scaffold-placeholder:mapping");
      // </hobo-fill>
    }
  };
}
`);
}

function renderServiceImplementationTemplate(contract) {
  return normalizeTemplate(`
// Generated by HoBo scaffold stage. Fill service behavior only.
export const artifactKind = "implementation";
export const targetWitPort = "${contract.target.witPort}";
export const conformanceSuiteId = "${contract.conformanceSuiteId}";

export async function handle(input, context) {
  void input;
  void context;
  // <hobo-fill>
  throw new Error("scaffold-placeholder:handle");
  // </hobo-fill>
}
`);
}

function renderTerraformImporterTemplate(contract) {
  return normalizeTemplate(`
// Generated by HoBo scaffold stage. Fill importer mapping only.
export const artifactKind = "migration-importer";
export const targetWitPort = "${contract.target.witPort}";
export const conformanceSuiteId = "${contract.conformanceSuiteId}";

export function importTerraformState(state) {
  void state;
  // <hobo-fill>
  throw new Error("scaffold-placeholder:terraform-state-import");
  // </hobo-fill>
}
`);
}

function renderReactiveViewTemplate(contract) {
  return normalizeTemplate(`
// Generated by HoBo scaffold stage. Fill view projection only.
export const artifactKind = "ui";
export const targetWitPort = "${contract.target.witPort}";
export const conformanceSuiteId = "${contract.conformanceSuiteId}";

export function renderReactiveView(model) {
  void model;
  // <hobo-fill>
  throw new Error("scaffold-placeholder:reactive-view");
  // </hobo-fill>
}
`);
}

function normalizeTemplate(template) {
  return template.trimStart().replace(/\r\n/g, "\n").trimEnd() + "\n";
}

function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertObject(value, code, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ScaffoldContractError(code, path);
  }
}

function assertEqual(actual, expected, code, path) {
  if (actual !== expected) {
    throw new ScaffoldContractError(code, path);
  }
}

function assertNonEmptyString(value, code, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ScaffoldContractError(code, path);
  }
}
