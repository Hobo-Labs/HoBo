import {
  REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS,
  REQUIRED_PLAN_REVIEW_STATES,
  VIBE_PLAN_REVIEW_STATES,
  parseVibePlanReviewStates,
  type ParsedVibePlanReviewStates,
} from "../../../ux/vibe-plan-review-states/src/vibe-plan-review-states.ts";
import {
  VIBE_PLAN_ANNOTATION_PSEUDOCODE,
  parsePlanAnnotationPseudocode,
  type PlanAnnotationFixture,
  type PlanAnnotationPseudocode,
} from "../../../ux/vibe-plan-annotation-pseudocode/src/vibe-plan-annotation-pseudocode.ts";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const REQUIRED_GOLDEN_PLAN_STATES = REQUIRED_PLAN_REVIEW_STATES;

export const REQUIRED_PLAN_DIFF_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_PLAN_DIFF_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_PLAN_DIFF_SURFACES = [
  "plan-summary",
  "change-diff",
  "risk-policy",
  "cost-capacity",
  "approval-support",
] as const;

export const REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS = REQUIRED_PLAN_REVIEW_QUICKSTART_FIXTURE_IDS;

const REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES = ["HOBO-542", "HOBO-543", "HOBO-577"] as const;

type GoldenPlanStateId = (typeof REQUIRED_GOLDEN_PLAN_STATES)[number];
type PlanDiffScenarioId = (typeof REQUIRED_PLAN_DIFF_SCENARIOS)[number];
type PlanDiffProofMode = (typeof REQUIRED_PLAN_DIFF_PROOF_MODES)[number];
type PlanDiffSurfaceId = (typeof REQUIRED_PLAN_DIFF_SURFACES)[number];
type PlanDiffQuickstartFixtureId = (typeof REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS)[number];
type SourceIssue = (typeof REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES)[number];

interface AnnotationCasesByPlanState {
  readonly create: readonly string[];
  readonly update: readonly string[];
  readonly "no-op": readonly string[];
  readonly destructive: readonly string[];
  readonly blocked: readonly string[];
  readonly stale: readonly string[];
  readonly "unknown-evidence": readonly string[];
}

const ANNOTATION_CASES_BY_PLAN_STATE: AnnotationCasesByPlanState = {
  create: ["cost estimate", "capacity warning"],
  update: ["cost estimate", "widened permission"],
  "no-op": ["cost estimate"],
  destructive: ["missing approval", "widened permission"],
  blocked: ["policy denial"],
  stale: ["stale SLO signal", "cost estimate"],
  "unknown-evidence": ["stale SLO signal", "missing approval"],
};

export type PlanDiffRequestClassification =
  | { readonly allowed: true; readonly reason: "reference-prototype" }
  | {
      readonly allowed: false;
      readonly reason:
        | "planner-runtime"
        | "apply-rollback"
        | "approval-service"
        | "live-cost-api"
        | "production-ui"
        | "launch-claim";
    };

export interface PlanDiffSourceDependency {
  readonly issue: SourceIssue;
  readonly title: string;
  readonly status: "accepted";
  readonly evidence: string;
}

export interface PlanDiffAnnotationRef {
  readonly sourceIssue: "HOBO-543";
  readonly fixtureId: string;
  readonly annotationCase: string;
  readonly displayGroup: string;
  readonly severity: string;
  readonly proofMode: string;
}

export interface PlanDiffSupportHandoff {
  readonly issue: "HOBO-560";
  readonly sourceIssue: SourceIssue;
  readonly correlationId: string;
  readonly customerSafeWording: string;
  readonly visibleFields: readonly string[];
  readonly withheldFields: readonly string[];
  readonly ownerRoute: string;
  readonly nextAction: string;
  readonly liveTicketCreated: false;
}

export interface GoldenPlanDiffFixture {
  readonly state: GoldenPlanStateId;
  readonly surface: PlanDiffSurfaceId;
  readonly sourceIssue: SourceIssue;
  readonly sourceFixtureId: string;
  readonly planReviewStateId: GoldenPlanStateId;
  readonly evidenceSource: string;
  readonly owner: string;
  readonly safeNextAction: string;
  readonly riskCategory: string;
  readonly policyDisposition: string;
  readonly costDisposition: string;
  readonly capacityDisposition: string;
  readonly customerSafeWording: string;
  readonly proofMode: PlanDiffProofMode;
  readonly annotationRefs: readonly PlanDiffAnnotationRef[];
  readonly supportHandoff: PlanDiffSupportHandoff;
}

export interface PlanDiffScenario {
  readonly id: PlanDiffScenarioId;
  readonly title: string;
  readonly goldenStates: readonly GoldenPlanStateId[];
  readonly proofModeLabels: readonly PlanDiffProofMode[];
  readonly safeOutcome: string;
}

export interface PlanDiffQuickstartFixtureRef {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: PlanDiffQuickstartFixtureId;
  readonly proofMode: "reference-fixture" | "simulated" | "live" | "scope-out";
  readonly consumingSurface: PlanDiffSurfaceId;
  readonly planDiffUse: string;
}

export interface VibePlanDiffReviewPrototype {
  readonly issue: "HOBO-560";
  readonly phase: "M2";
  readonly targetPackage: "src/draft/exp-proofs/ux/vibe-plan-diff-review-prototype";
  readonly proofNote: "docs/design/proofs/vibe-plan-diff-review-prototype/README.md";
  readonly designRefs: readonly string[];
  readonly sourceDependencies: readonly PlanDiffSourceDependency[];
  readonly quickstartFixtureRefs: readonly PlanDiffQuickstartFixtureRef[];
  readonly goldenFixtures: readonly GoldenPlanDiffFixture[];
  readonly scenarios: readonly PlanDiffScenario[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
}

function planStateById(
  proof: ParsedVibePlanReviewStates,
  stateId: GoldenPlanStateId,
): ParsedVibePlanReviewStates["planStates"][number] {
  const state = proof.planStates.find((candidate) => candidate.id === stateId);
  if (!state) {
    throw new TypeError(`missing HOBO-542 plan state ${stateId}`);
  }
  return state;
}

function annotationsForState(
  annotations: readonly PlanAnnotationFixture[],
  stateId: GoldenPlanStateId,
): readonly PlanAnnotationFixture[] {
  const cases = ANNOTATION_CASES_BY_PLAN_STATE[stateId];
  return cases.map((annotationCase) => {
    const annotation = annotations.find((candidate) => candidate.case === annotationCase);
    if (!annotation) {
      throw new TypeError(`missing HOBO-543 annotation case ${annotationCase} for ${stateId}`);
    }
    return annotation;
  });
}

function surfaceForState(stateId: GoldenPlanStateId): PlanDiffSurfaceId {
  switch (stateId) {
    case "create":
    case "update":
    case "no-op":
      return "plan-summary";
    case "destructive":
      return "change-diff";
    case "blocked":
      return "risk-policy";
    case "stale":
    case "unknown-evidence":
      return "cost-capacity";
    default:
      return "approval-support";
  }
}

function sourceIssueForState(stateId: GoldenPlanStateId): SourceIssue {
  if (stateId === "blocked" || stateId === "destructive") {
    return "HOBO-543";
  }
  return "HOBO-542";
}

function supportHandoffForFixture(
  stateId: GoldenPlanStateId,
  planState: ParsedVibePlanReviewStates["planStates"][number],
  annotations: readonly PlanAnnotationFixture[],
): PlanDiffSupportHandoff {
  const primaryAnnotation = annotations[0];
  const planReviewHandoff = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES).supportHandoff;

  return {
    issue: "HOBO-560",
    sourceIssue: sourceIssueForState(stateId),
    correlationId: `cor_hobo_560_${stateId.replace(/[^a-z0-9]+/gi, "_")}`,
    customerSafeWording:
      stateId === "unknown-evidence" || stateId === "stale" || stateId === "blocked"
        ? planReviewHandoff.customerSafeMessage
        : primaryAnnotation.supportSafeWording,
    visibleFields: ["planId", "fixtureId", "state", "owner", "correlationId"],
    withheldFields: [
      "tenantData",
      "providerCredential",
      "internalPolicyId",
      "rawProjectionPayload",
    ],
    ownerRoute: primaryAnnotation.supportOwnerRoute,
    nextAction: planState.safeNextAction,
    liveTicketCreated: false,
  };
}

function buildGoldenFixtures(
  planReview: ParsedVibePlanReviewStates,
  annotations: PlanAnnotationPseudocode,
): readonly GoldenPlanDiffFixture[] {
  return REQUIRED_GOLDEN_PLAN_STATES.map((stateId) => {
    const planState = planStateById(planReview, stateId);
    const stateAnnotations = annotationsForState(annotations.annotations, stateId);

    return {
      state: stateId,
      surface: surfaceForState(stateId),
      sourceIssue: sourceIssueForState(stateId),
      sourceFixtureId: planState.evidenceSource.replace(/^fixture:\/\//, ""),
      planReviewStateId: stateId,
      evidenceSource: planState.evidenceSource,
      owner: planState.owner,
      safeNextAction: planState.safeNextAction,
      riskCategory: planState.riskCategory,
      policyDisposition: planState.policyDisposition,
      costDisposition: planState.costDisposition,
      capacityDisposition: planState.capacityDisposition,
      customerSafeWording: planState.customerSafeWording,
      proofMode: planState.proofMode,
      annotationRefs: stateAnnotations.map((annotation) => ({
        sourceIssue: "HOBO-543" as const,
        fixtureId: annotation.fixtureId,
        annotationCase: annotation.case,
        displayGroup: annotation.displayGroup,
        severity: annotation.severity,
        proofMode: annotation.proofMode,
      })),
      supportHandoff: supportHandoffForFixture(stateId, planState, stateAnnotations),
    };
  });
}

const QUICKSTART_FIXTURE_REFS: readonly PlanDiffQuickstartFixtureRef[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-plan-safe-preview-v1",
    proofMode: "simulated",
    consumingSurface: "plan-summary",
    planDiffUse:
      "golden create, update, no-op, and blocked plan fixtures reuse the accepted safe preview quickstart",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingSurface: "cost-capacity",
    planDiffUse: "stale evidence golden fixture cites accepted stale-evidence quickstart copy",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-migrate-brownfield-preview-v1",
    proofMode: "simulated",
    consumingSurface: "risk-policy",
    planDiffUse: "unknown-evidence golden fixture cites accepted brownfield owner gap quickstart",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "reference-fixture",
    consumingSurface: "change-diff",
    planDiffUse: "destructive golden fixture cites accepted rollback boundary quickstart",
  },
];

function resolveGoldenFixtures(): readonly GoldenPlanDiffFixture[] {
  const planReview = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);
  const annotations = parsePlanAnnotationPseudocode(VIBE_PLAN_ANNOTATION_PSEUDOCODE);
  return buildGoldenFixtures(planReview, annotations);
}

export function resolvePlanDiffDependencies(): readonly PlanDiffSourceDependency[] {
  const planReview = parseVibePlanReviewStates(VIBE_PLAN_REVIEW_STATES);
  const annotations = parsePlanAnnotationPseudocode(VIBE_PLAN_ANNOTATION_PSEUDOCODE);

  return [
    {
      issue: "HOBO-542",
      title: "Vibe plan review states",
      status: "accepted",
      evidence: planReview.packagePath,
    },
    {
      issue: "HOBO-543",
      title: "Vibe plan annotation pseudocode",
      status: "accepted",
      evidence: annotations.targetPackagePath,
    },
    {
      issue: "HOBO-577",
      title: "Vibe resource lifecycle quickstart examples",
      status: "accepted",
      evidence: "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
    },
  ];
}

export const VIBE_PLAN_DIFF_REVIEW_PROTOTYPE = {
  issue: "HOBO-560",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/ux/vibe-plan-diff-review-prototype",
  proofNote: "docs/design/proofs/vibe-plan-diff-review-prototype/README.md",
  designRefs: [
    "docs/design/plan-diff-viewer.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/proofs/vibe-plan-review-states/README.md",
    "docs/design/proofs/vibe-plan-annotation-pseudocode/README.md",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  sourceDependencies: resolvePlanDiffDependencies(),
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  goldenFixtures: resolveGoldenFixtures(),
  scenarios: [
    {
      id: "happy-path",
      title: "Safe create, update, and no-op plan review",
      goldenStates: ["create", "update", "no-op"],
      proofModeLabels: ["simulated", "reference fixture", "live"],
      safeOutcome: "review golden fixtures with policy, cost, and capacity annotations without live apply",
    },
    {
      id: "blocked-path",
      title: "Policy and destructive guardrails",
      goldenStates: ["blocked", "destructive"],
      proofModeLabels: ["simulated", "reference fixture", "scope-out"],
      safeOutcome: "block progression until policy, approval, or rollback evidence is present",
    },
    {
      id: "stale-or-unknown-evidence",
      title: "Stale and unknown evidence labels",
      goldenStates: ["stale", "unknown-evidence"],
      proofModeLabels: ["reference fixture", "scope-out"],
      safeOutcome: "wait for refresh or route support without treating missing evidence as success",
    },
    {
      id: "support-handoff",
      title: "Customer-safe support packets across non-green states",
      goldenStates: ["blocked", "stale", "unknown-evidence", "destructive"],
      proofModeLabels: ["simulated", "reference fixture", "scope-out"],
      safeOutcome: "handoff redacted evidence packets without live approval or ticketing systems",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows plan summary, change diff, risk policy, cost capacity, then approval support regions.",
    "Screen reader labels include plan state, evidence source, owner, annotation severity, proof mode, and safe next action.",
    "Color cannot be the only signal for safe, blocked, destructive, stale, or unknown evidence states.",
    "Reduced motion users get static diff groups and no animated risk transition requirement.",
  ],
  scopeOut: [
    "No planner, matcher, apply, rollback, or approval service implementation.",
    "No live cloud cost API or provider credentials.",
    "No production plan/diff UI.",
    "No launch claims without evidence.",
  ],
} as const satisfies VibePlanDiffReviewPrototype;

export function parseVibePlanDiffReviewPrototype(value: JsonValue): VibePlanDiffReviewPrototype {
  const prototype = expectRecord(value, "plan/diff review prototype");
  expectLiteral(prototype.issue, "HOBO-560", "issue");
  expectLiteral(prototype.phase, "M2", "phase");
  expectLiteral(
    prototype.targetPackage,
    "src/draft/exp-proofs/ux/vibe-plan-diff-review-prototype",
    "targetPackage",
  );
  expectLiteral(
    prototype.proofNote,
    "docs/design/proofs/vibe-plan-diff-review-prototype/README.md",
    "proofNote",
  );

  assertSourceDependencies(expectArray(prototype.sourceDependencies, "sourceDependencies"));
  assertQuickstartFixtureRefs(expectArray(prototype.quickstartFixtureRefs, "quickstartFixtureRefs"));
  const goldenFixtures = expectArray(prototype.goldenFixtures, "goldenFixtures").map(expectGoldenFixture);
  assertExactOrder(
    goldenFixtures.map((fixture) => fixture.state),
    REQUIRED_GOLDEN_PLAN_STATES,
    "required golden plan state",
  );

  const scenarios = expectArray(prototype.scenarios, "scenarios").map(expectScenario);
  assertExactOrder(
    scenarios.map((scenario) => scenario.id),
    REQUIRED_PLAN_DIFF_SCENARIOS,
    "scenario",
  );
  assertScenarioCoverage(scenarios);
  assertAccessibility(expectStringArray(prototype.accessibilityNotes, "accessibilityNotes"));

  // SAFETY: `return value as VibePlanDiffReviewPrototype;` is required at this I/O or test boundary.
  return value as VibePlanDiffReviewPrototype;
}

export function renderGoldenPlanDiffFixture(fixture: GoldenPlanDiffFixture): string {
  const annotationSummary = fixture.annotationRefs
    .map((ref) => `${ref.annotationCase}:${ref.severity}`)
    .join(", ");

  return [
    `state: ${fixture.state}`,
    `surface: ${fixture.surface}`,
    `source: ${fixture.sourceIssue}/${fixture.sourceFixtureId}`,
    `owner: ${fixture.owner}`,
    `policy: ${fixture.policyDisposition}`,
    `cost: ${fixture.costDisposition}`,
    `capacity: ${fixture.capacityDisposition}`,
    `annotations: ${annotationSummary}`,
    `next action: ${fixture.safeNextAction}`,
    `proof mode: ${fixture.proofMode}`,
  ].join("\n");
}

export function renderPlanDiffSupportPacket(
  fixture: GoldenPlanDiffFixture,
): PlanDiffSupportHandoff {
  return fixture.supportHandoff;
}

export function classifyPlanDiffRequest(input: string): PlanDiffRequestClassification {
  const normalized = input.toLowerCase();
  if (/\b(planner|matcher|resource planner|matching engine)\b/.test(normalized)) {
    return { allowed: false, reason: "planner-runtime" };
  }
  if (/\b(approval service|approval workflow|approval engine|approval runtime)\b/.test(normalized)) {
    return { allowed: false, reason: "approval-service" };
  }
  if (/\b(apply|rollback|provision|deploy live)\b/.test(normalized)) {
    return { allowed: false, reason: "apply-rollback" };
  }
  if (/\b(live cost api|cloud cost api|provider cost)\b/.test(normalized)) {
    return { allowed: false, reason: "live-cost-api" };
  }
  if (/\b(production ui|production plan viewer|final ui)\b/.test(normalized)) {
    return { allowed: false, reason: "production-ui" };
  }
  if (/\blaunch\b|\bmarketing\b|\bclaim\b/.test(normalized)) {
    return { allowed: false, reason: "launch-claim" };
  }
  return { allowed: true, reason: "reference-prototype" };
}

function assertSourceDependencies(values: readonly unknown[]): void {
  const dependencies = values.map((value) => {
    const dependency = expectRecord(value, "source dependency");
    return {
      issue: expectOneOf(
        dependency.issue,
        REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES,
        "source dependency issue",
      ),
      title: expectString(dependency.title, "source dependency title"),
      status: expectLiteral(dependency.status, "accepted", "source dependency status"),
      evidence: expectString(dependency.evidence, "source dependency evidence"),
    };
  });
  assertExactOrder(
    dependencies.map((dependency) => dependency.issue),
    REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES,
    "source dependency",
  );
}

function assertQuickstartFixtureRefs(values: readonly unknown[]): void {
  const refs = values.map((value) => {
    const ref = expectRecord(value, "quickstart fixture ref");
    const fixtureId = expectOneOf(
      ref.fixtureId,
      REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS,
      "quickstart fixture id",
    );
    const consumingSurface = expectOneOf(
      ref.consumingSurface,
      REQUIRED_PLAN_DIFF_SURFACES,
      `${fixtureId}.consumingSurface`,
    );
    expectLiteral(ref.sourceIssue, "HOBO-577", `${fixtureId}.sourceIssue`);
    expectString(ref.planDiffUse, `${fixtureId}.planDiffUse`);
    return { fixtureId, consumingSurface };
  });

  assertExactOrder(
    refs.map((ref) => ref.fixtureId),
    REQUIRED_PLAN_DIFF_QUICKSTART_FIXTURE_IDS,
    "quickstart fixture",
  );

  const surfaces = new Set(refs.map((ref) => ref.consumingSurface));
  for (const surface of ["plan-summary", "change-diff", "risk-policy", "cost-capacity"] as const) {
    if (!surfaces.has(surface)) {
      throw new TypeError(`required surface ${surface} has no quickstart fixture coverage`);
    }
  }
}

function expectGoldenFixture(value: JsonValue): GoldenPlanDiffFixture {
  const fixture = expectRecord(value, "golden fixture");
  const state = expectOneOf(fixture.state, REQUIRED_GOLDEN_PLAN_STATES, "golden fixture state");
  expectOneOf(fixture.surface, REQUIRED_PLAN_DIFF_SURFACES, `${state}.surface`);
  expectOneOf(fixture.sourceIssue, REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES, `${state}.sourceIssue`);
  expectString(fixture.sourceFixtureId, `${state}.sourceFixtureId`);
  expectLiteral(fixture.planReviewStateId, state, `${state}.planReviewStateId`);
  expectString(fixture.evidenceSource, `${state}.evidenceSource`);
  expectString(fixture.owner, `${state}.owner`);
  expectString(fixture.safeNextAction, `${state}.safeNextAction`);
  expectString(fixture.riskCategory, `${state}.riskCategory`);
  expectString(fixture.policyDisposition, `${state}.policyDisposition`);
  expectString(fixture.costDisposition, `${state}.costDisposition`);
  expectString(fixture.capacityDisposition, `${state}.capacityDisposition`);
  expectString(fixture.customerSafeWording, `${state}.customerSafeWording`);
  expectOneOf(fixture.proofMode, REQUIRED_PLAN_DIFF_PROOF_MODES, `${state}.proofMode`);

  const annotationRefs = expectArray(fixture.annotationRefs, `${state}.annotationRefs`);
  if (annotationRefs.length === 0) {
    throw new TypeError(`${state} must compose at least one HOBO-543 annotation`);
  }
  for (const annotationRef of annotationRefs) {
    const ref = expectRecord(annotationRef, `${state}.annotationRef`);
    expectLiteral(ref.sourceIssue, "HOBO-543", `${state}.annotationRef.sourceIssue`);
    expectString(ref.fixtureId, `${state}.annotationRef.fixtureId`);
    expectString(ref.annotationCase, `${state}.annotationRef.annotationCase`);
    expectString(ref.displayGroup, `${state}.annotationRef.displayGroup`);
    expectString(ref.severity, `${state}.annotationRef.severity`);
    expectString(ref.proofMode, `${state}.annotationRef.proofMode`);
  }

  expectSupportHandoff(fixture.supportHandoff, `${state}.supportHandoff`);
  // SAFETY: `return fixture as GoldenPlanDiffFixture;` is required at this I/O or test boundary.
  return fixture as GoldenPlanDiffFixture;
}

function expectSupportHandoff(value: JsonValue, label: string): PlanDiffSupportHandoff {
  const packet = expectRecord(value, label);
  expectLiteral(packet.issue, "HOBO-560", `${label}.issue`);
  expectOneOf(packet.sourceIssue, REQUIRED_PLAN_DIFF_SOURCE_DEPENDENCIES, `${label}.sourceIssue`);
  expectString(packet.correlationId, `${label}.correlationId`);
  expectString(packet.customerSafeWording, `${label}.customerSafeWording`);
  const visibleFields = expectStringArray(packet.visibleFields, `${label}.visibleFields`);
  const withheldFields = expectStringArray(packet.withheldFields, `${label}.withheldFields`);
  if (!visibleFields.includes("correlationId")) {
    throw new TypeError(`${label} visibleFields must include correlationId`);
  }
  if (!withheldFields.includes("providerCredential") || !withheldFields.includes("tenantData")) {
    throw new TypeError(`${label} withheldFields must include tenant data and provider credential`);
  }
  expectString(packet.ownerRoute, `${label}.ownerRoute`);
  expectString(packet.nextAction, `${label}.nextAction`);
  if (packet.liveTicketCreated !== false) {
    throw new TypeError(`${label} must not create live support tickets`);
  }
  // SAFETY: `return packet as PlanDiffSupportHandoff;` is required at this I/O or test boundary.
  return packet as PlanDiffSupportHandoff;
}

function expectScenario(value: JsonValue): PlanDiffScenario {
  const scenario = expectRecord(value, "scenario");
  const id = expectOneOf(scenario.id, REQUIRED_PLAN_DIFF_SCENARIOS, "scenario id");
  expectString(scenario.title, `${id}.title`);
  const goldenStates = expectStringArray(scenario.goldenStates, `${id}.goldenStates`);
  if (goldenStates.length === 0) {
    throw new TypeError(`${id} must reference at least one golden state`);
  }
  for (const state of goldenStates) {
    expectOneOf(state, REQUIRED_GOLDEN_PLAN_STATES, `${id}.goldenStates`);
  }
  const proofModeLabels = expectStringArray(scenario.proofModeLabels, `${id}.proofModeLabels`);
  if (proofModeLabels.length === 0) {
    throw new TypeError(`${id} must carry proof-mode labels`);
  }
  for (const proofMode of proofModeLabels) {
    expectOneOf(proofMode, REQUIRED_PLAN_DIFF_PROOF_MODES, `${id}.proofModeLabels`);
  }
  expectString(scenario.safeOutcome, `${id}.safeOutcome`);
  // SAFETY: `return scenario as PlanDiffScenario;` is required at this I/O or test boundary.
  return scenario as PlanDiffScenario;
}

function assertScenarioCoverage(scenarios: readonly PlanDiffScenario[]): void {
  const states = new Set(scenarios.flatMap((scenario) => scenario.goldenStates));
  for (const requiredState of REQUIRED_GOLDEN_PLAN_STATES) {
    if (!states.has(requiredState)) {
      throw new TypeError(`required golden state ${requiredState} has no scenario coverage`);
    }
  }

  const modes = new Set(scenarios.flatMap((scenario) => scenario.proofModeLabels));
  for (const requiredMode of REQUIRED_PLAN_DIFF_PROOF_MODES) {
    if (!modes.has(requiredMode)) {
      throw new TypeError(`required proof mode ${requiredMode} has no scenario coverage`);
    }
  }
}

function assertAccessibility(notes: readonly string[]): void {
  const joined = notes.join(" ").toLowerCase();
  for (const required of ["keyboard", "screen reader", "color", "motion"]) {
    if (!joined.includes(required)) {
      throw new TypeError(`accessibility notes must include ${required}`);
    }
  }
}

function assertExactOrder<T extends string>(
  actual: readonly string[],
  expected: readonly T[],
  label: string,
): void {
  if (actual.length !== expected.length) {
    throw new TypeError(`${label} set has wrong length`);
  }
  for (const [index, expectedValue] of expected.entries()) {
    if (actual[index] !== expectedValue) {
      throw new TypeError(`${label} order mismatch at ${expectedValue}`);
    }
  }
}

function expectRecord(value: JsonValue, label: string): JsonObject {
  if (!isJsonObject(value) || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  // SAFETY: `return value as JsonObject;` is required at this I/O or test boundary.
  return value as JsonObject;
}

function expectArray(value: JsonValue, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function expectString(value: JsonValue, label: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function expectStringArray(value: JsonValue, label: string): readonly string[] {
  const values = expectArray(value, label);
  for (const [index, item] of values.entries()) {
    expectString(item, `${label}[${index}]`);
  }
  // SAFETY: `return values as readonly string[];` is required at this I/O or test boundary.
  return values as readonly string[];
}

function expectLiteral<T extends string>(value: JsonValue, expected: T, label: string): T {
  if (value !== expected) {
    throw new TypeError(`${label} must be ${expected}`);
  }
  return expected;
}

function expectOneOf<T extends readonly string[]>(
  value: JsonValue,
  expected: T,
  label: string,
): T[number] {
  if (!isJsonString(value) || !expected.includes(value)) {
    throw new TypeError(`${label} must be one of ${expected.join(", ")}`);
  }
  return value;
}
