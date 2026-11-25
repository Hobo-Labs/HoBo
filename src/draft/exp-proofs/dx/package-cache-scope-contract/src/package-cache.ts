export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "cache-subject-matrix",
  "digest-lock-fixtures",
  "invalidation-contract",
  "offline-cache-manifest",
  "security-quarantine-rules",
  "support-debug-record",
  "retention-policy-map",
]);

const REQUIRED_PACKAGE_CACHE_EVIDENCE = Object.freeze([
  "package-coordinate",
  "digest",
  "source-registry",
  "provenance-ref",
  "sbom-ref",
  "vulnerability-state",
  "invalidation-policy",
  "retention-class",
  "offline-availability",
  "support-handoff",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "registry",
    pattern: /\b(registry backend|package publishing api|publish packages?|registry storage)\b/i,
  },
  {
    label: "mirror",
    pattern: /\b(live package mirror|cdn edge cache|mirror service|cache service)\b/i,
  },
  {
    label: "installer",
    pattern: /\b(hobo install|bootstrap flows?|package manager clients?|installer implementation)\b/i,
  },
  {
    label: "security",
    pattern: /\b(scan arbitrary customer packages?|vulnerability approval decisions?|security approval)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support tickets?|customer notifications?|helpdesk integration|support automation)\b/i,
  },
  {
    label: "network",
    pattern: /\b(fetch packages? from the public internet|live network|outbound network|internet fetch)\b/i,
  },
]);

export const PACKAGE_CACHE_SCOPE = Object.freeze({
  issue: "HOBO-446",
  project: "Package Cache",
  phase: "M0",
  goal:
    "Define Package Cache scope and acceptance so release, platform, security, support, and offline operators know which digest-pinned package evidence must exist before package-cache design/build issues fan out.",
  personas: Object.freeze([
    {
      id: "release-engineer",
      name: "Release engineer",
      need:
        "Needs retained package digests, provenance refs, and invalidation records before release notes or assurance packets cite cached package evidence.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need:
        "Needs deterministic cache subject classes, digest fixtures, and cacheability states before building a package-cache service.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need:
        "Needs SBOM, vulnerability, quarantine, and provenance evidence without turning this issue into a scanner or approval workflow.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need:
        "Needs cache miss, invalidation, yanked package, and unsupported package handoff fields without adding support automation.",
    },
    {
      id: "offline-admin",
      name: "Self-host/offline admin",
      need:
        "Needs offline bundle package availability and anti-rollback evidence before self-host install paths depend on a cache.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define cache subject classes for npm packages, WIT interfaces, wasm components, OCI artifacts, and offline bundles.",
    "Record required evidence fields for package coordinate, digest, upstream source, provenance, SBOM, vulnerability state, invalidation policy, retention class, offline availability, and support handoff.",
    "Define result states for cacheable, blocked, unsupported, quarantined, invalidated, and needs-manual-review package outcomes.",
    "Map service, UX, security, and support boundaries for package cache evidence and downstream handoffs.",
    "List owning initiative dependencies across Package Cache, Artifact Store, Portability Registry, Release Artifact Provenance, SBOM/Vulnerability evidence, Bootstrap Installer, Security Verification, and Support Workflow.",
    "List M1 evidence required before cache subject matrices, digest lock fixtures, invalidation contracts, offline manifests, quarantine rules, support debug records, or retention maps can depend on this record.",
  ]),
  scopeOut: Object.freeze([
    "No production package-cache service, mirror, CDN edge, local proxy, or package download runtime.",
    "No package publishing API, Registry storage, namespace ownership change, trust-tier decisioning, or marketplace listing mutation.",
    "No installer, `hobo install`, bootstrap path, package-manager client, or developer machine integration.",
    "No live vulnerability scanner, SBOM generator, malware scanner, package approval workflow, or legal notice generator.",
    "No support ticket automation, helpdesk integration, customer notification workflow, SLA promise, or support queue.",
    "No public internet fetch, live upstream access, credential persistence, customer package scan, or tenant data access.",
    "No retention store, blob storage, artifact replication, offline bundle builder, or provenance signing runtime.",
    "No downstream M1-M4 issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Build a package cache, registry backend, proxy, package manager plugin, or artifact storage service.",
    "Replace package namespace ownership, registry distribution, artifact provenance retention, or SBOM evidence records.",
    "Approve vulnerability posture, legal notices, trust tiers, launch claims, or customer assurance wording.",
    "Fetch live packages, scan customer dependencies, persist credentials, or mutate release artifacts.",
    "Create downstream implementation issues before M0 Package Cache scope is accepted.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Package Cache",
      promise:
        "Owns cache subject taxonomy, evidence fields, result states, and M1 proof expectations; runtime service and storage remain later work.",
    },
    {
      id: "ux",
      owner: "Bootstrap Installer, Release Notes, and Support Workflow",
      promise:
        "Defines future customer-safe labels for cacheable, unavailable, invalidated, and unsupported packages without building install or UI surfaces.",
    },
    {
      id: "security",
      owner: "Security Verification and SBOM Vulnerability Notice Evidence",
      promise:
        "Names SBOM, vulnerability, quarantine, provenance, and anti-rollback evidence without scanner or approval implementation.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Defines support-debug record fields, cache miss reasons, invalidation handoff, and escalation owner without support automation.",
    },
  ]),
  cacheSubjects: Object.freeze([
    {
      id: "npm-package",
      definition:
        "Published npm package coordinate with version, integrity digest, provenance ref, SBOM/notice refs, and invalidation status.",
    },
    {
      id: "wit-interface",
      definition:
        "Vendored WIT interface or generated binding package pinned by digest, compatibility floor, and source provenance.",
    },
    {
      id: "wasm-component",
      definition:
        "Built wasm component dependency with component digest, toolchain provenance, SBOM ref, and compatibility state.",
    },
    {
      id: "oci-artifact",
      definition:
        "OCI artifact dependency referenced by immutable digest, provenance, retention class, and yank/invalidation behavior.",
    },
    {
      id: "offline-bundle",
      definition:
        "Self-host/offline dependency closure manifest with included package digests, unavailable classes, and anti-rollback metadata.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "package-coordinate",
      owner: "Package Cache",
      proof: "Names package name, version or range, ecosystem, and owning package namespace rule.",
    },
    {
      id: "digest",
      owner: "Package Cache",
      proof: "Records immutable content digest or explicitly blocks cacheability when digest evidence is missing.",
    },
    {
      id: "source-registry",
      owner: "Portability Registry",
      proof: "Names upstream source metadata and mirror eligibility without implementing registry storage.",
    },
    {
      id: "provenance-ref",
      owner: "Release Artifact Provenance",
      proof: "Links signed build, generation, or publication provenance for release and support evidence.",
    },
    {
      id: "sbom-ref",
      owner: "SBOM Vulnerability Notice Evidence",
      proof: "Links package inventory, third-party notice, and customer assurance evidence sections.",
    },
    {
      id: "vulnerability-state",
      owner: "Security Verification",
      proof: "Records known, deferred, unavailable, quarantined, or manually reviewed vulnerability posture.",
    },
    {
      id: "invalidation-policy",
      owner: "Package Cache",
      proof: "Defines yank, replacement, expiry, quarantine, and anti-rollback handling for the subject.",
    },
    {
      id: "retention-class",
      owner: "Release Artifact Provenance",
      proof: "Maps package metadata and evidence retention to release, support, or customer assurance windows.",
    },
    {
      id: "offline-availability",
      owner: "Bootstrap Installer",
      proof: "States whether the subject is included, excluded, or unavailable for self-host/offline bundles.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Names cache miss, invalidation, unsupported, quarantine, or manual-review owner and next action.",
    },
  ]),
  resultStates: Object.freeze([
    {
      id: "cacheable",
      meaning: "All required evidence exists for a digest-pinned subject within the accepted retention and support class.",
    },
    {
      id: "blocked",
      meaning: "A required digest, provenance, SBOM, security, retention, offline, or support evidence field is missing.",
    },
    {
      id: "unsupported",
      meaning: "The package class is explicitly outside v1 support and must route to release notes or support limitations.",
    },
    {
      id: "quarantined",
      meaning: "Security or notice evidence prevents use until a reviewer resolves, replaces, or accepts the risk.",
    },
    {
      id: "invalidated",
      meaning: "A yank, replacement, digest mismatch, expiry, or anti-rollback event made prior cache evidence unusable.",
    },
    {
      id: "needs-manual-review",
      meaning: "A human owner must evaluate provenance, vulnerability, notice, or support evidence before cacheability.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/package-namespaces.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/security-verification.md",
    "docs/design/support-sla-channels.md",
    "docs/design/tenant-data-lifecycle.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Package Cache",
      boundary:
        "Owns cache subject taxonomy, evidence fields, cacheability states, invalidation posture, M1 proof expectations, and follow-up gate.",
    },
    {
      owner: "Artifact Store",
      boundary:
        "Provides durable artifact retention and blob ownership later; this M0 record only names package evidence needs.",
    },
    {
      owner: "Portability Registry",
      boundary:
        "Provides registry descriptors, signed distribution, and version resolution without package-cache service implementation here.",
    },
    {
      owner: "Release Artifact Provenance",
      boundary:
        "Provides provenance, retention class, yank, invalidation, and customer assurance handoff inputs.",
    },
    {
      owner: "SBOM Vulnerability Notice Evidence",
      boundary:
        "Provides SBOM, vulnerability, notice, and assurance sections consumed by cache evidence.",
    },
    {
      owner: "Bootstrap Installer",
      boundary:
        "Consumes offline availability and dependency closure evidence for self-host and local/dev install paths.",
    },
    {
      owner: "Security Verification",
      boundary:
        "Consumes quarantine and vulnerability posture without granting this issue scanner or approval authority.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Consumes cache miss, invalidation, unsupported, quarantine, and manual-review records without support tooling.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "cache-subject-matrix",
      mode: "design-record",
      proves: "npm, WIT, wasm component, OCI artifact, and offline bundle subjects have accepted coverage rows.",
    },
    {
      id: "digest-lock-fixtures",
      mode: "reference-fixture",
      proves: "Cacheability requires immutable digests and rejects missing or mismatched digest evidence.",
    },
    {
      id: "invalidation-contract",
      mode: "contract-test",
      proves: "Yank, replacement, expiry, quarantine, and anti-rollback outcomes are stable and fail closed.",
    },
    {
      id: "offline-cache-manifest",
      mode: "manifest-fixture",
      proves: "Self-host/offline package closure names included, excluded, and unavailable package classes.",
    },
    {
      id: "security-quarantine-rules",
      mode: "security-fixture",
      proves: "Vulnerability, notice, provenance, and manual-review gaps route to blocked or quarantined states.",
    },
    {
      id: "support-debug-record",
      mode: "support-handoff",
      proves: "Support can route cache misses, invalidations, unsupported classes, and manual-review states with owner and next action.",
    },
    {
      id: "retention-policy-map",
      mode: "policy-map",
      proves: "Package metadata and evidence retention map to release, support, and customer assurance windows.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Package Cache design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreatePackageCacheFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Package Cache gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Package Cache scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Package Cache scope.",
  };
}

export function classifyPackageCacheDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(artifact store|blob retention|artifact retention|storage)\b/.test(text)) {
    return { owner: "Artifact Store", inScope: false };
  }
  if (/\b(registry publishing|registry backend|registry distribution|version resolution)\b/.test(text)) {
    return { owner: "Portability Registry", inScope: false };
  }
  if (/\b(release provenance|provenance invalidation|retention class|yank)\b/.test(text)) {
    return { owner: "Release Artifact Provenance", inScope: false };
  }
  if (/\b(sbom|vulnerability notice|third-party notice|customer assurance)\b/.test(text)) {
    return { owner: "SBOM Vulnerability Notice Evidence", inScope: false };
  }
  if (/\b(bootstrap install|installer|package fetch|offline install)\b/.test(text)) {
    return { owner: "Bootstrap Installer", inScope: false };
  }
  if (/\b(security quarantine|vulnerability approval|malware scan|security decision)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(support ticket|cache miss|customer notification|support debug)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  return { owner: "Package Cache", inScope: true };
}

export function validatePackageCacheScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-446") {
    errors.push("Scope record must be tied to HOBO-446.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal?.toLowerCase().includes("package cache")) {
    errors.push("Goal must name Package Cache.");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five primary personas are required.");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("Scope in must record at least five launch-critical entries.");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("Scope out must reject adjacent implementation work.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }
  for (const field of REQUIRED_PACKAGE_CACHE_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required package cache evidence: ${field}.`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.mode || !evidence.proves) {
      errors.push(`Evidence ${evidence.id ?? "<unknown>"} must name proof mode and proof.`);
    }
  }
  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
