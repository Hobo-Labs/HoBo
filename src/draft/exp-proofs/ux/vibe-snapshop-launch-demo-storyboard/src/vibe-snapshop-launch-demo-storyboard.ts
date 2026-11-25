import { type JsonValue } from "./json.js";
export const REQUIRED_SNAPSHOP_STORY_STEPS = [
  "scaffold",
  "local-run",
  "inspect",
  "plan",
  "live-recording-slot",
  "failure-recovery",
  "support-docs-handoff",
] as const;

export const REQUIRED_SNAPSHOP_ASSETS = [
  "screenshots",
  "recording-manifest",
  "command-transcript",
  "fixture-data",
  "docs",
] as const;

export const REQUIRED_SNAPSHOP_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_SNAPSHOP_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS = [
  "rlq-define-object-graph-v1",
  "rlq-collect-manifest-ir-v1",
  "rlq-plan-safe-preview-v1",
  "rlq-deploy-run-accepted-v1",
  "rlq-inspect-event-projection-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_SNAPSHOP_QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

type SnapshopStoryStepId = (typeof REQUIRED_SNAPSHOP_STORY_STEPS)[number];
type SnapshopAssetKind = (typeof REQUIRED_SNAPSHOP_ASSETS)[number];
type SnapshopScenarioId = (typeof REQUIRED_SNAPSHOP_SCENARIOS)[number];
type SnapshopProofMode = (typeof REQUIRED_SNAPSHOP_PROOF_MODES)[number];
type QuickstartProofMode = (typeof REQUIRED_SNAPSHOP_QUICKSTART_PROOF_MODES)[number];
type QuickstartFixtureId = (typeof REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS)[number];

// domain-view: parse-produced draft-proof record; its wire form is the SnapshopQuickstartFixtureReference proto message in data-models/.
export type SnapshopQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: QuickstartFixtureId;
  readonly proofMode: QuickstartProofMode;
  readonly consumingStep: SnapshopStoryStepId;
  readonly storyboardUse: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the SnapshopStoryboardStep proto message in data-models/.
export type SnapshopStoryboardStep = {
  readonly id: SnapshopStoryStepId;
  readonly title: string;
  readonly commandOrSurface: string;
  readonly proofMode: SnapshopProofMode;
  readonly fixtureId: QuickstartFixtureId;
  readonly evidenceObject: string;
  readonly owner: string;
  readonly safeClaim: string;
  readonly supportDocsHandoff: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the SnapshopAssetMapEntry proto message in data-models/.
export type SnapshopAssetMapEntry = {
  readonly kind: SnapshopAssetKind;
  readonly source: string;
  readonly owner: string;
  readonly proofMode: SnapshopProofMode;
  readonly refreshTrigger: string;
  readonly validationRoute: string;
  readonly staleDowngrade: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the SnapshopScenarioPath proto message in data-models/.
export type SnapshopScenarioPath = {
  readonly id: SnapshopScenarioId;
  readonly narrative: string;
  readonly stepIds: readonly SnapshopStoryStepId[];
  readonly assetKinds: readonly SnapshopAssetKind[];
  readonly proofModeLabels: readonly SnapshopProofMode[];
  readonly accessibilityNote: string;
  readonly supportHandoff: string;
  readonly safeOutcome: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeSnapshopLaunchDemoStoryboard proto message in data-models/.
export type VibeSnapshopLaunchDemoStoryboard = {
  readonly issue: "HOBO-555";
  readonly phase: "M5";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard";
  readonly proofPath: "docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md";
  readonly designRefs: readonly string[];
  readonly proofModes: readonly SnapshopProofMode[];
  readonly quickstartFixtureRefs: readonly SnapshopQuickstartFixtureReference[];
  readonly storyboardSteps: readonly SnapshopStoryboardStep[];
  readonly assetMap: readonly SnapshopAssetMapEntry[];
  readonly scenarioPaths: readonly SnapshopScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

export type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedSnapshopStoryboardBrand: unique symbol;

export type ParsedVibeSnapshopLaunchDemoStoryboard =
  VibeSnapshopLaunchDemoStoryboard & {
    readonly [parsedSnapshopStoryboardBrand]: true;
  };

const QUICKSTART_REFS: readonly SnapshopQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-define-object-graph-v1",
    proofMode: "reference-fixture",
    consumingStep: "scaffold",
    storyboardUse: "scaffold scene uses accepted object-graph fixture ids and command transcript shape",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-collect-manifest-ir-v1",
    proofMode: "simulated",
    consumingStep: "local-run",
    storyboardUse: "local run scene reuses the accepted manifest collection fixture instead of inventing runtime behavior",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    consumingStep: "plan",
    storyboardUse: "plan scene reuses accepted plan preview fixture and proof-mode labels",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "live",
    consumingStep: "live-recording-slot",
    storyboardUse: "live recording slot can claim live behavior only when manifest evidence is attached",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-inspect-event-projection-v1",
    proofMode: "reference-fixture",
    consumingStep: "inspect",
    storyboardUse: "inspect scene uses accepted projection evidence before layering freshness warnings",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingStep: "inspect",
    storyboardUse: "inspect scene shows stale and unknown evidence without promoting it to live proof",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "reference-fixture",
    consumingStep: "failure-recovery",
    storyboardUse: "failure recovery scene cites accepted snapshot restore preview evidence without claiming production recovery",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    consumingStep: "support-docs-handoff",
    storyboardUse: "support handoff scene labels unsupported remediation and routes it to docs/support",
  },
];

const STORYBOARD_STEPS: readonly SnapshopStoryboardStep[] = [
  {
    id: "scaffold",
    title: "Scaffold snapshop from the quickstart fixture",
    commandOrSurface: "npx hobo new snapshop -t fullstack --fixture rlq-define-object-graph-v1",
    proofMode: "reference fixture",
    fixtureId: "rlq-define-object-graph-v1",
    evidenceObject: "terminal scaffold transcript with fixture id and generated file summary",
    owner: "Example Apps",
    safeClaim: "Shows the command path shape for snapshop; it does not claim a shipped scaffold implementation.",
    supportDocsHandoff: "Docs Portal can reuse the transcript with reference-fixture labeling.",
  },
  {
    id: "local-run",
    title: "Run snapshop locally through the simulated Camp",
    commandOrSurface: "hobo dev --fixture rlq-collect-manifest-ir-v1",
    proofMode: "simulated",
    fixtureId: "rlq-collect-manifest-ir-v1",
    evidenceObject: "local runtime activity screen with simulated service boundary markers",
    owner: "Example Apps",
    safeClaim: "Shows local runtime behavior over mocked boundaries, not provider-hosted execution.",
    supportDocsHandoff: "Tutorials can cite simulated local-run behavior and route failures to troubleshooting.",
  },
  {
    id: "inspect",
    title: "Inspect run evidence and freshness",
    commandOrSurface: "hobo inspect run snapshop-preview-001 --fixture rlq-inspect-event-projection-v1",
    proofMode: "reference fixture",
    fixtureId: "rlq-inspect-event-projection-v1",
    evidenceObject: "run inspector timeline with projection freshness and unknown-evidence markers",
    owner: "CLI, MCP & Developer Experience",
    safeClaim: "Shows the inspection evidence shape without implementing the inspector runtime.",
    supportDocsHandoff: "Troubleshooting can link stale evidence to the support route and owner field.",
  },
  {
    id: "plan",
    title: "Preview the deployment plan before launch",
    commandOrSurface: "hobo plan --camp preview --fixture rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    fixtureId: "rlq-plan-safe-preview-v1",
    evidenceObject: "plan diff with proof-mode chips, policy disposition, and safe next action",
    owner: "Plan/Diff Viewer",
    safeClaim: "Demonstrates deterministic plan evidence and unsupported-state labels without provisioning.",
    supportDocsHandoff: "Plan/Diff consumers can reuse the fixture id and must keep approval/provider work out of scope.",
  },
  {
    id: "live-recording-slot",
    title: "Reserve the live preview recording slot",
    commandOrSurface: "hobo up --camp preview --strategy canary --recording-slot launch-demo",
    proofMode: "live",
    fixtureId: "rlq-deploy-run-accepted-v1",
    evidenceObject: "recording manifest slot requiring accepted live preview evidence before public use",
    owner: "V1 Launch Site, Messaging & Demo Assets",
    safeClaim: "Live proof can be claimed only when the recording manifest links accepted live behavior.",
    supportDocsHandoff: "Launch Site consumes this as a placeholder until the manifest carries current evidence.",
  },
  {
    id: "failure-recovery",
    title: "Preview snapshot restore recovery without overclaiming remediation",
    commandOrSurface: "hobo up --rollback deployment-set:previous --fixture rlq-recover-snapshot-restore-v1 --dry-run",
    proofMode: "reference fixture",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    evidenceObject: "rollback preview panel with snapshot restore evidence and production-recovery guardrails",
    owner: "Troubleshooting Guides",
    safeClaim: "Shows accepted recovery preview evidence without promising automated production restore.",
    supportDocsHandoff: "Support Workflow receives the owner route, customer-safe recovery wording, and accepted limitation.",
  },
  {
    id: "support-docs-handoff",
    title: "Hand off evidence to support and docs owners",
    commandOrSurface: "support/docs handoff matrix for snapshop launch demo assets",
    proofMode: "scope-out",
    fixtureId: "rlq-recover-scope-out-v1",
    evidenceObject: "handoff matrix naming docs route, support owner, stale downgrade, and limitation text",
    owner: "V1 Launch Site, Messaging & Demo Assets",
    safeClaim: "Keeps launch-demo support and docs follow-up explicit before any public claim is published.",
    supportDocsHandoff: "Docs Portal, Launch Site, Troubleshooting, and Support Workflow each get a target route.",
  },
];

const ASSET_MAP: readonly SnapshopAssetMapEntry[] = [
  {
    kind: "screenshots",
    source: "docs/design/launch-demo-golden-path.md#required-assets",
    owner: "V1 Launch Site, Messaging & Demo Assets",
    proofMode: "live",
    refreshTrigger: "Any screen, command wording, output, or proof-mode label changes.",
    validationRoute: "docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md#asset-map",
    staleDowngrade: "Downgrade to reference fixture until refreshed live screenshots exist.",
  },
  {
    kind: "recording-manifest",
    source: "docs/design/launch-messaging-claims.md#required-demo-assets",
    owner: "V1 Launch Site, Messaging & Demo Assets",
    proofMode: "live",
    refreshTrigger: "Any live preview, expected output, simulated marker, or recording slot changes.",
    validationRoute: "recording manifest entry with freshness owner and accepted live evidence link",
    staleDowngrade: "Mark recording stale and block public live claims.",
  },
  {
    kind: "command-transcript",
    source: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    owner: "Example Apps",
    proofMode: "reference fixture",
    refreshTrigger: "Any command path, CLI wording, fixture output, or safe-claim boundary changes.",
    validationRoute: "checked-in transcript fixture cited by the storyboard proof note",
    staleDowngrade: "Keep transcript reference-only until quickstart fixture ids are refreshed.",
  },
  {
    kind: "fixture-data",
    source: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples",
    owner: "Example Apps",
    proofMode: "reference fixture",
    refreshTrigger: "Any sample app, resource, manifest, failure, or recovery fixture changes.",
    validationRoute: "HOBO-577 quickstart parser and Pact-style fixture",
    staleDowngrade: "Reject downstream scenario updates that invent fixture ids.",
  },
  {
    kind: "docs",
    source: "docs/design/launch-demo-golden-path.md",
    owner: "Example Apps",
    proofMode: "reference fixture",
    refreshTrigger: "Any acceptance, owner, scope, proof mode, or public-claim boundary changes.",
    validationRoute: "design proof README plus docs freshness gate",
    staleDowngrade: "Route to known limitations and support wording before publication.",
  },
];

export const VIBE_SNAPSHOP_LAUNCH_DEMO_STORYBOARD: VibeSnapshopLaunchDemoStoryboard = {
  issue: "HOBO-555",
  phase: "M5",
  packagePath: "src/draft/exp-proofs/ux/vibe-snapshop-launch-demo-storyboard",
  proofPath: "docs/design/proofs/vibe-snapshop-launch-demo-storyboard/README.md",
  designRefs: [
    "docs/design/launch-demo-golden-path.md",
    "docs/design/launch-messaging-claims.md",
    "docs/design/known-limitations-register.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  proofModes: REQUIRED_SNAPSHOP_PROOF_MODES,
  quickstartFixtureRefs: QUICKSTART_REFS,
  storyboardSteps: STORYBOARD_STEPS,
  assetMap: ASSET_MAP,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Evaluator scaffolds snapshop, runs locally, previews a plan, and reaches the live recording slot only when evidence exists.",
      stepIds: ["scaffold", "local-run", "plan", "live-recording-slot"],
      assetKinds: ["command-transcript", "fixture-data", "recording-manifest", "screenshots"],
      proofModeLabels: ["reference fixture", "simulated", "live"],
      accessibilityNote: "Keyboard order follows command, evidence, owner, and proof-mode label before the next action.",
      supportHandoff: "Docs owner receives transcript and fixture ids; launch owner receives recording slot.",
      safeOutcome: "Demo can be rehearsed while live claims wait for recording-manifest evidence.",
    },
    {
      id: "blocked-path",
      narrative: "Missing auth, policy denial, unsupported provider, or can-deploy failure blocks the live slot and routes to recovery.",
      stepIds: ["plan", "failure-recovery", "support-docs-handoff"],
      assetKinds: ["docs", "fixture-data", "command-transcript"],
      proofModeLabels: ["simulated", "scope-out", "reference fixture"],
      accessibilityNote: "Blocked state uses clear text, visible focus target, contrast-safe severity, and no motion-only cue.",
      supportHandoff: "Troubleshooting gets the denial evidence and customer-safe recovery wording.",
      safeOutcome: "No live provider action is implied while blocked recovery remains scope-out.",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Stale recording, unknown projection freshness, or missing fixture source downgrades the asset before publication.",
      stepIds: ["inspect", "live-recording-slot", "support-docs-handoff"],
      assetKinds: ["recording-manifest", "screenshots", "docs"],
      proofModeLabels: ["reference fixture", "live", "scope-out"],
      accessibilityNote: "Screen reader text announces stale evidence, owner route, and downgrade result.",
      supportHandoff: "Launch owner refreshes the asset or docs owner marks the limitation.",
      safeOutcome: "Stale assets cannot support public launch claims until refreshed.",
    },
    {
      id: "support-handoff",
      narrative: "Support and docs handoff keeps unsupported states explainable without claiming production recovery.",
      stepIds: ["failure-recovery", "support-docs-handoff"],
      assetKinds: ["docs", "command-transcript", "fixture-data"],
      proofModeLabels: ["reference fixture", "scope-out"],
      accessibilityNote: "Responsive layout keeps owner, next action, and support route visible without truncation.",
      supportHandoff: "Support Workflow receives limitation wording, escalation owner, and evidence source.",
      safeOutcome: "Customer-safe support wording is available before any public demo publication.",
    },
  ],
  accessibilityNotes: [
    "Keyboard navigation reaches each storyboard step, proof-mode chip, asset owner, and handoff route in reading order.",
    "Screen reader labels name live, simulated, reference fixture, and scope-out modes without relying on color alone.",
    "Contrast, responsive layout, and reduced motion are required for all launch-demo storyboard states.",
  ],
  scopeOut: [
    "final launch marketing page",
    "final demo video",
    "live provider provisioning",
    "provider credentials",
    "customer data",
    "public launch claims without evidence",
  ],
};

export class VibeSnapshopLaunchDemoStoryboardParseError extends Error {
  readonly errors: readonly ValidationError[];

  constructor(errors: readonly ValidationError[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "VibeSnapshopLaunchDemoStoryboardParseError";
    this.errors = errors;
  }
}

export function validateVibeSnapshopLaunchDemoStoryboard(
  value: VibeSnapshopLaunchDemoStoryboard,
): { readonly ok: true; readonly errors: readonly [] } | { readonly ok: false; readonly errors: readonly ValidationError[] } {
  const errors: ValidationError[] = [];

  for (const stepId of REQUIRED_SNAPSHOP_STORY_STEPS) {
    if (!value.storyboardSteps.some((step) => step.id === stepId)) {
      errors.push({
        code: "missing-storyboard-step",
        message: `Missing storyboard step ${stepId}.`,
      });
    }
  }

  for (const kind of REQUIRED_SNAPSHOP_ASSETS) {
    if (!value.assetMap.some((asset) => asset.kind === kind)) {
      errors.push({
        code: "missing-asset-kind",
        message: `Missing asset kind ${kind}.`,
      });
    }
  }

  for (const scenarioId of REQUIRED_SNAPSHOP_SCENARIOS) {
    if (!value.scenarioPaths.some((scenario) => scenario.id === scenarioId)) {
      errors.push({
        code: "missing-scenario-path",
        message: `Missing scenario path ${scenarioId}.`,
      });
    }
  }

  for (const mode of REQUIRED_SNAPSHOP_PROOF_MODES) {
    if (!value.proofModes.includes(mode)) {
      errors.push({
        code: "missing-proof-mode",
        message: `Missing proof mode ${mode}.`,
      });
    }
  }

  validateQuickstartFixtureRefs(value.quickstartFixtureRefs, errors);

  const stepIds = new Set(value.storyboardSteps.map((step) => step.id));
  const assetKinds = new Set(value.assetMap.map((asset) => asset.kind));
  const quickstartStepRefs = new Set(
    value.quickstartFixtureRefs.map((ref) => `${ref.consumingStep}:${ref.fixtureId}`),
  );

  for (const step of value.storyboardSteps) {
    requireText(errors, step.title, `storyboard step ${step.id} title`);
    requireText(errors, step.commandOrSurface, `storyboard step ${step.id} command or surface`);
    requireText(errors, step.evidenceObject, `storyboard step ${step.id} evidence object`);
    requireText(errors, step.owner, `storyboard step ${step.id} owner`);
    requireText(errors, step.safeClaim, `storyboard step ${step.id} safe claim`);
    requireText(errors, step.supportDocsHandoff, `storyboard step ${step.id} support docs handoff`);
    if (!REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS.includes(step.fixtureId)) {
      errors.push({
        code: "unknown-storyboard-fixture",
        message: `Storyboard step ${step.id} references unknown HOBO-577 fixture ${step.fixtureId}.`,
      });
    }
    if (!quickstartStepRefs.has(`${step.id}:${step.fixtureId}`)) {
      errors.push({
        code: "uncited-storyboard-fixture",
        message: `Storyboard step ${step.id} fixture ${step.fixtureId} must be cited in quickstartFixtureRefs.`,
      });
    }
  }

  for (const asset of value.assetMap) {
    requireText(errors, asset.source, `asset ${asset.kind} source`);
    requireText(errors, asset.owner, `asset ${asset.kind} owner`);
    requireText(errors, asset.refreshTrigger, `asset ${asset.kind} refresh trigger`);
    requireText(errors, asset.validationRoute, `asset ${asset.kind} validation route`);
    requireText(errors, asset.staleDowngrade, `asset ${asset.kind} stale downgrade`);
  }

  for (const scenario of value.scenarioPaths) {
    requireText(errors, scenario.narrative, `scenario ${scenario.id} narrative`);
    requireText(errors, scenario.accessibilityNote, `scenario ${scenario.id} accessibility note`);
    requireText(errors, scenario.supportHandoff, `scenario ${scenario.id} support handoff`);
    requireText(errors, scenario.safeOutcome, `scenario ${scenario.id} safe outcome`);

    for (const stepId of scenario.stepIds) {
      if (!stepIds.has(stepId)) {
        errors.push({
          code: "unknown-scenario-step",
          message: `Scenario ${scenario.id} references unknown step ${stepId}.`,
        });
      }
    }

    for (const assetKind of scenario.assetKinds) {
      if (!assetKinds.has(assetKind)) {
        errors.push({
          code: "unknown-scenario-asset",
          message: `Scenario ${scenario.id} references unknown asset ${assetKind}.`,
        });
      }
    }
  }

  if (value.accessibilityNotes.length === 0) {
    errors.push({
      code: "missing-accessibility-note",
      message: "At least one accessibility note is required.",
    });
  }

  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function parseVibeSnapshopLaunchDemoStoryboard(
  value: JsonValue,
): ParsedVibeSnapshopLaunchDemoStoryboard {
  // SAFETY: `const proof = value as VibeSnapshopLaunchDemoStoryboard;` is required at this I/O or test boundary.
  const proof = value as VibeSnapshopLaunchDemoStoryboard;
  const validation = validateVibeSnapshopLaunchDemoStoryboard(proof);
  if (!validation.ok) {
    throw new VibeSnapshopLaunchDemoStoryboardParseError(validation.errors);
  }

  // SAFETY: `return proof as ParsedVibeSnapshopLaunchDemoStoryboard;` is required at this I/O or test boundary.
  return proof as ParsedVibeSnapshopLaunchDemoStoryboard;
}

export function renderStoryboardStepSummary(step: SnapshopStoryboardStep): string {
  return `${step.title}: ${step.proofMode} evidence from ${step.evidenceObject}; owner ${step.owner}.`;
}

export function classifySnapshopStoryboardRequest(request: string): "in-scope-proof" | "scope-out" {
  const normalized = request.toLowerCase();
  const scopeOutTerms = [
    "final launch marketing page",
    "final demo video",
    "live provider",
    "provider credential",
    "customer data",
    "public launch claim",
    "production launch",
    "real cloud",
  ];

  return scopeOutTerms.some((term) => normalized.includes(term)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartFixtureRefs(
  refs: readonly SnapshopQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  const fixtureIds = refs.map((ref) => ref.fixtureId);
  const proofModes = new Set<QuickstartProofMode>();

  if (!arraysEqual(fixtureIds, REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "Snapshop launch demo must cite the required accepted HOBO-577 quickstart fixture ids.",
    });
  }

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577.`,
      });
    }
    if (!REQUIRED_SNAPSHOP_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-577 launch-demo fixture.`,
      });
    }
    if (!REQUIRED_SNAPSHOP_QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({
        code: "unknown-quickstart-proof-mode",
        message: `${ref.fixtureId} uses unsupported HOBO-577 proof mode ${String(ref.proofMode)}.`,
      });
    } else {
      proofModes.add(ref.proofMode);
    }
    if (!REQUIRED_SNAPSHOP_STORY_STEPS.includes(ref.consumingStep)) {
      errors.push({
        code: "unknown-quickstart-consuming-step",
        message: `${ref.fixtureId} targets unsupported storyboard step ${String(ref.consumingStep)}.`,
      });
    }
    requireText(errors, ref.storyboardUse, `quickstart fixture ${ref.fixtureId} storyboard use`);
  }

  for (const mode of REQUIRED_SNAPSHOP_QUICKSTART_PROOF_MODES) {
    if (proofModes.has(mode)) continue;
    errors.push({
      code: "missing-quickstart-proof-mode",
      message: "Snapshop launch demo must preserve HOBO-577 reference-fixture, simulated, live, and scope-out labels.",
    });
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requireText(errors: ValidationError[], value: string, field: string): void {
  if (value.trim().length === 0) {
    errors.push({
      code: "empty-required-field",
      message: `Missing ${field}.`,
    });
  }
}
