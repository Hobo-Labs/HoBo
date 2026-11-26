import { createHash, createHmac } from "node:crypto";

import {
  createArtifactPayload,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const RESOURCE_PACK_DISTRIBUTION_CONTRACT = "hobo.resource-pack-distribution/v1";
export const RESOURCE_PACK_SCHEMA = "hobo.resource-pack/v1";
export const RESOURCE_PACK_MEDIA_TYPE = "application/vnd.hobo.resource-pack.v1+json";
export const OFFLINE_RESOURCE_PACK_BUNDLE_SCHEMA = "hobo.offline-resource-pack-bundle/v1";

const DEFAULT_CONFORMANCE_SUITE = "@hobo/conformance/resource-pack@1.0.0";
const DEFAULT_COORDINATE_SCOPE = "oci://registry.example/hobo/resource-packs/";

export function createResourcePackTrustBoundary({
  trustedSigningKeys,
  trustedBuilderIds,
  requiredConformanceSuites = [DEFAULT_CONFORMANCE_SUITE],
  allowedCoordinateScopes = [DEFAULT_COORDINATE_SCOPE],
  minimumProvenanceTier = "slsa-build-l3",
  minimumBuildTimestamp = null,
  trustedOfflineBundleKeys = [],
} = {}) {
  const trustedKeyIds = asArray(trustedSigningKeys, "trustedSigningKeys").map((key) =>
    isJsonString(key) ? key : key.keyId
  );
  const signedArtifactTrustBoundary = createTrustBoundary({
    trustedKeyIds,
    trustedBuilderIds,
    requiredConformanceSuites,
    allowedCoordinateScopes,
    minimumProvenanceTier,
  });

  return freezeClone({
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    signedArtifactTrustBoundary,
    requiredConformanceSuites: [...requiredConformanceSuites],
    minimumBuildTimestamp,
    trustedOfflineBundleKeys: trustedOfflineBundleKeys.map((key) => ({
      keyId: key.keyId,
      secret: key.secret,
    })),
  });
}

export function createOfflineBundleSigningKey({ keyId, secret } = {}) {
  if (!keyId || !isJsonString(keyId)) {
    throw new Error("offline bundle signing keyId is required");
  }
  if (!secret || !isJsonString(secret)) {
    throw new Error("offline bundle signing secret is required");
  }
  return Object.freeze({ keyId, secret });
}

export function createYard({ yardId = "yard.dev.local", catalog = [], airGap = {} } = {}) {
  return freezeClone({
    yardId,
    catalog,
    events: [],
    airGap: {
      lastBundleIssuedAt: airGap.lastBundleIssuedAt ?? null,
      lastAcceptedBuildTimestamp: airGap.lastAcceptedBuildTimestamp ?? null,
    },
  });
}

export function createFixtureProviderResourcePack({
  name = "@hobo/aws-defaults",
  version = "1.0.0",
  provider = {
    id: "aws",
    version: "6.0.0",
    codeDigest: digestText("aws-provider-code-v1"),
  },
  definitions = defaultAwsDefinitions(),
  signingKey,
  issuedAt = "2026-06-26T12:00:00.000Z",
  provenanceTier = "slsa-build-l3",
  conformanceSuite = DEFAULT_CONFORMANCE_SUITE,
  conformancePassed = true,
  selectionHint = null,
} = {}) {
  if (!signingKey) {
    throw new Error("signingKey is required");
  }

  const content = sortKeys({
    kind: "provider-resource-pack",
    name,
    version,
    provider,
    definitions: definitions.map(normalizeDefinition),
    selectionHint,
  });
  const contentDigest = digestValue(content);
  const definitionDigests = Object.fromEntries(
    content.definitions.map((definition) => [definition.id, digestValue(definition)])
  );
  const conformanceReport = sortKeys({
    suiteId: conformanceSuite,
    passed: conformancePassed,
    assertions: [
      "provider-code-bundled",
      "default-resource-definitions-bundled",
      "matching-availability-only",
    ],
    subject: {
      packContentDigest: contentDigest,
      providerCodeDigest: provider.codeDigest,
      definitionDigests,
    },
  });
  const artifact = createArtifactPayload({
    coordinate: `${DEFAULT_COORDINATE_SCOPE}${safeCoordinate(name)}`,
    version,
    mediaType: RESOURCE_PACK_MEDIA_TYPE,
    bytes: stableStringify(content),
  });
  const signedArtifact = publishSignedArtifact({
    artifact,
    signingKey,
    conformanceReport,
    issuedAt,
    provenanceTier,
  });

  return freezeClone({
    schema: RESOURCE_PACK_SCHEMA,
    name,
    version,
    content,
    contentDigest,
    conformanceReport,
    signedArtifact,
  });
}

export function hoboAddResourcePack({
  yard = createYard(),
  pack,
  trustBoundary,
  command = "hobo add",
} = {}) {
  if (!["hobo add", "hobo pack add"].includes(command)) {
    throw new Error("command must be hobo add or hobo pack add");
  }

  const normalizedYard = normalizeYard(yard);
  const verification = verifyResourcePack({ pack, trustBoundary });
  if (!verification.ok) {
    return freezeClone({
      ok: false,
      contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
      command,
      reasons: verification.reasons,
      yard: normalizedYard,
      availableToMatching: false,
      selectedByMatching: false,
      events: [],
      warnings: [],
    });
  }

  const warnings = pack.content.selectionHint?.forceWinner === true
    ? ["selection.force_ignored"]
    : [];
  const entries = pack.content.definitions.map((definition) => catalogEntryFor({ definition, pack }));
  const event = {
    type: "resourcePack.Installed",
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    command,
    yardId: normalizedYard.yardId,
    pack: packRef(pack),
    definitions: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      provider: entry.provider,
      driver: entry.driver,
      definitionDigest: entry.definitionDigest,
    })),
    availableToMatching: true,
    selectedByMatching: false,
    warnings,
  };
  const updatedYard = freezeClone({
    ...normalizedYard,
    catalog: [...normalizedYard.catalog, ...entries],
    events: [...normalizedYard.events, event],
  });

  return freezeClone({
    ok: true,
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    command,
    reasons: [],
    yard: updatedYard,
    entries,
    availableToMatching: true,
    selectedByMatching: false,
    warnings,
    events: [event],
  });
}

export function verifyResourcePack({ pack, trustBoundary } = {}) {
  const reasons = [];
  if (!pack || !isJsonObject(pack) || Array.isArray(pack)) {
    return rejectedVerification(["resourcePack.required"]);
  }
  if (pack.schema !== RESOURCE_PACK_SCHEMA) {
    reasons.push("resourcePack.schema");
  }
  if (!pack.content || !isJsonObject(pack.content) || Array.isArray(pack.content)) {
    reasons.push("resourcePack.content.required");
  }
  if (!trustBoundary?.signedArtifactTrustBoundary) {
    reasons.push("trustBoundary.required");
  }

  const contentDigest = pack.content ? digestValue(pack.content) : null;
  if (contentDigest && pack.contentDigest !== contentDigest) {
    reasons.push("resourcePack.content_digest_mismatch");
  }
  if (pack.signedArtifact?.artifact?.mediaType !== RESOURCE_PACK_MEDIA_TYPE) {
    reasons.push("resourcePack.media_type");
  }
  if (pack.content && pack.signedArtifact?.artifact?.bytes !== stableStringify(pack.content)) {
    reasons.push("resourcePack.signed_content_mismatch");
  }

  if (trustBoundary?.signedArtifactTrustBoundary) {
    const install = verifyInstallCandidate({
      candidate: pack.signedArtifact,
      trustBoundary: trustBoundary.signedArtifactTrustBoundary,
    });
    reasons.push(...install.reasons.map((reason) => `signedArtifact.${reason}`));
  }

  reasons.push(...conformanceReasons({ pack, contentDigest, trustBoundary }));
  reasons.push(...buildTimestampReasons({ pack, trustBoundary }));

  if (reasons.length > 0) {
    return rejectedVerification(unique(reasons));
  }
  return freezeClone({
    ok: true,
    reasons: [],
    pack: packRef(pack),
  });
}

export function matchManifest({ yard, manifest, camp } = {}) {
  const normalizedYard = normalizeYard(yard);
  const resources = asArray(manifest?.resources, "manifest.resources");
  const catalogContentHash = catalogHash(normalizedYard.catalog);
  const decisions = resources.map((resource) =>
    matchResource({
      resource,
      catalog: normalizedYard.catalog,
      catalogContentHash,
      camp,
    })
  );

  return freezeClone({
    ok: decisions.every((decision) => decision.winner !== null),
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    catalogContentHash,
    decisions,
  });
}

export function createSignedOfflineResourcePackBundle({
  bundleId = "bundle.resource-pack.airgap",
  issuedAt = "2026-06-26T13:00:00.000Z",
  packs,
  bundleSigningKey,
} = {}) {
  if (!bundleSigningKey) {
    throw new Error("bundleSigningKey is required");
  }
  const payload = sortKeys({
    schema: OFFLINE_RESOURCE_PACK_BUNDLE_SCHEMA,
    bundleId,
    issuedAt,
    packs: asArray(packs, "packs"),
    verificationPolicy: {
      signature: "required",
      provenance: "required",
      conformance: "required",
      antiRollback: "required",
      inBoundary: "required",
    },
  });
  const bundleDigest = digestValue(payload);

  return freezeClone({
    ...payload,
    bundleDigest,
    signature: {
      alg: "fixture-hmac-sha256",
      keyId: bundleSigningKey.keyId,
      value: signOfflineBundle({ bundleDigest, secret: bundleSigningKey.secret }),
    },
  });
}

export function importOfflineResourcePackBundle({
  yard = createYard(),
  bundle,
  trustBoundary,
} = {}) {
  const normalizedYard = normalizeYard(yard);
  const reasons = verifyOfflineBundle({ bundle, yard: normalizedYard, trustBoundary });
  if (reasons.length > 0) {
    return freezeClone({
      ok: false,
      contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
      reasons,
      yard: normalizedYard,
      event: null,
      egressAttempted: false,
    });
  }

  let nextYard = normalizedYard;
  const installedPacks = [];
  for (const pack of bundle.packs) {
    const installed = hoboAddResourcePack({
      yard: nextYard,
      pack,
      trustBoundary,
      command: "hobo pack add",
    });
    nextYard = installed.yard;
    installedPacks.push(packRef(pack));
  }

  const maxBuildTimestamp = maxIsoTimestamp([
    normalizedYard.airGap.lastAcceptedBuildTimestamp,
    ...bundle.packs.map((pack) => pack.signedArtifact.provenance.slsa.issuedAt),
  ]);
  const event = {
    type: "resourcePack.OfflineBundleImported",
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    bundleId: bundle.bundleId,
    bundleDigest: bundle.bundleDigest,
    importedPacks: installedPacks,
    verification: {
      signature: "passed",
      provenance: "passed",
      conformance: "passed",
      antiRollback: "passed",
      inBoundary: "passed",
    },
    egressAttempted: false,
  };
  nextYard = freezeClone({
    ...nextYard,
    airGap: {
      lastBundleIssuedAt: maxIsoTimestamp([nextYard.airGap.lastBundleIssuedAt, bundle.issuedAt]),
      lastAcceptedBuildTimestamp: maxBuildTimestamp,
    },
    events: [...nextYard.events, event],
  });

  return freezeClone({
    ok: true,
    contract: RESOURCE_PACK_DISTRIBUTION_CONTRACT,
    reasons: [],
    yard: nextYard,
    event,
    egressAttempted: false,
  });
}

export function catalogHash(catalog) {
  return digestValue(asArray(catalog, "catalog").map(sortKeys));
}

function verifyOfflineBundle({ bundle, yard, trustBoundary }) {
  const reasons = [];
  if (!bundle || !isJsonObject(bundle) || Array.isArray(bundle)) {
    return ["offlineBundle.required"];
  }
  if (bundle.schema !== OFFLINE_RESOURCE_PACK_BUNDLE_SCHEMA) {
    reasons.push("offlineBundle.schema");
  }
  if (!bundle.signature || bundle.signature.alg !== "fixture-hmac-sha256") {
    reasons.push("offlineBundle.signature.required");
  }
  const unsigned = withoutKeys(bundle, ["bundleDigest", "signature"]);
  const expectedDigest = digestValue(sortKeys(unsigned));
  if (bundle.bundleDigest !== expectedDigest) {
    reasons.push("offlineBundle.digest_mismatch");
  }
  const trustedBundleKey = (trustBoundary?.trustedOfflineBundleKeys ?? []).find(
    (key) => key.keyId === bundle.signature?.keyId
  );
  if (!trustedBundleKey) {
    reasons.push("offlineBundle.signature.key_untrusted");
  } else if (
    bundle.signature?.value !== signOfflineBundle({ bundleDigest: bundle.bundleDigest, secret: trustedBundleKey.secret })
  ) {
    reasons.push("offlineBundle.signature.invalid");
  }
  if (
    yard.airGap.lastBundleIssuedAt &&
    Date.parse(bundle.issuedAt) <= Date.parse(yard.airGap.lastBundleIssuedAt)
  ) {
    reasons.push("airgap.rollback.bundle_epoch");
  }

  const packs = Array.isArray(bundle.packs) ? bundle.packs : [];
  if (packs.length === 0) {
    reasons.push("offlineBundle.packs.required");
  }

  for (const pack of packs) {
    const verification = verifyResourcePack({ pack, trustBoundary });
    reasons.push(...verification.reasons.map((reason) => `${pack.name ?? "pack"}:${reason}`));
    const buildTimestamp = pack?.signedArtifact?.provenance?.slsa?.issuedAt;
    if (
      yard.airGap.lastAcceptedBuildTimestamp &&
      Date.parse(buildTimestamp) <= Date.parse(yard.airGap.lastAcceptedBuildTimestamp)
    ) {
      reasons.push(`${pack.name}:airgap.rollback.vulnerable_pack`);
    }
  }

  return unique(reasons);
}

function conformanceReasons({ pack, contentDigest, trustBoundary }) {
  const reasons = [];
  const report = pack.signedArtifact?.conformance?.report;
  if (!report || !isJsonObject(report) || Array.isArray(report)) {
    return ["conformance.required"];
  }
  if (stableStringify(pack.conformanceReport ?? null) !== stableStringify(report)) {
    reasons.push("conformance.report_unsigned_mismatch");
  }
  const requiredSuites = trustBoundary?.requiredConformanceSuites ?? [];
  if (!requiredSuites.includes(report.suiteId)) {
    reasons.push("conformance.suite_untrusted");
  }
  if (report.passed !== true) {
    reasons.push("conformance.failed");
  }
  if (report.subject?.packContentDigest !== contentDigest) {
    reasons.push("conformance.stale_pack_content");
  }
  if (report.subject?.providerCodeDigest !== pack.content?.provider?.codeDigest) {
    reasons.push("conformance.stale_provider_code");
  }

  const expectedDefinitionDigests = Object.fromEntries(
    (pack.content?.definitions ?? []).map((definition) => [definition.id, digestValue(definition)])
  );
  if (stableStringify(report.subject?.definitionDigests ?? {}) !== stableStringify(expectedDefinitionDigests)) {
    reasons.push("conformance.stale_definition_digest");
  }

  return reasons;
}

function buildTimestampReasons({ pack, trustBoundary }) {
  const minimum = trustBoundary?.minimumBuildTimestamp;
  const issuedAt = pack?.signedArtifact?.provenance?.slsa?.issuedAt;
  if (minimum && Date.parse(issuedAt) < Date.parse(minimum)) {
    return ["provenance.build_timestamp_below_policy"];
  }
  return [];
}

function matchResource({ resource, catalog, catalogContentHash, camp }) {
  const candidates = catalog
    .filter((entry) => entry.type === resource.type)
    .filter((entry) => satisfies(entry.satisfies, resource.require ?? []))
    .filter((entry) => !camp?.provider || entry.provider === camp.provider)
    .filter((entry) => !camp?.driver || entry.driver === camp.driver)
    .map((entry) => ({
      ...entry,
      score: matchScore({ entry, resource, camp }),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if ((right.priority ?? 0) !== (left.priority ?? 0)) return (right.priority ?? 0) - (left.priority ?? 0);
      return left.id.localeCompare(right.id);
    });

  const [winner, runnerUp] = candidates;
  return {
    resourceId: resource.id,
    type: resource.type,
    winner: winner ? winnerSnapshot(winner) : null,
    candidateCount: candidates.length,
    equalScoreTie: Boolean(winner && runnerUp && winner.score === runnerUp.score),
    catalogContentHash,
    candidateContentHashes: candidates.map((candidate) => ({
      definitionId: candidate.id,
      pack: candidate.pack.name,
      packContentDigest: candidate.pack.contentDigest,
      definitionDigest: candidate.definitionDigest,
      score: candidate.score,
    })),
  };
}

function matchScore({ entry, resource, camp }) {
  let score = 0;
  score += satisfies(entry.satisfies, resource.require ?? []) ? resource.require?.length ?? 0 : 0;
  score += camp?.provider && entry.provider === camp.provider ? 5 : 0;
  score += camp?.driver && entry.driver === camp.driver ? 3 : 0;
  score += Object.keys(entry.match ?? {}).length;
  return score;
}

function catalogEntryFor({ definition, pack }) {
  const normalized = normalizeDefinition(definition);
  return freezeClone({
    ...normalized,
    source: "resource-pack",
    pack: packRef(pack),
    definitionDigest: digestValue(normalized),
    availableToMatching: true,
    selectedByMatching: false,
  });
}

function defaultAwsDefinitions() {
  return [
    {
      id: "aws.default.database",
      type: "database",
      provider: "aws",
      driver: "terraform",
      resourceClass: "rds-aurora-postgres",
      satisfies: ["postgres", "managed", "ha"],
      match: {},
    },
    {
      id: "aws.default.object-store",
      type: "objectStore",
      provider: "aws",
      driver: "terraform",
      resourceClass: "s3-bucket",
      satisfies: ["durable", "versioned"],
      match: {},
    },
    {
      id: "aws.default.compute",
      type: "compute",
      provider: "aws",
      driver: "terraform",
      resourceClass: "fargate-service",
      satisfies: ["container", "http"],
      match: {},
    },
  ];
}

function normalizeDefinition(definition) {
  return sortKeys({
    ...definition,
    match: definition.match ?? {},
    priority: 0,
    satisfies: definition.satisfies ?? [],
  });
}

function signOfflineBundle({ bundleDigest, secret }) {
  return createHmac("sha256", secret).update(bundleDigest).digest("base64url");
}

function normalizeYard(yard) {
  if (!yard || !isJsonObject(yard) || Array.isArray(yard)) {
    throw new Error("yard must be an object");
  }
  return freezeClone({
    yardId: yard.yardId,
    catalog: yard.catalog ?? [],
    events: yard.events ?? [],
    airGap: {
      lastBundleIssuedAt: yard.airGap?.lastBundleIssuedAt ?? null,
      lastAcceptedBuildTimestamp: yard.airGap?.lastAcceptedBuildTimestamp ?? null,
    },
  });
}

function packRef(pack) {
  return {
    name: pack.name,
    version: pack.version,
    contentDigest: pack.contentDigest,
    artifactDigest: pack.signedArtifact.artifact.digest,
    provenanceIssuedAt: pack.signedArtifact.provenance.slsa.issuedAt,
  };
}

function winnerSnapshot(entry) {
  return {
    id: entry.id,
    type: entry.type,
    provider: entry.provider,
    driver: entry.driver,
    resourceClass: entry.resourceClass,
    pack: entry.pack,
    definitionDigest: entry.definitionDigest,
    availableToMatching: entry.availableToMatching,
    selectedByMatching: entry.selectedByMatching,
    score: entry.score,
  };
}

function rejectedVerification(reasons) {
  return freezeClone({
    ok: false,
    reasons,
    pack: null,
  });
}

function satisfies(actual = [], required = []) {
  return required.every((item) => actual.includes(item));
}

function maxIsoTimestamp(values) {
  return values
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) ?? null;
}

function asArray(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function safeCoordinate(value) {
  return String(value).replace(/^@/, "").replace(/[^A-Za-z0-9_.-]+/g, "-");
}

function digestText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestValue(value) {
  return digestText(stableStringify(value));
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

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function withoutKeys(value, keys) {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function unique(values) {
  return [...new Set(values)];
}

function freezeClone(value) {
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}
