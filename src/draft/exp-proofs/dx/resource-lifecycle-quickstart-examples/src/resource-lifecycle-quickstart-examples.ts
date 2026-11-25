import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const QUICKSTART_PHASES = [
  "define",
  "collect",
  "plan",
  "deploy",
  "inspect",
  "manage",
  "migrate",
  "recover",
] as const;

export const QUICKSTART_CHANNELS = ["sdk", "cli", "api", "mcp"] as const;

export const QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

export const QUICKSTART_CONSUMERS = [
  "Docs Portal",
  "Tutorials",
  "Troubleshooting",
  "Launch Site",
  "Workspace UX",
  "Plan/Diff",
  "Dashboard",
] as const;

type QuickstartPhase = (typeof QUICKSTART_PHASES)[number];
type QuickstartChannel = (typeof QUICKSTART_CHANNELS)[number];
type QuickstartProofMode = (typeof QUICKSTART_PROOF_MODES)[number];
type QuickstartConsumer = (typeof QUICKSTART_CONSUMERS)[number];

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLifecycleQuickstartSnippet proto message in data-models/.
export type ResourceLifecycleQuickstartSnippet = {
  readonly id: string;
  readonly channel: QuickstartChannel;
  readonly text: string;
  readonly fixtureId: string;
  readonly proofMode: QuickstartProofMode;
  readonly safeClaim: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLifecycleQuickstartStep proto message in data-models/.
export type ResourceLifecycleQuickstartStep = {
  readonly phase: QuickstartPhase;
  readonly title: string;
  readonly intent: string;
  readonly snippets: Readonly<Record<QuickstartChannel, ResourceLifecycleQuickstartSnippet>>;
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLifecycleQuickstartHandoff proto message in data-models/.
export type ResourceLifecycleQuickstartHandoff = {
  readonly consumer: QuickstartConsumer;
  readonly use: string;
  readonly fixtureIds: readonly string[];
  readonly handoffNote: string;
  readonly mustNotClaim: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLifecycleQuickstartModeNote proto message in data-models/.
export type ResourceLifecycleQuickstartModeNote = {
  readonly proofMode: QuickstartProofMode;
  readonly meaning: string;
  readonly docsLabel: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ResourceLifecycleQuickstartExamples proto message in data-models/.
export type ResourceLifecycleQuickstartExamples = {
  readonly issue: "HOBO-577";
  readonly phase: "M2";
  readonly targetPackage: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples";
  readonly proofNote: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md";
  readonly designRefs: readonly string[];
  readonly scopeOut: readonly string[];
  readonly safeClaims: readonly string[];
  readonly modeNotes: readonly ResourceLifecycleQuickstartModeNote[];
  readonly steps: readonly ResourceLifecycleQuickstartStep[];
  readonly handoffs: readonly ResourceLifecycleQuickstartHandoff[];
  readonly __brand: "ParsedResourceLifecycleQuickstartExamples";
};

type UnparsedResourceLifecycleQuickstartExamples = Omit<
  ResourceLifecycleQuickstartExamples,
  "__brand"
>;

const standardScopeOut = [
  "marketing copy not backed by transcripts",
  "customer promises",
  "live credentials",
  "production docs publication",
  "enterprise dashboard feature tours",
] as const;

export const RESOURCE_LIFECYCLE_QUICKSTART_EXAMPLES = {
  issue: "HOBO-577",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples",
  proofNote: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  designRefs: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/sdk-api.md#plan-02",
    "docs/design/control-plane.md#plan-04",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/data-plane.md#plan-32",
    "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md",
    "docs/design/proofs/cli-mcp-parity-resource-lifecycle-contracts/README.md",
  ],
  scopeOut: standardScopeOut,
  safeClaims: [
    "Shows the canonical resource lifecycle quickstart as fixtures, not a shipped runtime.",
    "Labels each snippet as reference fixture, simulated, optional live read, or scope-out.",
    "Covers deploy, manage, migrate, and recover without inventing dashboard behavior.",
  ],
  modeNotes: [
    {
      proofMode: "reference-fixture",
      meaning: "The snippet reads a checked-in fixture or transcript-equivalent contract.",
      docsLabel: "Reference fixture",
    },
    {
      proofMode: "simulated",
      meaning: "The snippet is runnable only against mocked service boundaries.",
      docsLabel: "Simulated",
    },
    {
      proofMode: "live",
      meaning: "The snippet may be adapted for a future live tenant after credentials and release gates exist.",
      docsLabel: "Optional live",
    },
    {
      proofMode: "scope-out",
      meaning: "The quickstart names a boundary that downstream docs must not claim as implemented.",
      docsLabel: "Scope-out",
    },
  ],
  steps: [
    {
      phase: "define",
      title: "Define resource intent",
      intent: "Start from the canonical object-graph sample and keep authoring identity separate from deployed resource identity.",
      snippets: {
        sdk: {
          id: "define-sdk-bindle",
          channel: "sdk",
          text: "bindle('shop-api', ({ b }) => ({ api: b.api(), cache: b.cache(), images: b.bucket() }))",
          fixtureId: "rlq-define-object-graph-v1",
          proofMode: "reference-fixture",
          safeClaim: "Defines a fixture-backed object graph with generated resource identifiers.",
        },
        cli: {
          id: "define-cli-new",
          channel: "cli",
          text: "hobo new shop-api --fixture resource-lifecycle",
          fixtureId: "rlq-define-object-graph-v1",
          proofMode: "reference-fixture",
          safeClaim: "Copies the quickstart fixture; it does not scaffold production infrastructure.",
        },
        api: {
          id: "define-api-manifest",
          channel: "api",
          text: "POST /draft/resource-lifecycle/fixtures/rlq-define-object-graph-v1/manifest",
          fixtureId: "rlq-define-object-graph-v1",
          proofMode: "reference-fixture",
          safeClaim: "Returns the fixture manifest shape used by later snippets.",
        },
        mcp: {
          id: "define-mcp-fixture",
          channel: "mcp",
          text: "hobo_read_resource_lifecycle_fixture({ fixtureId: 'rlq-define-object-graph-v1' })",
          fixtureId: "rlq-define-object-graph-v1",
          proofMode: "reference-fixture",
          safeClaim: "Lets an agent inspect the same fixture without hidden deploy authority.",
        },
      },
    },
    {
      phase: "collect",
      title: "Collect manifest IR",
      intent: "Lower authoring code into hobo.manifest/v1 with dependency edges and diagnostic labels.",
      snippets: {
        sdk: {
          id: "collect-sdk-manifest",
          channel: "sdk",
          text: "await bindle.collect({ fixtureId: 'rlq-define-object-graph-v1' })",
          fixtureId: "rlq-collect-manifest-ir-v1",
          proofMode: "simulated",
          safeClaim: "Collects the fixture into a manifest IR under mocked collector boundaries.",
        },
        cli: {
          id: "collect-cli-json",
          channel: "cli",
          text: "hobo collect ./examples/shop-api --fixture rlq-define-object-graph-v1 --json",
          fixtureId: "rlq-collect-manifest-ir-v1",
          proofMode: "simulated",
          safeClaim: "Shows manifest collection output without claiming a production CLI implementation.",
        },
        api: {
          id: "collect-api",
          channel: "api",
          text: "POST /draft/resource-lifecycle/collect { \"fixtureId\": \"rlq-define-object-graph-v1\" }",
          fixtureId: "rlq-collect-manifest-ir-v1",
          proofMode: "simulated",
          safeClaim: "Returns deterministic manifest IR for docs and tutorial reuse.",
        },
        mcp: {
          id: "collect-mcp",
          channel: "mcp",
          text: "hobo_collect({ fixtureId: 'rlq-define-object-graph-v1', output: 'manifest-ir' })",
          fixtureId: "rlq-collect-manifest-ir-v1",
          proofMode: "simulated",
          safeClaim: "Uses the same fixture contract as CLI and API collect snippets.",
        },
      },
    },
    {
      phase: "plan",
      title: "Plan deployability",
      intent: "Convert manifest IR into a DeploymentPlan, Gatekeeper decision, and Delta preview.",
      snippets: {
        sdk: {
          id: "plan-sdk-preview",
          channel: "sdk",
          text: "await hobo.plan({ fixtureId: 'rlq-collect-manifest-ir-v1', camp: 'preview' })",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          safeClaim: "Shows a plan preview against deterministic Gatekeeper and planner fixtures.",
        },
        cli: {
          id: "plan-cli-preview",
          channel: "cli",
          text: "hobo plan --fixture rlq-collect-manifest-ir-v1 --camp preview --json",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          safeClaim: "Emits the fixture DeploymentPlan, Gatekeeper receipt, and Delta preview.",
        },
        api: {
          id: "plan-api-preview",
          channel: "api",
          text: "POST /draft/resource-lifecycle/plans { \"fixtureId\": \"rlq-collect-manifest-ir-v1\", \"camp\": \"preview\" }",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          safeClaim: "Models the plan boundary without promising provider execution.",
        },
        mcp: {
          id: "plan-mcp-preview",
          channel: "mcp",
          text: "hobo_plan({ fixtureId: 'rlq-collect-manifest-ir-v1', camp: 'preview' })",
          fixtureId: "rlq-plan-safe-preview-v1",
          proofMode: "simulated",
          safeClaim: "Lets agents request the same preview while preserving approval boundaries.",
        },
      },
    },
    {
      phase: "deploy",
      title: "Deploy a simulated set",
      intent: "Accept a safe DeploymentPlan into a Deployment Set and ResourceActor event timeline.",
      snippets: {
        sdk: {
          id: "deploy-sdk-up",
          channel: "sdk",
          text: "await hobo.up({ planFixtureId: 'rlq-plan-safe-preview-v1', mode: 'simulated' })",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          safeClaim: "Shows the accepted deploy event sequence using mocked execution boundaries.",
        },
        cli: {
          id: "deploy-cli-up",
          channel: "cli",
          text: "hobo up --plan-fixture rlq-plan-safe-preview-v1 --mode simulated --json",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          safeClaim: "Demonstrates deploy flow without live providers or credentials.",
        },
        api: {
          id: "deploy-api-up",
          channel: "api",
          text: "POST /draft/resource-lifecycle/deployments { \"planFixtureId\": \"rlq-plan-safe-preview-v1\", \"mode\": \"simulated\" }",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          safeClaim: "Returns a simulated Deployment Set receipt and ResourceActor timeline.",
        },
        mcp: {
          id: "deploy-mcp-up",
          channel: "mcp",
          text: "hobo_up({ planFixtureId: 'rlq-plan-safe-preview-v1', mode: 'simulated' })",
          fixtureId: "rlq-deploy-run-accepted-v1",
          proofMode: "simulated",
          safeClaim: "Requires fixture approval evidence before agent-triggered deploy simulation.",
        },
      },
    },
    {
      phase: "inspect",
      title: "Inspect current state",
      intent: "Read event-derived projections and label stale or unknown evidence instead of implying success.",
      snippets: {
        sdk: {
          id: "inspect-sdk-projection",
          channel: "sdk",
          text: "await hobo.inspect.resource({ fixtureId: 'rlq-deploy-run-accepted-v1', resource: 'api' })",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          safeClaim: "Reads the checked-in projection fixture for the deployed API resource.",
        },
        cli: {
          id: "inspect-cli-run",
          channel: "cli",
          text: "hobo inspect run --fixture rlq-deploy-run-accepted-v1 --last --json",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          safeClaim: "Shows run and resource status from replayable fixture evidence.",
        },
        api: {
          id: "inspect-api-projection",
          channel: "api",
          text: "GET /draft/resource-lifecycle/projections/rlq-inspect-event-projection-v1/resources/api",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          safeClaim: "Returns a projection snapshot with freshness labels.",
        },
        mcp: {
          id: "inspect-mcp-run",
          channel: "mcp",
          text: "hobo_inspect_run({ fixtureId: 'rlq-deploy-run-accepted-v1', freshness: 'label-stale' })",
          fixtureId: "rlq-inspect-event-projection-v1",
          proofMode: "reference-fixture",
          safeClaim: "Lets agents inspect replay-derived state without treating unknown evidence as green.",
        },
      },
    },
    {
      phase: "manage",
      title: "Manage stale evidence",
      intent: "Show drift, stale projections, and doctor guidance as resource management evidence.",
      snippets: {
        sdk: {
          id: "manage-sdk-doctor",
          channel: "sdk",
          text: "await hobo.doctor({ fixtureId: 'rlq-inspect-event-projection-v1', focus: 'stale-projection' })",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          safeClaim: "Reports stale evidence as a managed condition, not a successful deploy.",
        },
        cli: {
          id: "manage-cli-doctor",
          channel: "cli",
          text: "hobo doctor --fixture rlq-inspect-event-projection-v1 --focus stale-projection",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          safeClaim: "Shows remediation guidance from the stale projection fixture.",
        },
        api: {
          id: "manage-api-doctor",
          channel: "api",
          text: "POST /draft/resource-lifecycle/doctor { \"fixtureId\": \"rlq-inspect-event-projection-v1\", \"focus\": \"stale-projection\" }",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          safeClaim: "Returns deterministic doctor findings for docs and troubleshooting.",
        },
        mcp: {
          id: "manage-mcp-doctor",
          channel: "mcp",
          text: "hobo_doctor({ fixtureId: 'rlq-inspect-event-projection-v1', focus: 'stale-projection' })",
          fixtureId: "rlq-manage-stale-evidence-v1",
          proofMode: "reference-fixture",
          safeClaim: "Lets agents surface the same safe remediation without inventing dashboard actions.",
        },
      },
    },
    {
      phase: "migrate",
      title: "Migrate brownfield resources",
      intent: "Preview brownfield import and migration events before any deploy-like action.",
      snippets: {
        sdk: {
          id: "migrate-sdk-import",
          channel: "sdk",
          text: "await hobo.importTerraform({ fixtureId: 'rlq-brownfield-terraform-v1', dryRun: true })",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          safeClaim: "Produces migration.* preview events without adopting live infrastructure.",
        },
        cli: {
          id: "migrate-cli-import",
          channel: "cli",
          text: "hobo import terraform ./infra --fixture rlq-brownfield-terraform-v1 --dry-run --json",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          safeClaim: "Shows import/adopt preview output that must feed plan before deploy.",
        },
        api: {
          id: "migrate-api-import",
          channel: "api",
          text: "POST /draft/resource-lifecycle/migrations/preview { \"fixtureId\": \"rlq-brownfield-terraform-v1\" }",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          safeClaim: "Returns migration preview events and a blocked deploy handoff.",
        },
        mcp: {
          id: "migrate-mcp-import",
          channel: "mcp",
          text: "hobo_import_terraform({ fixtureId: 'rlq-brownfield-terraform-v1', dryRun: true })",
          fixtureId: "rlq-migrate-brownfield-preview-v1",
          proofMode: "simulated",
          safeClaim: "Lets agents inspect migration preview evidence without adoption authority.",
        },
      },
    },
    {
      phase: "recover",
      title: "Recover from a safe snapshot",
      intent: "Use snapshot and rollback fixtures to show recovery paths and explicit launch-demo boundaries.",
      snippets: {
        sdk: {
          id: "recover-sdk-snapshot",
          channel: "sdk",
          text: "await hobo.recover({ fixtureId: 'rlq-recover-snapshot-restore-v1', mode: 'preview' })",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "reference-fixture",
          safeClaim: "Shows recovery preview from a fixture snapshot, not a live restore.",
        },
        cli: {
          id: "recover-cli-rollback",
          channel: "cli",
          text: "hobo up --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1 --dry-run",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "reference-fixture",
          safeClaim: "Documents rollback preview using replayable Deployment Set evidence.",
        },
        api: {
          id: "recover-api-live-boundary",
          channel: "api",
          text: "GET /draft/resource-lifecycle/live-boundary/rlq-recover-snapshot-restore-v1",
          fixtureId: "rlq-recover-snapshot-restore-v1",
          proofMode: "live",
          safeClaim: "Marks future live restore as optional and gated by credentials, release, and policy reviews.",
        },
        mcp: {
          id: "recover-mcp-scope-out",
          channel: "mcp",
          text: "hobo_quickstart_scope_out({ boundary: 'no-production-restore-or-dashboard-tour' })",
          fixtureId: "rlq-recover-scope-out-v1",
          proofMode: "scope-out",
          safeClaim: "Explicitly prevents docs, agents, and demos from claiming production restore or broad dashboard behavior.",
        },
      },
    },
  ],
  handoffs: [
    {
      consumer: "Docs Portal",
      use: "Use the phase-ordered snippets as the canonical quickstart page source.",
      fixtureIds: [
        "rlq-define-object-graph-v1",
        "rlq-collect-manifest-ir-v1",
        "rlq-plan-safe-preview-v1",
        "rlq-deploy-run-accepted-v1",
      ],
      handoffNote: "Preserve proof-mode labels beside every snippet and link to the proof note.",
      mustNotClaim: ["production docs publication", "live provider support"],
    },
    {
      consumer: "Tutorials",
      use: "Turn define, collect, plan, deploy, inspect, manage, migrate, and recover into tutorial checkpoints.",
      fixtureIds: [
        "rlq-collect-manifest-ir-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-migrate-brownfield-preview-v1",
      ],
      handoffNote: "Keep simulated steps separate from future live setup instructions.",
      mustNotClaim: ["real credentials", "customer data"],
    },
    {
      consumer: "Troubleshooting",
      use: "Reuse stale evidence, Gatekeeper, doctor, rollback, and migration preview fixtures.",
      fixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-recover-snapshot-restore-v1",
      ],
      handoffNote: "Troubleshooting can cite fixture failures and recovery preview only.",
      mustNotClaim: ["support automation", "live incident response"],
    },
    {
      consumer: "Launch Site",
      use: "Extract safe claims and launch demo labels from the quickstart contract.",
      fixtureIds: ["rlq-deploy-run-accepted-v1", "rlq-recover-scope-out-v1"],
      handoffNote: "Launch copy must stay within the safeClaims list and must cite proof modes.",
      mustNotClaim: ["customer promises", "unsupported launch claims"],
    },
    {
      consumer: "Workspace UX",
      use: "Use fixture ids as state names for mocked onboarding and workspace walkthroughs.",
      fixtureIds: [
        "rlq-define-object-graph-v1",
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
      ],
      handoffNote: "Workspace UX may show fixture state labels but cannot invent runtime behavior.",
      mustNotClaim: ["production workspace state", "live tenant data"],
    },
    {
      consumer: "Plan/Diff",
      use: "Consume plan, Delta, migration preview, stale evidence, and rollback fixtures.",
      fixtureIds: [
        "rlq-plan-safe-preview-v1",
        "rlq-migrate-brownfield-preview-v1",
        "rlq-recover-snapshot-restore-v1",
      ],
      handoffNote: "Plan/Diff surfaces must show preview and blocked states before deploy claims.",
      mustNotClaim: ["live applies", "unreviewed adoption"],
    },
    {
      consumer: "Dashboard",
      use: "Reuse inspect and manage fixture ids for mockup topology and status cards.",
      fixtureIds: [
        "rlq-inspect-event-projection-v1",
        "rlq-manage-stale-evidence-v1",
        "rlq-recover-scope-out-v1",
      ],
      handoffNote: "Dashboard mockups must cite these fixture ids and avoid enterprise feature tours.",
      mustNotClaim: ["enterprise dashboard feature tours", "invented topology behavior"],
    },
  ],
} as const satisfies UnparsedResourceLifecycleQuickstartExamples;

export type QuickstartScopeDecision =
  | { readonly allowed: true; readonly reason: "quickstart-fixture" }
  | {
      readonly allowed: false;
      readonly reason:
        | "customer-promise"
        | "live-credential"
        | "production-publication"
        | "enterprise-dashboard-tour"
        | "unbacked-marketing";
    };

export function classifyQuickstartScope(proposal: string): QuickstartScopeDecision {
  const normalized = proposal.toLowerCase();

  if (/customer promise|guarantee.*customer|customer data|tenant data/.test(normalized)) {
    return { allowed: false, reason: "customer-promise" };
  }
  if (/live credential|real credential|secret|aws key|azure credential|gcp credential/.test(normalized)) {
    return { allowed: false, reason: "live-credential" };
  }
  if (/production docs publication|publish.*production docs|public docs/.test(normalized)) {
    return { allowed: false, reason: "production-publication" };
  }
  if (/enterprise dashboard feature tour|dashboard tour|feature tour/.test(normalized)) {
    return { allowed: false, reason: "enterprise-dashboard-tour" };
  }
  if (/marketing copy|launch claim|claim.*without.*transcript/.test(normalized)) {
    return { allowed: false, reason: "unbacked-marketing" };
  }

  return { allowed: true, reason: "quickstart-fixture" };
}

export function parseResourceLifecycleQuickstartExamples(
  quickstart: JsonValue,
): ResourceLifecycleQuickstartExamples {
  assertObject(quickstart, "quickstart");
  assertLiteral(quickstart.issue, "HOBO-577", "issue");
  assertLiteral(quickstart.phase, "M2", "phase");
  assertLiteral(
    quickstart.targetPackage,
    "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples",
    "targetPackage",
  );
  assertLiteral(
    quickstart.proofNote,
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    "proofNote",
  );
  assertNonEmptyStringArray(quickstart.designRefs, "designRefs");
  assertScopeOut(quickstart.scopeOut);
  assertNonEmptyStringArray(quickstart.safeClaims, "safeClaims");
  assertModeNotes(quickstart.modeNotes);

  const steps = assertStepArray(quickstart.steps);
  const handoffs = assertHandoffArray(quickstart.handoffs);
  assertPhaseCoverage(steps);
  assertConsumerCoverage(handoffs);
  // SAFETY: `assertSafeClaims(steps, quickstart.safeClaims as readonly string[]);` is required at this I/O or test boundary.
  assertSafeClaims(steps, quickstart.safeClaims as readonly string[]);

  return {
    // SAFETY: `...(quickstart as UnparsedResourceLifecycleQuickstartExamples),` is required at this I/O or test boundary.
    ...(quickstart as UnparsedResourceLifecycleQuickstartExamples),
    __brand: "ParsedResourceLifecycleQuickstartExamples",
  };
}

export function listQuickstartSnippets(
  quickstart: ResourceLifecycleQuickstartExamples,
): readonly ResourceLifecycleQuickstartSnippet[] {
  return quickstart.steps.flatMap((step) => QUICKSTART_CHANNELS.map((channel) => step.snippets[channel]));
}

export function summarizeQuickstartHandoffs(
  quickstart: ResourceLifecycleQuickstartExamples,
): ReadonlyArray<{
  readonly consumer: QuickstartConsumer;
  readonly fixtureIds: readonly string[];
  readonly mustNotClaim: readonly string[];
}> {
  return quickstart.handoffs.map((handoff) => ({
    consumer: handoff.consumer,
    fixtureIds: handoff.fixtureIds,
    mustNotClaim: handoff.mustNotClaim,
  }));
}

function assertObject(value: JsonValue, name: string): asserts value is JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertLiteral<T extends string>(value: JsonValue, expected: T, name: string): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${name} must be ${expected}`);
  }
}

function assertStringArray(value: JsonValue, name: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry))) {
    throw new TypeError(`${name} must be a string array`);
  }

  return value;
}

function assertNonEmptyStringArray(value: JsonValue, name: string): void {
  const entries = assertStringArray(value, name);
  if (entries.length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertScopeOut(value: JsonValue): void {
  const scopeOut = assertStringArray(value, "scopeOut");
  for (const expected of standardScopeOut) {
    if (!scopeOut.includes(expected)) {
      throw new TypeError(`scopeOut missing ${expected}`);
    }
  }
}

function assertModeNotes(value: JsonValue): void {
  if (!Array.isArray(value)) {
    throw new TypeError("modeNotes must be an array");
  }

  const modes = new Set<QuickstartProofMode>();
  for (const [index, entry] of value.entries()) {
    assertObject(entry, `modeNote ${index}`);
    assertProofMode(entry.proofMode);
    assertNonEmptyString(entry.meaning, `modeNote ${index}.meaning`);
    assertNonEmptyString(entry.docsLabel, `modeNote ${index}.docsLabel`);
    modes.add(entry.proofMode);
  }

  for (const mode of QUICKSTART_PROOF_MODES) {
    if (!modes.has(mode)) {
      throw new TypeError(`modeNotes missing ${mode}`);
    }
  }
}

function assertStepArray(value: JsonValue): ResourceLifecycleQuickstartStep[] {
  if (!Array.isArray(value)) {
    throw new TypeError("steps must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `step ${index}`);
    assertPhase(entry.phase);
    assertNonEmptyString(entry.title, `${entry.phase}.title`);
    assertNonEmptyString(entry.intent, `${entry.phase}.intent`);
    const snippets = assertSnippetRecord(entry.snippets, entry.phase);

    return {
      phase: entry.phase,
      title: entry.title,
      intent: entry.intent,
      snippets,
    };
  });
}

interface QuickstartSnippetRecord {
  readonly sdk: ResourceLifecycleQuickstartSnippet;
  readonly cli: ResourceLifecycleQuickstartSnippet;
  readonly api: ResourceLifecycleQuickstartSnippet;
  readonly mcp: ResourceLifecycleQuickstartSnippet;
}

interface QuickstartSnippetBag {
  sdk?: ResourceLifecycleQuickstartSnippet;
  cli?: ResourceLifecycleQuickstartSnippet;
  api?: ResourceLifecycleQuickstartSnippet;
  mcp?: ResourceLifecycleQuickstartSnippet;
}

function assertSnippetRecord(
  value: JsonValue,
  phase: QuickstartPhase,
): QuickstartSnippetRecord {
  assertObject(value, `${phase}.snippets`);
  const snippets: QuickstartSnippetBag = {};

  for (const channel of QUICKSTART_CHANNELS) {
    const snippet = value[channel];
    assertObject(snippet, `${phase}.${channel}`);
    assertLiteral(snippet.channel, channel, `${phase}.${channel}.channel`);
    assertNonEmptyString(snippet.id, `${phase}.${channel}.id`);
    assertNonEmptyString(snippet.text, `${phase}.${channel}.text`);
    assertFixtureId(snippet.fixtureId, `${phase}.${channel}.fixtureId`);
    assertProofMode(snippet.proofMode);
    assertNonEmptyString(snippet.safeClaim, `${phase}.${channel}.safeClaim`);
    // SAFETY: `snippets[channel] = snippet as ResourceLifecycleQuickstartSnippet;` is required at this I/O or test boundary.
    snippets[channel] = snippet as ResourceLifecycleQuickstartSnippet;
  }

  if (!snippets.sdk || !snippets.cli || !snippets.api || !snippets.mcp) {
    throw new TypeError(`${phase}.snippets must cover sdk, cli, api, and mcp`);
  }

  return {
    sdk: snippets.sdk,
    cli: snippets.cli,
    api: snippets.api,
    mcp: snippets.mcp,
  };
}

function assertHandoffArray(value: JsonValue): ResourceLifecycleQuickstartHandoff[] {
  if (!Array.isArray(value)) {
    throw new TypeError("handoffs must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `handoff ${index}`);
    assertConsumer(entry.consumer);
    assertNonEmptyString(entry.use, `${entry.consumer}.use`);
    assertNonEmptyString(entry.handoffNote, `${entry.consumer}.handoffNote`);
    assertNonEmptyStringArray(entry.fixtureIds, `${entry.consumer}.fixtureIds`);
    assertNonEmptyStringArray(entry.mustNotClaim, `${entry.consumer}.mustNotClaim`);
    // SAFETY: `for (const fixtureId of entry.fixtureIds as readonly string[]) {` is required at this I/O or test boundary.
    for (const fixtureId of entry.fixtureIds as readonly string[]) {
      assertFixtureId(fixtureId, `${entry.consumer}.fixtureIds`);
    }

    // SAFETY: `return entry as ResourceLifecycleQuickstartHandoff;` is required at this I/O or test boundary.
    return entry as ResourceLifecycleQuickstartHandoff;
  });
}

function assertPhaseCoverage(steps: readonly ResourceLifecycleQuickstartStep[]): void {
  const phases = steps.map((step) => step.phase);
  for (const phase of QUICKSTART_PHASES) {
    if (!phases.includes(phase)) {
      throw new TypeError(`missing quickstart phase ${phase}`);
    }
  }
  if (new Set(phases).size !== phases.length) {
    throw new TypeError("quickstart phases must be unique");
  }
}

function assertConsumerCoverage(handoffs: readonly ResourceLifecycleQuickstartHandoff[]): void {
  const consumers = new Set(handoffs.map((handoff) => handoff.consumer));
  for (const consumer of QUICKSTART_CONSUMERS) {
    if (!consumers.has(consumer)) {
      throw new TypeError(`missing handoff consumer ${consumer}`);
    }
  }
  if (consumers.size !== handoffs.length) {
    throw new TypeError("handoff consumers must be unique");
  }
}

function assertSafeClaims(
  steps: readonly ResourceLifecycleQuickstartStep[],
  safeClaims: readonly string[],
): void {
  const combinedClaims = [
    ...safeClaims,
    ...steps.flatMap((step) => QUICKSTART_CHANNELS.map((channel) => step.snippets[channel].safeClaim)),
  ];

  for (const claim of combinedClaims) {
    const decision = classifyQuickstartScope(claim);
    if (!decision.allowed) {
      throw new TypeError(`unsafe quickstart claim: ${decision.reason}`);
    }
  }
}

function assertPhase(value: JsonValue): asserts value is QuickstartPhase {
  // SAFETY: `if (!QUICKSTART_PHASES.includes(value as QuickstartPhase)) {` is required at this I/O or test boundary.
  if (!QUICKSTART_PHASES.includes(value as QuickstartPhase)) {
    throw new TypeError(`unknown quickstart phase ${String(value)}`);
  }
}

function assertConsumer(value: JsonValue): asserts value is QuickstartConsumer {
  // SAFETY: `if (!QUICKSTART_CONSUMERS.includes(value as QuickstartConsumer)) {` is required at this I/O or test boundary.
  if (!QUICKSTART_CONSUMERS.includes(value as QuickstartConsumer)) {
    throw new TypeError(`unknown quickstart consumer ${String(value)}`);
  }
}

function assertProofMode(value: JsonValue): asserts value is QuickstartProofMode {
  // SAFETY: `if (!QUICKSTART_PROOF_MODES.includes(value as QuickstartProofMode)) {` is required at this I/O or test boundary.
  if (!QUICKSTART_PROOF_MODES.includes(value as QuickstartProofMode)) {
    throw new TypeError(`unsupported proof mode ${String(value)}`);
  }
}

function assertFixtureId(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || !/^rlq-[a-z0-9-]+-v[0-9]+$/.test(value)) {
    throw new TypeError(`${name} must be a resource lifecycle quickstart fixture id`);
  }
}

function assertNonEmptyString(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
}
