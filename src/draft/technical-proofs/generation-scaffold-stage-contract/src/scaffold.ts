import { isJsonString, isJsonObject, type JsonValue } from "./json.js";
import { createHash } from "node:crypto";
import {
  authoritativeContractFromRequest,
  validateGenRequest,
  validateGenerationEvent,
} from "../../generation-pipeline-io-contract/src/contract.js";

const scaffoldCandidateSchema = "hobo.gen.scaffold-candidate/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/;

const templateRegistry = new Map([
  ["implementation:service", renderServiceImplementationTemplate],
  ["migration-importer:terraform-state", renderTerraformImporterTemplate],
  ["provider:database", renderDatabaseProviderTemplate],
  ["resource-definition:database", renderDatabaseResourceDefinitionTemplate],
  ["ui:reactive-view", renderReactiveViewTemplate],
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
        failingAssertions: ["scaffold.template.missing"],
      },
      options,
    );

    return {
      status: "needs-human",
      event,
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
      digest,
    },
    authoritativeInputs: {
      witPort: contract.target.witPort,
      conformanceSuiteId: contract.conformanceSuiteId,
      capabilityManifestDigest: contract.capabilityManifestDigest,
      authoritativeRefCount: validated.authoritativeRefs.length,
      materialRefCount: 0,
    },
  };

  validateScaffoldCandidate(candidate);

  const event = buildEvent(
    validated,
    "gen.CandidateGenerated",
    {
      requestId: validated.requestId,
      candidateRef: candidate.ref,
      iteration: options.iteration ?? 0,
    },
    options,
  );

  return {
    status: "candidate-generated",
    candidate,
    event,
  };
}

export function validateScaffoldCandidate(candidate) {
  assertObject(candidate, "scaffold.candidate", "$");
  assertEqual(
    candidate.schema,
    scaffoldCandidateSchema,
    "scaffold.schema",
    "$.schema",
  );
  assertNonEmptyString(
    candidate.requestId,
    "scaffold.request_id",
    "$.requestId",
  );
  assertNonEmptyString(
    candidate.artifactKind,
    "scaffold.artifact_kind",
    "$.artifactKind",
  );
  assertNonEmptyString(
    candidate.targetWitPort,
    "scaffold.target_wit_port",
    "$.targetWitPort",
  );
  if (!templateRegistry.has(candidate.templateKey)) {
    throw new ScaffoldContractError("scaffold.template_key", "$.templateKey");
  }
  const resolvedTemplateKey = resolveTemplateKey({
    artifactKind: candidate.artifactKind,
    target: { witPort: candidate.targetWitPort },
  });
  assertEqual(
    candidate.templateKey,
    resolvedTemplateKey,
    "scaffold.template_mismatch",
    "$.templateKey",
  );
  assertNonEmptyString(candidate.bytes, "scaffold.bytes", "$.bytes");
  if (
    /scaffold-placeholder|hobo-fill|\b(?:TODO|FIXME|HACK|XXX|TBD)\b/iu.test(
      candidate.bytes,
    )
  ) {
    throw new ScaffoldContractError("scaffold.incomplete_bytes", "$.bytes");
  }
  assertObject(candidate.ref, "scaffold.ref", "$.ref");
  assertNonEmptyString(candidate.ref.uri, "scaffold.ref_uri", "$.ref.uri");
  if (!digestPattern.test(candidate.ref.digest ?? "")) {
    throw new ScaffoldContractError("scaffold.ref_digest", "$.ref.digest");
  }
  if (candidate.ref.digest !== sha256Digest(candidate.bytes)) {
    throw new ScaffoldContractError("scaffold.digest_mismatch", "$.ref.digest");
  }
  assertObject(
    candidate.authoritativeInputs,
    "scaffold.authoritative_inputs",
    "$.authoritativeInputs",
  );
  assertEqual(
    candidate.authoritativeInputs.materialRefCount,
    0,
    "scaffold.material_exclusion",
    "$.authoritativeInputs.materialRefCount",
  );

  return candidate;
}

export type ParsedScaffoldCandidate = ReturnType<
  typeof validateScaffoldCandidate
>;

export function parseScaffoldCandidate(
  input: JsonValue,
): ParsedScaffoldCandidate {
  return validateScaffoldCandidate(input);
}

function resolveTemplateKey(request) {
  const portFamily = parseWitPortFamily(request.target.witPort);
  const kind = request.artifactKind;

  if (kind === "provider" && ["database", "postgres"].includes(portFamily)) {
    return "provider:database";
  }
  if (
    kind === "resource-definition" &&
    ["database", "postgres"].includes(portFamily)
  ) {
    return "resource-definition:database";
  }
  if (
    kind === "implementation" &&
    ["service", "function", "handler"].includes(portFamily)
  ) {
    return "implementation:service";
  }
  if (
    kind === "migration-importer" &&
    ["terraform", "opentofu", "state"].includes(portFamily)
  ) {
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
      id: "agent:generation-scaffold",
    },
    tenant: options.tenant ?? "tenant:demo",
    correlationId: request.requestId,
    data,
  };

  return validateGenerationEvent(event);
}

function renderDatabaseProviderTemplate(contract) {
  return normalizeTemplate(`
export const artifactKind = "provider";
export const targetWitPort = ${JSON.stringify(contract.target.witPort)};
export const conformanceSuiteId = ${JSON.stringify(contract.conformanceSuiteId)};
export const capabilityManifestDigest = ${JSON.stringify(contract.capabilityManifestDigest)};

export function createProvider(driver) {
  for (const method of ["connect", "query"]) {
    if (typeof driver?.[method] !== "function") {
      throw new TypeError("database driver must implement " + method + "()");
    }
  }

  return Object.freeze({
    targetWitPort,
    capabilities: Object.freeze(["database"]),
    connect: (...args) => driver.connect(...args),
    query: (...args) => driver.query(...args),
    destroy: (...args) => typeof driver.destroy === "function" ? driver.destroy(...args) : undefined
  });
}
`);
}

function renderDatabaseResourceDefinitionTemplate(contract) {
  return normalizeTemplate(`
export const artifactKind = "resource-definition";
export const targetWitPort = ${JSON.stringify(contract.target.witPort)};
export const conformanceSuiteId = ${JSON.stringify(contract.conformanceSuiteId)};

export function defineDatabaseResource(resource = {}) {
  const name = typeof resource.name === "string" && resource.name.length > 0
    ? resource.name
    : "database";
  return Object.freeze({
    type: "database",
    name,
    targetWitPort,
    driver: "contract",
    mapping: Object.freeze({ name, targetWitPort })
  });
}
`);
}

function renderServiceImplementationTemplate(contract) {
  return normalizeTemplate(`
export const artifactKind = "implementation";
export const targetWitPort = ${JSON.stringify(contract.target.witPort)};
export const conformanceSuiteId = ${JSON.stringify(contract.conformanceSuiteId)};

export async function handle(input, context = {}) {
  return { ok: true, targetWitPort, input, context };
}
`);
}

function renderTerraformImporterTemplate(contract) {
  return normalizeTemplate(`
export const artifactKind = "migration-importer";
export const targetWitPort = ${JSON.stringify(contract.target.witPort)};
export const conformanceSuiteId = ${JSON.stringify(contract.conformanceSuiteId)};

export function importTerraformState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("terraform state must be an object");
  }
  const resources = Array.isArray(state.resources) ? state.resources : [];
  return { imported: true, targetWitPort, resources };
}
`);
}

function renderReactiveViewTemplate(contract) {
  return normalizeTemplate(`
export const artifactKind = "ui";
export const targetWitPort = ${JSON.stringify(contract.target.witPort)};
export const conformanceSuiteId = ${JSON.stringify(contract.conformanceSuiteId)};

export function renderReactiveView(model) {
  return Object.freeze({ view: "reactive", targetWitPort, model });
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
