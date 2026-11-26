import { isJsonString, isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_ASSET_KINDS = [
  "screenshots",
  "recording-manifest",
  "command-transcript",
  "fixture-data",
  "docs",
] as const;

export const REQUIRED_PROOF_MODES = ["live", "reference fixture", "scope-out", "simulated"] as const;

export const REQUIRED_SCENARIO_KINDS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
  "accessibility-check",
] as const;

export type AssetKind = (typeof REQUIRED_ASSET_KINDS)[number];
export type ProofMode = (typeof REQUIRED_PROOF_MODES)[number];
export type ScenarioKind = (typeof REQUIRED_SCENARIO_KINDS)[number];

// domain-view: parse-produced draft-proof record; its wire form is the LaunchAsset proto message in data-models/.
export interface LaunchAsset {
  id: string;
  kind: AssetKind;
  label: string;
  sourceOwner: string;
  proofMode: ProofMode;
  evidenceSource: string;
  freshnessRule: string;
  refreshTrigger: string;
  validationRoute: string;
  staleDowngrade: string;
}

export interface LaunchFixtureExample {
  id: string;
  proofMode: ProofMode;
  assetKind: AssetKind | "scope-out-asset";
  evidenceSource: string;
  claimBoundary: string;
}

export interface LaunchRefreshScenario {
  id: string;
  kind: ScenarioKind;
  proofMode: ProofMode;
  assetIds: string[];
  expectedState: "ready" | "blocked" | "downgraded" | "routed";
  launchReadinessImpact: "ready-for-review" | "blocked-until-owner-action" | "downgrade-until-refreshed";
  safeNextAction: string;
  supportHandoff: string;
  accessibilityNote: string;
}

export interface VibeLaunchAssetRefreshPlan {
  schema: "hobo.vibe-launch-asset-refresh-plan/v1";
  issue: "HOBO-556";
  targetPackagePath: "src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan";
  proofNotePath: "docs/design/proofs/vibe-launch-asset-refresh-plan/README.md";
  sourceRefs: string[];
  audience: string[];
  assets: LaunchAsset[];
  fixtureExamples: LaunchFixtureExample[];
  scenarios: LaunchRefreshScenario[];
  scopeOut: string[];
}

export interface ParsedVibeLaunchAssetRefreshPlan extends VibeLaunchAssetRefreshPlan {
  readonly __parsed: "VibeLaunchAssetRefreshPlan";
}

// domain-view: parse-produced draft-proof record; its wire form is the ScopeCreepDenial proto message in data-models/.
export interface ScopeCreepDenial {
  decision: "reject";
  reason: string;
  request: string;
}

type AcceptedSummary = {
  assetKinds: AssetKind[];
  proofModes: ProofMode[];
  scenarioKinds: ScenarioKind[];
};

export const VIBE_LAUNCH_ASSET_REFRESH_PLAN: VibeLaunchAssetRefreshPlan = {
  schema: "hobo.vibe-launch-asset-refresh-plan/v1",
  issue: "HOBO-556",
  targetPackagePath: "src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan",
  proofNotePath: "docs/design/proofs/vibe-launch-asset-refresh-plan/README.md",
  sourceRefs: [
    "docs/design/launch-demo-golden-path.md",
    "docs/design/launch-messaging-claims.md",
    "src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md",
    "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/README.md",
  ],
  audience: [
    "demo maintainer refreshing screenshots and recordings",
    "docs owner refreshing command transcripts and fixture snippets",
    "launch messaging owner checking proof-mode boundaries",
    "support operator routing stale or unknown evidence",
    "accessibility reviewer checking representative asset notes",
  ],
  assets: [
    asset({
      kind: "screenshots",
      label: "snapshop launch screenshot set",
      sourceOwner: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live",
      evidenceSource: "recordings/snapshop/screenshots/",
      freshnessRule: "Current only when every visible screen, proof-mode badge, and customer-safe claim matches the accepted golden path.",
      refreshTrigger: "Screen layout, command wording, output, proof-mode label, or launch visual boundary changes.",
      validationRoute: "Demo maintainer compares screenshots to the golden-path checklist before launch-site use.",
      staleDowngrade: "Downgrade to simulated/reference fixture and block public launch screenshots until refreshed.",
    }),
    asset({
      kind: "recording-manifest",
      label: "snapshop demo recording manifest",
      sourceOwner: "V1 Launch Site, Messaging & Demo Assets",
      proofMode: "live",
      evidenceSource: "recordings/manifest.json",
      freshnessRule: "Current only when recording ids, captured commands, expected outputs, and proof-mode markers match the accepted demo path.",
      refreshTrigger: "Live preview URL, recorded command path, expected output, unsupported-state marker, or proof-mode boundary changes.",
      validationRoute: "Launch owner verifies the manifest before any video or public-demo claim is used.",
      staleDowngrade: "Mark recording evidence stale and use reference fixture wording until a new manifest is accepted.",
    }),
    asset({
      kind: "command-transcript",
      label: "resource lifecycle command transcript",
      sourceOwner: "Example Apps",
      proofMode: "reference fixture",
      evidenceSource: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/README.md",
      freshnessRule: "Current when CLI wording, fixture ids, refusal text, and support handoffs match the quickstart examples.",
      refreshTrigger: "Command path, CLI output, MCP parity, fixture id, refusal wording, or scope-out wording changes.",
      validationRoute: "Docs owner reruns the transcript proof and keeps reference-fixture labels visible.",
      staleDowngrade: "Keep docs examples as reference-only and block live CLI claims until the transcript is refreshed.",
    }),
    asset({
      kind: "fixture-data",
      label: "snapshop lifecycle fixture data",
      sourceOwner: "Example Apps",
      proofMode: "reference fixture",
      evidenceSource: "src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus/README.md",
      freshnessRule: "Current when manifest IR, DeploymentPlan, delta, Gatekeeper, projection, logs, and support evidence share the accepted fixture ids.",
      refreshTrigger: "Sample app resources, manifest shape, lifecycle scenario, failure recovery, or support evidence fields change.",
      validationRoute: "Fixture owner validates deterministic ids and redaction before visual or docs consumers reuse them.",
      staleDowngrade: "Mark consuming assets stale or unknown and route to fixture owner for refresh before readiness claims.",
    }),
    asset({
      kind: "docs",
      label: "launch demo and messaging docs",
      sourceOwner: "Example Apps",
      proofMode: "reference fixture",
      evidenceSource: "docs/design/launch-demo-golden-path.md",
      freshnessRule: "Current when acceptance, owner routing, public-claim boundary, and proof-mode vocabulary match the executable proofs.",
      refreshTrigger: "Acceptance, owner, scope, proof note, claim register, or known-limitation boundary changes.",
      validationRoute: "Docs owner updates design records and proof notes in the same branch as asset refresh changes.",
      staleDowngrade: "Treat docs as design-record only and block launch-publication wording until the proof note is current.",
    }),
  ],
  fixtureExamples: [
    {
      id: "fixture.live.screenshot-set",
      proofMode: "live",
      assetKind: "screenshots",
      evidenceSource: "recordings/snapshop/screenshots/current/",
      claimBoundary: "May support a public visual claim only while the recording manifest is current.",
    },
    {
      id: "fixture.simulated.plan-preview",
      proofMode: "simulated",
      assetKind: "recording-manifest",
      evidenceSource: "src/draft/exp-proofs/dx/launch-demo-golden-path-contract/README.md#command-path",
      claimBoundary: "Shows intended plan/diff behavior without claiming a live planner or provider.",
    },
    {
      id: "fixture.reference.command-transcript",
      proofMode: "reference fixture",
      assetKind: "command-transcript",
      evidenceSource: "src/draft/exp-proofs/dx/resource-lifecycle-quickstart-examples/README.md",
      claimBoundary: "Pins CLI and MCP wording for downstream docs without claiming shipped CLI behavior.",
    },
    {
      id: "fixture.scope-out.final-demo-video",
      proofMode: "scope-out",
      assetKind: "scope-out-asset",
      evidenceSource: "HOBO-556 scope-out",
      claimBoundary: "Final marketing assets, recording production, and launch publication are rejected by this proof.",
    },
  ],
  scenarios: [
    {
      id: "scenario.refresh.ready",
      kind: "happy-path",
      proofMode: "reference fixture",
      assetIds: ["screenshots", "recording-manifest", "command-transcript", "fixture-data", "docs"],
      expectedState: "ready",
      launchReadinessImpact: "ready-for-review",
      safeNextAction: "Review the refreshed asset manifest with proof-mode labels still visible.",
      supportHandoff:
        "Support owner can cite the current manifest and transcript ids when a ticket asks what evidence is current.",
      accessibilityNote:
        "Plain text labels and screenshot alt notes support screen reader review without relying on color alone.",
    },
    {
      id: "scenario.refresh.blocked",
      kind: "blocked-path",
      proofMode: "scope-out",
      assetIds: ["recording-manifest"],
      expectedState: "blocked",
      launchReadinessImpact: "blocked-until-owner-action",
      safeNextAction: "Reject recording production and route to the launch owner for a separate approved capture task.",
      supportHandoff:
        "Create an owner handoff instead of a support ticket that promises final assets from this proof.",
      accessibilityNote:
        "Blocked copy is plain text and keyboard reachable in downstream checklists.",
    },
    {
      id: "scenario.refresh.stale-evidence",
      kind: "stale-or-unknown-evidence",
      proofMode: "reference fixture",
      assetIds: ["screenshots", "recording-manifest", "fixture-data"],
      expectedState: "downgraded",
      launchReadinessImpact: "downgrade-until-refreshed",
      safeNextAction: "Downgrade stale or unknown evidence to reference fixture and refresh the owning asset before claims.",
      supportHandoff:
        "Support owner receives the stale asset id, source owner, and refresh trigger before customer-safe wording is reused.",
      accessibilityNote:
        "Stale state uses plain text and does not depend on color, animation, or hover-only notices.",
    },
    {
      id: "scenario.refresh.support-route",
      kind: "support-handoff",
      proofMode: "reference fixture",
      assetIds: ["command-transcript", "docs"],
      expectedState: "routed",
      launchReadinessImpact: "blocked-until-owner-action",
      safeNextAction: "Route missing transcript or docs evidence to the owning project before publication.",
      supportHandoff:
        "Support handoff names owner route, ticket evidence, customer-safe summary, and unsupported-claim boundary.",
      accessibilityNote:
        "Support wording stays in plain text so screen reader users hear the owner and next action.",
    },
    {
      id: "scenario.refresh.accessibility",
      kind: "accessibility-check",
      proofMode: "simulated",
      assetIds: ["screenshots", "docs"],
      expectedState: "routed",
      launchReadinessImpact: "blocked-until-owner-action",
      safeNextAction: "Run representative keyboard, contrast, reduced motion, and copy checks before treating assets as useful evidence.",
      supportHandoff:
        "Accessibility reviewer hands findings to the asset owner and support route when evidence is unclear.",
      accessibilityNote:
        "Requires keyboard path, contrast note, reduced motion behavior, and screen reader smoke evidence.",
    },
  ],
  scopeOut: [
    "No final marketing assets.",
    "No recording production.",
    "No live provider execution.",
    "No customer data.",
    "No launch publication.",
    "No unsupported public claims.",
  ],
};

export function evaluateLaunchAssetRefreshPlan(input: JsonValue) {
  const parsed = parseLaunchAssetRefreshPlan(input);
  const errors = [...parsed.errors];

  if (!parsed.value) {
    return {
      ok: false,
      errors,
      accepted: emptyAcceptedSummary(),
    };
  }

  const record = parsed.value;
  const assetKinds = collectRequired(record.assets.map((asset) => asset.kind), REQUIRED_ASSET_KINDS);
  const proofModes = collectRequired(
    record.fixtureExamples.map((fixture) => fixture.proofMode),
    REQUIRED_PROOF_MODES,
  );
  const scenarioKinds = collectRequired(
    record.scenarios.map((scenario) => scenario.kind),
    REQUIRED_SCENARIO_KINDS,
  );

  for (const kind of REQUIRED_ASSET_KINDS) {
    if (!assetKinds.includes(kind)) {
      errors.push(`missing required asset: ${kind}`);
    }
  }
  for (const proofMode of REQUIRED_PROOF_MODES) {
    if (!proofModes.includes(proofMode)) {
      errors.push(`missing proof mode fixture: ${proofMode}`);
    }
  }
  for (const kind of REQUIRED_SCENARIO_KINDS) {
    if (!scenarioKinds.includes(kind)) {
      errors.push(`missing scenario kind: ${kind}`);
    }
  }

  for (const asset of record.assets) {
    requireText(asset.sourceOwner, `${asset.kind}: source owner is required`, errors);
    requireText(asset.proofMode, `${asset.kind}: proof mode is required`, errors);
    requireText(asset.freshnessRule, `${asset.kind}: freshness rule is required`, errors);
    requireText(asset.refreshTrigger, `${asset.kind}: refresh trigger is required`, errors);
    requireText(asset.validationRoute, `${asset.kind}: validation route is required`, errors);
    requireText(asset.staleDowngrade, `${asset.kind}: stale downgrade behavior is required`, errors);
    if (!REQUIRED_PROOF_MODES.includes(asset.proofMode)) {
      errors.push(`${asset.kind}: invalid proof mode ${asset.proofMode}`);
    }
  }

  for (const fixture of record.fixtureExamples) {
    requireText(fixture.evidenceSource, `${fixture.id}: evidence source is required`, errors);
    requireText(fixture.claimBoundary, `${fixture.id}: claim boundary is required`, errors);
  }

  for (const scenario of record.scenarios) {
    requireText(scenario.safeNextAction, `${scenario.id}: safe next action is required`, errors);
    if (!/support|owner|handoff|ticket/i.test(scenario.supportHandoff)) {
      errors.push(`${scenario.id}: support handoff is required`);
    }
    if (!/screen reader|keyboard|contrast|reduced motion|plain text/i.test(scenario.accessibilityNote)) {
      errors.push(`${scenario.id}: accessibility note is required`);
    }
    if (scenario.kind === "stale-or-unknown-evidence" && scenario.launchReadinessImpact !== "downgrade-until-refreshed") {
      errors.push(`${scenario.id}: stale evidence must downgrade launch readiness`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    accepted: { assetKinds, proofModes, scenarioKinds },
  };
}

export function parseLaunchAssetRefreshPlan(input: JsonValue) {
  const errors: string[] = [];

  if (!input || !isJsonObject(input)) {
    return { errors: ["launch asset refresh plan record is required"] };
  }

  // SAFETY: `const record = input as Partial<VibeLaunchAssetRefreshPlan>;` is required at this I/O or test boundary.
  const record = input as Partial<VibeLaunchAssetRefreshPlan>;
  if (record.schema !== "hobo.vibe-launch-asset-refresh-plan/v1") {
    errors.push("schema must be hobo.vibe-launch-asset-refresh-plan/v1");
  }
  if (record.issue !== "HOBO-556") {
    errors.push("issue must be HOBO-556");
  }
  if (record.targetPackagePath !== "src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan") {
    errors.push("target package path must match HOBO-556 acceptance");
  }
  if (record.proofNotePath !== "docs/design/proofs/vibe-launch-asset-refresh-plan/README.md") {
    errors.push("proof note path must match HOBO-556 acceptance");
  }
  if (!Array.isArray(record.assets)) {
    errors.push("assets must be an array");
  }
  if (!Array.isArray(record.fixtureExamples)) {
    errors.push("fixture examples must be an array");
  }
  if (!Array.isArray(record.scenarios)) {
    errors.push("scenarios must be an array");
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    errors,
    // SAFETY: `value: { ...(record as VibeLaunchAssetRefreshPlan), __parsed: "VibeLaunchAssetRe` is required at this I/O or test boundary.
    value: { ...(record as VibeLaunchAssetRefreshPlan), __parsed: "VibeLaunchAssetRefreshPlan" as const },
  };
}

export function rejectLaunchAssetScopeCreep(requests: string[]): ScopeCreepDenial[] {
  return requests.flatMap((request) => {
    const reason = forbiddenReason(request);
    return reason ? [{ decision: "reject" as const, reason, request }] : [];
  });
}

function asset(input: Omit<LaunchAsset, "id">): LaunchAsset {
  return {
    id: input.kind,
    ...input,
  };
}

function collectRequired<T extends string>(values: T[], required: readonly T[]) {
  const present = new Set(values);
  return required.filter((value) => present.has(value));
}

function emptyAcceptedSummary(): AcceptedSummary {
  return {
    assetKinds: [],
    proofModes: [],
    scenarioKinds: [],
  };
}

function requireText(value: JsonValue, message: string, errors: string[]) {
  if (!isJsonString(value) || value.trim().length === 0) {
    errors.push(message);
  }
}

function forbiddenReason(request: string) {
  if (/final marketing|marketing screenshot|final asset|public launch site/i.test(request)) {
    return "final marketing assets are out of scope";
  }
  if (/record.*production|production demo video|final demo video/i.test(request)) {
    return "recording production is out of scope";
  }
  if (/live provider|AWS|Azure|GCP|Cloudflare|real cloud/i.test(request)) {
    return "live provider execution is out of scope";
  }
  if (/customer data|customer payload|real tenant/i.test(request)) {
    return "customer data is out of scope";
  }
  if (/publish|launch page|publication/i.test(request)) {
    return "launch publication is out of scope";
  }
  if (/unsupported.*claim|production readiness|public claim/i.test(request)) {
    return "unsupported public claims are out of scope";
  }
  return undefined;
}
