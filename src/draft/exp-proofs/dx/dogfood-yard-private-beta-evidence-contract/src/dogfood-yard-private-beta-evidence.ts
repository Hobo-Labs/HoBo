export type DogfoodScenarioId =
  | "hosted-yard-preview-path"
  | "self-hosted-seed-handover"
  | "yard-upgrade-and-rollback"
  | "incident-debug-and-restore";

export type EvidenceChannelId = "logs" | "traces" | "status-views" | "support-debug" | "rollback-signals";

export type EvidenceStatus = "accepted" | "pending" | "rejected";

export type RequiredEvidence = Readonly<{
  id: string;
  ownerProject: string;
  evidenceSource: string;
  proves: string;
  status: EvidenceStatus;
}>;

export type DogfoodPrivateBetaScenario = Readonly<{
  id: DogfoodScenarioId;
  yardMode: "hosted" | "self-hosted" | "hosted-or-self-hosted";
  betaCohort: string;
  fixtureIds: readonly string[];
  evidenceChannels: readonly EvidenceChannelId[];
  exitCriteria: readonly string[];
  supportHandoff: string;
  usesLiveCustomerData: boolean;
  callsLiveProviders: boolean;
}>;

export type EvidenceChannel = Readonly<{
  id: EvidenceChannelId;
  ownerProject: string;
  redactionRule: string;
  privateBetaUse: string;
}>;

export type RecordedBlocker = Readonly<{
  id: string;
  category: "beta-blocker" | "launch-note" | "carried-forward";
  ownerProject: string;
  sourceEvidenceId: string;
  disposition: string;
  launchRisk: "low" | "medium" | "high";
}>;

export type AcceptedRisk = Readonly<{
  id: string;
  ownerRole: string;
  mitigation: string;
  followUpOrLaunchNote: string;
  revisitDate: string;
  evidenceId: string;
}>;

export type CrossProjectDependency = Readonly<{
  ownerProject: string;
  consumesEvidenceId: string;
  cutlineImpact: string;
}>;

export type MissingEvidence = Readonly<{
  id: string;
  ownerProject: string;
  reason: string;
  launchDisposition: "follow-up" | "release-candidate" | "ga-handoff";
}>;

export type FollowUpIssue = Readonly<{
  id: string;
  ownerProject: string;
  missingEvidenceId: string;
  allowedReason: string;
}>;

export type ParentInitiativeSync = Readonly<{
  initiative: "HoBo v1 Release Readiness";
  launchRiskChanged: boolean;
  statusUpdated: boolean;
  statusUpdateReason: string;
}>;

export type ClaimBoundaries = Readonly<{
  privateBetaClaim: string;
  publicClaim: string;
  unsupportedClaim: string;
}>;

export type DogfoodPrivateBetaEvidence = Readonly<{
  schema: "hobo.v1.dogfood-yard.private-beta/2026-06-30";
  issue: "HOBO-462";
  parentIssue: "HOBO-403";
  phase: "M2";
  milestoneGate: "M2 Private beta proof";
  decisionStatus: "private-beta-evidence-accepted";
  requiredEvidence: readonly RequiredEvidence[];
  scenarios: readonly DogfoodPrivateBetaScenario[];
  evidenceChannels: readonly EvidenceChannel[];
  blockers: readonly RecordedBlocker[];
  acceptedRisks: readonly AcceptedRisk[];
  crossProjectDependencies: readonly CrossProjectDependency[];
  missingEvidence: readonly MissingEvidence[];
  followUpIssues: readonly FollowUpIssue[];
  parentInitiativeSync: ParentInitiativeSync;
  claimBoundaries: ClaimBoundaries;
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  designRefs: readonly string[];
  adrRefs: readonly string[];
}>;

export type MutableDogfoodPrivateBetaEvidence = Omit<
  DogfoodPrivateBetaEvidence,
  | "requiredEvidence"
  | "scenarios"
  | "evidenceChannels"
  | "blockers"
  | "acceptedRisks"
  | "crossProjectDependencies"
  | "missingEvidence"
  | "followUpIssues"
  | "parentInitiativeSync"
  | "claimBoundaries"
  | "scopeIn"
> & {
  requiredEvidence: RequiredEvidence[];
  scenarios: DogfoodPrivateBetaScenario[];
  evidenceChannels: EvidenceChannel[];
  blockers: RecordedBlocker[];
  acceptedRisks: AcceptedRisk[];
  crossProjectDependencies: CrossProjectDependency[];
  missingEvidence: MissingEvidence[];
  followUpIssues: FollowUpIssue[];
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness";
    launchRiskChanged: boolean;
    statusUpdated: boolean;
    statusUpdateReason: string;
  };
  claimBoundaries: {
    privateBetaClaim: string;
    publicClaim: string;
    unsupportedClaim: string;
  };
  scopeIn: string[];
};

export type ValidationResult = Readonly<{
  ok: boolean;
  errors: readonly string[];
}>;

export type PrivateBetaEvidenceSummary = Readonly<{
  scenarioIds: readonly DogfoodScenarioId[];
  cutlineEntries: readonly string[];
  supportEntries: readonly string[];
  betaReadinessEntries: readonly string[];
}>;

export type WorkClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const REQUIRED_SCENARIO_IDS = Object.freeze([
  "hosted-yard-preview-path",
  "self-hosted-seed-handover",
  "yard-upgrade-and-rollback",
  "incident-debug-and-restore",
]) satisfies readonly DogfoodScenarioId[];

const REQUIRED_CHANNEL_IDS = Object.freeze([
  "logs",
  "traces",
  "status-views",
  "support-debug",
  "rollback-signals",
]) satisfies readonly EvidenceChannelId[];

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "live provider",
    pattern: /\b(live provider|production provider|provider api|cloud resources?|provision live cloud)\b/i,
  },
  {
    label: "live customer data",
    pattern: /\b(live customer|customer payload|customer data|tenant payload|inspect live customer)\b/i,
  },
  {
    label: "hosted runtime implementation",
    pattern: /\b(hosted yard runtime|runtime service|build the yard|yard implementation)\b/i,
  },
  {
    label: "admin UI implementation",
    pattern: /\b(admin dashboard|admin console navigation|admin ui)\b/i,
  },
  {
    label: "GA readiness",
    pattern: /\b(ga ready|ga readiness|production ready|all customers)\b/i,
  },
]);

export const DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE: DogfoodPrivateBetaEvidence = Object.freeze({
  schema: "hobo.v1.dogfood-yard.private-beta/2026-06-30",
  issue: "HOBO-462",
  parentIssue: "HOBO-403",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  decisionStatus: "private-beta-evidence-accepted",
  requiredEvidence: Object.freeze([
    evidence(
      "m0-dogfood-yard-scope",
      "V1 Dogfood Yard & Hosted Operations",
      "docs/design/dogfood-yard.md",
      "M0 Dogfood Yard personas, scenarios, evidence channels, and owner boundaries are accepted.",
    ),
    evidence(
      "private-beta-scenario-fixtures",
      "V1 Dogfood Yard & Hosted Operations",
      "src/draft/exp-proofs/dx/dogfood-yard-private-beta-evidence-contract",
      "Private beta fixture pack covers hosted preview, self-host handover, upgrade rollback, and incident restore evidence without live data.",
    ),
    evidence(
      "telemetry-channel-review",
      "Reliability, Observability & Cost (FinOps)",
      "docs/design/reliability-observability-cost.md#plan-05",
      "Logs, traces, status views, support/debug bundles, and rollback signals have owners, redaction, and private-beta use.",
    ),
    evidence(
      "beta-blocker-risk-register",
      "V1 Release Program & Cutline",
      "docs/design/launch-blocker-taxonomy.md",
      "Private beta blockers and accepted risks are recorded with owners, dispositions, and revisit points.",
    ),
    evidence(
      "cross-project-cutline-sync",
      "V1 Release Program & Cutline",
      "docs/design/traceability.md",
      "Dogfood, support, release notes, bootstrap, reliability, and broker handoffs remain reflected in the release cutline.",
    ),
  ]),
  scenarios: Object.freeze([
    scenario("hosted-yard-preview-path", "hosted", "first hosted private-beta cohort", [
      "logs",
      "traces",
      "status-views",
      "support-debug",
    ]),
    scenario("self-hosted-seed-handover", "self-hosted", "self-host operator private-beta cohort", [
      "logs",
      "status-views",
      "support-debug",
      "rollback-signals",
    ]),
    scenario("yard-upgrade-and-rollback", "hosted-or-self-hosted", "upgrade dry-run private-beta cohort", [
      "logs",
      "traces",
      "rollback-signals",
    ]),
    scenario("incident-debug-and-restore", "hosted-or-self-hosted", "support responder private-beta cohort", [
      "logs",
      "traces",
      "status-views",
      "support-debug",
    ]),
  ]),
  evidenceChannels: Object.freeze([
    channel(
      "logs",
      "Reliability, Observability & Cost (FinOps)",
      "No provider secrets, live customer payloads, or tenant data appear in log fixtures.",
      "Private beta operators can correlate Yard bootstrap, deploy, upgrade, incident, and recovery steps.",
    ),
    channel(
      "traces",
      "Reliability, Observability & Cost (FinOps)",
      "Trace attributes stay to ids, timings, and state transitions.",
      "Private beta reviewers can inspect request/deploy correlation across control-plane boundaries.",
    ),
    channel(
      "status-views",
      "Admin Console",
      "Status views expose aggregate state and evidence links, not raw customer data.",
      "Private beta owners can see hosted/self-host health, degraded state, maintenance, and readiness.",
    ),
    channel(
      "support-debug",
      "V1 Launch Support Desk & Escalation",
      "Debug bundles are support-safe and tenant-scoped before export.",
      "Support can triage bootstrap, deploy, incident, and recovery handoff without customer-data leakage.",
    ),
    channel(
      "rollback-signals",
      "Bootstrap Installer",
      "Rollback evidence records state ids and prior Set/provenance pointers, not provider credentials.",
      "Private beta upgrade, deploy failure, and restore paths expose rollback-ready state and operator cues.",
    ),
  ]),
  blockers: Object.freeze([
    {
      id: "beta-proof-is-not-ga-proof",
      category: "launch-note",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      sourceEvidenceId: "private-beta-scenario-fixtures",
      disposition:
        "Private beta evidence can support beta operations review, but cannot promote GA operational claims.",
      launchRisk: "medium",
    },
    {
      id: "broker-m2-inputs-in-flight",
      category: "carried-forward",
      ownerProject: "Meta-cloud Broker",
      sourceEvidenceId: "cross-project-cutline-sync",
      disposition:
        "HOBO-525, HOBO-526, and HOBO-527 remain owner issues for broker resolution, provider/catalog snapshots, and admin approvals.",
      launchRisk: "medium",
    },
  ]),
  acceptedRisks: Object.freeze([
    {
      id: "fixture-backed-private-beta",
      ownerRole: "dogfood-operations-owner",
      mitigation:
        "Keep launch copy scoped to private beta until M3 release-candidate and M4 GA handoff evidence land.",
      followUpOrLaunchNote: "Known limitation in release notes and beta pilot briefing.",
      revisitDate: "2026-08-15",
      evidenceId: "beta-blocker-risk-register",
    },
  ]),
  crossProjectDependencies: Object.freeze([
    dependency(
      "V1 Release Notes & Upgrade Guide",
      "cross-project-cutline-sync",
      "Release notes may cite private beta Yard evidence only with beta limitation wording.",
    ),
    dependency(
      "V1 Launch Support Desk & Escalation",
      "telemetry-channel-review",
      "Support handoff consumes support-safe debug and status-view evidence, not raw customer data.",
    ),
    dependency(
      "Bootstrap Installer",
      "private-beta-scenario-fixtures",
      "Bootstrap owns seed handover, rollback signal, and local/self-host install evidence boundaries.",
    ),
    dependency(
      "Reliability, Observability & Cost (FinOps)",
      "telemetry-channel-review",
      "Reliability owns trace correlation, rollback signals, and operational evidence quality.",
    ),
    dependency(
      "Meta-cloud Broker",
      "cross-project-cutline-sync",
      "Broker M2 owner issues remain separate from Dogfood Yard private beta evidence.",
    ),
  ]),
  missingEvidence: Object.freeze([
    {
      id: "release-candidate-operations-evidence",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      reason: "Private beta evidence does not prove release-candidate readiness.",
      launchDisposition: "release-candidate",
    },
    {
      id: "ga-handoff-operations-evidence",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      reason: "Private beta evidence does not prove GA handoff readiness.",
      launchDisposition: "ga-handoff",
    },
  ]),
  followUpIssues: Object.freeze([
    {
      id: "HOBO-469",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      missingEvidenceId: "release-candidate-operations-evidence",
      allowedReason: "Existing M3 release-candidate evidence issue covers missing release-candidate proof.",
    },
    {
      id: "HOBO-476",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      missingEvidenceId: "ga-handoff-operations-evidence",
      allowedReason: "Existing M4 GA handoff evidence issue covers missing GA proof.",
    },
  ]),
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: false,
    statusUpdated: false,
    statusUpdateReason:
      "M2 private beta evidence records beta limitations and carries existing M3/M4 follow-ups without changing launch risk.",
  },
  claimBoundaries: {
    privateBetaClaim:
      "Dogfood Yard has private beta evidence fixtures for hosted preview, self-host handover, upgrade rollback, and incident restore.",
    publicClaim:
      "No public or GA readiness claim is made by this M2 proof; public claims wait for M3/M4 evidence.",
    unsupportedClaim:
      "This proof does not claim production hosted operations, live provider success, customer-data debugging, or GA support readiness.",
  },
  scopeIn: Object.freeze([
    "Record private beta evidence requirements for Dogfood Yard hosted and self-hosted operational scenarios.",
    "Map evidence channels to owners, redaction rules, beta use, blockers, accepted risks, and release cutline handoffs.",
    "Use sanitized fixtures and mocked service boundaries for evidence proof.",
  ]),
  scopeOut: Object.freeze([
    "Do not build hosted Yard runtime, admin UI, support ticket automation, provider adapters, or bootstrap installer runtime.",
    "Do not provision live cloud resources, call production provider APIs, inspect live customer payloads, or store provider credentials.",
    "Do not promote private beta evidence to release-candidate, GA, or public support readiness claims.",
  ]),
  designRefs: Object.freeze([
    "docs/design/dogfood-yard.md",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/operators-sre.md#plan-40",
    "docs/design/launch-blocker-taxonomy.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/01-architecture-core.md#adr-0092",
    "docs/design/adr/02-identity-security.md#adr-0082",
    "docs/design/adr/03-data-plane.md#adr-0058",
  ]),
});

export function validateDogfoodPrivateBetaEvidence(
  target: Partial<MutableDogfoodPrivateBetaEvidence>,
): ValidationResult {
  const errors: string[] = [];
  const evidenceIds = new Set((target.requiredEvidence ?? []).map((item) => item.id));
  const missingEvidenceIds = new Set((target.missingEvidence ?? []).map((item) => item.id));

  if (target.issue !== "HOBO-462") {
    errors.push("issue must be HOBO-462");
  }
  if (target.phase !== "M2") {
    errors.push("phase must be M2");
  }
  if (target.milestoneGate !== "M2 Private beta proof") {
    errors.push("milestone gate must be M2 Private beta proof");
  }

  for (const evidence of target.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.evidenceSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must map evidence to ownerProject, evidenceSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before the M2 private beta gate can pass`);
    }
  }

  for (const scenarioId of REQUIRED_SCENARIO_IDS) {
    const scenario = target.scenarios?.find((candidate) => candidate.id === scenarioId);
    if (!scenario) {
      errors.push(`missing private beta scenario: ${scenarioId}`);
      continue;
    }
    if (!scenario.betaCohort) {
      errors.push(`${scenarioId} must name beta cohort`);
    }
    if ((scenario.fixtureIds ?? []).length === 0) {
      errors.push(`${scenarioId} must name fixture ids`);
    }
    if ((scenario.exitCriteria ?? []).length === 0) {
      errors.push(`${scenarioId} must name exit criteria`);
    }
    if (scenario.usesLiveCustomerData) {
      errors.push(`${scenarioId} uses live customer data`);
    }
    if (scenario.callsLiveProviders) {
      errors.push(`${scenarioId} calls live provider`);
    }
  }

  for (const channelId of REQUIRED_CHANNEL_IDS) {
    const channel = target.evidenceChannels?.find((candidate) => candidate.id === channelId);
    if (!channel) {
      errors.push(`missing evidence channel: ${channelId}`);
      continue;
    }
    if (!channel.ownerProject || !channel.redactionRule || !channel.privateBetaUse) {
      errors.push(`${channelId} must name ownerProject, redactionRule, and privateBetaUse`);
    }
  }

  for (const blocker of target.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker must name category, ownerProject, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceIds.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  for (const risk of target.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerRole || !risk.mitigation || !risk.followUpOrLaunchNote || !risk.revisitDate) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk must name ownerRole, mitigation, followUpOrLaunchNote, and revisitDate`);
    }
    if (risk.evidenceId && !evidenceIds.has(risk.evidenceId)) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk cites unknown evidence ${risk.evidenceId}`);
    }
  }

  for (const dependency of target.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.consumesEvidenceId || !dependency.cutlineImpact) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency must name ownerProject, consumesEvidenceId, and cutlineImpact`);
    }
    if (dependency.consumesEvidenceId && !evidenceIds.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency cites unknown evidence ${dependency.consumesEvidenceId}`);
    }
  }

  for (const followUp of target.followUpIssues ?? []) {
    if (!followUp.id || !followUp.ownerProject || !followUp.missingEvidenceId || !followUp.allowedReason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up must name ownerProject, missingEvidenceId, and allowedReason`);
    }
    if (followUp.missingEvidenceId && !missingEvidenceIds.has(followUp.missingEvidenceId)) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up is allowed only for missing evidence`);
    }
  }

  if (target.parentInitiativeSync?.launchRiskChanged && !target.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated when launch risk changes");
  }

  for (const [claimName, claimValue] of Object.entries(target.claimBoundaries ?? {})) {
    if (claimsForbiddenReadiness(String(claimValue))) {
      errors.push(`${claimName} cannot promote M2 private beta evidence to production readiness`);
    }
  }

  for (const scopeItem of target.scopeIn ?? []) {
    for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
      if (forbidden.pattern.test(scopeItem)) {
        errors.push(`scope creep rejected: ${forbidden.label}`);
      }
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function summarizePrivateBetaEvidence(record: DogfoodPrivateBetaEvidence): PrivateBetaEvidenceSummary {
  return Object.freeze({
    scenarioIds: record.scenarios.map((scenario) => scenario.id),
    cutlineEntries: Object.freeze([
      `${record.issue} records private beta Dogfood Yard evidence for the release cutline.`,
      ...record.crossProjectDependencies.map((dependency) => dependency.cutlineImpact),
    ]),
    supportEntries: Object.freeze(
      record.evidenceChannels
        .filter((channelEntry) => channelEntry.id === "support-debug" || channelEntry.id === "status-views")
        .map((channelEntry) => `${channelEntry.id}: support-safe ${channelEntry.privateBetaUse}`),
    ),
    betaReadinessEntries: Object.freeze(
      record.scenarios.map((scenarioEntry) => `${scenarioEntry.id} exit criteria: ${scenarioEntry.exitCriteria.join("; ")}`),
    ),
  });
}

export function cloneMutableDogfoodPrivateBetaEvidence(): MutableDogfoodPrivateBetaEvidence {
  return {
    ...DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE,
    requiredEvidence: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.requiredEvidence.map((item) => ({ ...item })),
    scenarios: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.scenarios.map((item) => ({ ...item })),
    evidenceChannels: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.evidenceChannels.map((item) => ({ ...item })),
    blockers: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.blockers.map((item) => ({ ...item })),
    acceptedRisks: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.acceptedRisks.map((item) => ({ ...item })),
    crossProjectDependencies: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.crossProjectDependencies.map((item) => ({ ...item })),
    missingEvidence: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.missingEvidence.map((item) => ({ ...item })),
    followUpIssues: DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.followUpIssues.map((item) => ({ ...item })),
    parentInitiativeSync: { ...DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.parentInitiativeSync },
    claimBoundaries: { ...DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.claimBoundaries },
    scopeIn: [...DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.scopeIn],
  };
}

export function classifyDogfoodPrivateBetaWork(description: string): WorkClassification {
  const normalized = description.toLowerCase();

  if (/\b(hosted yard runtime|runtime service|build the yard)\b/.test(normalized)) {
    return { owner: "Hosted Operations Runtime", inScope: false };
  }
  if (/\b(admin dashboard|admin console|admin navigation|admin ui)\b/.test(normalized)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\b(provider api|production provider|live cloud|live provider|real deploy)\b/.test(normalized)) {
    return { owner: "Providers/IaC/Deploy Runtime", inScope: false };
  }
  if (/\b(ga support|public support|support promise|support sla|ticket automation)\b/.test(normalized)) {
    return { owner: "V1 Launch Support Desk & Escalation", inScope: false };
  }

  return { owner: "V1 Dogfood Yard & Hosted Operations", inScope: true };
}

function evidence(id: string, ownerProject: string, evidenceSource: string, proves: string): RequiredEvidence {
  return Object.freeze({
    id,
    ownerProject,
    evidenceSource,
    proves,
    status: "accepted",
  });
}

function scenario(
  id: DogfoodScenarioId,
  yardMode: DogfoodPrivateBetaScenario["yardMode"],
  betaCohort: string,
  evidenceChannels: readonly EvidenceChannelId[],
): DogfoodPrivateBetaScenario {
  return Object.freeze({
    id,
    yardMode,
    betaCohort,
    fixtureIds: Object.freeze([`${id}-sanitized-fixture`, `${id}-evidence-ledger`, `${id}-owner-handoff`]),
    evidenceChannels: Object.freeze([...evidenceChannels]),
    exitCriteria: Object.freeze([
      "scenario evidence has owner, timestamp, fixture id, and cutline disposition",
      "support-safe bundle exists without provider secrets or live customer payloads",
    ]),
    supportHandoff: `${id} emits support-safe triage summary and owner route.`,
    usesLiveCustomerData: false,
    callsLiveProviders: false,
  });
}

function channel(
  id: EvidenceChannelId,
  ownerProject: string,
  redactionRule: string,
  privateBetaUse: string,
): EvidenceChannel {
  return Object.freeze({
    id,
    ownerProject,
    redactionRule,
    privateBetaUse,
  });
}

function dependency(
  ownerProject: string,
  consumesEvidenceId: string,
  cutlineImpact: string,
): CrossProjectDependency {
  return Object.freeze({
    ownerProject,
    consumesEvidenceId,
    cutlineImpact,
  });
}

function claimsForbiddenReadiness(value: string): boolean {
  return value.split(/[.;\n]/).some((statement) => {
    const claimsReadiness =
      /\b(production ready|production readiness|production hosted|production recovery|ga ready|ga readiness|ga support readiness|all customers|public support readiness|support sla|sla)\b/i.test(
        statement,
      );
    const deniesReadiness =
      /\b(no|not|never|without|cannot|can't|must not|does not|do not|is not|are not|waits? for|outside|out of scope)\b/i.test(
        statement,
      );

    return claimsReadiness && !deniesReadiness;
  });
}
