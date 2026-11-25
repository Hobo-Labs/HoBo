const REQUIRED_CHILD_SCENARIOS = [
  "happy path",
  "blocked path",
  "stale/unknown evidence path",
  "support handoff",
  "accessibility notes",
] as const;

const REQUIRED_PROOF_MODES = ["live", "simulated", "reference fixture", "scope-out"] as const;

const REQUIRED_DX_LABELS = ["dx-first", "api", "sdk", "cli", "contract"] as const;

const FORBIDDEN_SCOPE_PATTERNS = [
  /live provider calls?/i,
  /production ui/i,
  /production (cli|api|sdk)/i,
  /customer data/i,
  /real credentials?/i,
  /launch claims?/i,
  /publish final/i,
  /implement the product/i,
];

const REQUIRED_SCOPE_OUT_GUARDS = [
  /live provider calls?/i,
  /production ui/i,
  /production (cli|api|sdk)/i,
  /customer data/i,
  /real credentials?/i,
  /launch claims?/i,
];

const ALLOWED_ARTIFACTS = new Set([
  "mockups",
  "wireframes",
  "state model",
  "storyboard",
  "script",
  "pseudocode",
  "fixtures",
  "copy states",
  "decision trees",
  "tutorial outline",
  "transcript",
  "recording manifest",
  "asset map",
  "clickable prototype",
  "reference prototype",
  "acceptance checklist",
  "representative checks",
]);

export type VibeChildPhase = "M1" | "M2" | "M5";

// domain-view: readonly parse-produced report shape; its wire form is the vibe backlog proto message of the same name.
export interface VibeChildIssue {
  id: string;
  title: string;
  project: string;
  phase: VibeChildPhase;
  estimate: 3 | 5;
  targetPackagePath: `src/draft/exp-proofs/${string}`;
  proofNotePath: `docs/design/proofs/${string}/README.md`;
  artifactSlices: string[];
  requiredScenarios: string[];
  proofModes: string[];
  sourceDesignDocs: string[];
  scopeOut: string[];
}

// domain-view: readonly parse-produced report shape; its wire form is the vibe backlog proto message of the same name.
export interface VibeGapClosureBacklog {
  parentIssue: "HOBO-539";
  parentTitle: string;
  dxBackbone: VibeDxBackboneGraph;
  childIssues: VibeChildIssue[];
  unblockRule: string;
}

export type DxPhase = "M1" | "M2";

// domain-view: readonly parse-produced report shape; its wire form is the vibe backlog proto message of the same name.
export interface VibeDxSliceIssue {
  id: string;
  title: string;
  parentId: "HOBO-566";
  project: "CLI, MCP & Developer Experience";
  phase: DxPhase;
  estimate: 3 | 5 | 8;
  labels: string[];
  targetPackagePath: `src/draft/exp-proofs/${string}`;
  proofNotePath: `docs/design/proofs/${string}/README.md`;
  blockedBy: string[];
  blocks: string[];
  lifecycleCoverage: string[];
  proofModes: string[];
  scopeOut: string[];
}

// domain-view: readonly parse-produced report shape; its wire form is the vibe backlog proto message of the same name.
export interface VibeDxBackboneGraph {
  parentIssue: "HOBO-539";
  backboneIssue: {
    id: "HOBO-566";
    parentId: "HOBO-539";
    project: "CLI, MCP & Developer Experience";
    labels: string[];
  };
  childSlices: VibeDxSliceIssue[];
  quickstartConsumerIds: string[];
  terminalErrorConsumer: {
    id: "HOBO-558";
    blockedBy: string[];
  };
}

export const DX_BACKBONE_GRAPH: VibeDxBackboneGraph = {
  parentIssue: "HOBO-539",
  backboneIssue: {
    id: "HOBO-566",
    parentId: "HOBO-539",
    project: "CLI, MCP & Developer Experience",
    labels: ["contract", "cli", "sdk", "api", "dx-first", "epic", "hcd", "persona-driven"],
  },
  childSlices: [
    dxSlice("HOBO-567", "DX scenario matrix for deploy, manage, and migrate resources", "M1", 3, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "dx-resource-lifecycle-scenario-matrix", [], ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "api",
      "sdk",
      "cli",
      "mcp",
      "deploy",
      "manage",
      "migrate",
      "rollback",
      "support",
    ]),
    dxSlice("HOBO-568", "@hobo/bindles SDK object graph and manifest IR consumer examples", "M1", 5, [
      "contract",
      "sdk",
      "api",
      "dx-first",
      "slice",
    ], "sdk-object-graph-manifest-ir-shapes", [], ["HOBO-573", "HOBO-575", "HOBO-576"], [
      "sdk",
      "api",
      "deploy",
      "manage",
      "migrate",
    ]),
    dxSlice("HOBO-569", "control-plane API shapes for DeploymentPlan, DeploymentSet, Delta, and migration", "M1", 5, [
      "contract",
      "api",
      "dx-first",
      "slice",
    ], "control-plane-api-resource-lifecycle-shapes", [], ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "api",
      "mcp",
      "cli",
      "deploy",
      "manage",
      "migrate",
      "rollback",
      "support",
    ]),
    dxSlice("HOBO-570", "CLI/MCP parity contracts for plan, up, collect, inspect, logs, doctor", "M1", 5, [
      "contract",
      "cli",
      "api",
      "dx-first",
      "slice",
    ], "cli-mcp-parity-resource-lifecycle-contracts", [], ["HOBO-558", "HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "cli",
      "mcp",
      "plan",
      "up",
      "collect",
      "inspect",
      "logs",
      "doctor",
      "migrate",
    ]),
    dxSlice("HOBO-571", "typed result, gate, refusal, and proof-mode envelope examples", "M1", 3, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "slice",
    ], "dx-result-refusal-proof-envelopes", [], ["HOBO-558", "HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "api",
      "sdk",
      "cli",
      "mcp",
      "refusal",
      "proof-mode",
      "support",
    ]),
    dxSlice("HOBO-572", "deterministic resource lifecycle fixture corpus for DX examples", "M1", 5, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "slice",
    ], "dx-resource-lifecycle-fixture-corpus", [], ["HOBO-558", "HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "api",
      "sdk",
      "cli",
      "mcp",
      "fixture",
      "deploy",
      "manage",
      "migrate",
      "rollback",
      "support",
    ]),
    dxSlice("HOBO-573", "CLI deploy transcript prototype over DeploymentPlan and Gatekeeper fixtures", "M2", 5, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "cli-deploy-transcript-prototype", ["HOBO-567", "HOBO-568", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"], ["HOBO-577"], [
      "cli",
      "mcp",
      "deploy",
      "blocked",
      "stale",
      "support",
    ]),
    dxSlice("HOBO-574", "CLI manage transcript prototype for inspect, logs, drift, and support bundles", "M2", 5, [
      "contract",
      "cli",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "cli-manage-inspect-logs-drift-prototype", ["HOBO-567", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"], ["HOBO-577"], [
      "cli",
      "mcp",
      "manage",
      "inspect",
      "logs",
      "drift",
      "support",
    ]),
    dxSlice("HOBO-575", "CLI migration transcript prototype for import, adopt-in-place, expand/backfill/contract, cutover", "M2", 8, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "cli-migration-transcript-prototype", ["HOBO-567", "HOBO-568", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"], ["HOBO-577"], [
      "cli",
      "api",
      "sdk",
      "mcp",
      "migrate",
      "rollback",
      "blocked",
    ]),
    dxSlice("HOBO-576", "SDK-to-CLI golden path compile consumer and terminal transcript", "M2", 5, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "sdk-to-cli-golden-path", ["HOBO-567", "HOBO-568", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"], ["HOBO-577"], [
      "sdk",
      "cli",
      "api",
      "mcp",
      "deploy",
      "blocked",
      "stale",
      "support",
    ]),
    dxSlice("HOBO-577", "resource lifecycle quickstart examples for docs, tutorials, and launch demo", "M2", 5, [
      "contract",
      "cli",
      "sdk",
      "api",
      "dx-first",
      "user-story",
      "slice",
    ], "resource-lifecycle-quickstart-examples", ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], [
      "HOBO-540",
      "HOBO-541",
      "HOBO-542",
      "HOBO-543",
      "HOBO-544",
      "HOBO-545",
      "HOBO-546",
      "HOBO-547",
      "HOBO-548",
      "HOBO-549",
      "HOBO-550",
      "HOBO-551",
      "HOBO-552",
      "HOBO-553",
      "HOBO-554",
      "HOBO-555",
      "HOBO-556",
      "HOBO-557",
      "HOBO-559",
      "HOBO-560",
      "HOBO-561",
      "HOBO-562",
      "HOBO-563",
      "HOBO-564",
      "HOBO-565",
    ], [
      "sdk",
      "cli",
      "api",
      "mcp",
      "quickstart",
      "deploy",
      "manage",
      "migrate",
      "rollback",
      "support",
    ]),
  ],
  quickstartConsumerIds: [
    "HOBO-540",
    "HOBO-541",
    "HOBO-542",
    "HOBO-543",
    "HOBO-544",
    "HOBO-545",
    "HOBO-546",
    "HOBO-547",
    "HOBO-548",
    "HOBO-549",
    "HOBO-550",
    "HOBO-551",
    "HOBO-552",
    "HOBO-553",
    "HOBO-554",
    "HOBO-555",
    "HOBO-556",
    "HOBO-557",
    "HOBO-559",
    "HOBO-560",
    "HOBO-561",
    "HOBO-562",
    "HOBO-563",
    "HOBO-564",
    "HOBO-565",
  ],
  terminalErrorConsumer: {
    id: "HOBO-558",
    blockedBy: ["HOBO-570", "HOBO-571", "HOBO-572"],
  },
};

export const VIBE_GAP_CLOSURE_BACKLOG: VibeGapClosureBacklog = {
  parentIssue: "HOBO-539",
  parentTitle: "Epic: Close v1 vibe gaps with DX-first API, SDK, and CLI resource lifecycle examples",
  unblockRule:
    "HOBO-539 can move to Done after this proof shows the DX-first backbone exists, M1 shape slices block M2 transcript/prototype work, quickstart examples block downstream artifact slices, and scope-out guards reject production/runtime creep.",
  dxBackbone: DX_BACKBONE_GRAPH,
  childIssues: [
    child("HOBO-540", "first-run activation rail mockups and state model", "Workspace & Onboarding UX", "M1", 3, [
      "mockups",
      "state model",
    ], ["docs/design/workspace-onboarding-ux.md", "docs/design/outcome-activation-rail.md"]),
    child("HOBO-541", "workspace/project empty, blocked, recovery, and value-proof states", "Workspace & Onboarding UX", "M1", 3, [
      "mockups",
      "state model",
    ], ["docs/design/workspace-onboarding-ux.md"]),
    child("HOBO-542", "plan review mockups for safe, blocked, destructive, stale, and unknown evidence", "Plan/Diff Viewer", "M1", 3, [
      "mockups",
      "wireframes",
    ], ["docs/design/plan-diff-viewer.md"]),
    child("HOBO-543", "policy, cost, capacity, and approval annotation pseudocode", "Plan/Diff Viewer", "M1", 3, [
      "pseudocode",
      "fixtures",
    ], ["docs/design/plan-diff-viewer.md", "docs/design/contracts-policy-flags.md#plan-29"]),
    child("HOBO-544", "deployment timeline, topology graph, run inspector, and health rollup mockups", "Deployment Dashboard & Topology Explorer", "M1", 3, [
      "mockups",
      "wireframes",
    ], ["docs/design/deployment-dashboard-topology-explorer.md", "docs/design/developer-experience.md#plan-07"]),
    child("HOBO-545", "projection freshness, tenant/RBAC, and support handoff fixtures", "Deployment Dashboard & Topology Explorer", "M1", 3, [
      "fixtures",
      "state model",
    ], ["docs/design/deployment-dashboard-topology-explorer.md", "docs/design/data-plane.md#plan-32"]),
    child("HOBO-546", "browse/search/detail/installability mockups", "Marketplace UX", "M1", 3, [
      "mockups",
      "wireframes",
    ], ["docs/design/marketplace-ux.md"]),
    child("HOBO-547", "trust warning, org-catalog filter, deprecation, and yank copy states", "Marketplace UX", "M1", 3, [
      "copy states",
      "fixtures",
    ], ["docs/design/marketplace-ux.md", "docs/design/org-catalogs.md"]),
    child("HOBO-548", "publisher submission, evidence upload, review, rejection, and yank remediation mockups", "Publisher Portal", "M1", 3, [
      "mockups",
      "wireframes",
    ], ["docs/design/publisher-portal.md", "docs/design/marketplace-publisher-trust-evidence.md"]),
    child("HOBO-549", "first-customer pilot storyboard and script artifacts", "Customer Onboarding", "M1", 3, [
      "storyboard",
      "script",
    ], ["docs/design/customer-onboarding.md"]),
    child("HOBO-550", "support intake, triage, owner-route, and customer update mockups", "Support Workflow", "M1", 3, [
      "mockups",
      "wireframes",
    ], ["docs/design/support-workflow.md", "docs/design/launch-support-escalation.md"]),
    child("HOBO-551", "docs IA, audience paths, search metadata, and stale-content states", "Docs Portal", "M1", 3, [
      "fixtures",
      "state model",
    ], ["docs/design/docs-portal.md"]),
    child("HOBO-552", "app developer, platform engineer, GitOps, SecOps, DevOps, and SRE tutorial outlines", "Tutorials & Walkthroughs", "M1", 3, [
      "tutorial outline",
      "fixtures",
    ], ["docs/design/tutorials-walkthroughs.md", "docs/design/walkthrough.md"]),
    child("HOBO-553", "diagnostic decision trees for install, auth, plan, deploy, policy, and support failures", "Troubleshooting Guides", "M1", 3, [
      "decision trees",
      "fixtures",
    ], ["docs/design/troubleshooting-guides.md", "docs/design/support-debug-tools.md"]),
    child("HOBO-554", "accessibility/usability acceptance checklist for every vibe artifact", "Accessibility & Usability Quality", "M1", 3, [
      "acceptance checklist",
      "representative checks",
    ], ["docs/design/accessibility-usability-launch-baseline.md"]),
    child("HOBO-555", "snapshot launch demo storyboard and proof-mode asset map", "V1 Launch Site, Messaging & Demo Assets", "M5", 3, [
      "storyboard",
      "asset map",
    ], ["docs/design/launch-demo-golden-path.md", "docs/design/launch-messaging-claims.md"]),
    child("HOBO-556", "screenshot, recording manifest, command transcript, and fixture refresh plan", "V1 Launch Site, Messaging & Demo Assets", "M5", 3, [
      "recording manifest",
      "transcript",
      "fixtures",
    ], ["docs/design/launch-demo-golden-path.md", "docs/design/launch-messaging-claims.md"]),
    child("HOBO-557", "CLI transcript and MCP tool pseudocode examples for six role journeys", "CLI, MCP & Developer Experience", "M1", 3, [
      "transcript",
      "pseudocode",
    ], ["docs/design/cli-spec.md", "docs/design/developer-experience.md#plan-07", "docs/design/walkthrough.md"]),
    child("HOBO-558", "error/refusal UX examples for doctor, plan, up, inspect, logs, and MCP actions", "CLI, MCP & Developer Experience", "M1", 3, [
      "copy states",
      "fixtures",
    ], ["docs/design/cli-spec.md", "docs/design/troubleshooting-guides.md"]),
    child("HOBO-559", "clickable first-run walkthrough with snapshot fixtures", "Workspace & Onboarding UX", "M2", 5, [
      "clickable prototype",
      "fixtures",
    ], ["docs/design/workspace-onboarding-ux.md", "docs/design/worked-example.md#plan-19"]),
    child("HOBO-560", "deterministic plan/diff review prototype over golden fixtures", "Plan/Diff Viewer", "M2", 5, [
      "reference prototype",
      "fixtures",
    ], ["docs/design/plan-diff-viewer.md"]),
    child("HOBO-561", "topology/status prototype over projection snapshots", "Deployment Dashboard & Topology Explorer", "M2", 5, [
      "reference prototype",
      "fixtures",
    ], ["docs/design/deployment-dashboard-topology-explorer.md", "docs/design/data-plane.md#plan-32"]),
    child("HOBO-562", "deterministic marketplace discovery and install-intent prototype", "Marketplace UX", "M2", 5, [
      "reference prototype",
      "fixtures",
    ], ["docs/design/marketplace-ux.md", "docs/design/org-catalogs.md"]),
    child("HOBO-563", "pilot workspace-to-first-proof walkthrough with blocker routing", "Customer Onboarding", "M2", 5, [
      "clickable prototype",
      "fixtures",
    ], ["docs/design/customer-onboarding.md", "docs/design/workspace-onboarding-ux.md"]),
    child("HOBO-564", "support case prototype with redacted evidence pack", "Support Workflow", "M2", 5, [
      "reference prototype",
      "fixtures",
    ], ["docs/design/support-workflow.md", "docs/design/support-debug-tools.md"]),
    child("HOBO-565", "representative keyboard, screen-reader, responsive, contrast, and copy checks", "Accessibility & Usability Quality", "M2", 5, [
      "representative checks",
      "fixtures",
    ], ["docs/design/accessibility-usability-launch-baseline.md"]),
  ],
};

export function evaluateVibeGapClosure(backlog: VibeGapClosureBacklog = VIBE_GAP_CLOSURE_BACKLOG) {
  const violations: string[] = [];
  const dxResult = evaluateDxBackboneGraph(backlog.dxBackbone);
  violations.push(...dxResult.violations);

  if (backlog.parentIssue !== "HOBO-539") {
    violations.push("parent issue must be HOBO-539");
  }
  if (backlog.childIssues.length !== 26) {
    violations.push(`expected 26 child artifact issues, got ${backlog.childIssues.length}`);
  }

  const seen = new Set<string>();
  const childIds = new Set<string>();
  for (const issue of backlog.childIssues) {
    if (seen.has(issue.id)) {
      violations.push(`${issue.id} is duplicated`);
    }
    seen.add(issue.id);
    childIds.add(issue.id);

    if (!issue.targetPackagePath.startsWith("src/draft/exp-proofs/")) {
      violations.push(`${issue.id} must target src/draft/exp-proofs/<type>/<slug>`);
    }
    if (!issue.proofNotePath.startsWith(`docs/design/proofs/${issue.id.toLowerCase()}-`)) {
      violations.push(`${issue.id} proof note must live under docs/design/proofs/<issue-slug>/`);
    }
    if (issue.artifactSlices.length === 0 || issue.artifactSlices.some((slice) => !ALLOWED_ARTIFACTS.has(slice))) {
      violations.push(`${issue.id} must target branch-sized artifact slices`);
    }
    for (const scenario of REQUIRED_CHILD_SCENARIOS) {
      if (!issue.requiredScenarios.includes(scenario)) {
        violations.push(`${issue.id} missing scenario coverage: ${scenario}`);
      }
    }
    for (const mode of REQUIRED_PROOF_MODES) {
      if (!issue.proofModes.includes(mode)) {
        violations.push(`${issue.id} missing proof mode label: ${mode}`);
      }
    }
    if (issue.project === "V1 Launch Site, Messaging & Demo Assets" && issue.phase !== "M5") {
      violations.push(`${issue.id} launch-demo issue must use M5 vibe refresh phase`);
    }
    if (issue.project !== "V1 Launch Site, Messaging & Demo Assets" && issue.phase === "M5") {
      violations.push(`${issue.id} non-launch issue must not use M5 vibe refresh phase`);
    }
    if (issue.sourceDesignDocs.length === 0) {
      violations.push(`${issue.id} must cite at least one design source`);
    }
    const forbiddenScope = findForbiddenScope(issue.scopeOut);
    if (forbiddenScope.length < REQUIRED_SCOPE_OUT_GUARDS.length) {
      violations.push(`${issue.id} scope-out guard must cover provider, UI, CLI/API/SDK, data, credential, and launch-claim creep`);
    }
  }

  const expectedQuickstartConsumers = new Set([...childIds].filter((id) => id !== backlog.dxBackbone.terminalErrorConsumer.id));
  assertSetEquals(
    backlog.dxBackbone.quickstartConsumerIds,
    [...expectedQuickstartConsumers],
    "HOBO-577 downstream child consumers",
    violations,
  );

  return {
    ok: violations.length === 0,
    violations,
    summary: {
      parentIssue: backlog.parentIssue,
      childCount: backlog.childIssues.length,
      phases: countBy(backlog.childIssues.map((issue) => issue.phase)),
      projects: countBy(backlog.childIssues.map((issue) => issue.project)),
      contracts: {
        covered: [
          "VibeChildBacklogBoundary",
          "VibeDxBackboneBoundary",
          "VibeScopeGuardBoundary",
          "VibeUnblockLedgerBoundary",
        ],
        // SAFETY: assertion to `[] as string[]` is required at this boundary.
        missing: [] as string[],
      },
      dxBackbone: dxResult.summary,
      unblockOutcome:
        "After this PR merges and HOBO-539 moves Done, the DX backbone can continue through HOBO-566 and downstream visual/support/launch/docs slices stay gated by accepted DX quickstart evidence.",
    },
  };
}

export function evaluateDxBackboneGraph(graph: VibeDxBackboneGraph = DX_BACKBONE_GRAPH) {
  const violations: string[] = [];

  if (graph.parentIssue !== "HOBO-539") {
    violations.push("DX graph parent issue must be HOBO-539");
  }
  if (graph.backboneIssue.id !== "HOBO-566" || graph.backboneIssue.parentId !== "HOBO-539") {
    violations.push("HOBO-566 must be the DX backbone child under HOBO-539");
  }
  if (graph.backboneIssue.project !== "CLI, MCP & Developer Experience") {
    violations.push("HOBO-566 must live in CLI, MCP & Developer Experience");
  }

  const childIds = graph.childSlices.map((issue) => issue.id);
  assertSetEquals(childIds, [
    "HOBO-567",
    "HOBO-568",
    "HOBO-569",
    "HOBO-570",
    "HOBO-571",
    "HOBO-572",
    "HOBO-573",
    "HOBO-574",
    "HOBO-575",
    "HOBO-576",
    "HOBO-577",
  ], "DX child slices", violations);

  const foundationIds = graph.childSlices.filter((issue) => issue.phase === "M1").map((issue) => issue.id);
  const prototypeIds = graph.childSlices.filter((issue) => issue.phase === "M2").map((issue) => issue.id);
  assertSetEquals(foundationIds, ["HOBO-567", "HOBO-568", "HOBO-569", "HOBO-570", "HOBO-571", "HOBO-572"], "M1 foundation slices", violations);
  assertSetEquals(prototypeIds, ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576", "HOBO-577"], "M2 transcript/prototype slices", violations);

  const allLabels = new Set([...graph.backboneIssue.labels, ...graph.childSlices.flatMap((issue) => issue.labels)]);
  for (const label of REQUIRED_DX_LABELS) {
    if (!allLabels.has(label)) {
      violations.push(`DX backbone missing required label family: ${label}`);
    }
  }

  const requiredLifecycle = ["deploy", "manage", "migrate", "rollback", "support", "api", "sdk", "cli", "mcp"];
  const lifecycleCoverage = new Set(graph.childSlices.flatMap((issue) => issue.lifecycleCoverage));
  for (const coverage of requiredLifecycle) {
    if (!lifecycleCoverage.has(coverage)) {
      violations.push(`DX backbone missing lifecycle coverage: ${coverage}`);
    }
  }

  const issueById = new Map(graph.childSlices.map((issue) => [issue.id, issue]));
  for (const issue of graph.childSlices) {
    if (issue.parentId !== "HOBO-566") {
      violations.push(`${issue.id} must be a child of HOBO-566`);
    }
    if (issue.project !== "CLI, MCP & Developer Experience") {
      violations.push(`${issue.id} must live in CLI, MCP & Developer Experience`);
    }
    if (!issue.labels.includes("dx-first") || !issue.labels.includes("contract")) {
      violations.push(`${issue.id} must keep dx-first and contract labels`);
    }
    if (!issue.targetPackagePath.startsWith("src/draft/exp-proofs/")) {
      violations.push(`${issue.id} must target src/draft/exp-proofs/<type>/<slug>`);
    }
    if (!issue.proofNotePath.startsWith("docs/design/proofs/")) {
      violations.push(`${issue.id} proof note must live under docs/design/proofs/<slug>/README.md`);
    }
    for (const mode of REQUIRED_PROOF_MODES) {
      if (!issue.proofModes.includes(mode)) {
        violations.push(`${issue.id} missing proof mode label: ${mode}`);
      }
    }
    const forbiddenScope = findForbiddenScope(issue.scopeOut);
    if (forbiddenScope.length < REQUIRED_SCOPE_OUT_GUARDS.length) {
      violations.push(`${issue.id} scope-out guard must cover provider, UI, CLI/API/SDK, data, credential, and launch-claim creep`);
    }
    for (const blocker of issue.blockedBy) {
      if (!issueById.has(blocker)) {
        violations.push(`${issue.id} references unknown DX blocker ${blocker}`);
      }
      if (issue.phase === "M1" && issueById.get(blocker)?.phase === "M2") {
        violations.push(`${issue.id} M1 foundation slice must not be blocked by M2 transcript/prototype work`);
      }
    }
  }

  for (const issue of graph.childSlices.filter((childIssue) => childIssue.phase === "M2" && childIssue.id !== "HOBO-577")) {
    if (!issue.blockedBy.some((blocker) => foundationIds.includes(blocker))) {
      violations.push(`${issue.id} must be blocked by at least one M1 DX foundation slice`);
    }
  }

  const quickstart = issueById.get("HOBO-577");
  if (!quickstart) {
    violations.push("HOBO-577 quickstart slice is missing");
  } else {
    assertSetEquals(quickstart.blockedBy, ["HOBO-573", "HOBO-574", "HOBO-575", "HOBO-576"], "HOBO-577 transcript blockers", violations);
    for (const consumer of graph.quickstartConsumerIds) {
      if (!quickstart.blocks.includes(consumer)) {
        violations.push(`HOBO-577 must block downstream consumer ${consumer}`);
      }
    }
  }

  for (const blocker of graph.terminalErrorConsumer.blockedBy) {
    const blockerIssue = issueById.get(blocker);
    if (!blockerIssue?.blocks.includes(graph.terminalErrorConsumer.id)) {
      violations.push(`${blocker} must block ${graph.terminalErrorConsumer.id}`);
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    summary: {
      backboneIssue: graph.backboneIssue.id,
      childCount: graph.childSlices.length,
      phases: countBy(graph.childSlices.map((issue) => issue.phase)),
      labels: [...allLabels].sort(),
      quickstartConsumers: graph.quickstartConsumerIds.length,
      terminalErrorConsumer: graph.terminalErrorConsumer.id,
    },
  };
}

export function rejectVibeScopeCreep(requests: string[]) {
  return requests
    .filter((request) => FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(request)))
    .map((request) => ({
      request,
      decision: "reject",
      reason:
        "HOBO-539 coordinates DX-first artifact-proof backlog only; production behavior, live data, credentials, and launch claims stay out of scope.",
    }));
}

export function createIssueSlug(issue: string, title: string) {
  return `${issue.toLowerCase()}-${title}`
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function child(
  id: string,
  title: string,
  project: string,
  phase: VibeChildPhase,
  estimate: 3 | 5,
  artifactSlices: string[],
  sourceDesignDocs: string[],
): VibeChildIssue {
  const issueSlug = createIssueSlug(id, title);
  const packageSlug = issueSlug.replace(/^hobo-\d+-/, "");

  return {
    id,
    title: `Vibe slice: ${title}`,
    project,
    phase,
    estimate,
    targetPackagePath: `src/draft/exp-proofs/ux/${packageSlug}`,
    proofNotePath: `docs/design/proofs/${issueSlug}/README.md`,
    artifactSlices,
    requiredScenarios: [...REQUIRED_CHILD_SCENARIOS],
    proofModes: [...REQUIRED_PROOF_MODES],
    sourceDesignDocs,
    scopeOut: [
      "No live provider calls.",
      "No production UI implementation.",
      "No production CLI/API/SDK implementation.",
      "No live customer data.",
      "No real credentials or secrets.",
      "No launch claims without evidence.",
    ],
  };
}

function dxSlice(
  id: string,
  title: string,
  phase: DxPhase,
  estimate: 3 | 5 | 8,
  labels: string[],
  packageSlug: string,
  blockedBy: string[],
  blocks: string[],
  lifecycleCoverage: string[],
): VibeDxSliceIssue {
  return {
    id,
    title: `Vibe slice: ${title}`,
    parentId: "HOBO-566",
    project: "CLI, MCP & Developer Experience",
    phase,
    estimate,
    labels,
    targetPackagePath: `src/draft/exp-proofs/dx/${packageSlug}`,
    proofNotePath: `docs/design/proofs/${packageSlug}/README.md`,
    blockedBy,
    blocks,
    lifecycleCoverage,
    proofModes: [...REQUIRED_PROOF_MODES],
    scopeOut: [
      "No live provider calls.",
      "No production UI implementation.",
      "No production CLI/API/SDK implementation.",
      "No live customer data.",
      "No real credentials or secrets.",
      "No launch claims without evidence.",
    ],
  };
}

function findForbiddenScope(scopeOut: string[]) {
  return REQUIRED_SCOPE_OUT_GUARDS.filter((pattern) => scopeOut.some((entry) => pattern.test(entry)));
}

function countBy(values: string[]) {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function assertSetEquals(actual: string[], expected: string[], label: string, violations: string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      violations.push(`${label} missing ${value}`);
    }
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      violations.push(`${label} has unexpected ${value}`);
    }
  }
}
