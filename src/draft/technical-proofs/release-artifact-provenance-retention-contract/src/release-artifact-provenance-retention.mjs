export const REQUIRED_ARTIFACT_CLASSES = [
  "saas-release",
  "self-host-offline-bundle",
  "cli-release",
  "package-release",
  "registry-listing",
  "generated-provider-artifact",
  "customer-assurance-packet",
];

export const REQUIRED_HANDOFF_FIELDS = [
  "provenanceSource",
  "retentionPeriod",
  "invalidationAndYank",
  "offlineBundleExpectation",
  "supportDebugAccess",
];

export const REQUIRED_OWNER_LANES = [
  "release-engineering",
  "artifact-store",
  "package-cache",
  "registry",
  "compliance",
  "support",
];

const VALID_GAP_DISPOSITIONS = new Set([
  "beta-limitation",
  "ga-blocker",
  "post-ga-follow-up",
]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /\b(implement|build|wire|operate|integrate)\b.*\b(artifact store|blob retention|package cache|registry backend)\b/i,
  /\bproduction\b.*\bretention\b/i,
];

export const RELEASE_ARTIFACT_PROVENANCE_RETENTION = {
  schema: "hobo.release-artifact-provenance-retention/v1",
  issue: "HOBO-504",
  project: "Provenance & Retention",
  phase: "M0",
  goal:
    "Define the M0 release artifact provenance and retention handoff so every shipped artifact class has a verifiable source, retention rule, yank path, offline-bundle posture, and support/debug access boundary before artifact-store implementation work begins.",
  scopeIn: [
    "Artifact classes and handoff fields for release provenance, retention, invalidation/yank, offline bundle expectations, and support/debug access.",
    "Owner-lane links between release engineering, artifact store, package cache, registry, compliance, and support.",
    "Known gap dispositions marked beta limitation, GA blocker, or post-GA follow-up.",
  ],
  scopeOut: [
    "Do not implement an artifact store, package cache, registry backend, or production blob retention in HOBO-504.",
    "Do not create live release pipelines, customer assurance export jobs, or support/debug tooling.",
    "Do not replace SBOM/vulnerability notices, legal/privacy, or registry trust-tier evidence contracts.",
  ],
  artifactClasses: [
    artifactClass({
      id: "saas-release",
      title: "Hosted SaaS control-plane release",
      provenanceSource: "Release Engineering attaches signed build provenance, deployment manifest digest, and source revision for each SaaS release train.",
      retentionPeriod: "Retain release manifest, provenance, deployment evidence, and customer-facing version metadata for the supported release window plus customer assurance review period.",
      invalidationAndYank: "A SaaS release invalidation records affected deployment ids, replacement release id, customer-safe reason, and release-cutline decision.",
      offlineBundleExpectation: "SaaS-only artifacts are explicitly marked online-only and excluded from offline bundles with a retained reason.",
      supportDebugAccess: "Support can inspect retained release manifest, digest, rollout evidence, and redacted logs; no provider credentials or tenant data are exposed.",
    }),
    artifactClass({
      id: "self-host-offline-bundle",
      title: "Self-host and offline install bundle",
      provenanceSource: "Bootstrap Installer publishes bundle manifest, signed checksums, SLSA provenance, and included artifact digest list.",
      retentionPeriod: "Retain bundle manifest, provenance, checksum set, revocation material, and supported-install evidence for every supported self-host release.",
      invalidationAndYank: "Bundle yank records bundle digest, affected install path, replacement or rollback path, revocation note, and support handoff.",
      offlineBundleExpectation: "Offline bundle contents must be manifest-complete, digest-pinned, and carry an explicit unsupported-online-dependency list.",
      supportDebugAccess: "Support can access bundle manifest, install log schema, known issues, and revocation status without customer secrets.",
    }),
    artifactClass({
      id: "cli-release",
      title: "HoBo CLI release",
      provenanceSource: "Release Engineering links CLI package digest, platform build provenance, and compatibility matrix evidence.",
      retentionPeriod: "Retain CLI binary/package digests, platform matrix, provenance, and rollback/yank notes for supported CLI versions.",
      invalidationAndYank: "CLI yank records package version, platform, reason, replacement version, and upgrade-guide note.",
      offlineBundleExpectation: "CLI artifacts included in self-host/offline bundles must be digest-pinned; hosted-only installers are marked online-only.",
      supportDebugAccess: "Support can inspect CLI version, platform, checksum, known issues, and troubleshooting facts without local credentials.",
    }),
    artifactClass({
      id: "package-release",
      title: "Published package release",
      provenanceSource: "Package Cache records package version, source revision, package digest, provenance ref, and publish actor.",
      retentionPeriod: "Retain package tarball digest, metadata, provenance, deprecation/yank records, and dependency lock evidence for supported package versions.",
      invalidationAndYank: "Package yank records version, replacement range, dependent surfaces, customer-visible mitigation, and package-cache invalidation.",
      offlineBundleExpectation: "Offline bundles carry package digests and dependency closure or explicitly state unavailable package classes.",
      supportDebugAccess: "Support can inspect package metadata, deprecation state, known vulnerabilities link, and retained provenance without registry write access.",
    }),
    artifactClass({
      id: "registry-listing",
      title: "Registry listing and capability bundle",
      provenanceSource: "Registry records signed listing descriptor, publisher identity, conformance certificate, and artifact digest.",
      retentionPeriod: "Retain listing descriptor, certification result, provenance, trust-tier history, yank/deprecation events, and customer assurance evidence.",
      invalidationAndYank: "Listing yank records listing id, digest, publisher, affected installs, replacement guidance, and trust-tier change.",
      offlineBundleExpectation: "Offline import bundles include listing descriptor, signatures, revocation snapshot, and anti-rollback metadata.",
      supportDebugAccess: "Support can inspect listing state, digest, certificate, publisher trust, and redacted install evidence without publisher secrets.",
    }),
    artifactClass({
      id: "generated-provider-artifact",
      title: "Generated provider or implementation artifact",
      provenanceSource: "Generation pipeline records prompt/material digest, model/toolchain id, eval/conformance refs, signed certification, and artifact digest.",
      retentionPeriod: "Retain generation certification, trajectory digest, conformance result, provenance, and accepted-risk note for every customer-visible generated artifact.",
      invalidationAndYank: "Generated artifact yank records certification failure, affected capability, replacement candidate, and human approval state.",
      offlineBundleExpectation: "Generated artifacts in offline bundles must include certification/provenance refs or be excluded with an explicit beta limitation.",
      supportDebugAccess: "Support can inspect certification and conformance summaries, not raw prompts, sensitive materials, or tenant data.",
    }),
    artifactClass({
      id: "customer-assurance-packet",
      title: "Customer assurance release evidence packet",
      provenanceSource: "Compliance Evidence Pack links retained artifact manifests, SBOM/notice evidence, release decision, and accepted limitation records.",
      retentionPeriod: "Retain customer assurance packet snapshots for the customer assurance review period and the active supported release window.",
      invalidationAndYank: "Packet invalidation records changed claim, removed evidence, replacement wording, customer notification posture, and owner approval.",
      offlineBundleExpectation: "Offline assurance packets include evidence manifests and explicit unavailable sections; they never imply live provider access.",
      supportDebugAccess: "Support can share approved customer-facing packet sections and internal redaction notes through a support-reviewed path.",
    }),
  ],
  handoffOwnerLinks: [
    ownerLink("release-engineering", "Release Engineering", "Owns release ids, source revisions, signed build provenance, publish/yank decision records, and cutline handoff.", "release train manifest and go/no-go decision"),
    ownerLink("artifact-store", "Provenance & Retention", "Owns artifact class retention rules, support/debug access boundaries, invalidation history, and evidence retention gaps.", "release artifact provenance and retention handoff"),
    ownerLink("package-cache", "Package Cache", "Owns published package digests, cache invalidation, dependency closure, package yanks, and package metadata retention.", "package cache release metadata"),
    ownerLink("registry", "Registry & Distribution", "Owns listing descriptors, signed offline bundle metadata, trust-tier history, and install/yank propagation.", "registry listing and offline bundle descriptor"),
    ownerLink("compliance", "Compliance Evidence Pack", "Owns customer assurance packet sections, legal/privacy/compliance evidence boundaries, and approved customer-facing wording.", "customer assurance packet"),
    ownerLink("support", "Support Workflow", "Owns support/debug access workflow, redaction rules, escalation path, and customer-safe troubleshooting handoff.", "support handoff and debug access record"),
  ],
  knownGaps: [
    {
      id: "manual-provenance-review",
      disposition: "beta-limitation",
      ownerLane: "release-engineering",
      customerImpact: "Beta artifacts may require manual provenance review before customer assurance wording is approved.",
    },
    {
      id: "unretained-yank-evidence",
      disposition: "ga-blocker",
      ownerLane: "artifact-store",
      customerImpact: "GA cannot claim supportable release provenance if yank/invalidation evidence is not retained.",
    },
    {
      id: "automated-customer-assurance-export",
      disposition: "post-ga-follow-up",
      ownerLane: "compliance",
      customerImpact: "Manual assurance packet assembly is acceptable for v1 if evidence sources and retention are recorded.",
    },
  ],
  dependencies: [
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/07-portability-extensibility.md#adr-0073",
    "docs/design/adr/01-architecture-core.md#adr-0085",
  ],
};

export function classifyGapDisposition(record) {
  const summary = {
    "beta-limitation": [],
    "ga-blocker": [],
    "post-ga-follow-up": [],
  };

  for (const gap of record.knownGaps ?? []) {
    if (Object.hasOwn(summary, gap.disposition)) {
      summary[gap.disposition].push(gap.id);
    }
  }

  return summary;
}

export function evaluateArtifactHandoffReadiness(artifact) {
  const errors = [];

  if (!isPlainObject(artifact)) {
    return { ok: false, errors: ["artifact handoff record is required"] };
  }

  for (const field of REQUIRED_HANDOFF_FIELDS) {
    if (!artifact[field]) {
      errors.push(`${artifact.id ?? "<missing>"} missing ${field}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateReleaseArtifactProvenanceRetention(record) {
  const errors = [];

  if (!isPlainObject(record)) {
    return { ok: false, errors: ["release artifact provenance retention record is required"] };
  }
  if (record.issue !== "HOBO-504") {
    errors.push("issue must be HOBO-504");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const entry of record.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`artifact store implementation is scope-out: ${entry}`);
    }
  }

  const artifactIds = new Set((record.artifactClasses ?? []).map((artifact) => artifact.id));
  for (const artifactClass of REQUIRED_ARTIFACT_CLASSES) {
    if (!artifactIds.has(artifactClass)) {
      errors.push(`missing artifact class ${artifactClass}`);
    }
  }

  for (const artifact of record.artifactClasses ?? []) {
    errors.push(...evaluateArtifactHandoffReadiness(artifact).errors);
  }

  const ownerLanes = new Set((record.handoffOwnerLinks ?? []).map((link) => link.lane));
  for (const lane of REQUIRED_OWNER_LANES) {
    if (!ownerLanes.has(lane)) {
      errors.push(`missing owner lane ${lane}`);
    }
  }
  for (const link of record.handoffOwnerLinks ?? []) {
    for (const field of ["ownerProject", "handoffResponsibility", "sourceOfTruth"]) {
      if (!link[field]) {
        errors.push(`${link.lane ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const gap of record.knownGaps ?? []) {
    if (!VALID_GAP_DISPOSITIONS.has(gap.disposition)) {
      errors.push(`${gap.id ?? "<missing>"} disposition must be beta-limitation, ga-blocker, or post-ga-follow-up`);
    }
    if (!gap.ownerLane || !gap.customerImpact) {
      errors.push(`${gap.id ?? "<missing>"} must name ownerLane and customerImpact`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function artifactClass({
  id,
  title,
  provenanceSource,
  retentionPeriod,
  invalidationAndYank,
  offlineBundleExpectation,
  supportDebugAccess,
}) {
  return {
    id,
    title,
    provenanceSource,
    retentionPeriod,
    invalidationAndYank,
    offlineBundleExpectation,
    supportDebugAccess,
  };
}

function ownerLink(lane, ownerProject, handoffResponsibility, sourceOfTruth) {
  return {
    lane,
    ownerProject,
    handoffResponsibility,
    sourceOfTruth,
  };
}

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === "[object Object]";
}
