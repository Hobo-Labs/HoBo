import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const SNAPSHOT_SCHEMA = "hobo.broker-environment-snapshot/v1";
const PUBLICATION_VERSION = "2026-06-30.m2";

const DEFAULT_PROVIDER_CAPABILITY = {
  providerId: "aws",
  manifestDigest: digestRef("aws-capability-manifest"),
  conformanceDigest: digestRef("aws-provider-conformance"),
  capabilities: [
    {
      type: "database",
      features: ["postgres", "managed", "ha"],
    },
  ],
  conformance: [
    {
      type: "database",
      features: ["postgres", "managed", "ha"],
    },
  ],
};

const DEFAULT_CATALOG = {
  catalogVersion: "broker-catalog-2026-06-30",
  snapshotDigest: digestRef("broker-catalog-snapshot"),
  issuedAt: "2026-06-30T00:00:00Z",
  staleAfter: "2026-07-30T00:00:00Z",
};

const DEFAULT_MAPPING = {
  mappingId: "aws-postgres-prod",
  mappingDigest: digestRef("aws-postgres-prod-mapping"),
  providerId: "aws",
  resourceType: "database",
  providerResourceClass: "rds-aurora-postgres",
  requires: ["postgres", "managed"],
  compatibility: "compatible",
};

const DEFAULT_APPROVAL = {
  approvalId: "appr_broker_env_prod_001",
  approvedBy: "broker-admin",
  decision: "approved",
  approvedAt: "2026-06-30T00:00:00Z",
  evidenceDigest: digestRef("broker-admin-approval-evidence"),
};

const DEFAULT_PROVENANCE = {
  sourceIssue: "HOBO-526",
  sourceRefs: [
    "docs/design/platform-engineering.md",
    "docs/design/meta-cloud-broker.md",
    "src/draft/provider-capability-manifest-contract",
    "src/draft/provider-default-definitions-contract",
  ],
  digest: digestRef("broker-environment-publication-provenance"),
};

export function buildFixturePublication(overrides = {}) {
  return {
    asOf: overrides.asOf ?? "2026-06-30T00:00:00Z",
    expectedSnapshotId: overrides.expectedSnapshotId,
    providerCapability: merge(DEFAULT_PROVIDER_CAPABILITY, overrides.providerCapability),
    catalog: merge(DEFAULT_CATALOG, overrides.catalog),
    mapping: merge(DEFAULT_MAPPING, overrides.mapping),
    approval: merge(DEFAULT_APPROVAL, overrides.approval),
    provenance: merge(DEFAULT_PROVENANCE, overrides.provenance),
    providerDefaults: overrides.providerDefaults ?? [
      {
        definitionId: "aws.default.database",
        providerId: "aws",
        type: "database",
        resourceClass: "rds-aurora-postgres",
        role: "broker-validation-input",
      },
    ],
  };
}

export function publishBrokerEnvironmentSnapshot(publication) {
  const parsed = parsePublication(publication);
  if (!parsed.ok) {
    return { ok: false, errors: parsed.errors };
  }

  const content = {
    schema: SNAPSHOT_SCHEMA,
    sourceIssue: parsed.value.provenance.sourceIssue,
    provider: {
      providerId: parsed.value.providerCapability.providerId,
      manifestDigest: parsed.value.providerCapability.manifestDigest,
      conformanceDigest: parsed.value.providerCapability.conformanceDigest,
      capabilities: parsed.value.providerCapability.capabilities,
    },
    catalog: {
      catalogVersion: parsed.value.catalog.catalogVersion,
      snapshotDigest: parsed.value.catalog.snapshotDigest,
      issuedAt: parsed.value.catalog.issuedAt,
      staleAfter: parsed.value.catalog.staleAfter,
    },
    mapping: {
      mappingId: parsed.value.mapping.mappingId,
      mappingDigest: parsed.value.mapping.mappingDigest,
      providerId: parsed.value.mapping.providerId,
      resourceType: parsed.value.mapping.resourceType,
      providerResourceClass: parsed.value.mapping.providerResourceClass,
      requires: parsed.value.mapping.requires,
    },
    approval: {
      approvalId: parsed.value.approval.approvalId,
      approvedBy: parsed.value.approval.approvedBy,
      approvedAt: parsed.value.approval.approvedAt,
      evidenceDigest: parsed.value.approval.evidenceDigest,
    },
    version: {
      publicationVersion: PUBLICATION_VERSION,
      catalogVersion: parsed.value.catalog.catalogVersion,
    },
    provenance: parsed.value.provenance,
    providerDefaults: parsed.value.providerDefaults,
  };
  const snapshotId = `bes_${stableDigest(content).slice(0, 24)}`;
  if (parsed.value.expectedSnapshotId && parsed.value.expectedSnapshotId !== snapshotId) {
    return {
      ok: false,
      errors: ["shadow update changed snapshot content without a new snapshot identity"],
    };
  }

  return {
    ok: true,
    errors: [],
    snapshot: deepFreeze({
      snapshotId,
      ...content,
    }),
  };
}

export function createResolutionProofInput(snapshot) {
  return deepFreeze({
    authority: "meta-cloud-broker",
    environmentSnapshotId: snapshot.snapshotId,
    environmentDigest: `sha256:${stableDigest(snapshot)}`,
    allowedProviderDefaults: snapshot.providerDefaults.map((definition) => definition.definitionId),
    receiptInputRole: "immutable-broker-environment",
  });
}

export function validateArchitectureEvidence({ architecture, proto, cue, pact }) {
  const errors = [];
  requireMatch(proto, /message BrokerEnvironmentSnapshot/, "proto must define BrokerEnvironmentSnapshot", errors);
  requireMatch(proto, /message ProviderCapabilityPublication/, "proto must define ProviderCapabilityPublication", errors);
  requireMatch(proto, /message MappingPublication/, "proto must define MappingPublication", errors);
  requireMatch(cue, /#BrokerEnvironmentSnapshot:/, "CUE must constrain BrokerEnvironmentSnapshot", errors);
  requireMatch(cue, /#ProviderCapabilityPublication:/, "CUE must constrain ProviderCapabilityPublication", errors);
  requireMatch(cue, /#MappingPublication:/, "CUE must constrain MappingPublication", errors);
  requireMatch(architecture, /parse, don't validate/i, "architecture must name parse, don't validate", errors);
  requireMatch(
    architecture,
    /ParsedBrokerEnvironmentPublication/,
    "architecture must name the parsed publication type",
    errors,
  );
  for (const word of ["Command", "Events", "Actor", "event store", "projection", "Snapshot", "read store"]) {
    requireMatch(architecture, new RegExp(word, "i"), `architecture must name ${word}`, errors);
  }
  if (pact?.consumer?.name !== "ProviderCatalogPublisher") {
    errors.push("PACT consumer must be ProviderCatalogPublisher");
  }
  if (pact?.provider?.name !== "MetaCloudBrokerEnvironmentSnapshot") {
    errors.push("PACT provider must be MetaCloudBrokerEnvironmentSnapshot");
  }
  if (!Array.isArray(pact?.interactions) || pact.interactions.length < 2) {
    errors.push("PACT must include at least accepted and rejected publication interactions");
  }
  return errors;
}

function parsePublication(publication) {
  const errors = [];

  if (!publication || !isJsonObject(publication)) {
    return { ok: false, errors: ["publication must be an object"] };
  }

  let value;
  try {
    value = structuredClone(publication);
  } catch {
    return { ok: false, errors: ["publication must be cloneable"] };
  }

  validateProviderCapability(value.providerCapability, errors);
  validateCatalog(value.catalog, value.asOf, errors);
  validateMapping(value.mapping, value.providerCapability, errors);
  validateApproval(value.approval, errors);
  validateProvenance(value.provenance, errors);
  validateProviderDefaults(value.providerDefaults, value.providerCapability, errors);

  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}

function validateProviderCapability(providerCapability, errors) {
  if (!providerCapability || !isJsonObject(providerCapability)) {
    errors.push("providerCapability must be an object");
    return;
  }
  if (!isNonEmpty(providerCapability.providerId)) {
    errors.push("providerCapability.providerId must be non-empty");
  }
  for (const field of ["manifestDigest", "conformanceDigest"]) {
    if (!isShaDigest(providerCapability[field])) {
      errors.push(`${field} must be a sha256 digest`);
    }
  }
  if (!Array.isArray(providerCapability.capabilities) || providerCapability.capabilities.length === 0) {
    errors.push("providerCapability.capabilities must be non-empty");
    return;
  }

  const coverage = new Map(
    (providerCapability.conformance ?? []).map((entry) => [entry.type, new Set(entry.features ?? [])]),
  );
  for (const capability of providerCapability.capabilities) {
    if (!isNonEmpty(capability.type)) {
      errors.push("provider capability type must be non-empty");
      continue;
    }
    const covered = coverage.get(capability.type);
    if (!covered) {
      errors.push(`capability ${capability.type} lacks conformance coverage`);
      continue;
    }
    for (const feature of capability.features ?? []) {
      if (!covered.has(feature)) {
        errors.push(`capability ${capability.type} feature ${feature} lacks conformance coverage`);
      }
    }
  }
}

function validateCatalog(catalog, asOf, errors) {
  if (!catalog || !isJsonObject(catalog)) {
    errors.push("catalog must be an object");
    return;
  }
  if (!isNonEmpty(catalog.catalogVersion)) {
    errors.push("catalogVersion must be non-empty");
  }
  if (!isShaDigest(catalog.snapshotDigest)) {
    errors.push("catalog snapshotDigest must be a sha256 digest");
  }
  if (Date.parse(asOf) > Date.parse(catalog.staleAfter)) {
    errors.push("catalog snapshot is stale");
  }
}

function validateMapping(mapping, providerCapability, errors) {
  if (!mapping || !isJsonObject(mapping)) {
    errors.push("mapping must be an object");
    return;
  }
  if (mapping.providerId !== providerCapability?.providerId) {
    errors.push("mapping providerId must match provider capability");
  }
  if (!isShaDigest(mapping.mappingDigest)) {
    errors.push("mappingDigest must be a sha256 digest");
  }
  if (mapping.compatibility !== "compatible") {
    errors.push("mapping compatibility must be compatible");
  }

  const capability = (providerCapability?.capabilities ?? []).find((entry) => entry.type === mapping.resourceType);
  if (!capability) {
    errors.push(`mapping resourceType ${String(mapping.resourceType)} is not published by provider`);
    return;
  }
  const features = new Set(capability.features ?? []);
  for (const required of mapping.requires ?? []) {
    if (!features.has(required)) {
      errors.push(`mapping requires ${required}, but provider capability ${mapping.resourceType} does not publish it`);
    }
  }
}

function validateApproval(approval, errors) {
  if (!approval || !isJsonObject(approval)) {
    errors.push("approval must be an object");
    return;
  }
  if (approval.decision !== "approved") {
    errors.push("approval decision must be approved");
  }
  if (!isNonEmpty(approval.approvalId) || !isNonEmpty(approval.approvedBy)) {
    errors.push("approval id and approver must be non-empty");
  }
  if (!isShaDigest(approval.evidenceDigest)) {
    errors.push("approval evidenceDigest must be a sha256 digest");
  }
}

function validateProvenance(provenance, errors) {
  if (!provenance || !isJsonObject(provenance)) {
    errors.push("provenance must be an object");
    return;
  }
  if (provenance.sourceIssue !== "HOBO-526") {
    errors.push("provenance sourceIssue must be HOBO-526");
  }
  if (!isShaDigest(provenance.digest)) {
    errors.push("provenance digest must be a sha256 digest");
  }
}

function validateProviderDefaults(providerDefaults, providerCapability, errors) {
  if (!Array.isArray(providerDefaults) || providerDefaults.length === 0) {
    errors.push("providerDefaults must be non-empty");
    return;
  }
  for (const definition of providerDefaults) {
    if (definition.providerId !== providerCapability?.providerId) {
      errors.push(`provider default ${String(definition.definitionId)} providerId must match publication provider`);
    }
    if (definition.role !== "broker-validation-input") {
      errors.push(`provider default ${String(definition.definitionId)} must be broker-validation-input`);
    }
  }
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function digestRef(seed) {
  return `sha256:${stableDigest(seed)}`;
}

function merge(base, override = {}) {
  return {
    ...structuredClone(base),
    ...structuredClone(override),
  };
}

function isNonEmpty(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isShaDigest(value) {
  return isJsonString(value) && /^sha256:[a-f0-9]{64}$/.test(value);
}

function requireMatch(value, pattern, message, errors) {
  if (!pattern.test(value ?? "")) {
    errors.push(message);
  }
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
