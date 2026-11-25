const REQUIRED_M1_EVIDENCE = Object.freeze([
  "catalog-schema",
  "approval-state-machine",
  "policy-consumption-fixture",
  "registry-handoff",
  "support-export",
  "scope-boundary-register",
]);

const REQUIRED_ENTRY_EVIDENCE = Object.freeze([
  "source",
  "owner",
  "trust-tier",
  "scope",
  "version-pin",
  "policy",
  "support-handoff",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "runtime",
    pattern:
      /\b(implement|build|ship|provision|create)\b.{0,56}\b(install-time resolver|resolver runtime|runtime|policy enforcer|provider execution)\b/i,
  },
  {
    label: "registry",
    pattern: /\b(live registry storage|registry backend|artifact publication|publish listing)\b/i,
  },
  {
    label: "marketplace",
    pattern: /\b(paid marketplace|marketplace placement|payout|revenue share|storefront|publisher portal)\b/i,
  },
  {
    label: "billing",
    pattern: /\b(invoice|subscription|payment|billing|tax|chargeback)\b/i,
  },
  {
    label: "RBAC",
    pattern: /\b(role grant|rbac enforcement|member invite|approver role implementation)\b/i,
  },
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const ORG_CATALOGS_SCOPE = Object.freeze({
  issue: "HOBO-424",
  project: "Org Catalogs",
  phase: "M0",
  goal:
    "Define the org catalog and approved catalog boundary so workspaces can name which providers, resource packs, template Bindles, policy packs, and private listings are allowed without building registry, marketplace, RBAC, or install runtime behavior.",
  personas: Object.freeze([
    {
      id: "workspace-admin",
      name: "Workspace administrator",
      need: "Needs a reviewable list of approved catalog entries, owners, states, and policy pins for a workspace.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need: "Needs approved provider and resource-pack inputs without taking registry or resolver implementation scope.",
    },
    {
      id: "app-developer",
      name: "Application developer",
      need: "Needs clear signals for which templates and capability packs are available for the current workspace.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs support-safe owner, state, scope, and limitation evidence for catalog-related tickets.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define catalog kinds for provider packs, resource packs, template Bindles, policy packs, and private listings.",
    "Record catalog entry lifecycle states: proposed, approved, deprecated, blocked, and retired.",
    "Define required entry evidence for source, owner, trust tier, scope, version pin, policy, and support handoff.",
    "Map service, UX, security, and support boundaries for org catalog approval claims.",
    "List M1 evidence required before downstream schema, approval, policy, registry, and support work can begin.",
  ]),
  scopeOut: Object.freeze([
    "Live registry storage, artifact publication, catalog backends, and install-time resolver runtime.",
    "Marketplace storefront, publisher portal UI, ratings, paid placement, revenue share, and payouts.",
    "RBAC role grants, approver workflows, member management, and authorization enforcement.",
    "Provider execution, resource provisioning, default-provider registration, and capability conformance runs.",
    "Billing, subscription, invoice, tax, chargeback, or commercial packaging behavior.",
  ]),
  nonGoals: Object.freeze([
    "Replace Registry distribution, marketplace trust tiers, or provider conformance contracts.",
    "Make unreviewed private listings installable by default.",
    "Treat a catalog approval as a substitute for signed provenance, security review, or policy evaluation.",
    "Create M1, M2, M3, or M4 implementation issues before M0 scope and acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Org Catalogs",
      promise:
        "Owns catalog nouns, entry states, evidence fields, and M1 proof expectations; storage and resolver services are later work.",
    },
    {
      id: "ux",
      owner: "Marketplace UX / Publisher Portal",
      promise:
        "May present approved entries later, but this M0 record defines information architecture only, not screens.",
    },
    {
      id: "security",
      owner: "Member/RBAC Administration",
      promise:
        "Owns approver authority and authorization checks; this record names required handoffs and policy evidence.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes support-safe entry state, owner, limitation, and escalation evidence without adding support tooling.",
    },
  ]),
  catalogKinds: Object.freeze([
    {
      id: "provider-pack",
      definition: "Approved provider packages, defaults, and capability specs an org may use.",
    },
    {
      id: "resource-pack",
      definition: "Signed Resource Packs or capability listings accepted for use in a workspace.",
    },
    {
      id: "template-bindle",
      definition: "Starter or sample Bindles approved for org onboarding and workspace reuse.",
    },
    {
      id: "policy-pack",
      definition: "Mandatory or default policy packs available to the org or workspace.",
    },
    {
      id: "private-listing",
      definition: "Enterprise-private or side-loaded listings visible only to approved org scopes.",
    },
  ]),
  entryStates: Object.freeze([
    {
      id: "proposed",
      meaning: "Submitted for org review but not usable by default.",
    },
    {
      id: "approved",
      meaning: "Approved for the recorded org scope with explicit evidence and policy pins.",
    },
    {
      id: "deprecated",
      meaning: "Still visible for existing use while upgrade, replacement, or retirement evidence is prepared.",
    },
    {
      id: "blocked",
      meaning: "Denied for new use because evidence, trust, policy, security, or support conditions failed.",
    },
    {
      id: "retired",
      meaning: "No longer selectable and retained only for audit, support, or historical explanation.",
    },
  ]),
  requiredEntryEvidence: Object.freeze([
    {
      id: "source",
      owner: "Registry & Distribution",
      proof: "Names the upstream registry, private source, or side-loaded source of the entry.",
    },
    {
      id: "owner",
      owner: "Org Catalogs",
      proof: "Names the org or workspace owner responsible for review and lifecycle state.",
    },
    {
      id: "trust-tier",
      owner: "Marketplace Publisher Trust Evidence",
      proof: "Records generated, verified, curated, or enterprise-private trust posture.",
    },
    {
      id: "scope",
      owner: "Organization & Workspace Model",
      proof: "Records org, workspace, project, environment, or private visibility boundary.",
    },
    {
      id: "version-pin",
      owner: "Portability, Registry & Distribution",
      proof: "Records immutable version or digest requirements for approved use.",
    },
    {
      id: "policy",
      owner: "Member/RBAC Administration",
      proof: "Records mandatory/default policy packs or approver authority needed for use.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Records customer-safe limitations, escalation owner, and unsupported states.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/organization-workspace-model.md",
    "docs/design/settings-project-lifecycle.md",
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/walkthrough.md",
    "docs/design/authoring-resources-wiring.md#plan-21",
    "docs/design/contracts-policy-flags.md#plan-29",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/07-portability-extensibility.md#adr-0062",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0073",
    "docs/design/adr/07-portability-extensibility.md#adr-0075",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Organization & Workspace Model",
      boundary:
        "Supplies org, workspace, project, and environment visibility vocabulary for catalog scope.",
    },
    {
      owner: "Registry & Distribution",
      boundary:
        "Owns signed artifact storage, publishing, install resolution, deprecation, yank, and offline bundles.",
    },
    {
      owner: "Marketplace Publisher Trust Evidence",
      boundary:
        "Supplies publisher trust tiers, curated/private catalog posture, and warning evidence.",
    },
    {
      owner: "Member/RBAC Administration",
      boundary:
        "Owns approver authority, role grants, mandatory policy evaluation, and member workflows.",
    },
    {
      owner: "Marketplace UX / Publisher Portal",
      boundary:
        "Owns future storefront, publisher portal, ratings, and listing management UI surfaces.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns customer-safe support routing, escalation, and unsupported-state communication later.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "catalog-schema",
      mode: "design-record",
      proves: "Catalog kind, entry state, evidence field, and visibility records are stable.",
    },
    {
      id: "approval-state-machine",
      mode: "contract-test",
      proves: "Proposed, approved, deprecated, blocked, and retired states transition deterministically.",
    },
    {
      id: "policy-consumption-fixture",
      mode: "reference-fixture",
      proves: "Mandatory/default policy and approver evidence are consumed without implementing RBAC.",
    },
    {
      id: "registry-handoff",
      mode: "integration-contract",
      proves: "Registry publication, resolver, version, deprecation, and yank work remains owned elsewhere.",
    },
    {
      id: "support-export",
      mode: "support-handoff",
      proves: "Support can explain entry owner, state, scope, limitation, and escalation path.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Marketplace, registry, RBAC, billing, provider execution, and UI work are routed out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 org-catalog implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateOrgCatalogFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 org catalog gate." };
  }

  if (m0Accepted) {
    return { allowed: true, reason: "M0 org catalog scope and acceptance evidence has been accepted." };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 org catalog scope.",
  };
}

export function classifyOrgCatalogDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(install-time resolver|resolver runtime|install resolver|artifact pull)\b/.test(text)) {
    return { owner: "Portability, Registry & Distribution", inScope: false };
  }

  if (/\b(live registry storage|publish listing|registry backend|offline bundle|yank)\b/.test(text)) {
    return { owner: "Registry & Distribution", inScope: false };
  }

  if (/\b(marketplace|publisher portal|rating|payout|storefront|revenue share)\b/.test(text)) {
    return { owner: "Marketplace UX / Publisher Portal", inScope: false };
  }

  if (/\b(rbac|role grant|member|approver role|permission grant)\b/.test(text)) {
    return { owner: "Member/RBAC Administration", inScope: false };
  }

  if (/\b(invoice|subscription|billing|payment|tax|chargeback)\b/.test(text)) {
    return { owner: "Billing & Credits", inScope: false };
  }

  return { owner: "Org Catalogs", inScope: true };
}

export function validateOrgCatalogsScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-424") {
    errors.push("Scope record must be tied to HOBO-424.");
  }

  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
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

  for (const field of REQUIRED_ENTRY_EVIDENCE) {
    if (!scope.requiredEntryEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required entry evidence: ${field}.`);
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
