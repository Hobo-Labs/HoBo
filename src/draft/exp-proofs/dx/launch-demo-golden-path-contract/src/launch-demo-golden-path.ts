import { isJsonObject } from "./json.js";
const VALID_PROOF_MODES = new Set(["live-product", "reference-fixture", "simulated-reference", "design-record"]);
const REQUIRED_EVIDENCE_KINDS = new Set(["screenshots", "recording-manifest", "command-transcript", "fixture-data", "docs"]);
const FORBIDDEN_IMPLEMENTATION_PATTERNS = [
  /public launch site/i,
  /production demo/i,
  /ship.*demo app/i,
  /implement.*demo/i,
  /final polished/i,
];

export const launchDemoGoldenPath = {
  schema: "hobo.launch-demo-golden-path/2026-06-29",
  issue: "HOBO-488",
  project: "Example Apps",
  phase: "M0",
  sampleApp: {
    id: "snapshop",
    source: "docs/design/worked-example.md#plan-19",
    reason: "Snapshop is already the compressed end-to-end HoBo product story.",
  },
  primaryPersona: {
    role: "app developer evaluator",
    need: "Follow one reproducible path from scaffold through local run, plan, deploy evidence, and failure recovery.",
  },
  supportingPersonas: [
    {
      role: "platform engineer evaluator",
      need: "Inspect provider-agnostic app code and Camp/provider mapping decisions without hidden cloud setup.",
    },
    {
      role: "agent builder",
      need: "Use a deterministic transcript and fixture set without private local knowledge.",
    },
    {
      role: "demo maintainer",
      need: "Know which screenshots, recordings, fixtures, and docs refresh when the path changes.",
    },
  ],
  setupPrerequisites: [
    {
      id: "node-runtime",
      requirement: "Node 24 plus npm installed from the repository lockfile.",
      evidenceSource: "package.json#engines",
    },
    {
      id: "accepted-example-apps-scope",
      requirement: "Example Apps M0 scope is accepted before launch-demo assets consume it.",
      evidenceSource: "docs/design/example-apps.md#m0-acceptance-record",
    },
    {
      id: "claim-register",
      requirement: "Launch claims use proof-mode labels before publication.",
      evidenceSource: "docs/design/launch-messaging-claims.md#claim-states",
    },
    {
      id: "no-provider-secrets",
      requirement: "The path starts with fixtures and simulated/reference boundaries; no provider credentials are required.",
      evidenceSource: "docs/design/example-apps.md#scope-out-and-non-goals",
    },
  ],
  commandPath: [
    {
      id: "scaffold-snapshop",
      command: "npx hobo new snapshop -t fullstack",
      screen: "terminal scaffold transcript",
      proofMode: "reference-fixture",
      claimBoundary: "Proves the command path shape; does not claim a shipped scaffold implementation.",
    },
    {
      id: "run-local",
      command: "hobo dev",
      screen: "local runtime activity screen",
      proofMode: "simulated-reference",
      claimBoundary: "Shows reference local runtime behavior until live CLI evidence exists.",
    },
    {
      id: "inspect-run",
      command: "hobo inspect run <run-id>",
      screen: "run inspector timeline",
      proofMode: "reference-fixture",
      claimBoundary: "Pins expected workflow, step, and event evidence without implementing the inspector.",
    },
    {
      id: "plan-preview",
      command: "hobo plan --camp preview",
      screen: "plan diff and proof-mode labels",
      proofMode: "simulated-reference",
      claimBoundary: "Shows expected planning evidence and unsupported-state labels without provisioning.",
    },
    {
      id: "record-live-preview",
      command: "hobo up --camp preview --strategy canary",
      screen: "preview deploy recording slot",
      proofMode: "live-product",
      claimBoundary: "Public demo may claim live behavior only when the recording manifest links accepted live evidence.",
    },
  ],
  screens: [
    {
      id: "terminal-scaffold",
      label: "Scaffold terminal",
      expectedSignal: "Template, dependency, and generated file summary are visible.",
    },
    {
      id: "local-dev",
      label: "Local runtime",
      expectedSignal: "Local run, replay, and fixture boundary are visible.",
    },
    {
      id: "plan-diff",
      label: "Plan/diff",
      expectedSignal: "Resource mapping, proof mode, unsupported states, and next action are visible.",
    },
    {
      id: "run-inspector",
      label: "Run inspector",
      expectedSignal: "Workflow, event, and recovery timeline are visible.",
    },
    {
      id: "evidence-manifest",
      label: "Evidence manifest",
      expectedSignal: "Screenshots, recording, transcript, fixtures, and docs are linked.",
    },
  ],
  expectedOutputs: [
    {
      id: "scaffold-summary",
      output: "snapshop project created with Bindle, service, web, and fixture references.",
      proofMode: "reference-fixture",
    },
    {
      id: "manifest-fixture",
      output: "Manifest IR fixture records db, images, orders, api, and site resources.",
      proofMode: "reference-fixture",
    },
    {
      id: "local-replay",
      output: "Local workflow replay reaches the same checkout state after restart.",
      proofMode: "simulated-reference",
    },
    {
      id: "plan-warning",
      output: "Plan output labels simulated/reference behavior and unsupported provider states.",
      proofMode: "simulated-reference",
    },
    {
      id: "live-url-evidence",
      output: "Live preview URL or equivalent accepted recording evidence is linked before public demo use.",
      proofMode: "live-product",
    },
  ],
  failureRecovery: [
    {
      id: "dependency-install-failure",
      scenario: "npm install or scaffold dependency fails",
      expectedRecovery: "Transcript records exact failure, retry command, and docs handoff.",
    },
    {
      id: "missing-auth",
      scenario: "hobo login or SVID state is absent for a live preview path",
      expectedRecovery: "Demo switches to reference fixture or labels the live step blocked.",
    },
    {
      id: "policy-deny",
      scenario: "can-deploy or policy gate denies a step",
      expectedRecovery: "Plan output explains denial and links the remediation owner.",
    },
    {
      id: "unsupported-provider",
      scenario: "Provider/capability is not available for preview",
      expectedRecovery: "Path records unsupported state and uses simulated-reference proof only.",
    },
    {
      id: "stale-recording",
      scenario: "Recording no longer matches command output or proof mode",
      expectedRecovery: "Recording manifest fails freshness until refreshed or downgraded.",
    },
  ],
  evidenceArtifacts: [
    {
      kind: "screenshots",
      owner: "demo maintainer",
      proofMode: "live-product",
      source: "docs/design/proofs/hobo-488-launch-demo-golden-path/README.md#required-assets",
      refreshTrigger: "Any screen, command wording, output, or proof-mode label changes.",
    },
    {
      kind: "recording-manifest",
      owner: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live-product",
      source: "recordings/manifest.json",
      refreshTrigger: "Any live preview, expected output, or simulated/reference marker changes.",
    },
    {
      kind: "command-transcript",
      owner: "Example Apps",
      proofMode: "reference-fixture",
      source: "src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md#command-path",
      refreshTrigger: "Any command path, CLI wording, or fixture output changes.",
    },
    {
      kind: "fixture-data",
      owner: "Example Apps",
      proofMode: "reference-fixture",
      source: "src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md#expected-outputs",
      refreshTrigger: "Any sample app, resource, manifest, or failure recovery fixture changes.",
    },
    {
      kind: "docs",
      owner: "Example Apps",
      proofMode: "design-record",
      source: "docs/design/launch-demo-golden-path.md",
      refreshTrigger: "Any acceptance, owner, scope, or public-claim boundary changes.",
    },
  ],
  scopeIn: [
    "Golden path checklist and proof asset inventory for the snapshop launch demo.",
    "Proof-mode labels separating live product evidence from reference fixtures and simulated references.",
    "Failure recovery scenarios for dependency, auth, policy, provider, and recording freshness failures.",
    "Refresh ownership for screenshots, recordings, transcripts, fixtures, and docs.",
  ],
  scopeOut: [
    "No launch marketing page, final copy, or visual polish is produced by this issue.",
    "No example application implementation is built here.",
    "No provider credentials, real cloud resources, or production hosting are provisioned.",
    "No customer onboarding, support, billing, or legal launch process is defined here.",
  ],
};

export function validateLaunchDemoGoldenPath(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch demo golden path record is required"] };
  }
  if (record.issue !== "HOBO-488") {
    errors.push("issue must be HOBO-488");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (record.sampleApp?.id !== "snapshop") {
    errors.push("sample app must be snapshop");
  }
  if (!record.primaryPersona?.role || !record.primaryPersona?.need) {
    errors.push("primary persona must name role and need");
  }

  requireMin(record.setupPrerequisites, 4, "setup prerequisites", errors);
  requireMin(record.commandPath, 5, "command path", errors);
  requireMin(record.screens, 4, "screens", errors);
  requireMin(record.expectedOutputs, 5, "expected outputs", errors);
  requireMin(record.failureRecovery, 4, "failure recovery", errors);

  for (const step of record.commandPath ?? []) {
    if (!step.id || !step.command || !step.screen || !step.claimBoundary) {
      errors.push("command steps require id, command, screen, and claimBoundary");
    }
    requireProofMode(step.proofMode, `${step.id ?? "command step"} must declare a proof mode`, errors);
    const text = `${step.id ?? ""} ${step.command ?? ""} ${step.screen ?? ""} ${step.claimBoundary ?? ""}`;
    if (FORBIDDEN_IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push("demo implementation is scope-out");
    }
  }

  for (const output of record.expectedOutputs ?? []) {
    if (!output.id || !output.output) {
      errors.push("expected outputs require id and output");
    }
    requireProofMode(output.proofMode, `${output.id ?? "expected output"} must declare a proof mode`, errors);
  }

  const assetKinds = new Set();
  for (const asset of record.evidenceArtifacts ?? []) {
    assetKinds.add(asset.kind);
    if (!asset.kind || !asset.owner || !asset.source || !asset.refreshTrigger) {
      errors.push("evidence artifacts require kind, owner, source, and refreshTrigger");
    }
    requireProofMode(asset.proofMode, `${asset.kind ?? "evidence artifact"} must declare a proof mode`, errors);
  }
  for (const kind of REQUIRED_EVIDENCE_KINDS) {
    if (!assetKinds.has(kind)) {
      errors.push(`missing required evidence artifact: ${kind}`);
    }
  }

  for (const text of record.scopeOut ?? []) {
    if (/build/i.test(text) && /marketing page|final polished|final copy|visual polish/i.test(text)) {
      errors.push("marketing polish is scope-out");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchDemoGoldenPath(record = launchDemoGoldenPath) {
  const result = validateLaunchDemoGoldenPath(record);
  if (!result.ok) {
    throw new Error(`launch demo golden path invalid:\n${result.errors.join("\n")}`);
  }
  return record;
}

function requireMin(items, min, label, errors) {
  if (!Array.isArray(items) || items.length < min) {
    errors.push(`${label} must have at least ${min} entries`);
  }
}

function requireProofMode(proofMode, message, errors) {
  if (!VALID_PROOF_MODES.has(proofMode)) {
    errors.push(message);
  }
}
