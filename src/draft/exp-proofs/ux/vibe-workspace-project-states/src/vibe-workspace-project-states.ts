import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const WORKSPACE_PROJECT_STATES = [
  "empty",
  "ready",
  "blocked",
  "recovering",
  "failed",
  "value-proven",
] as const;

export const REQUIRED_PROOF_MODES = ["live", "simulated", "reference fixture", "scope-out"] as const;

export const REQUIRED_JOURNEY_COVERAGE = [
  "happy path",
  "blocked path",
  "stale/unknown evidence path",
  "support handoff",
  "accessibility notes",
] as const;

export const REQUIRED_PERSONAS = [
  "app developer",
  "team admin",
  "platform engineer",
  "support operator",
] as const;

type WorkspaceProjectState = (typeof WORKSPACE_PROJECT_STATES)[number];
type ProofMode = (typeof REQUIRED_PROOF_MODES)[number];
type JourneyCoverage = (typeof REQUIRED_JOURNEY_COVERAGE)[number];
type Persona = (typeof REQUIRED_PERSONAS)[number];

type EvidenceFreshness = "current" | "stale" | "unknown" | "scope-out" | "future-live-gated";
type ProviderReadinessStatus =
  | "not-required"
  | "ready"
  | "missing-prerequisite"
  | "recovering"
  | "failed"
  | "value-proven";

// domain-view: parse-produced draft-proof record; its wire form is the WorkspaceProjectStateFixture proto message in data-models/.
export type WorkspaceProjectStateFixture = {
  readonly id: string;
  readonly state: WorkspaceProjectState;
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
  };
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
  };
  readonly providerReadiness: {
    readonly status: ProviderReadinessStatus;
    readonly owner: Persona | "none";
    readonly detail: string;
  };
  readonly blockerOwner: Persona | "none";
  readonly safeNextAction: {
    readonly label: string;
    readonly owner: Persona;
    readonly evidenceRequired: string;
    readonly destructive: boolean;
    readonly opensLiveProvider: boolean;
  };
  readonly evidenceLink: {
    readonly label: string;
    readonly href: `docs/design/proofs/${string}/README.md#${string}`;
    readonly fixtureId: string;
    readonly freshness: EvidenceFreshness;
    readonly proofMode: ProofMode;
  };
  readonly proofMode: ProofMode;
  readonly pathCoverage: readonly JourneyCoverage[];
  readonly missingPrerequisiteBehavior: {
    readonly ifMissing: string;
    readonly userSees: string;
    readonly systemDoesNot: string;
  };
  readonly supportHandoff: {
    readonly required: boolean;
    readonly route: string;
    readonly redaction: string;
    readonly note: string;
  };
  readonly accessibilityNotes: readonly string[];
  readonly wireframe: {
    readonly surface: string;
    readonly caption: string;
    readonly regions: readonly string[];
    readonly primaryStatus: string;
    readonly secondaryDetail: string;
  };
  readonly claimPolicy: {
    readonly safeClaims: readonly string[];
    readonly forbiddenClaims: readonly string[];
  };
};

// domain-view: parse-produced draft-proof record; its wire form is the WorkspaceProjectModeNote proto message in data-models/.
export type WorkspaceProjectModeNote = {
  readonly proofMode: ProofMode;
  readonly label: string;
  readonly meaning: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the VibeWorkspaceProjectStateModel proto message in data-models/.
export type VibeWorkspaceProjectStateModel = {
  readonly issue: "HOBO-541";
  readonly phase: "M1";
  readonly targetPackage: "src/draft/exp-proofs/ux/vibe-workspace-project-states";
  readonly proofNote: "docs/design/proofs/vibe-workspace-project-states/README.md";
  readonly designRefs: readonly string[];
  readonly scopeOut: readonly string[];
  readonly modeNotes: readonly WorkspaceProjectModeNote[];
  readonly fixtures: readonly WorkspaceProjectStateFixture[];
  readonly __brand: "ParsedVibeWorkspaceProjectStateModel";
};

type UnparsedVibeWorkspaceProjectStateModel = Omit<VibeWorkspaceProjectStateModel, "__brand">;

const requiredScopeOut = [
  "account service implementation",
  "auth or billing flows",
  "production dashboard UI",
  "live provider calls",
  "customer data",
  "launch claims without evidence",
] as const;

const evidenceProof = (anchor: string) =>
  `docs/design/proofs/resource-lifecycle-quickstart-examples/README.md#${anchor}` as const;

export const VIBE_WORKSPACE_PROJECT_STATE_MODEL = {
  issue: "HOBO-541",
  phase: "M1",
  targetPackage: "src/draft/exp-proofs/ux/vibe-workspace-project-states",
  proofNote: "docs/design/proofs/vibe-workspace-project-states/README.md",
  designRefs: [
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/outcome-activation-rail.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  scopeOut: requiredScopeOut,
  modeNotes: [
    {
      proofMode: "reference fixture",
      label: "Reference fixture",
      meaning: "The state is rendered from checked-in fixture evidence and not from a tenant runtime.",
    },
    {
      proofMode: "simulated",
      label: "Simulated",
      meaning: "The next action is shown against mocked service boundaries and deterministic fixture state.",
    },
    {
      proofMode: "live",
      label: "Live evidence required",
      meaning: "A future surface may show this label only after accepted live evidence exists elsewhere.",
    },
    {
      proofMode: "scope-out",
      label: "Scope-out",
      meaning: "The state names a boundary this proof must not implement or claim as shipped.",
    },
  ],
  fixtures: [
    stateFixture({
      id: "vwp-empty-v1",
      state: "empty",
      workspaceSummary: "Workspace exists with no project and no provider prerequisite yet.",
      projectSummary: "No project has been created.",
      providerReadiness: {
        status: "not-required",
        owner: "none",
        detail: "Provider setup is not requested until a project fixture is selected.",
      },
      blockerOwner: "none",
      actionLabel: "Create a project from the snapshot fixture",
      actionOwner: "app developer",
      evidenceRequired: "resource lifecycle define fixture",
      evidenceAnchor: "fixture-ids",
      evidenceFreshness: "current",
      evidenceProofMode: "reference fixture",
      proofMode: "reference fixture",
      pathCoverage: ["accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "No workspace project fixture is selected.",
        userSees: "An empty state with a single safe project-start action and no deploy claims.",
        systemDoesNot: "Infer provider readiness, create accounts, or run live setup.",
      },
      supportRequired: false,
      supportRoute: "workspace-onboarding-reference",
      supportNote: "Support can confirm this is an empty fixture state, not a failure.",
      wireframeCaption: "Empty workspace shows project-start action and proof-mode label.",
      primaryStatus: "No project yet",
      secondaryDetail: "Start from a fixture before any provider readiness appears.",
      safeClaims: ["The empty state can point to a project fixture without claiming runtime setup."],
    }),
    stateFixture({
      id: "vwp-ready-v1",
      state: "ready",
      workspaceSummary: "Workspace and project have enough fixture evidence to preview a plan.",
      projectSummary: "Project has manifest and safe plan fixtures.",
      providerReadiness: {
        status: "ready",
        owner: "platform engineer",
        detail: "Provider readiness is simulated by accepted plan and Gatekeeper fixtures.",
      },
      blockerOwner: "none",
      actionLabel: "Review the simulated plan preview",
      actionOwner: "app developer",
      evidenceRequired: "plan preview fixture",
      evidenceAnchor: "acceptance-evidence",
      evidenceFreshness: "current",
      evidenceProofMode: "simulated",
      proofMode: "simulated",
      pathCoverage: ["happy path", "accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "Plan fixture is absent.",
        userSees: "Ready state downgrades to blocked with the missing fixture named.",
        systemDoesNot: "Treat missing planner evidence as deployable.",
      },
      supportRequired: false,
      supportRoute: "plan-preview-reference",
      supportNote: "Support sees fixture id and proof mode, but no customer data.",
      wireframeCaption: "Ready project shows plan review as the safe next action.",
      primaryStatus: "Ready to review",
      secondaryDetail: "Provider readiness is simulated and fixture-backed.",
      safeClaims: ["The ready state proves a mocked plan preview path, not a live deploy."],
    }),
    stateFixture({
      id: "vwp-blocked-v1",
      state: "blocked",
      workspaceSummary: "Workspace has a project, but provider readiness is blocked by owner action.",
      projectSummary: "Project has a plan fixture that cannot proceed until approval evidence exists.",
      providerReadiness: {
        status: "missing-prerequisite",
        owner: "platform engineer",
        detail: "Provider approval fixture is missing and must be owned outside the onboarding surface.",
      },
      blockerOwner: "platform engineer",
      actionLabel: "Request provider approval evidence",
      actionOwner: "team admin",
      evidenceRequired: "provider approval or Gatekeeper refusal fixture",
      evidenceAnchor: "acceptance-evidence",
      evidenceFreshness: "current",
      evidenceProofMode: "reference fixture",
      proofMode: "reference fixture",
      pathCoverage: ["blocked path", "support handoff", "accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "Provider approval evidence is absent.",
        userSees: "Blocked state names the owner and the safe request action.",
        systemDoesNot: "Hide the blocker or offer a deploy button.",
      },
      supportRequired: true,
      supportRoute: "provider-readiness-owner-route",
      supportNote: "Support routes to the platform engineer with the missing approval fixture id.",
      wireframeCaption: "Blocked project names owner, missing evidence, and support-safe handoff.",
      primaryStatus: "Provider readiness blocked",
      secondaryDetail: "Approval evidence is missing; deploy actions stay hidden.",
      safeClaims: ["The blocked state names owner and evidence without bypassing policy."],
    }),
    stateFixture({
      id: "vwp-recovering-v1",
      state: "recovering",
      workspaceSummary: "Workspace is returning from a failed or stale state using recovery fixtures.",
      projectSummary: "Project has a recovery preview fixture and a support route.",
      providerReadiness: {
        status: "recovering",
        owner: "support operator",
        detail: "Recovery is shown from snapshot and rollback preview evidence only.",
      },
      blockerOwner: "support operator",
      actionLabel: "Open the recovery preview handoff",
      actionOwner: "support operator",
      evidenceRequired: "snapshot or rollback preview fixture",
      evidenceAnchor: "fixture-ids",
      evidenceFreshness: "stale",
      evidenceProofMode: "reference fixture",
      proofMode: "simulated",
      pathCoverage: ["stale/unknown evidence path", "support handoff", "accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "Recovery preview fixture is stale or missing.",
        userSees: "Recovering state labels evidence freshness before suggesting handoff.",
        systemDoesNot: "Claim restoration or mutate live resources.",
      },
      supportRequired: true,
      supportRoute: "recovery-preview-handoff",
      supportNote: "Support receives fixture id, freshness label, and redacted project state.",
      wireframeCaption: "Recovering state foregrounds stale evidence and support handoff.",
      primaryStatus: "Recovery preview available",
      secondaryDetail: "Evidence is stale; handoff before any success claim.",
      safeClaims: ["The recovery state shows a preview path and never claims live restore."],
    }),
    stateFixture({
      id: "vwp-failed-v1",
      state: "failed",
      workspaceSummary: "Workspace/project state has no trusted current evidence.",
      projectSummary: "Project cannot show success because evidence is unknown.",
      providerReadiness: {
        status: "failed",
        owner: "support operator",
        detail: "Evidence is unknown; support must inspect redacted fixture context.",
      },
      blockerOwner: "support operator",
      actionLabel: "Open a redacted support bundle",
      actionOwner: "support operator",
      evidenceRequired: "unknown-evidence support bundle fixture",
      evidenceAnchor: "acceptance-evidence",
      evidenceFreshness: "unknown",
      evidenceProofMode: "scope-out",
      proofMode: "scope-out",
      pathCoverage: ["stale/unknown evidence path", "support handoff", "accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "Evidence link is unknown.",
        userSees: "Failed state refuses success wording and provides support-safe next action.",
        systemDoesNot: "Show green status, launch copy, or live diagnostics.",
      },
      supportRequired: true,
      supportRoute: "unknown-evidence-redacted-bundle",
      supportNote: "Support receives no customer data; only fixture ids and failure category.",
      wireframeCaption: "Failed state is explicit, redacted, and action-oriented.",
      primaryStatus: "Evidence unavailable",
      secondaryDetail: "No success claim until evidence is refreshed.",
      safeClaims: ["The failed state is a refusal surface, not a launch or uptime claim."],
    }),
    stateFixture({
      id: "vwp-value-proven-v1",
      state: "value-proven",
      workspaceSummary: "Workspace has accepted evidence that a user-visible outcome was reached.",
      projectSummary: "Project shows value proof linked to accepted fixture evidence.",
      providerReadiness: {
        status: "value-proven",
        owner: "app developer",
        detail: "Value proof is tied to accepted quickstart evidence; future live proof is separately gated.",
      },
      blockerOwner: "none",
      actionLabel: "Share the accepted value proof link",
      actionOwner: "app developer",
      evidenceRequired: "accepted value evidence link",
      evidenceAnchor: "verification",
      evidenceFreshness: "future-live-gated",
      evidenceProofMode: "live",
      proofMode: "reference fixture",
      pathCoverage: ["happy path", "accessibility notes"],
      missingPrerequisiteBehavior: {
        ifMissing: "Accepted value evidence is missing.",
        userSees: "Value state downgrades to ready or recovering until evidence is linked.",
        systemDoesNot: "Create launch copy or imply live customer success.",
      },
      supportRequired: false,
      supportRoute: "value-evidence-reference",
      supportNote: "Support can cite the evidence link; live verification remains out of this proof.",
      wireframeCaption: "Value-proven state shows accepted evidence and no unsupported launch claim.",
      primaryStatus: "Value evidence linked",
      secondaryDetail: "Live label is gated by accepted evidence outside this fixture.",
      safeClaims: ["The value-proven state stays inside accepted evidence boundaries."],
    }),
  ],
} as const satisfies UnparsedVibeWorkspaceProjectStateModel;

export type WorkspaceProjectStateScopeDecision =
  | { readonly allowed: true; readonly reason: "fixture-proof" }
  | {
      readonly allowed: false;
      readonly reason:
        | "account-auth-billing"
        | "customer-data"
        | "launch-claim"
        | "live-provider"
        | "production-ui";
    };

export function classifyWorkspaceProjectStateScope(request: string): WorkspaceProjectStateScopeDecision {
  const normalized = request.toLowerCase();

  if (/account service|auth flow|authentication|billing|invoice|payment|plan upgrade/.test(normalized)) {
    return { allowed: false, reason: "account-auth-billing" };
  }
  if (/customer data|tenant data|real tenant|production tenant|secret|credential/.test(normalized)) {
    return { allowed: false, reason: "customer-data" };
  }
  if (/launch claim|marketing claim|customer promise|publish.*launch|public claim/.test(normalized)) {
    return { allowed: false, reason: "launch-claim" };
  }
  if (/live provider|call.*aws|call.*azure|call.*gcp|provision live|real provider/.test(normalized)) {
    return { allowed: false, reason: "live-provider" };
  }
  if (/production dashboard|production ui|runtime dashboard|build.*dashboard ui|ship.*screen/.test(normalized)) {
    return { allowed: false, reason: "production-ui" };
  }

  return { allowed: true, reason: "fixture-proof" };
}

export function parseVibeWorkspaceProjectStateModel(
  model: JsonValue,
): VibeWorkspaceProjectStateModel {
  assertObject(model, "state model");
  assertLiteral(model.issue, "HOBO-541", "issue");
  assertLiteral(model.phase, "M1", "phase");
  assertLiteral(
    model.targetPackage,
    "src/draft/exp-proofs/ux/vibe-workspace-project-states",
    "targetPackage",
  );
  assertLiteral(
    model.proofNote,
    "docs/design/proofs/vibe-workspace-project-states/README.md",
    "proofNote",
  );
  assertNonEmptyStringArray(model.designRefs, "designRefs");
  assertScopeOut(model.scopeOut);
  assertModeNotes(model.modeNotes);
  const fixtures = assertFixtureArray(model.fixtures);
  assertStateCoverage(fixtures);
  assertJourneyCoverage(fixtures);

  return {
    // SAFETY: `...(model as UnparsedVibeWorkspaceProjectStateModel),` is required at this I/O or test boundary.
    ...(model as UnparsedVibeWorkspaceProjectStateModel),
    __brand: "ParsedVibeWorkspaceProjectStateModel",
  };
}

export function listWorkspaceProjectWireframes(
  model: VibeWorkspaceProjectStateModel,
): ReadonlyArray<{
  readonly state: WorkspaceProjectState;
  readonly caption: string;
  readonly regions: readonly string[];
  readonly proofMode: ProofMode;
}> {
  return model.fixtures.map((fixture) => ({
    state: fixture.state,
    caption: fixture.wireframe.caption,
    regions: fixture.wireframe.regions,
    proofMode: fixture.proofMode,
  }));
}

function stateFixture(
  input: {
    readonly id: string;
    readonly state: WorkspaceProjectState;
    readonly workspaceSummary: string;
    readonly projectSummary: string;
    readonly providerReadiness: WorkspaceProjectStateFixture["providerReadiness"];
    readonly blockerOwner: WorkspaceProjectStateFixture["blockerOwner"];
    readonly actionLabel: string;
    readonly actionOwner: Persona;
    readonly evidenceRequired: string;
    readonly evidenceAnchor: string;
    readonly evidenceFreshness: EvidenceFreshness;
    readonly evidenceProofMode: ProofMode;
    readonly proofMode: ProofMode;
    readonly pathCoverage: readonly JourneyCoverage[];
    readonly missingPrerequisiteBehavior: WorkspaceProjectStateFixture["missingPrerequisiteBehavior"];
    readonly supportRequired: boolean;
    readonly supportRoute: string;
    readonly supportNote: string;
    readonly wireframeCaption: string;
    readonly primaryStatus: string;
    readonly secondaryDetail: string;
    readonly safeClaims: readonly string[];
  },
): WorkspaceProjectStateFixture {
  return {
    id: input.id,
    state: input.state,
    workspace: {
      id: "wsp-snapshop",
      name: "Snapshop Workspace",
      summary: input.workspaceSummary,
    },
    project: {
      id: `prj-snapshop-${input.state}`,
      name: "Snapshop API",
      summary: input.projectSummary,
    },
    providerReadiness: input.providerReadiness,
    blockerOwner: input.blockerOwner,
    safeNextAction: {
      label: input.actionLabel,
      owner: input.actionOwner,
      evidenceRequired: input.evidenceRequired,
      destructive: false,
      opensLiveProvider: false,
    },
    evidenceLink: {
      label: input.evidenceRequired,
      href: evidenceProof(input.evidenceAnchor),
      fixtureId: input.id,
      freshness: input.evidenceFreshness,
      proofMode: input.evidenceProofMode,
    },
    proofMode: input.proofMode,
    pathCoverage: input.pathCoverage,
    missingPrerequisiteBehavior: input.missingPrerequisiteBehavior,
    supportHandoff: {
      required: input.supportRequired,
      route: input.supportRoute,
      redaction: "fixture ids, owner role, and state category only; no customer data",
      note: input.supportNote,
    },
    accessibilityNotes: [
      "Primary status is text, not color-only state.",
      "Safe next action remains keyboard reachable and has owner/evidence context.",
    ],
    wireframe: {
      surface: "workspace-project-overview",
      caption: input.wireframeCaption,
      regions: [
        "primary-status",
        "workspace-summary",
        "project-summary",
        "provider-readiness",
        "evidence-link",
        "safe-next-action",
        "support-handoff",
      ],
      primaryStatus: input.primaryStatus,
      secondaryDetail: input.secondaryDetail,
    },
    claimPolicy: {
      safeClaims: input.safeClaims,
      forbiddenClaims: [
        "Production dashboard is implemented.",
        "Live provider call succeeded.",
        "Customer tenant is active.",
        "Launch claim is approved.",
      ],
    },
  };
}

function assertFixtureArray(value: JsonValue): WorkspaceProjectStateFixture[] {
  if (!Array.isArray(value)) {
    throw new TypeError("fixtures must be an array");
  }

  return value.map((entry, index) => {
    assertObject(entry, `fixture ${index}`);
    assertWorkspaceProjectState(entry.state);
    assertNonEmptyString(entry.id, `${entry.state}.id`);
    assertNestedRecord(entry.workspace, `${entry.state}.workspace`);
    assertNestedRecord(entry.project, `${entry.state}.project`);
    assertNestedRecord(entry.providerReadiness, `${entry.state}.providerReadiness`);
    assertNestedRecord(entry.safeNextAction, `${entry.state}.safeNextAction`);
    assertNestedRecord(entry.evidenceLink, `${entry.state}.evidenceLink`);
    assertNestedRecord(entry.missingPrerequisiteBehavior, `${entry.state}.missingPrerequisiteBehavior`);
    assertNestedRecord(entry.supportHandoff, `${entry.state}.supportHandoff`);
    assertNestedRecord(entry.wireframe, `${entry.state}.wireframe`);
    assertNestedRecord(entry.claimPolicy, `${entry.state}.claimPolicy`);

    assertNonEmptyString(entry.workspace.id, `${entry.state}.workspace.id`);
    assertNonEmptyString(entry.workspace.name, `${entry.state}.workspace.name`);
    assertNonEmptyString(entry.workspace.summary, `${entry.state}.workspace.summary`);
    assertNonEmptyString(entry.project.id, `${entry.state}.project.id`);
    assertNonEmptyString(entry.project.name, `${entry.state}.project.name`);
    assertNonEmptyString(entry.project.summary, `${entry.state}.project.summary`);
    assertNonEmptyString(entry.providerReadiness.status, `${entry.state}.providerReadiness.status`);
    assertPersonaOrNone(entry.providerReadiness.owner, `${entry.state}.providerReadiness.owner`);
    assertNonEmptyString(entry.providerReadiness.detail, `${entry.state}.providerReadiness.detail`);
    assertPersonaOrNone(entry.blockerOwner, `${entry.state}.blockerOwner`);
    assertNonEmptyString(entry.safeNextAction.label, `${entry.state}.safeNextAction.label`);
    assertPersona(entry.safeNextAction.owner, `${entry.state}.safeNextAction.owner`);
    assertNonEmptyString(entry.safeNextAction.evidenceRequired, `${entry.state}.safeNextAction.evidenceRequired`);
    assertFalse(entry.safeNextAction.destructive, `${entry.state} safeNextAction must not be destructive`);
    assertFalse(entry.safeNextAction.opensLiveProvider, `${entry.state} safeNextAction must not open live providers`);
    assertNonEmptyString(entry.evidenceLink.label, `${entry.state}.evidenceLink.label`);
    assertNonEmptyString(entry.evidenceLink.href, `${entry.state} evidenceLink.href`);
    assertNonEmptyString(entry.evidenceLink.fixtureId, `${entry.state}.evidenceLink.fixtureId`);
    assertProofMode(entry.evidenceLink.proofMode);
    assertProofMode(entry.proofMode);
    assertJourneyArray(entry.pathCoverage, `${entry.state}.pathCoverage`);
    assertNonEmptyString(entry.missingPrerequisiteBehavior.ifMissing, `${entry.state}.missingPrerequisiteBehavior.ifMissing`);
    assertNonEmptyString(entry.missingPrerequisiteBehavior.userSees, `${entry.state}.missingPrerequisiteBehavior.userSees`);
    assertNonEmptyString(entry.missingPrerequisiteBehavior.systemDoesNot, `${entry.state}.missingPrerequisiteBehavior.systemDoesNot`);
    assertNonEmptyString(entry.supportHandoff.route, `${entry.state}.supportHandoff.route`);
    assertNonEmptyString(entry.supportHandoff.redaction, `${entry.state}.supportHandoff.redaction`);
    assertNonEmptyString(entry.supportHandoff.note, `${entry.state}.supportHandoff.note`);
    assertNonEmptyStringArray(entry.accessibilityNotes, `${entry.state}.accessibilityNotes`);
    assertNonEmptyString(entry.wireframe.surface, `${entry.state}.wireframe.surface`);
    assertNonEmptyString(entry.wireframe.caption, `${entry.state}.wireframe.caption`);
    assertNonEmptyStringArray(entry.wireframe.regions, `${entry.state}.wireframe.regions`);
    assertNonEmptyString(entry.wireframe.primaryStatus, `${entry.state}.wireframe.primaryStatus`);
    assertNonEmptyString(entry.wireframe.secondaryDetail, `${entry.state}.wireframe.secondaryDetail`);
    assertNonEmptyStringArray(entry.claimPolicy.safeClaims, `${entry.state}.claimPolicy.safeClaims`);
    assertNonEmptyStringArray(entry.claimPolicy.forbiddenClaims, `${entry.state}.claimPolicy.forbiddenClaims`);

    for (const text of [
      entry.safeNextAction.label,
      entry.evidenceLink.label,
      ...entry.claimPolicy.safeClaims,
    ]) {
      const decision = classifyWorkspaceProjectStateScope(text);
      if (!decision.allowed) {
        throw new TypeError(`${entry.state} contains unsafe claim: ${decision.reason}`);
      }
    }

    // SAFETY: `return entry as WorkspaceProjectStateFixture;` is required at this I/O or test boundary.
    return entry as WorkspaceProjectStateFixture;
  });
}

function assertStateCoverage(fixtures: readonly WorkspaceProjectStateFixture[]): void {
  const states = fixtures.map((fixture) => fixture.state);
  for (const state of WORKSPACE_PROJECT_STATES) {
    if (!states.includes(state)) {
      throw new TypeError(`missing workspace project state ${state}`);
    }
  }
  if (new Set(states).size !== states.length) {
    throw new TypeError("workspace project states must be unique");
  }
}

function assertJourneyCoverage(fixtures: readonly WorkspaceProjectStateFixture[]): void {
  const coverage = new Set(fixtures.flatMap((fixture) => fixture.pathCoverage));
  for (const required of REQUIRED_JOURNEY_COVERAGE) {
    if (!coverage.has(required)) {
      throw new TypeError(`missing journey coverage ${required}`);
    }
  }
}

function assertScopeOut(value: JsonValue): void {
  const scopeOut = assertStringArray(value, "scopeOut");
  for (const required of requiredScopeOut) {
    if (!scopeOut.includes(required)) {
      throw new TypeError(`scopeOut missing ${required}`);
    }
  }
}

function assertModeNotes(value: JsonValue): void {
  if (!Array.isArray(value)) {
    throw new TypeError("modeNotes must be an array");
  }
  const modes = new Set<ProofMode>();
  for (const [index, note] of value.entries()) {
    assertObject(note, `modeNotes[${index}]`);
    assertProofMode(note.proofMode);
    assertNonEmptyString(note.label, `modeNotes[${index}].label`);
    assertNonEmptyString(note.meaning, `modeNotes[${index}].meaning`);
    modes.add(note.proofMode);
  }
  for (const required of REQUIRED_PROOF_MODES) {
    if (!modes.has(required)) {
      throw new TypeError(`modeNotes missing ${required}`);
    }
  }
}

function assertObject(value: JsonValue, name: string): asserts value is JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function assertNestedRecord(value: JsonValue, name: string): asserts value is JsonObject {
  assertObject(value, name);
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

function assertNonEmptyStringArray(value: JsonValue, name: string): string[] {
  const entries = assertStringArray(value, name);
  if (entries.length === 0 || entries.some((entry) => entry.trim() === "")) {
    throw new TypeError(`${name} must contain non-empty strings`);
  }

  return entries;
}

function assertNonEmptyString(value: JsonValue, name: string): asserts value is string {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${name} must not be empty`);
  }
}

function assertFalse(value: JsonValue, message: string): void {
  if (value !== false) {
    throw new TypeError(message);
  }
}

function assertProofMode(value: JsonValue): asserts value is ProofMode {
  // SAFETY: `if (!REQUIRED_PROOF_MODES.includes(value as ProofMode)) {` is required at this I/O or test boundary.
  if (!REQUIRED_PROOF_MODES.includes(value as ProofMode)) {
    throw new TypeError(`unsupported proof mode ${String(value)}`);
  }
}

function assertWorkspaceProjectState(value: JsonValue): asserts value is WorkspaceProjectState {
  // SAFETY: `if (!WORKSPACE_PROJECT_STATES.includes(value as WorkspaceProjectState)) {` is required at this I/O or test boundary.
  if (!WORKSPACE_PROJECT_STATES.includes(value as WorkspaceProjectState)) {
    throw new TypeError(`unsupported workspace project state ${String(value)}`);
  }
}

function assertPersona(value: JsonValue, name: string): asserts value is Persona {
  // SAFETY: `if (!REQUIRED_PERSONAS.includes(value as Persona)) {` is required at this I/O or test boundary.
  if (!REQUIRED_PERSONAS.includes(value as Persona)) {
    throw new TypeError(`${name} must be a known persona`);
  }
}

function assertPersonaOrNone(value: JsonValue, name: string): asserts value is Persona | "none" {
  if (value !== "none") {
    assertPersona(value, name);
  }
}

function assertJourneyArray(value: JsonValue, name: string): void {
  const entries = assertNonEmptyStringArray(value, name);
  for (const entry of entries) {
    // SAFETY: `if (!REQUIRED_JOURNEY_COVERAGE.includes(entry as JourneyCoverage)) {` is required at this I/O or test boundary.
    if (!REQUIRED_JOURNEY_COVERAGE.includes(entry as JourneyCoverage)) {
      throw new TypeError(`${name} has unsupported journey ${entry}`);
    }
  }
}
