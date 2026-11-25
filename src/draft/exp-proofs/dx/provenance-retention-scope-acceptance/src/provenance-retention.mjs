export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "audit-fixture",
  "support-handoff",
  "release-playbook",
  "customer-assurance",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /artifact store/i,
  /artifact repository/i,
  /signing key/i,
  /kms/i,
  /slsa signer/i,
  /live registry/i,
  /registry crawl/i,
  /legal retention program/i,
];

const REQUIRED_DEPENDENCIES = [
  "docs/design/governance-planes.md#plan-46",
  "docs/design/platform-engineering.md#plan-25",
  "docs/design/contracts-policy-flags.md#plan-29",
  "docs/design/adr/07-portability-extensibility.md#adr-0062",
  "docs/design/adr/07-portability-extensibility.md#adr-0073",
  "docs/design/adr/02-identity-security.md#adr-0046",
  "docs/design/adr/02-identity-security.md#adr-0023",
];

export const PROVENANCE_RETENTION_SCOPE = {
  issue: "HOBO-447",
  project: "Provenance & Retention",
  phase: "M0",
  goal:
    "Define the Provenance & Retention productization scope so artifact provenance, retention classes, audit export, support handoff, and customer assurance evidence have accepted M0 boundaries before design/build issues fan out.",
  personas: [
    {
      role: "release engineer",
      need: "Know which build, package, and release artifacts require provenance evidence before publish, yank, or rollback work can depend on them.",
    },
    {
      role: "security reviewer",
      need: "Review provenance, signing, audit, and policy-gate expectations without taking signing-key or artifact-store implementation scope.",
    },
    {
      role: "compliance lead",
      need: "Understand retention classes, legal/privacy handoffs, and customer-visible assurance claims before compliance evidence is promised.",
    },
    {
      role: "support operator",
      need: "Retrieve support-safe artifact, retention, yank, and audit evidence without raw customer data or hidden runtime dependencies.",
    },
    {
      role: "customer admin",
      need: "See what provenance and retention assurances HoBo can make, which evidence backs them, and which gaps remain future work.",
    },
  ],
  scopeIn: [
    "Canonical artifact provenance record classes for source, build, package, publish, install, yank, and support-debug evidence.",
    "Retention class matrix for release artifacts, provenance attestations, audit exports, support bundles, and customer assurance summaries.",
    "Customer-visible assurance claim register that names evidence source, owner, audience, and publication boundary for each claim.",
    "Audit export fixture requirements for retained provenance, retention policy, actor, timestamp, artifact identity, and redaction behavior.",
    "Support/debug handoff requirements for retained artifacts, yanked versions, disputed provenance, and customer escalation evidence.",
    "M1-ready evidence checklist for schema, policy matrix, audit fixture, support handoff, yank invalidation, and assurance summary proofs.",
  ],
  scopeOut: [
    "No artifact store, artifact repository, or blob lifecycle implementation.",
    "No signing-key, KMS, SLSA signer, certificate, or key-rotation implementation.",
    "No live registry crawler, registry mirror, package scanner, or distributed resolver implementation.",
    "No legal retention program, data processing agreement, or jurisdiction-specific compliance promise.",
    "No customer-facing assurance publication unless the evidence source is named in this M0 record.",
    "No downstream M1-M4 design or implementation issues before M0 scope is accepted.",
  ],
  nonGoals: [
    "Replace existing Registry, Release Channels, or Artifact Repo port decisions.",
    "Define package format semantics beyond the provenance and retention fields consumed by later contracts.",
    "Guarantee compliance outcomes before legal/privacy and security reviews accept the evidence matrix.",
    "Create follow-up implementation issues before the M0 scope record is accepted.",
  ],
  boundaries: {
    service:
      "Provenance and retention are product control-plane evidence records; this issue does not build storage, signing, registry, or resolver services.",
    ux:
      "UX scope is the accepted information architecture for evidence visibility, assurance status, and support handoff, not product screens or flows.",
    security:
      "Security scope names provenance, audit, redaction, and trust-tier requirements without implementing signing keys, SLSA emitters, or live enforcement.",
    support:
      "Support can rely on named evidence classes, retention expectations, and redaction boundaries; ticket workflow and SLA promises remain separate support work.",
  },
  dependencies: [
    {
      source: "docs/design/governance-planes.md#plan-46",
      reason:
        "Defines governance-plane audit, retention, OCSF, and compliance surfaces that consume provenance and retention evidence.",
    },
    {
      source: "docs/design/platform-engineering.md#plan-25",
      reason:
        "Defines resource pack and registry distribution surfaces that require artifact provenance and offline bundle evidence.",
    },
    {
      source: "docs/design/contracts-policy-flags.md#plan-29",
      reason:
        "Defines policy and contract gates for signed, attested, audit-ready artifacts and retention obligations.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0062",
      reason:
        "Pins registry distribution and trust expectations for signed bundles and conformance metadata.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0073",
      reason:
        "Pins Artifact Repo as a port, keeping repository implementation outside this M0 scope.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0046",
      reason:
        "Pins boundary standards, OTEL, OCSF, and identity-aware audit export expectations.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0023",
      reason:
        "Pins security posture expectations for audit retention, SBOM, SLSA provenance, and compliance evidence.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Provenance & Retention",
      consumes:
        "Owns accepted evidence classes, retention matrix, assurance claim sources, and M1 proof checklist.",
      scopeBoundary:
        "This issue defines the scope record; it does not build provenance emitters, storage, or retention jobs.",
    },
    {
      owner: "Release Channels",
      consumes: "Uses publish, yank, rollback, and release-note provenance evidence requirements.",
      scopeBoundary:
        "Release channel routing, release workflow, and customer notification remain in Release Channels.",
    },
    {
      owner: "Compatibility Matrix",
      consumes:
        "Uses artifact identity, provenance tier, and supported-version retention evidence for compatibility decisions.",
      scopeBoundary:
        "Compatibility calculation and version-resolution semantics remain in Compatibility Matrix.",
    },
    {
      owner: "Upgrade Test Suite",
      consumes:
        "Uses retained artifact and provenance fixtures to prove upgrade, rollback, and replay expectations.",
      scopeBoundary:
        "Upgrade harness execution and test orchestration remain in Upgrade Test Suite.",
    },
    {
      owner: "Backup & Restore",
      consumes:
        "Uses retention classes and audit evidence to distinguish recoverable artifacts from product backups.",
      scopeBoundary:
        "Backup storage, restore workflows, and customer data recovery remain in Backup & Restore.",
    },
    {
      owner: "Capability Review & Approval",
      consumes:
        "Uses provenance, SBOM, vulnerability, and assurance evidence to approve or block packages and capabilities.",
      scopeBoundary:
        "Approval workflow, policy authoring, and capability review UI remain outside Provenance M0.",
    },
    {
      owner: "Audit Explorer",
      consumes:
        "Uses audit export fields, redaction rules, actor identity, timestamps, and artifact lineage evidence.",
      scopeBoundary:
        "Search, visualization, export UI, and OCSF pipeline implementation remain in Audit Explorer.",
    },
    {
      owner: "Support & Debug Tools",
      consumes:
        "Uses support-safe provenance, retention, yank, and disputed-artifact evidence during escalation.",
      scopeBoundary:
        "Ticket routing, incident tooling, and live debug collection remain in Support & Debug Tools.",
    },
  ],
  artifactEvidenceClasses: [
    {
      id: "source-revision",
      owner: "release engineer",
      retainedFor: "published artifact lineage and rollback review",
    },
    {
      id: "build-attestation",
      owner: "security reviewer",
      retainedFor: "publish gate and later customer assurance summary",
    },
    {
      id: "package-manifest",
      owner: "release engineer",
      retainedFor: "install, yank, compatibility, and upgrade evidence",
    },
    {
      id: "audit-export",
      owner: "compliance lead",
      retainedFor: "governance-plane review and support escalation",
    },
    {
      id: "support-redacted-bundle",
      owner: "support operator",
      retainedFor: "customer-safe triage without raw customer data",
    },
  ],
  retentionClasses: [
    {
      id: "published-artifact",
      owner: "Release Channels",
      defaultRetention: "until superseded plus accepted rollback window",
      customerVisible: true,
    },
    {
      id: "provenance-attestation",
      owner: "Provenance & Retention",
      defaultRetention: "matches published artifact retention",
      customerVisible: true,
    },
    {
      id: "audit-export",
      owner: "Audit Explorer",
      defaultRetention: "governance-plane policy controlled",
      customerVisible: false,
    },
    {
      id: "support-debug-bundle",
      owner: "Support & Debug Tools",
      defaultRetention: "short-lived and redacted by support policy",
      customerVisible: false,
    },
    {
      id: "assurance-summary",
      owner: "Capability Review & Approval",
      defaultRetention: "matches claim publication lifetime",
      customerVisible: true,
    },
  ],
  assuranceClaims: [
    {
      claim: "Published artifacts carry source, build, package, and publish provenance fields.",
      audience: "customer admin",
      customerVisible: true,
      evidenceSource: "artifact-provenance-schema",
    },
    {
      claim: "Retention classes state which artifact and audit evidence is retained for support and assurance.",
      audience: "compliance lead",
      customerVisible: true,
      evidenceSource: "retention-policy-matrix",
    },
    {
      claim: "Yanked artifacts remain explainable through retained lineage and audit evidence.",
      audience: "release engineer",
      customerVisible: false,
      evidenceSource: "yank-invalidation-playbook",
    },
    {
      claim: "Support exports redact sensitive data while preserving artifact identity and provenance state.",
      audience: "support operator",
      customerVisible: false,
      evidenceSource: "support-debug-handoff",
    },
  ],
  m1Evidence: [
    {
      kind: "artifact-provenance-schema",
      owner: "Provenance & Retention",
      proofMode: "contract-test",
      proves:
        "Artifact evidence has source, build, package, publish, install, yank, and support-debug classes with owners.",
    },
    {
      kind: "retention-policy-matrix",
      owner: "Compliance",
      proofMode: "design-record",
      proves:
        "Retention classes define owner, default retention, customer visibility, and legal/privacy handoff.",
    },
    {
      kind: "audit-export-fixture",
      owner: "Audit Explorer",
      proofMode: "audit-fixture",
      proves:
        "Audit exports preserve actor, artifact identity, timestamp, retention class, and redaction behavior.",
    },
    {
      kind: "support-debug-handoff",
      owner: "Support & Debug Tools",
      proofMode: "support-handoff",
      proves:
        "Support can inspect retained provenance and retention state without raw customer data or runtime control.",
    },
    {
      kind: "yank-invalidation-playbook",
      owner: "Release Channels",
      proofMode: "release-playbook",
      proves:
        "Yank, rollback, and invalidation decisions consume retained lineage without implementing registry workflows.",
    },
    {
      kind: "customer-assurance-summary",
      owner: "Capability Review & Approval",
      proofMode: "customer-assurance",
      proves:
        "Every customer-visible claim maps to a named evidence source and publication boundary.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validateProvenanceRetentionScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-447") {
    errors.push("issue must be HOBO-447");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("provenance")) {
    errors.push("goal must name provenance");
  }
  if (!scope.goal?.toLowerCase().includes("retention")) {
    errors.push("goal must name retention");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 6) {
    errors.push("scope in must have at least six entries");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("scope out must have at least six entries");
  }
  if ((scope.nonGoals ?? []).length < 4) {
    errors.push("at least four non-goals are required");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("design dependencies must map to governance, platform, contracts, registry, artifact repo, audit, and security posture records");
  }

  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((scope.artifactEvidenceClasses ?? []).length < 5) {
    errors.push("artifact evidence classes must include source, build, package, audit, and support evidence");
  }
  if ((scope.retentionClasses ?? []).length < 5) {
    errors.push("retention classes must include artifact, attestation, audit, support, and assurance evidence");
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  for (const claim of scope.assuranceClaims ?? []) {
    if (claim.customerVisible && !claim.evidenceSource) {
      errors.push(`customer-visible claim "${claim.claim}" must name an evidence source`);
    }
  }

  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
