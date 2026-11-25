import {
  VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
  parseVibeMarketplaceInstallabilityMockups,
} from "../../../ux/vibe-marketplace-installability-mockups/src/vibe-marketplace-installability-mockups.ts";
import {
  MARKETPLACE_TRUST_COPY_STATES,
  parseMarketplaceTrustCopyStates,
} from "../../../ux/vibe-marketplace-trust-copy-states/src/vibe-marketplace-trust-copy-states.ts";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const MARKETPLACE_DISCOVERY_LISTING_STATES = [
  "preview-only",
  "limited-beta",
  "installable",
  "policy-blocked",
  "deprecated",
  "yanked",
] as const;

export const MARKETPLACE_DISCOVERY_PATHS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const MARKETPLACE_DISCOVERY_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

const QUICKSTART_FIXTURE_IDS = [
  "rlq-collect-manifest-ir-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-scope-out-v1",
] as const;

const REQUIRED_SCOPE_OUT = [
  "live storefront",
  "registry",
  "resolver",
  "install runtime",
  "ranking",
  "monetization",
  "publisher workflow",
  "production UI",
  "support queue",
  "launch claims without evidence",
] as const;

type MarketplaceDiscoveryListingState = (typeof MARKETPLACE_DISCOVERY_LISTING_STATES)[number];
type MarketplaceDiscoveryPathKind = (typeof MARKETPLACE_DISCOVERY_PATHS)[number];
type MarketplaceDiscoveryProofMode = (typeof MARKETPLACE_DISCOVERY_PROOF_MODES)[number];
type QuickstartFixtureId = (typeof QUICKSTART_FIXTURE_IDS)[number];
type MarketplaceDiscoverySurface = "browse" | "search" | "listing-detail" | "installability-panel";
type MarketplaceTrustCopyState =
  | "preview-warning"
  | "installable-with-evidence"
  | "policy-block"
  | "deprecated-guidance"
  | "yanked-support-route"
  | "hidden-listing";

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoverySourceIssue proto message in data-models/.
export type MarketplaceDiscoverySourceIssue = {
  readonly issue: "HOBO-546" | "HOBO-547" | "HOBO-577";
  readonly packagePath: string;
  readonly proofPath: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoveryMockupSource proto message in data-models/.
export type MarketplaceDiscoveryMockupSource = {
  readonly sourceIssue: "HOBO-546";
  readonly fixtureId: string;
  readonly surface: MarketplaceDiscoverySurface;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoveryTrustCopySource proto message in data-models/.
export type MarketplaceDiscoveryTrustCopySource = {
  readonly sourceIssue: "HOBO-547";
  readonly fixtureId: string;
  readonly copyState: MarketplaceTrustCopyState;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoveryQuickstartRef proto message in data-models/.
export type MarketplaceDiscoveryQuickstartRef = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: QuickstartFixtureId;
  readonly proofMode: "reference-fixture" | "simulated" | "live" | "scope-out";
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoveryCatalogFixture proto message in data-models/.
export type MarketplaceDiscoveryCatalogFixture = {
  readonly fixtureId: string;
  readonly listingState: MarketplaceDiscoveryListingState;
  readonly displayLabel: string;
  readonly sourceMockup: MarketplaceDiscoveryMockupSource;
  readonly sourceTrustCopy: MarketplaceDiscoveryTrustCopySource;
  readonly quickstartRef: MarketplaceDiscoveryQuickstartRef;
  readonly trustEvidence: string;
  readonly orgCatalogDecision: string;
  readonly supportRoute: string;
  readonly installabilityOutcome: string;
  readonly proofMode: MarketplaceDiscoveryProofMode;
  readonly customerSafeMessage: string;
  readonly safeNextAction: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the MarketplaceDiscoveryPath proto message in data-models/.
export type MarketplaceDiscoveryPath = {
  readonly kind: MarketplaceDiscoveryPathKind;
  readonly fixtureIds: readonly string[];
  readonly proofModes: readonly MarketplaceDiscoveryProofMode[];
  readonly expectedUserSignal: string;
  readonly supportHandoff: string;
};

export type MarketplaceDiscoveryPrototype = {
  readonly issue: "HOBO-562";
  readonly phase: "M2";
  readonly targetPackage: "src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype";
  readonly proofNote: "docs/design/proofs/vibe-marketplace-discovery-prototype/README.md";
  readonly designRefs: readonly string[];
  readonly sourceIssues: readonly MarketplaceDiscoverySourceIssue[];
  readonly catalog: readonly MarketplaceDiscoveryCatalogFixture[];
  readonly paths: readonly MarketplaceDiscoveryPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

export type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedMarketplaceDiscoveryPrototypeBrand: unique symbol;

export type ParsedMarketplaceDiscoveryPrototype = MarketplaceDiscoveryPrototype & {
  readonly [parsedMarketplaceDiscoveryPrototypeBrand]: true;
};

const acceptedMockups = parseVibeMarketplaceInstallabilityMockups(
  VIBE_MARKETPLACE_INSTALLABILITY_MOCKUPS,
);
const acceptedTrustCopy = parseMarketplaceTrustCopyStates(MARKETPLACE_TRUST_COPY_STATES);
const acceptedMockupFixtureIds = new Set(
  acceptedMockups.fixtures.map((fixture) => fixture.fixtureId),
);
const acceptedTrustFixtureIds = new Set(
  acceptedTrustCopy.scenarios.map((scenario) => scenario.fixtureId),
);
const acceptedQuickstartFixtureIds = new Set(
  acceptedMockups.quickstartFixtureRefs.map((ref) => ref.fixtureId),
);

export const MARKETPLACE_DISCOVERY_PROTOTYPE: MarketplaceDiscoveryPrototype = {
  issue: "HOBO-562",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype",
  proofNote: "docs/design/proofs/vibe-marketplace-discovery-prototype/README.md",
  designRefs: [
    "docs/design/marketplace-ux.md",
    "docs/design/org-catalogs.md",
    "docs/design/capability-review-approval.md",
    "docs/design/marketplace-publisher-trust-evidence.md",
    "docs/design/support-workflow.md",
    "docs/design/proofs/vibe-marketplace-installability-mockups/README.md",
    "docs/design/proofs/vibe-marketplace-trust-copy-states/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  sourceIssues: [
    {
      issue: "HOBO-546",
      packagePath: "src/draft/exp-proofs/ux/vibe-marketplace-installability-mockups",
      proofPath: "docs/design/proofs/vibe-marketplace-installability-mockups/README.md",
    },
    {
      issue: "HOBO-547",
      packagePath: "src/draft/exp-proofs/ux/vibe-marketplace-trust-copy-states",
      proofPath: "docs/design/proofs/vibe-marketplace-trust-copy-states/README.md",
    },
    {
      issue: "HOBO-577",
      packagePath: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples",
      proofPath: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    },
  ],
  catalog: [
    {
      fixtureId: "mdp-preview-only-v1",
      listingState: "preview-only",
      displayLabel: "Preview listing",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-preview-only",
        surface: "browse",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-preview-warning-v1",
        copyState: "preview-warning",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-collect-manifest-ir-v1",
        proofMode: "reference-fixture",
      },
      trustEvidence: "Publisher identity exists but review, conformance, and org catalog evidence are incomplete.",
      orgCatalogDecision: "Not eligible for org catalog selection until review evidence is accepted.",
      supportRoute: "Marketplace Publisher Trust Evidence",
      installabilityOutcome: "Warning-only discovery; install intent is hidden.",
      proofMode: "reference fixture",
      customerSafeMessage: "Preview listing is visible for evaluation and cannot be presented as installable.",
      safeNextAction: "Open the evidence checklist before planning any use.",
    },
    {
      fixtureId: "mdp-limited-beta-v1",
      listingState: "limited-beta",
      displayLabel: "Limited beta",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-limited-beta",
        surface: "search",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-preview-warning-v1",
        copyState: "preview-warning",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-plan-safe-preview-v1",
        proofMode: "simulated",
      },
      trustEvidence: "Limited beta approval is visible but still bounded by missing-evidence language.",
      orgCatalogDecision: "Visible only to approved beta workspaces with policy pin and owner route.",
      supportRoute: "Capability Review & Approval",
      installabilityOutcome: "Install intent is scoped to beta fixtures and must keep missing-evidence copy.",
      proofMode: "simulated",
      customerSafeMessage: "Limited-beta listing is available only to allowed scopes with explicit limits.",
      safeNextAction: "Confirm beta workspace eligibility and owner route before showing install intent.",
    },
    {
      fixtureId: "mdp-installable-v1",
      listingState: "installable",
      displayLabel: "Installable with evidence",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-installable",
        surface: "installability-panel",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-installable-evidence-v1",
        copyState: "installable-with-evidence",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-deploy-run-accepted-v1",
        proofMode: "live",
      },
      trustEvidence: "Provenance, conformance, security review, org catalog, and policy evidence are linked.",
      orgCatalogDecision: "Approved for the recorded workspace with immutable version pin and support owner.",
      supportRoute: "Capability Review & Approval",
      installabilityOutcome: "Install intent may be shown because every required evidence field is present.",
      proofMode: "live",
      customerSafeMessage: "Listing is installable for the recorded workspace because required evidence is linked.",
      safeNextAction: "Show install intent with evidence links, owner route, and proof-mode chip.",
    },
    {
      fixtureId: "mdp-policy-blocked-v1",
      listingState: "policy-blocked",
      displayLabel: "Blocked by policy",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-policy-blocked",
        surface: "search",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-policy-block-v1",
        copyState: "policy-block",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-plan-safe-preview-v1",
        proofMode: "simulated",
      },
      trustEvidence: "Catalog or mandatory policy denies this scope even though listing metadata remains visible.",
      orgCatalogDecision: "Blocked for current workspace; no install intent or override is exposed.",
      supportRoute: "Org Catalogs",
      installabilityOutcome: "Install intent is suppressed and user sees the catalog/policy owner.",
      proofMode: "simulated",
      customerSafeMessage: "Listing is blocked for this org or workspace by catalog, policy, trust, or approval state.",
      safeNextAction: "Route the user to catalog owner evidence without granting override.",
    },
    {
      fixtureId: "mdp-deprecated-v1",
      listingState: "deprecated",
      displayLabel: "Deprecated",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-deprecated",
        surface: "listing-detail",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-deprecated-guidance-v1",
        copyState: "deprecated-guidance",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-manage-stale-evidence-v1",
        proofMode: "reference-fixture",
      },
      trustEvidence: "Deprecation notice and replacement evidence exist, but current installability is stale.",
      orgCatalogDecision: "Visible for existing-use and migration guidance; not a default new selection.",
      supportRoute: "Registry Distribution",
      installabilityOutcome: "Install intent becomes guidance-only with migration or replacement next action.",
      proofMode: "reference fixture",
      customerSafeMessage: "Deprecated listing remains visible only for existing-use and migration guidance.",
      safeNextAction: "Show replacement or migration guidance and preserve stale-evidence label.",
    },
    {
      fixtureId: "mdp-yanked-v1",
      listingState: "yanked",
      displayLabel: "Yanked",
      sourceMockup: {
        sourceIssue: "HOBO-546",
        fixtureId: "hobo-546-marketplace-yanked",
        surface: "installability-panel",
      },
      sourceTrustCopy: {
        sourceIssue: "HOBO-547",
        fixtureId: "mtc-yanked-support-route-v1",
        copyState: "yanked-support-route",
      },
      quickstartRef: {
        sourceIssue: "HOBO-577",
        fixtureId: "rlq-recover-scope-out-v1",
        proofMode: "scope-out",
      },
      trustEvidence: "Yank decision is recorded; production registry removal remains outside this proof.",
      orgCatalogDecision: "Removed from new selection and retained only for audit/support explanation.",
      supportRoute: "Support Workflow",
      installabilityOutcome: "Install intent is denied and the only visible route is support or migration.",
      proofMode: "scope-out",
      customerSafeMessage: "Yanked listing is unavailable for new use and routes to support or migration guidance.",
      safeNextAction: "Show customer-safe support route without creating live tickets.",
    },
  ],
  paths: [
    {
      kind: "happy-path",
      fixtureIds: ["mdp-installable-v1"],
      proofModes: ["live", "reference fixture"],
      expectedUserSignal: "Installable listing shows evidence, owner route, org-catalog approval, and proof mode.",
      supportHandoff: "Capability review owner remains visible for evidence questions.",
    },
    {
      kind: "blocked-path",
      fixtureIds: ["mdp-policy-blocked-v1", "mdp-yanked-v1"],
      proofModes: ["simulated", "scope-out"],
      expectedUserSignal: "Blocked and yanked listings suppress install intent and expose owner routes.",
      supportHandoff: "Org Catalogs or Support Workflow receives a customer-safe handoff.",
    },
    {
      kind: "stale-or-unknown-evidence",
      fixtureIds: ["mdp-preview-only-v1", "mdp-limited-beta-v1", "mdp-deprecated-v1"],
      proofModes: ["reference fixture", "simulated"],
      expectedUserSignal: "Preview, beta, and deprecated states keep missing or stale evidence visible.",
      supportHandoff: "Marketplace trust, capability review, or registry distribution owner remains named.",
    },
    {
      kind: "support-handoff",
      fixtureIds: ["mdp-deprecated-v1", "mdp-yanked-v1"],
      proofModes: ["reference fixture", "scope-out"],
      expectedUserSignal: "Support handoff is visible without implying support automation exists.",
      supportHandoff: "Support Workflow receives redacted customer-safe context only.",
    },
  ],
  accessibilityNotes: [
    "Keyboard order reaches listing state, evidence, org-catalog decision, support route, proof mode, and safe action.",
    "Screen reader text includes listing state, installability outcome, proof mode, and source fixture id.",
    "Contrast and copy distinguish approved, preview, limited beta, policy-blocked, deprecated, and yanked states.",
    "Responsive layout keeps support route, customer-safe message, and proof mode adjacent on narrow screens.",
    "Reduced-motion variants preserve blocked and stale-evidence state changes without animation-only meaning.",
  ],
  scopeOut: [
    "No live storefront, browse/search service, marketplace service, or production UI.",
    "No Registry storage, registry resolver, package hosting, signing, or install-time verification.",
    "No install runtime, install service, deploy runtime, or live provider action.",
    "No ranking, recommendation, paid placement, monetization, payouts, or marketplace commerce policy.",
    "No publisher workflow, publisher portal UI, evidence upload service, or maintainer workflow.",
    "No policy engine, RBAC runtime, scanner integration, conformance runner, or approval service.",
    "No support queue, support tooling, notification delivery, or live ticket creation.",
    "No public launch publication or launch claims without evidence.",
  ],
};

export type MarketplaceDiscoveryRequestClassification = "in-scope-proof" | "scope-out";

export class VibeMarketplaceDiscoveryPrototypeParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(
      `Vibe marketplace discovery prototype failed parsing: ${errors
        .map((error) => error.code)
        .join(", ")}`,
    );
    this.name = "VibeMarketplaceDiscoveryPrototypeParseError";
  }
}

export function parseMarketplaceDiscoveryPrototype(
  prototype: JsonValue,
): ParsedMarketplaceDiscoveryPrototype {
  const validation = validateMarketplaceDiscoveryPrototype(prototype);

  if (!validation.ok) {
    throw new VibeMarketplaceDiscoveryPrototypeParseError(validation.errors);
  }

  // SAFETY: `return prototype as ParsedMarketplaceDiscoveryPrototype;` is required at this I/O or test boundary.
  return prototype as ParsedMarketplaceDiscoveryPrototype;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateMarketplaceDiscoveryPrototype(
  prototype: JsonValue,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (!isRecord(prototype)) {
    return {
      ok: false,
      errors: [{ code: "not-object", message: "prototype must be an object" }],
    };
  }

  if (prototype.issue !== "HOBO-562") {
    errors.push({ code: "wrong-issue", message: "prototype must pin HOBO-562" });
  }
  if (prototype.phase !== "M2") {
    errors.push({ code: "wrong-phase", message: "prototype must stay in M2" });
  }
  if (prototype.targetPackage !== "src/draft/exp-proofs/ux/vibe-marketplace-discovery-prototype") {
    errors.push({ code: "wrong-package", message: "target package drifted" });
  }
  if (prototype.proofNote !== "docs/design/proofs/vibe-marketplace-discovery-prototype/README.md") {
    errors.push({ code: "wrong-proof-note", message: "target proof note drifted" });
  }

  validateSourceIssues(prototype.sourceIssues, errors);
  validateCatalog(prototype.catalog, errors);
  validatePaths(prototype.paths, prototype.catalog, errors);
  validateAccessibilityNotes(prototype.accessibilityNotes, errors);
  validateScopeOut(prototype.scopeOut, errors);

  return { ok: errors.length === 0, errors };
}

export function classifyMarketplaceDiscoveryRequest(
  summary: string,
): MarketplaceDiscoveryRequestClassification {
  return [
    /\b(live storefront|storefront|browse service|search service|marketplace service)\b/i,
    /\b(registry|resolver|install-time verification|package hosting)\b/i,
    /\b(install runtime|install service|deploy runtime|live provider)\b/i,
    /\b(rank|ranking|recommendation|paid placement|paid marketplace listings)\b/i,
    /\b(monetization|payout|commerce)\b/i,
    /\b(publisher workflow|publisher portal|evidence upload|maintainer workflow)\b/i,
    /\b(production ui|ship ui|customer-facing ui)\b/i,
    /\b(support queue|support tooling|live ticket|notification delivery)\b/i,
    /\b(launch claims without evidence|launch claim|launch readiness)\b/i,
  ].some((pattern) => pattern.test(summary))
    ? "scope-out"
    : "in-scope-proof";
}

export function renderMarketplaceInstallIntentSummary(
  fixture: MarketplaceDiscoveryCatalogFixture,
): string {
  return [
    `state: ${fixture.listingState}`,
    `label: ${fixture.displayLabel}`,
    `outcome: ${fixture.installabilityOutcome}`,
    `org catalog: ${fixture.orgCatalogDecision}`,
    `support: ${fixture.supportRoute}`,
    `proof mode: ${fixture.proofMode}`,
  ].join("\n");
}

function validateSourceIssues(value: JsonValue, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ code: "missing-source-issues", message: "sourceIssues must be an array" });
    return;
  }
  const issues = value.map((source) => (isRecord(source) ? source.issue : undefined));
  if (!arraysEqual(issues, ["HOBO-546", "HOBO-547", "HOBO-577"])) {
    errors.push({
      code: "wrong-source-issues",
      message: "prototype must compose HOBO-546, HOBO-547, and HOBO-577",
    });
  }
}

function validateCatalog(value: JsonValue, errors: ValidationError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ code: "missing-catalog", message: "catalog must be an array" });
    return;
  }
  const states = value.map((fixture) => (isRecord(fixture) ? fixture.listingState : undefined));
  if (!arraysEqual(states, MARKETPLACE_DISCOVERY_LISTING_STATES)) {
    errors.push({
      code: "missing-listing-state",
      message: "catalog must cover every marketplace discovery listing state",
    });
  }

  for (const fixture of value) {
    if (!isRecord(fixture)) {
      errors.push({ code: "invalid-catalog-fixture", message: "catalog fixture must be an object" });
      continue;
    }
    const fixtureId = String(fixture.fixtureId ?? "");
    if (!/^mdp-[a-z0-9-]+-v[0-9]+$/.test(fixtureId)) {
      errors.push({ code: "invalid-fixture-id", message: `${fixtureId} must be an mdp fixture id` });
    }
    for (const field of [
      "displayLabel",
      "trustEvidence",
      "orgCatalogDecision",
      "supportRoute",
      "installabilityOutcome",
      "customerSafeMessage",
      "safeNextAction",
    ]) {
      if (!isJsonString(fixture[field]) || fixture[field].trim().length === 0) {
        errors.push({
          code: "missing-catalog-metadata",
          message: `${fixtureId || "<missing>"} must include ${field}`,
        });
      }
    }
    // SAFETY: `if (!MARKETPLACE_DISCOVERY_PROOF_MODES.includes(fixture.proofMode as Marketplace` is required at this I/O or test boundary.
    if (!MARKETPLACE_DISCOVERY_PROOF_MODES.includes(fixture.proofMode as MarketplaceDiscoveryProofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${fixtureId || "<missing>"} uses unsupported proof mode`,
      });
    }
    validateMockupSource(fixture.sourceMockup, fixtureId, errors);
    validateTrustCopySource(fixture.sourceTrustCopy, fixtureId, errors);
    validateQuickstartRef(fixture.quickstartRef, fixtureId, errors);
  }
}

function validateMockupSource(value: JsonValue, fixtureId: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ code: "missing-source-mockup", message: `${fixtureId} missing HOBO-546 source` });
    return;
  }
  if (value.sourceIssue !== "HOBO-546") {
    errors.push({ code: "wrong-source-mockup", message: `${fixtureId} must cite HOBO-546` });
  }
  if (!isJsonString(value.fixtureId) || !acceptedMockupFixtureIds.has(value.fixtureId)) {
    errors.push({ code: "unknown-source-mockup", message: `${fixtureId} cites unknown HOBO-546 fixture` });
  }
  if (!["browse", "search", "listing-detail", "installability-panel"].includes(String(value.surface))) {
    errors.push({ code: "unsupported-source-surface", message: `${fixtureId} source surface is unsupported` });
  }
}

function validateTrustCopySource(value: JsonValue, fixtureId: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ code: "missing-source-trust-copy", message: `${fixtureId} missing HOBO-547 source` });
    return;
  }
  if (value.sourceIssue !== "HOBO-547") {
    errors.push({ code: "wrong-source-trust-copy", message: `${fixtureId} must cite HOBO-547` });
  }
  if (!isJsonString(value.fixtureId) || !acceptedTrustFixtureIds.has(value.fixtureId)) {
    errors.push({ code: "unknown-source-trust-copy", message: `${fixtureId} cites unknown HOBO-547 fixture` });
  }
}

function validateQuickstartRef(value: JsonValue, fixtureId: string, errors: ValidationError[]): void {
  if (!isRecord(value)) {
    errors.push({ code: "missing-quickstart-ref", message: `${fixtureId} missing HOBO-577 ref` });
    return;
  }
  if (value.sourceIssue !== "HOBO-577") {
    errors.push({ code: "wrong-quickstart-source", message: `${fixtureId} must cite HOBO-577` });
  }
  if (!isJsonString(value.fixtureId) || !acceptedQuickstartFixtureIds.has(value.fixtureId)) {
    errors.push({ code: "unknown-quickstart-fixture", message: `${fixtureId} cites unknown HOBO-577 fixture` });
  }
}

function validatePaths(
  value: JsonValue,
  catalog: JsonValue,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ code: "missing-paths", message: "paths must be an array" });
    return;
  }
  const kinds = value.map((path) => (isRecord(path) ? path.kind : undefined));
  if (!arraysEqual(kinds, MARKETPLACE_DISCOVERY_PATHS)) {
    errors.push({
      code: "missing-path",
      message: "paths must cover happy, blocked, stale-or-unknown, and support handoff",
    });
  }
  const fixtureIds = new Set(
    Array.isArray(catalog)
      ? catalog.filter(isRecord).map((fixture) => String(fixture.fixtureId))
      : [],
  );
  const proofModes = new Set<string>();
  for (const path of value) {
    if (!isRecord(path)) {
      errors.push({ code: "invalid-path", message: "path must be an object" });
      continue;
    }
    if (!Array.isArray(path.fixtureIds) || path.fixtureIds.length === 0) {
      errors.push({ code: "empty-path-fixtures", message: `${String(path.kind)} needs fixture ids` });
    } else {
      for (const id of path.fixtureIds) {
        if (!fixtureIds.has(String(id))) {
          errors.push({ code: "unknown-path-fixture", message: `${String(path.kind)} cites ${String(id)}` });
        }
      }
    }
    if (!Array.isArray(path.proofModes) || path.proofModes.length === 0) {
      errors.push({ code: "empty-path-proof-modes", message: `${String(path.kind)} needs proof modes` });
    } else {
      for (const mode of path.proofModes) {
        proofModes.add(String(mode));
      }
    }
    if (!isJsonString(path.expectedUserSignal) || !isJsonString(path.supportHandoff)) {
      errors.push({ code: "incomplete-path", message: `${String(path.kind)} needs signal and handoff` });
    }
  }
  for (const mode of MARKETPLACE_DISCOVERY_PROOF_MODES) {
    if (!proofModes.has(mode)) {
      errors.push({ code: "missing-proof-mode", message: `paths must include ${mode}` });
    }
  }
}

function validateAccessibilityNotes(value: JsonValue, errors: ValidationError[]): void {
  if (!Array.isArray(value) || value.some((note) => !isJsonString(note))) {
    errors.push({ code: "missing-accessibility-notes", message: "accessibilityNotes must be strings" });
    return;
  }
  const text = value.join(" ").toLowerCase();
  for (const word of ["keyboard", "screen reader", "contrast", "responsive", "proof mode"]) {
    if (!text.includes(word)) {
      errors.push({ code: "missing-accessibility-note", message: `accessibility notes must include ${word}` });
    }
  }
}

function validateScopeOut(value: JsonValue, errors: ValidationError[]): void {
  if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
    errors.push({ code: "missing-scope-out", message: "scopeOut must be string entries" });
    return;
  }
  const text = value.join(" ").toLowerCase();
  for (const boundary of REQUIRED_SCOPE_OUT) {
    if (!text.includes(boundary.toLowerCase())) {
      errors.push({ code: "missing-scope-out", message: `scopeOut missing ${boundary}` });
    }
  }
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
