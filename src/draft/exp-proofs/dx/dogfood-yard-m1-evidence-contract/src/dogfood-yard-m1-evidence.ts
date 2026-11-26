const REQUIRED_SCENARIOS = [
  "hosted-yard-preview-path",
  "self-hosted-seed-handover",
  "yard-upgrade-and-rollback",
  "incident-debug-and-restore",
];

const REQUIRED_EVIDENCE = [
  "scenario-fixture-manifest",
  "safe-telemetry-bundle",
  "rollback-or-recovery-path",
  "gap-classification-ledger",
  "cutline-dependency-map",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  { label: "runtime", pattern: /build .*yard runtime|hosted yard runtime/i },
  { label: "production provider", pattern: /production provider|live provider/i },
  { label: "live customer data", pattern: /live customer data|customer payload/i },
  { label: "readiness", pattern: /mark .*readiness|claim .*readiness|beta readiness|ga readiness/i },
];

export class DogfoodYardM1EvidenceParseError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid Dogfood Yard M1 evidence record: ${errors.join("; ")}`);
    this.name = "DogfoodYardM1EvidenceParseError";
    this.errors = [...errors];
  }
}

export const DOGFOOD_YARD_M1_EVIDENCE = {
  schema: "hobo.dogfood-yard-m1-evidence/v1",
  issue: "HOBO-455",
  project: "V1 Dogfood Yard & Hosted Operations",
  phase: "M1",
  milestoneGate: "M1 Dogfood/alpha proof evidence is accepted for V1 Dogfood Yard & Hosted Operations.",
  goal:
    "Record dogfood/alpha evidence for hosted and self-hosted Yard operations without taking runtime, admin, bootstrap, release-note, or cutline implementation scope.",
  scopeIn: [
    "Define the M1 evidence bundle required for Dogfood Yard dogfood/alpha proof.",
    "Map each accepted M0 Dogfood Yard scenario to deterministic fixture evidence, safe telemetry, recovery proof, and release-cutline impact.",
    "Record blockers, accepted risks, and follow-up routes only where evidence is missing.",
    "Keep release-readiness status as an input to the release cutline, not a readiness claim in this package.",
  ],
  scopeOut: [
    "Do not build the Yard runtime, hosted operations runtime, admin console, bootstrap installer, or provider adapter.",
    "Do not call production providers, provision live cloud resources, or store provider credentials.",
    "Do not use live customer data in dogfood evidence, logs, traces, or support/debug bundles.",
    "Do not publish beta or GA readiness claims; route readiness impact to the release cutline.",
  ],
  requiredEvidence: [
    {
      id: "scenario-fixture-manifest",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      proves: "Every M0 dogfood scenario has a deterministic dogfood/alpha fixture and replay input.",
    },
    {
      id: "safe-telemetry-bundle",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      proves: "Logs, traces, status views, and debug evidence are correlated and redacted.",
    },
    {
      id: "rollback-or-recovery-path",
      ownerProject: "Bootstrap Installer",
      proves: "Upgrade, deploy, and incident paths name rollback, recovery, or pause evidence.",
    },
    {
      id: "gap-classification-ledger",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      proves: "Dogfood gaps are classified as beta blockers, launch notes, or follow-up work.",
    },
    {
      id: "cutline-dependency-map",
      ownerProject: "V1 Release Program & Cutline",
      proves: "Cross-project dependencies are visible to the release cutline and follow-up owners.",
    },
  ],
  scenarioEvidence: [
    {
      id: "hosted-yard-preview-path",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      evidence: ["preview fixture manifest", "status view snapshot", "redacted deploy trace"],
      cutlineImpact: "Supports hosted dogfood alpha readiness only after telemetry and status links exist.",
    },
    {
      id: "self-hosted-seed-handover",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      evidence: ["seed bootstrap transcript", "identity handover receipt", "seed retirement event"],
      cutlineImpact: "Blocks self-hosted alpha claims if seed retirement or identity handover evidence is missing.",
    },
    {
      id: "yard-upgrade-and-rollback",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      evidence: ["upgrade dry-run fixture", "rollback signal", "status-page impact classification"],
      cutlineImpact: "Routes upgrade safety to release notes until rollback evidence is accepted.",
    },
    {
      id: "incident-debug-and-restore",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      evidence: ["event-log restore fixture", "support-safe debug bundle", "operator diagnosis trace"],
      cutlineImpact: "Routes missing restore evidence to beta blocker or support launch note depending on severity.",
    },
  ],
  gapRoutes: [
    {
      decision: "beta-blocker",
      when: "A scenario cannot be reproduced, lacks rollback/recovery proof, or exposes unsafe evidence.",
      ownerProject: "V1 Release Program & Cutline",
    },
    {
      decision: "launch-note",
      when: "Evidence is accepted for alpha but needs customer-facing limitation wording.",
      ownerProject: "V1 Release Notes & Upgrade Guide",
    },
    {
      decision: "follow-up-work",
      when: "Evidence is missing outside Dogfood Yard ownership and has a named receiving project.",
      ownerProject: "Receiving owning initiative",
    },
  ],
  cutlineDependencies: [
    {
      owner: "V1 Release Program & Cutline",
      evidenceNeeded: "Release blocker, launch-note, and accepted-risk classifications for each scenario gap.",
    },
    {
      owner: "V1 Release Notes & Upgrade Guide",
      evidenceNeeded: "Known limitation and upgrade/rollback wording for dogfood-only evidence.",
    },
    {
      owner: "Admin Console",
      evidenceNeeded: "Status view and support-safe debug evidence handoff, not admin UI implementation.",
    },
    {
      owner: "Bootstrap Installer",
      evidenceNeeded: "Seed Yard bootstrap and handover evidence contract, not installer command implementation.",
    },
    {
      owner: "Reliability, Observability & Cost (FinOps)",
      evidenceNeeded: "Telemetry, trace, recovery, and status signal quality evidence.",
    },
  ],
  followUpPolicy: {
    createOnlyWhereEvidenceMissing: true,
    acceptedRiskRequiresOwner: true,
    releaseCutlineReceivesImpactSummary: true,
  },
};

export type DogfoodYardM1EvidenceRecord = typeof DOGFOOD_YARD_M1_EVIDENCE;

export type ParsedDogfoodYardM1Evidence = DogfoodYardM1EvidenceRecord & {
  readonly parsedDogfoodYardM1Evidence: true;
};

export function parseDogfoodYardM1Evidence(record: DogfoodYardM1EvidenceRecord): ParsedDogfoodYardM1Evidence {
  const errors = collectDogfoodYardM1EvidenceErrors(record);
  if (errors.length > 0) {
    throw new DogfoodYardM1EvidenceParseError(errors);
  }

  return Object.freeze({
    ...record,
    parsedDogfoodYardM1Evidence: true as const,
  });
}

function collectDogfoodYardM1EvidenceErrors(record: DogfoodYardM1EvidenceRecord): string[] {
  const errors: string[] = [];

  if (record.issue !== "HOBO-455") {
    errors.push("issue must be HOBO-455");
  }
  if (record.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (record.project !== "V1 Dogfood Yard & Hosted Operations") {
    errors.push("project must be V1 Dogfood Yard & Hosted Operations");
  }
  if (!/dogfood\/alpha proof/i.test(record.milestoneGate)) {
    errors.push("milestone gate must name dogfood/alpha proof");
  }

  const evidenceIds = new Set((record.requiredEvidence ?? []).map((evidence) => evidence.id));
  for (const id of REQUIRED_EVIDENCE) {
    if (!evidenceIds.has(id)) {
      errors.push(`missing required evidence ${id}`);
    }
  }

  const scenarioIds = new Set((record.scenarioEvidence ?? []).map((scenario) => scenario.id));
  for (const id of REQUIRED_SCENARIOS) {
    if (!scenarioIds.has(id)) {
      errors.push(`missing scenario evidence ${id}`);
    }
  }

  for (const scenario of record.scenarioEvidence ?? []) {
    if (!scenario.ownerProject || (scenario.evidence ?? []).length < 3 || !scenario.cutlineImpact) {
      errors.push(`${scenario.id ?? "<missing>"} must name owner, at least three evidence items, and cutline impact`);
    }
  }

  for (const route of record.gapRoutes ?? []) {
    if (!route.decision || !route.when || !route.ownerProject) {
      errors.push(`gap route ${route.decision ?? "<missing>"} must name decision, condition, and ownerProject`);
    }
  }

  if (!record.followUpPolicy?.createOnlyWhereEvidenceMissing) {
    errors.push("follow-up execution issues can be created only where evidence is missing");
  }

  const scopedText = [
    ...(record.scopeIn ?? []),
    ...(record.scenarioEvidence ?? []).flatMap((scenario) => [scenario.cutlineImpact, ...scenario.evidence]),
  ].join("\n");

  for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
    if (forbidden.pattern.test(scopedText)) {
      errors.push(`scope creep: ${forbidden.label}`);
    }
  }

  return errors;
}

export interface DogfoodM1Decision {
  owner: string;
  inScope: boolean;
}

export function classifyDogfoodM1Decision(text: string): DogfoodM1Decision {
  if (/\b(admin|status page controls|console)\b/i.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\b(bootstrap installer|installer command|seed command)\b/i.test(text)) {
    return { owner: "Bootstrap Installer", inScope: false };
  }
  if (/\b(release notes|known limitation|upgrade guide)\b/i.test(text)) {
    return { owner: "V1 Release Notes & Upgrade Guide", inScope: false };
  }
  if (/\b(public launch cutline|release cutline|accepted risk|blocker exception)\b/i.test(text)) {
    return { owner: "V1 Release Program & Cutline", inScope: false };
  }
  if (/\b(telemetry bundle|dogfood|scenario fixture|gap classification)\b/i.test(text)) {
    return { owner: "V1 Dogfood Yard & Hosted Operations", inScope: true };
  }

  return { owner: "V1 Dogfood Yard & Hosted Operations", inScope: false };
}
