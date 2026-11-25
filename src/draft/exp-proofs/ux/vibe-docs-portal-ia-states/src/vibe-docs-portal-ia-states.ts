export const REQUIRED_DOCS_PORTAL_CONTENT_AREAS = [
  "getting-started",
  "api-reference",
  "architecture",
  "operations",
  "troubleshooting",
  "release-notes",
  "known-limitations",
  "security",
  "support",
] as const;

export const REQUIRED_DOCS_PORTAL_AUDIENCES = [
  "app-developer",
  "platform-engineer",
  "support-operator",
  "security-reviewer",
  "docs-maintainer",
  "release-owner",
] as const;

export const REQUIRED_DOCS_PORTAL_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_DOCS_PORTAL_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_DOCS_PORTAL_FRESHNESS_STATUSES = [
  "fresh",
  "bounded-stale",
  "unknown",
  "scope-out",
] as const;

export const REQUIRED_DOCS_PORTAL_LIMITATION_STATES = [
  "supported",
  "known-limitation",
  "unsupported",
  "missing-evidence",
  "scope-out",
] as const;

type DocsPortalContentArea = (typeof REQUIRED_DOCS_PORTAL_CONTENT_AREAS)[number];
type DocsPortalAudience = (typeof REQUIRED_DOCS_PORTAL_AUDIENCES)[number];
type DocsPortalScenario = (typeof REQUIRED_DOCS_PORTAL_SCENARIOS)[number];
type DocsPortalProofMode = (typeof REQUIRED_DOCS_PORTAL_PROOF_MODES)[number];

type FreshnessStatus = (typeof REQUIRED_DOCS_PORTAL_FRESHNESS_STATUSES)[number];
type LimitationState = (typeof REQUIRED_DOCS_PORTAL_LIMITATION_STATES)[number];

type FreshnessSignal = {
  readonly status: FreshnessStatus;
  readonly signal: string;
  readonly checkedAt: string;
  readonly refreshTrigger: string;
  readonly staleDisposition: string;
};

type AudiencePath = {
  readonly persona: DocsPortalAudience;
  readonly entryPoint: string;
  readonly contentAreas: readonly DocsPortalContentArea[];
  readonly goal: string;
  readonly successCriteria: string;
  readonly blockedRoute: string;
};

type ContentInventoryEntry = {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly audiencePaths: readonly DocsPortalAudience[];
  readonly contentArea: DocsPortalContentArea;
  readonly sourceRecord: string;
  readonly owner: string;
  readonly freshnessSignal: FreshnessSignal;
  readonly proofMode: DocsPortalProofMode;
  readonly limitationState: LimitationState;
  readonly supportOrReleaseOwner: string;
  readonly customerVisibleStatus: string;
};

type SearchMetadataRecord = {
  readonly title: string;
  readonly slug: string;
  readonly audiences: readonly DocsPortalAudience[];
  readonly contentArea: DocsPortalContentArea;
  readonly sourceRecord: string;
  readonly owner: string;
  readonly freshnessSignal: FreshnessSignal;
  readonly proofMode: DocsPortalProofMode;
  readonly limitationState: LimitationState;
  readonly supportOrReleaseOwner: string;
  readonly searchableSummary: string;
};

type ScenarioPath = {
  readonly id: DocsPortalScenario;
  readonly narrative: string;
  readonly contentEntryIds: readonly string[];
  readonly safeOutcome: string;
};

type VibeDocsPortalIaStates = {
  readonly issue: "HOBO-551";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-docs-portal-ia-states";
  readonly proofPath: "docs/design/proofs/vibe-docs-portal-ia-states/README.md";
  readonly designRefs: readonly string[];
  readonly audiencePaths: readonly AudiencePath[];
  readonly contentInventory: readonly ContentInventoryEntry[];
  readonly searchMetadata: readonly SearchMetadataRecord[];
  readonly scenarioPaths: readonly ScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedDocsPortalIaStatesBrand: unique symbol;

export type ParsedVibeDocsPortalIaStates = VibeDocsPortalIaStates & {
  readonly [parsedDocsPortalIaStatesBrand]: true;
};

const CONTENT_INVENTORY: readonly ContentInventoryEntry[] = [
  {
    id: "docs-getting-started-resource-lifecycle",
    title: "Getting started with the resource lifecycle quickstart",
    slug: "/docs/getting-started/resource-lifecycle",
    audiencePaths: ["app-developer", "docs-maintainer", "release-owner"],
    contentArea: "getting-started",
    sourceRecord: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    owner: "Tutorials & Walkthroughs",
    freshnessSignal: {
      status: "fresh",
      signal: "HOBO-577 quickstart fixture ids accepted",
      checkedAt: "2026-07-01T15:06:35Z",
      refreshTrigger: "resource lifecycle fixture id or proof-mode label changes",
      staleDisposition: "downgrade to stale and route to Docs Portal owner before publication",
    },
    proofMode: "reference fixture",
    limitationState: "supported",
    supportOrReleaseOwner: "Docs Portal",
    customerVisibleStatus: "ready after docs owner review",
  },
  {
    id: "docs-api-reference-resource-lifecycle",
    title: "API and MCP resource lifecycle reference inventory",
    slug: "/docs/api/resource-lifecycle",
    audiencePaths: ["app-developer", "platform-engineer", "docs-maintainer"],
    contentArea: "api-reference",
    sourceRecord: "docs/design/sdk-contracts.md and docs/design/proofs/control-plane-api-resource-lifecycle-shapes/README.md",
    owner: "CLI, MCP & Developer Experience",
    freshnessSignal: {
      status: "bounded-stale",
      signal: "API/MCP proof package head and SDK contract record",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "API shape, MCP tool result, or SDK contract path changes",
      staleDisposition: "show versioned stale badge and route to DX owner",
    },
    proofMode: "simulated",
    limitationState: "supported",
    supportOrReleaseOwner: "Developer Experience",
    customerVisibleStatus: "reference-ready, not a production API promise",
  },
  {
    id: "docs-architecture-concepts",
    title: "Architecture and concepts map",
    slug: "/docs/architecture/concepts",
    audiencePaths: ["platform-engineer", "security-reviewer", "docs-maintainer"],
    contentArea: "architecture",
    sourceRecord: "docs/design/architecture.md and docs/design/developer-experience.md#plan-07",
    owner: "Architecture",
    freshnessSignal: {
      status: "fresh",
      signal: "current design suite source record",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "design plan or ADR link changes",
      staleDisposition: "block customer-safe concept copy until traceability is refreshed",
    },
    proofMode: "live",
    limitationState: "supported",
    supportOrReleaseOwner: "Architecture",
    customerVisibleStatus: "current design record, not shipped product behavior",
  },
  {
    id: "docs-operations-runbooks",
    title: "Operations guide and safe runbook entry points",
    slug: "/docs/operations/runbooks",
    audiencePaths: ["platform-engineer", "support-operator", "release-owner"],
    contentArea: "operations",
    sourceRecord: "docs/design/support-debug-tools.md and docs/design/developer-experience.md#plan-07",
    owner: "Operators & SRE",
    freshnessSignal: {
      status: "unknown",
      signal: "future M1 operations content inventory missing execution evidence",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "support debug tool or operations proof appears",
      staleDisposition: "render as unknown evidence and route to SRE owner",
    },
    proofMode: "scope-out",
    limitationState: "missing-evidence",
    supportOrReleaseOwner: "Operators & SRE",
    customerVisibleStatus: "not publishable until operations proof exists",
  },
  {
    id: "docs-troubleshooting-decision-trees",
    title: "Troubleshooting guides and owner routes",
    slug: "/docs/troubleshooting",
    audiencePaths: ["app-developer", "support-operator", "docs-maintainer"],
    contentArea: "troubleshooting",
    sourceRecord: "docs/design/troubleshooting-guides.md",
    owner: "Troubleshooting Guides",
    freshnessSignal: {
      status: "bounded-stale",
      signal: "troubleshooting scope record with follow-up issue gate",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "diagnostic decision tree fixtures change",
      staleDisposition: "show stale route and link support owner instead of a repair promise",
    },
    proofMode: "reference fixture",
    limitationState: "known-limitation",
    supportOrReleaseOwner: "Support Workflow",
    customerVisibleStatus: "reference fixture only",
  },
  {
    id: "docs-release-notes-upgrades",
    title: "Release notes, upgrades, and rollback route",
    slug: "/docs/releases/upgrade-guide",
    audiencePaths: ["release-owner", "platform-engineer", "support-operator"],
    contentArea: "release-notes",
    sourceRecord: "docs/design/release-notes-upgrade-guide.md",
    owner: "V1 Release Notes & Upgrade Guide",
    freshnessSignal: {
      status: "bounded-stale",
      signal: "release-note outline contract",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "release channel, known limitation, or upgrade proof changes",
      staleDisposition: "route stale release copy to release owner before customer exposure",
    },
    proofMode: "simulated",
    limitationState: "known-limitation",
    supportOrReleaseOwner: "Release Owner",
    customerVisibleStatus: "outline only, final release copy out of scope",
  },
  {
    id: "docs-known-limitations-register",
    title: "Known limitations and unsupported states",
    slug: "/docs/known-limitations",
    audiencePaths: ["app-developer", "support-operator", "release-owner"],
    contentArea: "known-limitations",
    sourceRecord: "docs/design/known-limitations-register.md",
    owner: "V1 Release Program & Cutline",
    freshnessSignal: {
      status: "fresh",
      signal: "known limitations register contract",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "unsupported environment, beta caveat, or launch limitation changes",
      staleDisposition: "block publish and route to release cutline owner",
    },
    proofMode: "reference fixture",
    limitationState: "known-limitation",
    supportOrReleaseOwner: "Release Owner",
    customerVisibleStatus: "customer-safe once release owner approves",
  },
  {
    id: "docs-security-disclosure-and-verification",
    title: "Security disclosure and verification routes",
    slug: "/docs/security",
    audiencePaths: ["security-reviewer", "support-operator", "docs-maintainer"],
    contentArea: "security",
    sourceRecord: "docs/design/security-verification.md",
    owner: "Security Verification",
    freshnessSignal: {
      status: "unknown",
      signal: "security launch-blocker source exists but intake implementation is out of scope",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "vulnerability disclosure or security notice route changes",
      staleDisposition: "show security route unknown and escalate to security owner",
    },
    proofMode: "scope-out",
    limitationState: "missing-evidence",
    supportOrReleaseOwner: "Security Verification",
    customerVisibleStatus: "not a disclosure intake implementation",
  },
  {
    id: "docs-support-channels-escalation",
    title: "Support channels and escalation handoff",
    slug: "/docs/support",
    audiencePaths: ["support-operator", "app-developer", "release-owner"],
    contentArea: "support",
    sourceRecord: "docs/design/support-sla-channels.md and docs/design/launch-support-escalation.md",
    owner: "Support Workflow",
    freshnessSignal: {
      status: "bounded-stale",
      signal: "support SLA and escalation scope records",
      checkedAt: "2026-07-01T15:50:00Z",
      refreshTrigger: "support channel coverage, unsupported request, or escalation route changes",
      staleDisposition: "show support route stale and owner-route the docs gap",
    },
    proofMode: "simulated",
    limitationState: "unsupported",
    supportOrReleaseOwner: "Support Workflow",
    customerVisibleStatus: "support wording only, no SLA promise",
  },
];

const AUDIENCE_PATHS: readonly AudiencePath[] = [
  {
    persona: "app-developer",
    entryPoint: "/docs/getting-started/resource-lifecycle",
    contentAreas: ["getting-started", "api-reference", "troubleshooting", "known-limitations", "support"],
    goal: "find the first safe resource lifecycle path and understand blocked or unsupported states",
    successCriteria: "can follow accepted quickstart fixtures without relying on production claims",
    blockedRoute: "route stale or unsupported evidence to support docs and known limitations",
  },
  {
    persona: "platform-engineer",
    entryPoint: "/docs/architecture/concepts",
    contentAreas: ["architecture", "operations", "api-reference", "release-notes"],
    goal: "map architecture and operational proof sources before adopting a workflow",
    successCriteria: "can identify source record, owner, and freshness for each operations claim",
    blockedRoute: "route missing operations evidence to Operators & SRE",
  },
  {
    persona: "support-operator",
    entryPoint: "/docs/support",
    contentAreas: ["support", "troubleshooting", "known-limitations", "release-notes", "security"],
    goal: "answer customer questions with customer-safe evidence and owner routes",
    successCriteria: "can separate supported, unsupported, missing-evidence, and security-owner cases",
    blockedRoute: "route unresolved cases to Support Workflow or Security Verification",
  },
  {
    persona: "security-reviewer",
    entryPoint: "/docs/security",
    contentAreas: ["security", "architecture", "api-reference", "support"],
    goal: "verify security docs name disclosure, provenance, and evidence ownership",
    successCriteria: "can block unbacked security claims before publication",
    blockedRoute: "route security-intake implementation requests out of scope",
  },
  {
    persona: "docs-maintainer",
    entryPoint: "/docs",
    contentAreas: REQUIRED_DOCS_PORTAL_CONTENT_AREAS,
    goal: "maintain docs IA, search metadata, and stale-content states without owning product code",
    successCriteria: "every launch-critical page class has owner, source, freshness, and proof mode",
    blockedRoute: "downgrade stale entries and open owner handoff before publishing",
  },
  {
    persona: "release-owner",
    entryPoint: "/docs/releases/upgrade-guide",
    contentAreas: ["release-notes", "known-limitations", "getting-started", "support", "operations"],
    goal: "prevent public release and launch claims without accepted evidence",
    successCriteria: "can trace every publishable doc area to proof mode and owner signoff",
    blockedRoute: "hold publication and route missing evidence to cutline owner",
  },
];

const SEARCH_METADATA: readonly SearchMetadataRecord[] = CONTENT_INVENTORY.map((entry) => ({
  title: entry.title,
  slug: entry.slug,
  audiences: entry.audiencePaths,
  contentArea: entry.contentArea,
  sourceRecord: entry.sourceRecord,
  owner: entry.owner,
  freshnessSignal: entry.freshnessSignal,
  proofMode: entry.proofMode,
  limitationState: entry.limitationState,
  supportOrReleaseOwner: entry.supportOrReleaseOwner,
  searchableSummary: `${entry.contentArea} record owned by ${entry.owner}; proof mode ${entry.proofMode}; limitation ${entry.limitationState}.`,
}));

export const VIBE_DOCS_PORTAL_IA_STATES: VibeDocsPortalIaStates = {
  issue: "HOBO-551",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-docs-portal-ia-states",
  proofPath: "docs/design/proofs/vibe-docs-portal-ia-states/README.md",
  designRefs: [
    "docs/design/docs-portal.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/known-limitations-register.md",
    "docs/design/troubleshooting-guides.md",
    "docs/design/support-sla-channels.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/security-verification.md",
    "docs/design/accessibility-usability-launch-baseline.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  audiencePaths: AUDIENCE_PATHS,
  contentInventory: CONTENT_INVENTORY,
  searchMetadata: SEARCH_METADATA,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Developer enters through getting started, reaches API reference, and sees supported known-limitations status.",
      contentEntryIds: [
        "docs-getting-started-resource-lifecycle",
        "docs-api-reference-resource-lifecycle",
        "docs-known-limitations-register",
      ],
      safeOutcome: "publish as reference-backed docs after owner review",
    },
    {
      id: "blocked-path",
      narrative: "Operations and security content disclose missing implementation evidence instead of claiming readiness.",
      contentEntryIds: ["docs-operations-runbooks", "docs-security-disclosure-and-verification"],
      safeOutcome: "block publication and route to SRE or security owner",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Bounded-stale troubleshooting, API, release, and support records carry downgrade behavior.",
      contentEntryIds: [
        "docs-api-reference-resource-lifecycle",
        "docs-troubleshooting-decision-trees",
        "docs-release-notes-upgrades",
        "docs-support-channels-escalation",
      ],
      safeOutcome: "show stale state and require owner refresh before launch claims",
    },
    {
      id: "support-handoff",
      narrative: "Support, known limitation, and security entries name customer-safe owners for handoff.",
      contentEntryIds: [
        "docs-support-channels-escalation",
        "docs-known-limitations-register",
        "docs-security-disclosure-and-verification",
      ],
      safeOutcome: "handoff to support, release, or security owner without exposing unsupported claims",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows audience path, content area, search metadata, freshness, and owner route fields.",
    "Screen reader labels include title, content area, proof mode, limitation state, freshness signal, and owner.",
    "Contrast and text labels distinguish fresh, stale, unknown, missing-evidence, and scope-out states.",
    "Reduced motion is required for any future portal navigation animation or stale-state transition.",
    "Plain-language summaries avoid jargon-only copy for blocked, unsupported, and security-owned states.",
  ],
  scopeOut: [
    "No docs portal UI, React implementation, frontend routing, or design system.",
    "No CMS, authoring workflow, content pipeline, publishing pipeline, hosting, CDN, or preview deployment.",
    "No search indexing service, crawler, ranking, analytics, recommendations, personalization, or telemetry pipeline.",
    "No final customer-facing copy, launch marketing, pricing, or commercial messaging approval.",
    "No support ticket queue, helpdesk integration, support automation, incident publishing workflow, or SLA promise.",
    "No identity provider, RBAC enforcement, tenant-data access, vulnerability disclosure intake, or security intake implementation.",
    "No launch claim, production readiness claim, or public publication without owner evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(docs portal ui|react implementation|frontend routing|design system|production ui)\b/i,
  /\b(cms|authoring workflow|content pipeline|publishing pipeline|static-site generator|hosting|cdn|preview deployment)\b/i,
  /\b(search service|search indexing|crawler|ranking|analytics|recommendations|personalization|telemetry pipeline)\b/i,
  /\b(final copy|customer-facing copy|launch marketing|pricing|commercial messaging)\b/i,
  /\b(helpdesk|support ticket|support automation|incident publishing|sla promise)\b/i,
  /\b(identity provider|rbac enforcement|tenant-data access|vulnerability disclosure intake|security intake)\b/i,
  /\b(launch claim|production readiness|public publication).*\b(without evidence|without owner evidence|now)\b/i,
];

export type DocsPortalIaRequestClassification = "in-scope-proof" | "scope-out";

export class VibeDocsPortalIaStatesParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe docs portal IA states failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeDocsPortalIaStatesParseError";
  }
}

export function parseVibeDocsPortalIaStates(
  states: VibeDocsPortalIaStates,
): ParsedVibeDocsPortalIaStates {
  const validation = validateVibeDocsPortalIaStates(states);

  if (!validation.ok) {
    throw new VibeDocsPortalIaStatesParseError(validation.errors);
  }

  // SAFETY: `return states as ParsedVibeDocsPortalIaStates;` is required at this I/O or test boundary.
  return states as ParsedVibeDocsPortalIaStates;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeDocsPortalIaStates(
  states: VibeDocsPortalIaStates,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (states.issue !== "HOBO-551") {
    errors.push({ code: "wrong-issue", message: "docs portal IA proof must pin HOBO-551" });
  }
  if (states.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "docs portal IA proof must stay in M1" });
  }
  if (states.packagePath !== "src/draft/exp-proofs/ux/vibe-docs-portal-ia-states") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (states.proofPath !== "docs/design/proofs/vibe-docs-portal-ia-states/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }

  const inventoryAreas = states.contentInventory.map((entry) => entry.contentArea);
  if (!arraysEqual(inventoryAreas, REQUIRED_DOCS_PORTAL_CONTENT_AREAS)) {
    errors.push({
      code: "missing-content-area",
      message: "content inventory must cover the required Docs Portal content areas in accepted order",
    });
  }

  validateAudiencePaths(states.audiencePaths, errors);
  validateContentInventory(states.contentInventory, errors);
  validateSearchMetadata(states.searchMetadata, errors);
  validateScenarioPaths(states.scenarioPaths, states.contentInventory, errors);
  validateAccessibilityNotes(states.accessibilityNotes, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyDocsPortalIaRequest(summary: string): DocsPortalIaRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateAudiencePaths(paths: readonly AudiencePath[], errors: ValidationError[]): void {
  if (!arraysEqual(paths.map((path) => path.persona), REQUIRED_DOCS_PORTAL_AUDIENCES)) {
    errors.push({
      code: "missing-audience-path",
      message: "audience paths must cover app developer, platform engineer, support, security, docs, and release roles",
    });
  }

  for (const path of paths) {
    if (!path.entryPoint || !path.goal || !path.successCriteria || !path.blockedRoute) {
      errors.push({
        code: "incomplete-audience-path",
        message: `${path.persona} must name entry point, goal, success criteria, and blocked route`,
      });
    }
    for (const area of path.contentAreas) {
      if (!REQUIRED_DOCS_PORTAL_CONTENT_AREAS.includes(area)) {
        errors.push({
          code: "unknown-audience-content-area",
          message: `${path.persona} references unknown content area ${String(area)}`,
        });
      }
    }
  }
}

function validateContentInventory(
  inventory: readonly ContentInventoryEntry[],
  errors: ValidationError[],
): void {
  const proofModes = new Set<DocsPortalProofMode>();

  for (const entry of inventory) {
    if (
      !entry.id ||
      !entry.title ||
      !entry.slug ||
      !entry.sourceRecord ||
      !entry.owner ||
      !entry.supportOrReleaseOwner ||
      !entry.customerVisibleStatus
    ) {
      errors.push({
        code: "missing-content-metadata",
        message: `${entry.id || entry.contentArea} must name title, slug, source, owner, handoff owner, and status`,
      });
    }
    if (!entry.audiencePaths.length) {
      errors.push({
        code: "missing-content-audience",
        message: `${entry.id} must name at least one audience path`,
      });
    }
    for (const audience of entry.audiencePaths) {
      if (REQUIRED_DOCS_PORTAL_AUDIENCES.includes(audience)) continue;
      errors.push({
        code: "unknown-content-audience",
        message: `${entry.id} references unknown audience ${String(audience)}`,
      });
    }
    if (!REQUIRED_DOCS_PORTAL_PROOF_MODES.includes(entry.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${entry.id} uses unsupported proof mode ${String(entry.proofMode)}`,
      });
    } else {
      proofModes.add(entry.proofMode);
    }
    if (!REQUIRED_DOCS_PORTAL_LIMITATION_STATES.includes(entry.limitationState)) {
      errors.push({
        code: "unsupported-limitation-state",
        message: `${entry.id} uses unsupported limitation state ${String(entry.limitationState)}`,
      });
    }
    validateFreshnessSignal(entry.freshnessSignal, entry.id || entry.contentArea, errors);
  }

  for (const proofMode of REQUIRED_DOCS_PORTAL_PROOF_MODES) {
    if (proofModes.has(proofMode)) continue;
    errors.push({
      code: "missing-proof-mode-label",
      message: "content inventory must cover live, simulated, reference fixture, and scope-out labels",
    });
  }
}

function validateSearchMetadata(metadata: readonly SearchMetadataRecord[], errors: ValidationError[]): void {
  if (!arraysEqual(metadata.map((entry) => entry.contentArea), REQUIRED_DOCS_PORTAL_CONTENT_AREAS)) {
    errors.push({
      code: "missing-search-metadata-area",
      message: "search metadata must mirror every content area",
    });
  }

  for (const entry of metadata) {
    if (
      !entry.title ||
      !entry.slug ||
      !entry.sourceRecord ||
      !entry.owner ||
      !entry.supportOrReleaseOwner ||
      !entry.searchableSummary
    ) {
      errors.push({
        code: "missing-search-metadata",
        message: `${entry.contentArea} search metadata must name source, owner, freshness, handoff owner, and summary`,
      });
    }
    for (const audience of entry.audiences) {
      if (REQUIRED_DOCS_PORTAL_AUDIENCES.includes(audience)) continue;
      errors.push({
        code: "unknown-search-audience",
        message: `${entry.contentArea} search metadata references unknown audience ${String(audience)}`,
      });
    }
    if (!REQUIRED_DOCS_PORTAL_PROOF_MODES.includes(entry.proofMode)) {
      errors.push({
        code: "unsupported-search-proof-mode",
        message: `${entry.contentArea} search metadata uses unsupported proof mode ${String(entry.proofMode)}`,
      });
    }
    if (!REQUIRED_DOCS_PORTAL_LIMITATION_STATES.includes(entry.limitationState)) {
      errors.push({
        code: "unsupported-search-limitation-state",
        message: `${entry.contentArea} search metadata uses unsupported limitation state ${String(entry.limitationState)}`,
      });
    }
    validateFreshnessSignal(entry.freshnessSignal, `${entry.contentArea} search metadata`, errors);
  }
}

function validateScenarioPaths(
  scenarios: readonly ScenarioPath[],
  inventory: readonly ContentInventoryEntry[],
  errors: ValidationError[],
): void {
  if (!arraysEqual(scenarios.map((scenario) => scenario.id), REQUIRED_DOCS_PORTAL_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "scenario paths must cover happy, blocked, stale/unknown, and support handoff",
    });
  }

  const ids = new Set(inventory.map((entry) => entry.id));
  for (const scenario of scenarios) {
    if (!scenario.narrative || !scenario.safeOutcome || !scenario.contentEntryIds.length) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name narrative, entries, and safe outcome`,
      });
    }
    for (const id of scenario.contentEntryIds) {
      if (!ids.has(id)) {
        errors.push({
          code: "unknown-scenario-content-entry",
          message: `${scenario.id} references missing content entry ${id}`,
        });
      }
    }
  }
}

function validateAccessibilityNotes(notes: readonly string[], errors: ValidationError[]): void {
  const noteText = notes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "contrast", "reduced motion", "plain-language"]) {
    if (noteText.includes(requiredNote)) continue;
    errors.push({
      code: "missing-accessibility-note",
      message: `accessibility notes must include ${requiredNote}`,
    });
  }
}

function validateFreshnessSignal(
  freshnessSignal: FreshnessSignal | undefined,
  recordId: string,
  errors: ValidationError[],
): void {
  if (!freshnessSignal) {
    errors.push({
      code: "missing-freshness-signal",
      message: `${recordId} must name a freshness signal`,
    });
    return;
  }

  if (!REQUIRED_DOCS_PORTAL_FRESHNESS_STATUSES.includes(freshnessSignal.status)) {
    errors.push({
      code: "unsupported-freshness-status",
      message: `${recordId} uses unsupported freshness status ${String(freshnessSignal.status)}`,
    });
  }
  if (
    !freshnessSignal.signal ||
    !freshnessSignal.checkedAt ||
    !freshnessSignal.refreshTrigger ||
    !freshnessSignal.staleDisposition
  ) {
    errors.push({
      code: "missing-freshness-signal",
      message: `${recordId} must name freshness signal, checked time, refresh trigger, and stale disposition`,
    });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
