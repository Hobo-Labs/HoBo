const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const REQUIRED_ARTIFACTS = Object.freeze([
  "contract-manifest",
  "broker-environment",
  "mapping-contract",
  "broker-catalog-snapshot",
  "resolution-receipt",
  "resolution-rejection",
]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "artifact-schema-contract",
  "authority-boundary-fixture",
  "receipt-consumption-fixture",
  "catalog-snapshot-fixture",
  "rejection-taxonomy-fixture",
  "scope-boundary-register",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "broker runtime",
    pattern: /\b(implement|build|ship|run|deploy|create|patch)\b.{0,72}\b(broker runtime|hosted broker runtime|runtime resolver|resolution service|live service)\b/i,
  },
  {
    label: "admin UI",
    pattern: /\b(admin UI|approval screen|settings UI|dashboard|console screen|user interface)\b/i,
  },
  {
    label: "provider adapter",
    pattern: /\b(provider adapter|provider implementation|live provider|provider connector|cloud adapter)\b/i,
  },
  {
    label: "Yard planner",
    pattern: /\b(Yard planner|planner behavior|DeploymentPlan builder|ResourcePlan engine|matching engine)\b/i,
  },
  {
    label: "Gatekeeper",
    pattern: /\b(Gatekeeper policy change|policy engine change|hobo verify implementation|mandatory policy implementation)\b/i,
  },
]);

export const REQUIRED_AUTHORITY_BOUNDARIES = Object.freeze([
  "meta-cloud-broker",
  "yard-control-plane",
  "ux-admin-controls",
  "gatekeeper",
]);

export const REQUIRED_OPERATING_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const META_CLOUD_BROKER_SCOPE = Object.freeze({
  issue: "HOBO-521",
  project: "Meta-cloud Broker",
  phase: "M0",
  goal:
    "Define Meta-cloud Broker M0 scope so Contract Manifests, approved Broker Environments, Resolution Receipts, Resolution Rejections, and authority boundaries are accepted before broker runtime or Yard integration work begins.",
  sourceRefs: Object.freeze([
    "Linear HOBO-521 issue body",
    "docs/design/architecture.md",
    "docs/design/control-plane.md",
    "docs/design/platform-engineering.md",
    "docs/design/contracts-policy-flags.md",
    "docs/design/glossary.md",
  ]),
  missingRefs: Object.freeze([
    {
      path: "docs/superpowers/specs/2026-06-29-meta-cloud-broker-design.md",
      status: "absent-on-origin-main",
      handling: "HOBO-521 issue body and this M0 design record carry the accepted scope.",
    },
  ]),
  personas: Object.freeze([
    {
      id: "broker-admin",
      need: "Approves Broker Environments and mapping state without becoming the broker authority.",
    },
    {
      id: "platform-engineer",
      need: "Publishes provider/catalog/mapping evidence that the broker can validate deterministically later.",
    },
    {
      id: "app-developer",
      need: "Receives clear receipt or rejection evidence for a Contract Manifest without guessing placement rules.",
    },
    {
      id: "support-operator",
      need: "Can explain failed or stale broker resolution using customer-safe receipt and rejection evidence.",
    },
    {
      id: "security-reviewer",
      need: "Verifies authority, tamper, replay, and policy boundaries before public broker claims ship.",
    },
  ]),
  scopeIn: Object.freeze([
    "Name the user/business goal and primary broker-admin, platform-engineer, app-developer, support-operator, and security-reviewer personas.",
    "Record broker-vs-Yard-vs-admin-vs-Gatekeeper authority boundaries.",
    "Define the M1 artifact vocabulary: Contract Manifest, Broker Environment, Mapping Contract, Broker Catalog Snapshot, Resolution Receipt, and Resolution Rejection.",
    "Map owning initiative and project dependencies without taking their implementation scope.",
    "List M1 evidence required before artifact schema, receipt consumption, deterministic resolution, admin controls, or adversarial hardening work can fan out.",
    "Record the follow-up gate that blocks M1/M2/M3/M4 broker work until this M0 scope is accepted.",
  ]),
  scopeOut: Object.freeze([
    "No broker runtime, resolution algorithm, hosted service, persistence layer, or signing implementation.",
    "No Yard planner, Matching, ResourcePlan, DeploymentPlan, provider adapter, or IaC behavior changes.",
    "No admin UI, settings page, approval workflow implementation, or live operator console.",
    "No Gatekeeper, policy engine, token broker, Contract IR, or provider Capability Manifest replacement.",
    "No public or release-facing broker claim without named proof mode and source evidence.",
    "No downstream M1-M4 broker work before this M0 record and executable proof are accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace the existing Yard control-plane planner and matching model.",
    "Replace the Contract IR, contract-engine, provider Capability Manifest, or Gatekeeper.",
    "Approve a production hosted broker launch claim.",
    "Define UI copy or workflow screens beyond ownership and evidence expectations.",
  ]),
  authorityBoundaries: Object.freeze([
    {
      id: "meta-cloud-broker",
      owner: "Meta-cloud Broker",
      promise:
        "Validates Contract Manifests against approved Broker Environments and emits signed Resolution Receipts or structured Resolution Rejections.",
      canOverwriteBrokerDecision: true,
      overwriteRule: "A new broker decision creates a new receipt or rejection with its own source evidence.",
    },
    {
      id: "yard-control-plane",
      owner: "Control Plane: Planner, Matching & Orchestrator",
      promise:
        "Consumes Resolution Receipts as broker evidence and executes Yard-local planning without silently re-resolving hosted broker authority.",
      canOverwriteBrokerDecision: false,
      overwriteRule: "Yard needs a new receipt or explicit policy decision to supersede broker authority.",
    },
    {
      id: "ux-admin-controls",
      owner: "Admin Console",
      promise:
        "Proposes and approves Broker Environment inputs; cannot mutate an issued receipt after resolution.",
      canOverwriteBrokerDecision: false,
      overwriteRule: "Admin changes require a new receipt or explicit policy decision before they affect Yard execution.",
    },
    {
      id: "gatekeeper",
      owner: "Contracts, Policy & Governance",
      promise:
        "May block, waive, or require policy obligations, but does not rewrite broker mapping outcomes.",
      canOverwriteBrokerDecision: false,
      overwriteRule: "Gatekeeper can require a policy decision but cannot overwrite a broker receipt in place.",
    },
  ]),
  operatingBoundaries: Object.freeze([
    {
      id: "service",
      owner: "Meta-cloud Broker",
      promise:
        "Owns authority vocabulary, artifact set, evidence list, and follow-up gate; runtime implementation waits for later issues.",
    },
    {
      id: "ux",
      owner: "Admin Console",
      promise:
        "May later expose environment proposal and approval controls; UI work is out of this M0 issue.",
    },
    {
      id: "security",
      owner: "Contracts, Policy & Governance",
      promise:
        "Requires proof that Gatekeeper policy can block or require obligations without rewriting broker receipts.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Receives customer-safe receipt/rejection evidence and escalation ownership without hidden resolution changes.",
    },
  ]),
  artifacts: Object.freeze([
    {
      id: "contract-manifest",
      owner: "App developer / SDK authoring",
      minimumM1Proof: "Schema fixture names requested capabilities, constraints, and declared application contract facts.",
    },
    {
      id: "broker-environment",
      owner: "Broker admin",
      minimumM1Proof: "Approved environment snapshot fixture lists allowed providers, catalogs, policies, and version pins.",
    },
    {
      id: "mapping-contract",
      owner: "Platform engineering",
      minimumM1Proof: "Mapping fixture proves provider/catalog choices are constrained inputs, not unilateral selection authority.",
    },
    {
      id: "broker-catalog-snapshot",
      owner: "Registry / provider catalog",
      minimumM1Proof: "Snapshot fixture pins provider Capability Manifest, conformance, trust tier, and stale-state behavior.",
    },
    {
      id: "resolution-receipt",
      owner: "Meta-cloud Broker",
      minimumM1Proof: "Receipt fixture names manifest digest, environment digest, decision, signature envelope, and Yard handoff facts.",
    },
    {
      id: "resolution-rejection",
      owner: "Meta-cloud Broker",
      minimumM1Proof: "Rejection fixture names deterministic reason codes for stale, incompatible, ambiguous, or unsupported mappings.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/architecture.md",
    "docs/design/control-plane.md",
    "docs/design/platform-engineering.md",
    "docs/design/contracts-policy-flags.md",
    "docs/design/glossary.md",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Meta-cloud Broker",
      boundary: "Owns M0 authority vocabulary, artifact set, evidence list, and follow-up gate.",
    },
    {
      owner: "Control Plane: Planner, Matching & Orchestrator",
      boundary: "Owns later Yard receipt consumption and no-re-resolve proof; planner implementation remains there.",
    },
    {
      owner: "Providers, IaC & Build Adapters",
      boundary: "Owns provider Capability Manifests, catalog entries, and mapping publications consumed by broker proofs.",
    },
    {
      owner: "Contracts, Policy & Governance",
      boundary: "Owns Gatekeeper decisions, policy obligations, and contract compatibility without rewriting receipts.",
    },
    {
      owner: "Admin Console",
      boundary: "Owns later UX controls for environment proposals and approvals, not this M0 scope record.",
    },
    {
      owner: "Support Workflow",
      boundary: "Consumes receipt/rejection evidence for customer-safe debugging and escalation.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Uses proof mode and source evidence before public broker claims or GA handoff language.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "artifact-schema-contract",
      mode: "schema-test",
      proves: "Contract Manifest, Broker Environment, Mapping Contract, catalog snapshot, receipt, and rejection schemas are pinned.",
    },
    {
      id: "authority-boundary-fixture",
      mode: "contract-test",
      proves: "Broker, Yard, admin controls, and Gatekeeper cannot silently overwrite each other.",
    },
    {
      id: "receipt-consumption-fixture",
      mode: "integration-fixture",
      proves: "Yard consumes Resolution Receipts without re-running hosted broker resolution.",
    },
    {
      id: "catalog-snapshot-fixture",
      mode: "deterministic-fixture",
      proves: "Provider/catalog mapping inputs are versioned and stale states are visible.",
    },
    {
      id: "rejection-taxonomy-fixture",
      mode: "negative-test",
      proves: "Stale, incompatible, ambiguous, and unsupported mappings fail with structured Resolution Rejections.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Runtime, planner, provider, admin UI, Gatekeeper, and public-claim work route to follow-up owners.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create or start M1/M2/M3/M4 Meta-cloud Broker follow-up work only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateBrokerFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 broker gate." };
  }
  if (m0Accepted) {
    return { allowed: true, reason: "M0 Meta-cloud Broker scope is accepted." };
  }
  return {
    allowed: false,
    reason: "M1-M4 Meta-cloud Broker work waits for accepted M0 scope.",
  };
}

export function classifyBrokerClaim({ audience, claim, proofMode, source } = {}) {
  const isPublic = /release|public|customer|marketing|ga|beta/i.test(String(audience ?? ""));
  const hasBrokerClaim = /broker|receipt|resolution|mapping/i.test(String(claim ?? ""));

  if (isPublic && hasBrokerClaim && (!proofMode || !source)) {
    return {
      allowed: false,
      reason: "Public or release-facing broker claims require proof mode and source evidence.",
    };
  }

  return { allowed: true, reason: "Claim has sufficient scope or evidence for this M0 record." };
}

export function validateMetaCloudBrokerScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-521") {
    errors.push("Scope record must be tied to HOBO-521.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!/Meta-cloud Broker/i.test(scope.goal ?? "")) {
    errors.push("Goal must name the Meta-cloud Broker.");
  }
  if (!/Resolution Receipts?/i.test(scope.goal ?? "")) {
    errors.push("Goal must name Resolution Receipts.");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five primary personas are required.");
  }

  for (const boundary of REQUIRED_AUTHORITY_BOUNDARIES) {
    if (!scope.authorityBoundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing authority boundary: ${boundary}.`);
    }
  }

  for (const boundary of REQUIRED_OPERATING_BOUNDARIES) {
    if (!scope.operatingBoundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing operating boundary: ${boundary}.`);
    }
  }

  const artifacts = new Set(scope.artifacts?.map((artifact) => artifact.id) ?? []);
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!artifacts.has(artifact)) {
      errors.push(`Missing broker artifact: ${artifact}.`);
    }
  }

  for (const artifact of scope.artifacts ?? []) {
    if (!artifact.owner || !artifact.minimumM1Proof) {
      errors.push(`Artifact ${artifact.id ?? "<unknown>"} must name owner and minimum M1 proof.`);
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  for (const boundary of scope.authorityBoundaries ?? []) {
    if (
      boundary.id !== "meta-cloud-broker" &&
      (boundary.canOverwriteBrokerDecision !== false ||
        !/new receipt|policy decision/i.test(boundary.overwriteRule ?? ""))
    ) {
      errors.push(`${boundary.id} must not silently overwrite broker decisions.`);
    }
  }

  for (const claim of [
    {
      audience: "release-notes",
      claim: "Hosted broker has complete public resolution support.",
    },
  ]) {
    const result = classifyBrokerClaim(claim);
    if (result.allowed) {
      errors.push("Release-facing broker claims must require proof mode and source evidence.");
    }
  }

  return { ok: errors.length === 0, errors };
}
