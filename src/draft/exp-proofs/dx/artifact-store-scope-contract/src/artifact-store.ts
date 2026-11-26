export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "artifact-record-schema",
  "custody-state-machine",
  "retention-policy-matrix",
  "access-policy-contract",
  "yank-invalidation-fixture",
  "support-debug-handoff",
  "customer-assurance-summary",
]);

const REQUIRED_ARTIFACT_EVIDENCE = Object.freeze([
  "artifact-identity",
  "digest-and-size",
  "provenance-link",
  "retention-class",
  "access-policy",
  "yank-invalidation",
  "support-debug-handoff",
  "customer-assurance-boundary",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "storage",
    pattern: /\b(production blob store|blob store|lifecycle worker|storage engine|object storage)\b/i,
  },
  {
    label: "registry",
    pattern: /\b(registry backend|distributed resolver|registry mirror|package resolver|listing service)\b/i,
  },
  {
    label: "signing",
    pattern: /\b(signing keys?|kms integration|certificate rotation|slsa signer|key rotation)\b/i,
  },
  {
    label: "pipeline",
    pattern: /\b(live release pipelines?|package publishing jobs?|publish job|release automation)\b/i,
  },
  {
    label: "ui",
    pattern: /\b(artifact browser ui|retention dashboards?|ui implementation|rendered screen)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support ticket automation|live debug collection|helpdesk integration|support queue)\b/i,
  },
  {
    label: "customer-data",
    pattern: /\b(customer data snapshots?|tenant backups?|live tenant data|provider credentials?)\b/i,
  },
]);

export const ARTIFACT_STORE_SCOPE = Object.freeze({
  issue: "HOBO-445",
  project: "Artifact Store",
  phase: "M0",
  goal:
    "Define Artifact Store scope and acceptance so artifact custody, retention, access, and support evidence are clear before implementation issues fan out.",
  personas: Object.freeze([
    {
      id: "release-engineer",
      name: "Release engineer",
      need:
        "Needs artifact classes, provenance links, retention rules, and yank expectations before release workflows depend on storage evidence.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need:
        "Needs stable artifact identities, custody states, and access contracts before building storage or package-cache adapters.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need:
        "Needs digest, provenance, access-policy, quarantine, and customer-data boundaries without owning signing-key implementation.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need:
        "Needs support-safe artifact lookup, yank explanation, and debug handoff evidence without live debug collection.",
    },
    {
      id: "customer-admin",
      name: "Customer admin",
      need:
        "Needs assurance wording that states which artifacts are retained, why they are trusted, and which evidence remains unavailable.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define artifact classes for wasm components, OCI images, resource packs, offline bundles, release assets, and generated provider artifacts.",
    "Record required evidence fields for artifact identity, digest and size, provenance link, retention class, access policy, yank invalidation, support handoff, and customer assurance boundary.",
    "Define custody states for declared, accepted, retained, yanked, expired, and quarantined artifacts.",
    "Map service, UX, security, and support boundaries for artifact custody evidence and downstream handoffs.",
    "List owning initiative dependencies across Provenance & Retention, Release Engineering, Registry & Distribution, Package Cache, Capability Review & Approval, and Support Workflow.",
    "List M1 evidence required before artifact storage, package cache, registry integration, support/debug, or customer assurance work can depend on this record.",
  ]),
  scopeOut: Object.freeze([
    "No production blob store, lifecycle worker, storage engine, or object-storage adapter.",
    "No registry backend, distributed resolver, package cache, registry mirror, or listing service implementation.",
    "No signing-key, KMS, SLSA signer, certificate issuance, or key-rotation implementation.",
    "No live release pipeline, package publishing job, release automation, or customer assurance export job.",
    "No artifact browser UI, retention dashboard, customer-facing screen, or support console.",
    "No support ticket automation, helpdesk integration, support queue, or live debug collection.",
    "No customer data snapshot, tenant backup storage, provider credential retention, or live tenant-data handling.",
    "No downstream M1-M4 issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Build the artifact store, blob store, registry backend, package cache, or blob lifecycle implementation.",
    "Replace artifact signing, SBOM, vulnerability, registry trust-tier, or release provenance decisions.",
    "Guarantee legal retention or customer assurance outcomes before security, privacy, and compliance owners accept evidence.",
    "Publish customer-facing assurance claims before every claim maps to a retained evidence source.",
    "Create follow-up implementation issues before the M0 scope record is accepted.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Artifact Store",
      promise:
        "Owns artifact classes, custody states, evidence fields, and follow-up gate; storage services remain later work.",
    },
    {
      id: "ux",
      owner: "Release Engineering, Capability Review, and Support Workflow",
      promise:
        "Defines future customer-safe labels, assurance status, yank explanations, and support handoff evidence, not product screens.",
    },
    {
      id: "security",
      owner: "Provenance & Retention and Security Verification",
      promise:
        "Names digest, provenance, access-policy, quarantine, and redaction evidence without implementing signing keys or live enforcement.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Defines lookup facts, retained evidence, yanked-artifact explanation, and escalation handoff without support tooling.",
    },
  ]),
  artifactClasses: Object.freeze([
    {
      id: "wasm-component",
      definition:
        "Component Model artifact with WIT package identity, digest, provenance link, and compatibility evidence.",
    },
    {
      id: "oci-image",
      definition:
        "Container or host image artifact with image digest, source revision, build attestation, and runtime support boundary.",
    },
    {
      id: "resource-pack",
      definition:
        "Provider resource pack or capability bundle with signed descriptor, conformance evidence, and trust-tier handoff.",
    },
    {
      id: "offline-bundle",
      definition:
        "Air-gap import bundle with manifest-complete digest set, revocation snapshot, and unsupported online dependency flags.",
    },
    {
      id: "release-asset",
      definition:
        "CLI, SDK, manifest, or release packet asset retained for upgrade, rollback, support, and customer assurance review.",
    },
    {
      id: "generated-provider",
      definition:
        "Generated provider artifact with material digest, model/toolchain id, conformance refs, and certification state.",
    },
  ]),
  custodyStates: Object.freeze([
    {
      id: "declared",
      meaning: "Artifact identity and expected evidence are declared but not accepted for use.",
    },
    {
      id: "accepted",
      meaning: "Required evidence exists and consumers may depend on the artifact class within stated limits.",
    },
    {
      id: "retained",
      meaning: "Artifact evidence is retained for the declared retention class and support boundary.",
    },
    {
      id: "yanked",
      meaning: "Artifact remains explainable but is no longer selectable for new install or release paths.",
    },
    {
      id: "expired",
      meaning: "Retention window closed and customer/support claims must route to limitation language.",
    },
    {
      id: "quarantined",
      meaning: "Security or integrity concern blocks use until a human owner accepts remediation evidence.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "artifact-identity",
      owner: "Artifact Store",
      proof: "Names artifact class, stable id, version, source owner, and digest namespace.",
    },
    {
      id: "digest-and-size",
      owner: "Artifact Store",
      proof: "Records digest algorithm, digest value, size, and immutable content boundary.",
    },
    {
      id: "provenance-link",
      owner: "Provenance & Retention",
      proof: "Links source revision, build attestation, publish actor, and retained provenance evidence.",
    },
    {
      id: "retention-class",
      owner: "Provenance & Retention",
      proof: "Names retention class, default window, customer visibility, and legal/privacy handoff.",
    },
    {
      id: "access-policy",
      owner: "Security Verification",
      proof: "Names who can publish, read, yank, debug, export, and view customer-facing assurance evidence.",
    },
    {
      id: "yank-invalidation",
      owner: "Release Engineering",
      proof: "Records affected artifact, reason, replacement guidance, cache invalidation, and support note.",
    },
    {
      id: "support-debug-handoff",
      owner: "Support Workflow",
      proof: "Names redacted support-safe fields and escalation owner without granting live storage control.",
    },
    {
      id: "customer-assurance-boundary",
      owner: "Capability Review & Approval",
      proof: "Maps customer-facing claims to retained evidence sources and unavailable-evidence wording.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/provenance-retention.md",
    "docs/design/release-artifact-provenance-retention.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/technical-standards.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/07-portability-extensibility.md#adr-0073",
    "docs/design/adr/01-architecture-core.md#adr-0085",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Artifact Store",
      boundary:
        "Owns artifact classes, custody states, evidence fields, M1 proof checklist, and follow-up gate.",
    },
    {
      owner: "Provenance & Retention",
      boundary:
        "Provides provenance, retention, audit, redaction, and assurance evidence without building storage.",
    },
    {
      owner: "Release Engineering",
      boundary:
        "Provides release ids, publish/yank decisions, release evidence, and replacement guidance.",
    },
    {
      owner: "Registry & Distribution",
      boundary:
        "Consumes artifact descriptors, offline bundle metadata, and trust-tier history without owning storage.",
    },
    {
      owner: "Package Cache",
      boundary:
        "Consumes digest and invalidation facts; cache implementation and dependency closure remain separate.",
    },
    {
      owner: "Capability Review & Approval",
      boundary:
        "Consumes customer assurance and trust evidence without implementing approval UI or policy authoring.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Consumes support-safe lookup, yank, dispute, and debug evidence without support automation.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "artifact-record-schema",
      mode: "contract-test",
      proves: "Artifact records carry class, identity, digest, provenance, retention, and access evidence.",
    },
    {
      id: "custody-state-machine",
      mode: "contract-test",
      proves: "Declared, accepted, retained, yanked, expired, and quarantined states are stable and fail closed.",
    },
    {
      id: "retention-policy-matrix",
      mode: "design-record",
      proves: "Retention class, default window, customer visibility, and legal/privacy handoff are explicit.",
    },
    {
      id: "access-policy-contract",
      mode: "policy-contract",
      proves: "Publish, read, yank, debug, export, and assurance visibility decisions are bounded.",
    },
    {
      id: "yank-invalidation-fixture",
      mode: "reference-fixture",
      proves: "Yank decisions retain lineage, replacement guidance, cache invalidation, and support wording.",
    },
    {
      id: "support-debug-handoff",
      mode: "support-handoff",
      proves: "Support can inspect redacted artifact evidence without raw customer data or live storage control.",
    },
    {
      id: "customer-assurance-summary",
      mode: "customer-assurance",
      proves: "Customer-facing assurance claims map to retained evidence or explicit unavailable sections.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Artifact Store design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateArtifactStoreFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Artifact Store gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Artifact Store scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Artifact Store scope.",
  };
}

export function classifyArtifactStoreDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(provenance|retention|audit export|assurance evidence)\b/.test(text)) {
    return { owner: "Provenance & Retention", inScope: false };
  }
  if (/\b(release pipeline|publish gate|release train|go\/no-go)\b/.test(text)) {
    return { owner: "Release Engineering", inScope: false };
  }
  if (/\b(registry|listing|offline bundle|mirror|resolver)\b/.test(text)) {
    return { owner: "Registry & Distribution", inScope: false };
  }
  if (/\b(package cache|cache invalidation|dependency closure)\b/.test(text)) {
    return { owner: "Package Cache", inScope: false };
  }
  if (/\b(capability trust|capability review|approval evidence|trust tier)\b/.test(text)) {
    return { owner: "Capability Review & Approval", inScope: false };
  }
  if (/\b(support ticket|support automation|helpdesk|live debug)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\b(blob lifecycle|production blob|storage engine)\b/.test(text)) {
    return { owner: "Artifact Store", inScope: false };
  }

  return { owner: "Artifact Store", inScope: true };
}

export function validateArtifactStoreScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-445") {
    errors.push("Scope record must be tied to HOBO-445.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal?.toLowerCase().includes("artifact store")) {
    errors.push("Goal must name Artifact Store.");
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
  for (const field of REQUIRED_ARTIFACT_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required artifact evidence: ${field}.`);
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
