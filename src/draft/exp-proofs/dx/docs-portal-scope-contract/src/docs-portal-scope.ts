export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

type Boundary = (typeof REQUIRED_BOUNDARIES)[number];

type ProofMode =
  | "design-record"
  | "contract-test"
  | "reference-fixture"
  | "security-review"
  | "support-handoff"
  | "release-gate";

interface Persona {
  role: string;
  need: string;
}

interface Dependency {
  source: string;
  reason: string;
}

interface InitiativeDependency {
  owner: string;
  consumes: string;
  scopeBoundary: string;
}

interface EvidenceItem {
  kind: string;
  owner: string;
  proofMode: ProofMode;
  source?: string;
  proves: string;
}

interface CustomerFacingClaim {
  id: string;
  customerVisible: boolean;
  ownerRoute?: string;
  customerMessage?: string;
  proofSource?: string;
}

interface FollowUpGate {
  allowedAfter: string;
  blockedBefore: string;
}

interface DocsPortalScope {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Persona[];
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<Boundary, string>;
  dependencies: Dependency[];
  initiativeDependencies: InitiativeDependency[];
  portalContentAreas: string[];
  customerFacingClaims: CustomerFacingClaim[];
  m1Evidence: EvidenceItem[];
  followUpGate: FollowUpGate;
}

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const VALID_PROOF_MODES = new Set<ProofMode>([
  "design-record",
  "contract-test",
  "reference-fixture",
  "security-review",
  "support-handoff",
  "release-gate",
]);

const REQUIRED_DEPENDENCIES = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/release-notes-upgrade-guide.md",
  "docs/design/compatibility-matrix.md",
  "docs/design/launch-messaging-claims.md",
  "docs/design/support-sla-channels.md",
  "docs/design/launch-support-escalation.md",
  "docs/design/security-verification.md",
  "docs/design/accessibility-usability-launch-baseline.md",
  "docs/design/adr/02-identity-security.md#adr-0082",
];

const REQUIRED_PORTAL_CONTENT_AREAS = [
  "getting-started",
  "api-reference",
  "architecture-and-concepts",
  "operations-and-troubleshooting",
  "release-notes-and-upgrades",
  "known-limitations",
  "security-and-support",
] as const;

const REQUIRED_M1_EVIDENCE = [
  "content-inventory-fixture",
  "audience-path-map",
  "navigation-taxonomy",
  "versioning-and-limitation-register",
  "search-index-contract",
  "support-handoff-routes",
  "scope-boundary-register",
] as const;

const FORBIDDEN_SCOPE_PATTERNS = [
  /\breact\b/i,
  /\bdocs portal ui\b/i,
  /\bportal ui\b/i,
  /\bportal screens?\b/i,
  /\bui implementation\b/i,
  /\bcms\b/i,
  /\bauthoring workflow\b/i,
  /\bsearch indexing service\b/i,
  /\bsearch service\b/i,
  /\banalytics pipeline\b/i,
  /\bmarketing site\b/i,
  /\bpublic website\b/i,
  /\bsupport ticket\b/i,
  /\bticket automation\b/i,
  /\bidentity provider\b/i,
  /\brbac enforcement\b/i,
];

export const DOCS_PORTAL_SCOPE: DocsPortalScope = {
  issue: "HOBO-434",
  project: "Docs Portal",
  phase: "M0",
  goal:
    "Define Docs Portal productization scope so getting-started, API reference, architecture, troubleshooting, release-note, known-limitation, security, and support documentation expectations are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "app developer",
      need: "Find a guided first path from workspace setup to a proven deploy without relying on unsupported launch claims.",
    },
    {
      role: "platform engineer",
      need: "Find architecture, provider, environment, compatibility, and operational guidance tied to accepted evidence sources.",
    },
    {
      role: "support operator",
      need: "Route customer questions to approved docs, known limitations, support channels, and escalation owners.",
    },
    {
      role: "security reviewer",
      need: "Confirm security, disclosure, provenance, access, and support wording has an owner and proof source before publication.",
    },
    {
      role: "docs maintainer",
      need: "Maintain content inventory, navigation, versioning, search metadata, and stale-content routes without owning product implementation.",
    },
    {
      role: "release owner",
      need: "Block public docs claims and follow-up issue fan-out until M0 scope, evidence owners, and proof requirements are accepted.",
    },
  ],
  scopeIn: [
    "Docs Portal information architecture for getting-started, API reference, architecture, operations, troubleshooting, release notes, known limitations, security, and support content areas.",
    "Audience path map for app developers, platform engineers, support operators, security reviewers, docs maintainers, and release owners.",
    "Content inventory fixture that names source record, owner, freshness signal, proof mode, and customer-visible status for each launch-critical page class.",
    "Navigation taxonomy and searchable metadata contract for future discovery work.",
    "Versioning, archived-doc, known-limitation, and unsupported-state rules consumed by release notes and support.",
    "Security and support handoff routes for disclosure, vulnerable dependency notices, unsupported install environments, account/support channels, and incident communication links.",
    "M1-ready evidence checklist for content inventory, audience paths, navigation taxonomy, versioning, search index contract, support handoffs, and scope boundary register.",
  ],
  scopeOut: [
    "No React implementation, docs portal UI, portal screens, design system work, frontend routing, or visual theme work.",
    "No CMS, authoring workflow, content pipeline, live publishing system, static-site generator, hosting, CDN, or preview deployment implementation.",
    "No search indexing service, crawler, ranking, analytics pipeline, telemetry vendor, personalization, or recommendation engine.",
    "No final customer-facing copy, launch-site copy, marketing site, public website, pricing page, or commercial messaging approval.",
    "No support ticket queue, helpdesk integration, support automation, incident publishing workflow, or status page implementation.",
    "No identity provider, RBAC enforcement, account access, tenant-data access, or security-disclosure intake implementation.",
    "No release decision, launch blocker resolution, compatibility certification, or production-readiness claim without owner evidence.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace V1 Release Notes & Upgrade Guide, Compatibility Matrix, Security Verification, or Support Workflow.",
    "Build docs portal UI, CMS, search service, analytics, support automation, identity, RBAC, or hosting.",
    "Approve public launch, GA, production-readiness, compatibility, support, or security claims.",
    "Create downstream execution issues before M0 acceptance is recorded.",
  ],
  boundaries: {
    service:
      "Docs Portal M0 owns accepted content inventory, source ownership, freshness expectations, versioning rules, and M1 proof requirements; it does not build hosting, CMS, search, analytics, or publishing services.",
    ux:
      "UX scope is information architecture, navigation vocabulary, audience paths, and customer-safe limitation wording for future documentation flows, not screens, routing, components, or visual design.",
    security:
      "Security scope records required proof sources, vulnerability/disclosure routes, redaction boundaries, and claim ownership before public security wording appears, without implementing auth, RBAC, tenant-data access, or disclosure intake.",
    support:
      "Support receives approved troubleshooting, unsupported-state, limitation, channel, and escalation routes; support queues, staffing workflows, incident publishing, and ticket automation remain separate work.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Owns docs, dashboards, CLI, status pages, and developer-facing operations surfaces consumed by Docs Portal information architecture.",
    },
    {
      source: "docs/design/release-notes-upgrade-guide.md",
      reason: "Defines release-note, upgrade, compatibility, known-limitation, rollback, migration, and support-contact inputs the portal must route without rewriting final copy.",
    },
    {
      source: "docs/design/compatibility-matrix.md",
      reason: "Defines browser, device, platform, CLI bootstrap, unsupported environment, and limitation evidence that customer-facing docs may publish.",
    },
    {
      source: "docs/design/launch-messaging-claims.md",
      reason: "Defines claim states, proof-mode labels, evidence owners, and unsupported public claim routing for docs and launch copy.",
    },
    {
      source: "docs/design/support-sla-channels.md",
      reason: "Defines support channels, response language, unsupported request classes, and owner routes docs must surface safely.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines escalation matrix, incident communication templates, and support gap routing consumed by troubleshooting and status documentation.",
    },
    {
      source: "docs/design/security-verification.md",
      reason: "Defines vulnerability disclosure and security launch-blocker process boundaries for security docs and customer assurances.",
    },
    {
      source: "docs/design/accessibility-usability-launch-baseline.md",
      reason: "Defines accessibility and usability evidence expectations for customer-visible documentation and launch surfaces.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Requires reproducible verification evidence before launch claims move into customer-facing material.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Docs Portal",
      consumes: "Owns accepted content areas, audience paths, source ownership, freshness policy, and follow-up gate.",
      scopeBoundary: "This issue defines M0 scope and acceptance; it does not build the portal UI, CMS, search, analytics, hosting, or publishing pipeline.",
    },
    {
      owner: "Tutorials & Walkthroughs",
      consumes: "Provides guided task paths and tutorial entry points that Docs Portal may organize.",
      scopeBoundary: "Tutorial content, recordings, and hands-on walkthrough execution stay in Tutorials & Walkthroughs.",
    },
    {
      owner: "Troubleshooting Guides",
      consumes: "Provides issue diagnosis trees, known failure modes, and operator handoff language.",
      scopeBoundary: "Troubleshooting content creation, diagnostic automation, and repair workflows remain outside Docs Portal.",
    },
    {
      owner: "V1 Release Notes & Upgrade Guide",
      consumes: "Provides release, upgrade, rollback, migration, known-limitation, and support-contact inputs.",
      scopeBoundary: "Release publication, release copy approval, and upgrade path proof stay in release-note ownership.",
    },
    {
      owner: "Compatibility Matrix",
      consumes: "Provides supported browser, device, platform, and CLI bootstrap evidence for docs support claims.",
      scopeBoundary: "Compatibility testing, certification, and unsupported report triage remain Compatibility Matrix scope.",
    },
    {
      owner: "Support Workflow",
      consumes: "Provides support channel, unsupported request, severity, and escalation language for support docs.",
      scopeBoundary: "Support queues, staffing, ticket automation, and contractual SLA approval stay outside Docs Portal.",
    },
    {
      owner: "Security Verification",
      consumes: "Provides vulnerability disclosure, security launch blocker, and assurance boundaries for security docs.",
      scopeBoundary: "Security intake, remediation, bug bounty, and verification operations remain Security Verification scope.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses accepted M0 scope to decide when M1-M4 docs portal follow-up issues can be created.",
      scopeBoundary: "Release go/no-go, cutline decisions, and downstream issue creation remain release-program scope.",
    },
  ],
  portalContentAreas: [...REQUIRED_PORTAL_CONTENT_AREAS],
  customerFacingClaims: [
    {
      id: "guided-first-run",
      customerVisible: true,
      ownerRoute: "Tutorials & Walkthroughs",
      customerMessage: "Getting-started docs may claim a guided path only when the source tutorial or proof fixture is linked.",
      proofSource: "docs/design/docs-portal.md#audience-paths-and-content-areas",
    },
    {
      id: "supported-platforms",
      customerVisible: true,
      ownerRoute: "Compatibility Matrix",
      customerMessage: "Supported browser, device, platform, and CLI bootstrap statements must cite compatibility evidence.",
      proofSource: "docs/design/compatibility-matrix.md#evidence-source-map",
    },
    {
      id: "known-limitations",
      customerVisible: true,
      ownerRoute: "V1 Release Notes & Upgrade Guide",
      customerMessage: "Known limitation content must name owner, current support posture, and release-note or support route.",
      proofSource: "docs/design/release-notes-upgrade-guide.md#missing-evidence-policy",
    },
    {
      id: "security-support",
      customerVisible: true,
      ownerRoute: "Security Verification",
      customerMessage: "Security and vulnerability disclosure guidance must cite accepted security-verification evidence.",
      proofSource: "docs/design/security-verification.md",
    },
  ],
  m1Evidence: [
    {
      kind: "content-inventory-fixture",
      owner: "docs maintainer",
      proofMode: "reference-fixture",
      source: "docs/design/docs-portal.md#content-inventory-requirements",
      proves: "Launch-critical page classes name source record, owner, freshness signal, proof mode, and customer-visible state.",
    },
    {
      kind: "audience-path-map",
      owner: "app developer",
      proofMode: "design-record",
      source: "docs/design/docs-portal.md#audience-paths-and-content-areas",
      proves: "Each primary persona has an explicit first path through portal content before IA or UI work begins.",
    },
    {
      kind: "navigation-taxonomy",
      owner: "docs maintainer",
      proofMode: "design-record",
      source: "docs/design/docs-portal.md#navigation-and-search-contract",
      proves: "Navigation categories and search metadata are accepted without implementing a search service.",
    },
    {
      kind: "versioning-and-limitation-register",
      owner: "release owner",
      proofMode: "contract-test",
      source: "docs/design/release-notes-upgrade-guide.md#missing-evidence-policy",
      proves: "Versioned docs, archived docs, unsupported states, and known limitations are governed before public claims ship.",
    },
    {
      kind: "search-index-contract",
      owner: "docs maintainer",
      proofMode: "contract-test",
      source: "docs/design/docs-portal.md#navigation-and-search-contract",
      proves: "Searchable records name title, audience, source, freshness, and proof mode without building search infrastructure.",
    },
    {
      kind: "support-handoff-routes",
      owner: "support operator",
      proofMode: "support-handoff",
      source: "docs/design/support-sla-channels.md#unsupported-request-classes",
      proves: "Docs route unsupported requests and troubleshooting gaps to the correct support owner.",
    },
    {
      kind: "scope-boundary-register",
      owner: "release owner",
      proofMode: "release-gate",
      source: "docs/design/docs-portal.md#scope-out-and-non-goals",
      proves: "Portal UI, CMS, search, analytics, support automation, security intake, hosting, and follow-up scope remain blocked until M0 acceptance.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 Docs Portal design or implementation issues must not be created until this Docs Portal scope record is accepted.",
  },
};

export function canCreateDocsPortalFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validateDocsPortalScope(scope: DocsPortalScope) {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-434") {
    errors.push("issue must be HOBO-434");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("docs portal")) {
    errors.push("goal must name docs portal");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 6) {
    errors.push("scope in must have at least six entries");
  }
  if ((scope.scopeOut ?? []).length < 7) {
    errors.push("scope out must have at least seven entries");
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
    errors.push(
      "design dependencies must map to DX, release notes, compatibility, launch claims, support, security, accessibility, and verification sources",
    );
  }

  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const area of REQUIRED_PORTAL_CONTENT_AREAS) {
    if (!(scope.portalContentAreas ?? []).includes(area)) {
      errors.push(`portal content area missing: ${area}`);
    }
  }

  for (const evidenceKind of REQUIRED_M1_EVIDENCE) {
    if (!(scope.m1Evidence ?? []).some((evidence) => evidence.kind === evidenceKind)) {
      errors.push(`m1 evidence missing: ${evidenceKind}`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves || !evidence.source) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner, source, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  for (const claim of scope.customerFacingClaims ?? []) {
    if (claim.customerVisible && (!claim.customerMessage || !claim.ownerRoute || !claim.proofSource)) {
      errors.push(`customer-facing claim ${claim.id ?? "<unknown>"} must name customer message, owner route, and proof source`);
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
