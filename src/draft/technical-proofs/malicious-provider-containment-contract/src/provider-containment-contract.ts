import { isJsonString, isJsonObject } from "./json.js";
export const CONTAINMENT_CONTRACT_VERSION = "hobo.provider-containment/v1";

const DEFAULT_COORDINATE = "oci://registry.example/hobo/provider/evil";

export function createEvilProviderFixture(overrides = {}) {
  return deepFreeze({
    coordinate: DEFAULT_COORDINATE,
    version: "2.0.0",
    implementedCapabilities: ["database"],
    productionBehavior: "unknown-after-conformance",
    ...overrides,
    manifest: {
      claimedCapabilities: ["database"],
      ...overrides.manifest,
    },
    packageIntegrity: {
      signed: true,
      signatureValid: true,
      digestValid: true,
      keyId: "provider-key-1",
      ...overrides.packageIntegrity,
    },
    conformanceAttachment: {
      suiteId: "@hobo/conformance/provider-capability/database",
      passed: true,
      digest: "sha256:report",
      ...overrides.conformanceAttachment,
    },
    sandboxRerun: {
      suiteId: "@hobo/conformance/provider-capability/database",
      passed: true,
      digest: "sha256:report",
      exercisedCapabilities: ["database"],
      ...overrides.sandboxRerun,
    },
    sandboxEgressAttempts: Array.isArray(overrides.sandboxEgressAttempts)
      ? [...overrides.sandboxEgressAttempts]
      : [],
  });
}

export function evaluateProviderContainment({ provider, policy }) {
  const parsedProvider = requireObject(provider, "provider");
  const parsedPolicy = normalizePolicy(policy);
  const gates = [];
  const auditEvents = [];
  const reasons = [];
  const residualRisks = [
    "validly-signed-but-malicious",
    "benign-during-conformance-malicious-in-production"
  ];
  const sandboxEffects = [];

  evaluateCapabilityClaim({ provider: parsedProvider, policy: parsedPolicy, gates, auditEvents, reasons });
  evaluateArtifactIntegrity({ provider: parsedProvider, gates, auditEvents, reasons });
  evaluateOfflineRevocation({ provider: parsedProvider, policy: parsedPolicy, gates, auditEvents, reasons });
  evaluateConformanceRerun({ provider: parsedProvider, gates, auditEvents, reasons });
  evaluateRollback({ provider: parsedProvider, policy: parsedPolicy, gates, auditEvents, reasons });
  evaluateYank({ provider: parsedProvider, policy: parsedPolicy, gates, auditEvents, reasons });
  evaluateSandboxEgress({
    provider: parsedProvider,
    policy: parsedPolicy,
    gates,
    auditEvents,
    reasons,
    residualRisks,
    sandboxEffects
  });
  evaluateProductionBehaviorLimit({ provider: parsedProvider, gates, auditEvents });

  const blockedGateIds = new Set(gates.filter((gate) => gate.decision === "deny").map((gate) => gate.id));
  const ok = blockedGateIds.size === 0;
  const artifactBlocked = ["artifact.signature", "artifact.digest", "trust.offline_revocation"]
    .some((gateId) => blockedGateIds.has(gateId));
  const selectionBlocked = ["artifact.anti_rollback", "listing.yanked"].some((gateId) => blockedGateIds.has(gateId));

  return deepFreeze({
    contractVersion: CONTAINMENT_CONTRACT_VERSION,
    ok,
    certification: ok ? "accepted" : "refused",
    installable: !artifactBlocked && ok,
    selectable: !selectionBlocked && ok,
    reachesInfraOutsideScope: false,
    trustedAttachedConformanceReport: false,
    assurance: ok
      ? "integrity-conformance-and-containment-gates-passed-not-benignity"
      : "rejected",
    reasons: [...new Set(reasons)],
    gates,
    auditEvents,
    sandboxEffects,
    residualRisks: ok ? [...new Set(residualRisks)] : []
  });
}

function evaluateCapabilityClaim({ provider, policy, gates, auditEvents, reasons }) {
  const unsupported = claimedCapabilities(provider)
    .filter((capability) => !policy.supportedCapabilities.includes(capability))
    .sort();
  if (unsupported.length === 0) {
    allow(gates, "provider.claim.unsupported_capability");
    return;
  }

  deny({
    gates,
    auditEvents,
    reasons,
    id: "provider.claim.unsupported_capability",
    code: `provider.claim.unsupported_capability: ${unsupported.join(", ")}`,
    gateReasons: unsupported.map((capability) => `unsupported capability: ${capability}`),
    eventType: "provider.CertificationRefused",
    details: { unsupportedCapabilities: unsupported }
  });
}

function evaluateArtifactIntegrity({ provider, gates, auditEvents, reasons }) {
  const integrity = provider.packageIntegrity ?? {};
  if (integrity.signed !== true) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "artifact.signature",
      code: "artifact.signature_required",
      gateReasons: ["provider package must carry a trusted signature"],
      eventType: "artifact.InstallRejected"
    });
  } else if (integrity.signatureValid !== true) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "artifact.signature",
      code: "artifact.signature_invalid",
      gateReasons: ["provider package signature must verify"],
      eventType: "artifact.InstallRejected"
    });
  } else {
    allow(gates, "artifact.signature");
  }

  if (integrity.digestValid !== true) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "artifact.digest",
      code: "artifact.digest_mismatch",
      gateReasons: ["provider package digest must match signed payload"],
      eventType: "artifact.InstallRejected"
    });
    return;
  }
  allow(gates, "artifact.digest");
}

function evaluateOfflineRevocation({ provider, policy, gates, auditEvents, reasons }) {
  const keyId = provider.packageIntegrity?.keyId;
  if (keyId && policy.revokedKeyIds.includes(keyId)) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "trust.offline_revocation",
      code: `trust.key_revoked: ${keyId}`,
      gateReasons: [`signing key ${keyId} is revoked by offline trust metadata`],
      eventType: "registry.KeyRevocationMatched",
      details: { keyId }
    });
    return;
  }
  allow(gates, "trust.offline_revocation");
}

function evaluateConformanceRerun({ provider, gates, auditEvents, reasons }) {
  const attached = provider.conformanceAttachment ?? {};
  const rerun = provider.sandboxRerun ?? {};
  const mismatch =
    attached.passed !== rerun.passed ||
    attached.suiteId !== rerun.suiteId ||
    attached.digest !== rerun.digest ||
    rerun.passed !== true;

  if (mismatch) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "conformance.in_boundary_rerun",
      code: "conformance.report_mismatch",
      gateReasons: ["attached conformance report must match an in-boundary rerun"],
      eventType: "conformance.ReportRejected",
      details: {
        attached: summarizeConformance(attached),
        rerun: summarizeConformance(rerun)
      }
    });
    return;
  }
  allow(gates, "conformance.in_boundary_rerun");

  const exercised = new Set(Array.isArray(rerun.exercisedCapabilities) ? rerun.exercisedCapabilities : []);
  const missingCoverage = claimedCapabilities(provider)
    .filter((capability) => !exercised.has(capability))
    .sort();
  if (missingCoverage.length > 0) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "conformance.claimed_capability_coverage",
      code: `conformance.coverage_missing: ${missingCoverage.join(", ")}`,
      gateReasons: missingCoverage.map((capability) => `claimed capability not rerun: ${capability}`),
      eventType: "conformance.ReportRejected",
      details: { missingCoverage }
    });
    return;
  }
  allow(gates, "conformance.claimed_capability_coverage");
}

function evaluateRollback({ provider, policy, gates, auditEvents, reasons }) {
  const minimumVersion = policy.minimumVersions[provider.coordinate];
  if (minimumVersion && compareSemver(provider.version, minimumVersion) < 0) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "artifact.anti_rollback",
      code: `artifact.anti_rollback: ${provider.coordinate}@${provider.version} below ${minimumVersion}`,
      gateReasons: [`${provider.coordinate}@${provider.version} is below minimum ${minimumVersion}`],
      eventType: "registry.RollbackRejected",
      details: {
        coordinate: provider.coordinate,
        version: provider.version,
        minimumVersion
      }
    });
    return;
  }
  allow(gates, "artifact.anti_rollback");
}

function evaluateYank({ provider, policy, gates, auditEvents, reasons }) {
  const ref = `${provider.coordinate}@${provider.version}`;
  if (policy.yankedVersions.includes(ref)) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "listing.yanked",
      code: `listing.yanked: ${ref}`,
      gateReasons: [`${ref} is yanked from new selection`],
      eventType: "listing.SelectionBlocked",
      details: { ref }
    });
    return;
  }
  allow(gates, "listing.yanked");
}

function evaluateSandboxEgress({
  provider,
  policy,
  gates,
  auditEvents,
  reasons,
  residualRisks,
  sandboxEffects
}) {
  let denied = false;
  let observedScoped = false;

  for (const attempt of provider.sandboxEgressAttempts ?? []) {
    const target = String(attempt.target ?? "");
    const channel = isJsonString(attempt.channel) ? attempt.channel : "normal";
    const inScope = policy.allowedEgressTargets.includes(target);
    if (!inScope) {
      denied = true;
      sandboxEffects.push({ target, channel, outcome: "denied" });
      auditEvents.push(event("sandbox.EgressDenied", "sandbox.egress_scope", {
        target,
        channel,
        outcome: "denied"
      }));
      continue;
    }

    observedScoped = true;
    sandboxEffects.push({ target, channel, outcome: "allowed-with-audit" });
    auditEvents.push(event("sandbox.ScopedEgressObserved", "sandbox.egress_scope", {
      target,
      channel,
      outcome: "allowed-with-audit"
    }));
    if (channel === "covert") {
      residualRisks.push("covert-channel-within-scoped-target");
    }
  }

  if (denied) {
    deny({
      gates,
      auditEvents,
      reasons,
      id: "sandbox.egress_scope",
      code: "sandbox.egress_out_of_scope",
      gateReasons: ["sandbox denied egress outside allowed scoped targets"],
      eventType: "provider.CertificationRefused"
    });
    return;
  }

  gates.push({
    id: "sandbox.egress_scope",
    decision: "allow",
    reasons: observedScoped ? ["scoped egress observed and audited"] : []
  });
}

function evaluateProductionBehaviorLimit({ provider, gates, auditEvents }) {
  gates.push({
    id: "provider.production_behavior_limit",
    decision: "observe",
    reasons: [
      "conformance proves boundary behavior, not future benign production intent"
    ]
  });
  if (provider.productionBehavior === "malicious-after-conformance") {
    auditEvents.push(event("provider.ResidualRiskRecorded", "provider.production_behavior_limit", {
      risk: "benign-during-conformance-malicious-in-production"
    }));
  }
}

function allow(gates, id) {
  gates.push({ id, decision: "allow", reasons: [] });
}

function deny({ gates, auditEvents, reasons, id, code, gateReasons, eventType, details = {} }) {
  gates.push({ id, decision: "deny", reasons: gateReasons });
  reasons.push(code);
  auditEvents.push(event(eventType, id, { reasons: gateReasons, ...details }));
}

function event(type, gateId, details = {}) {
  return {
    type,
    gateId,
    details
  };
}

function normalizePolicy(policy) {
  const parsed = requireObject(policy, "policy");
  return {
    supportedCapabilities: stringList(parsed.supportedCapabilities, "policy.supportedCapabilities"),
    allowedEgressTargets: stringList(parsed.allowedEgressTargets, "policy.allowedEgressTargets"),
    revokedKeyIds: Array.isArray(parsed.revokedKeyIds) ? [...parsed.revokedKeyIds] : [],
    yankedVersions: Array.isArray(parsed.yankedVersions) ? [...parsed.yankedVersions] : [],
    minimumVersions: { ...parsed.minimumVersions },
  };
}

function claimedCapabilities(provider) {
  return Array.isArray(provider.manifest?.claimedCapabilities)
    ? [...provider.manifest.claimedCapabilities]
    : [];
}

function compareSemver(left, right) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  for (const index of [0, 1, 2]) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function semverParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
  if (!match) {
    throw new Error(`invalid semver: ${value}`);
  }
  return match.slice(1).map(Number);
}

function summarizeConformance(report) {
  return {
    suiteId: report.suiteId ?? "unknown",
    passed: report.passed === true,
    digest: report.digest ?? "missing"
  };
}

function stringList(values, name) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${name} must be an array`);
  }
  return values.map((value) => {
    if (!isJsonString(value) || value.length === 0) {
      throw new TypeError(`${name} must contain non-empty strings`);
    }
    return value;
  });
}

function requireObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
