export const REQUIRED_TRANSCRIPT_CASES = [
  "adopt-in-place",
  "still-external",
  "safe-additive-migration",
  "blocked-destructive-contract",
  "snapshot-restore",
  "cross-cloud-export-import-cutover",
] as const;

export const REQUIRED_MIGRATION_EVENTS = [
  "migration.Planned",
  "migration.SnapshotTaken",
  "migration.PhaseApplied",
  "migration.PhaseApplied",
  "migration.PhaseApplied",
  "migration.Verified",
  "migration.RolledBack",
  "migration.Exported",
  "migration.Imported",
  "migration.CutOver",
] as const;

export const REQUIRED_GATEKEEPER_BLOCKERS = [
  "Gatekeeper",
  "Pact compatibility",
  "can-deploy",
] as const;

const REQUIRED_SAFE_NEXT_STEPS = [
  "keep the old field dual-published",
  "apply expand/backfill only",
  "rerun pact compatibility and can-deploy before contract",
] as const;

type TranscriptCase = (typeof REQUIRED_TRANSCRIPT_CASES)[number];
type MigrationEventType = (typeof REQUIRED_MIGRATION_EVENTS)[number];
type GatekeeperBlocker = (typeof REQUIRED_GATEKEEPER_BLOCKERS)[number];
type MigrationPhase = "expand" | "backfill" | "contract";
type ProofMode = "reference-fixture" | "simulated-reference" | "design-record";

export interface MigrationResultEnvelope {
  status: "ok" | "blocked" | "rolled-back";
  code: `migration.${string}`;
  humanMessage: string;
  remediation: string;
  proofMode: ProofMode;
  fixtureId: `hobo-575.${string}`;
}

// domain-view: parse-produced draft-proof record; its wire form is the GateOutcome proto message in data-models/.
export interface GateOutcome {
  blocked: boolean;
  blockers: GatekeeperBlocker[];
  safeNextSteps: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the TranscriptStep proto message in data-models/.
export interface TranscriptStep {
  case: TranscriptCase;
  actor: string;
  command: `hobo ${string}`;
  output: string;
  requestId: string;
  eventTypes: MigrationEventType[];
  gateOutcome: GateOutcome;
  resultEnvelope: MigrationResultEnvelope;
  notes: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the MigrationEventFixture proto message in data-models/.
export interface MigrationEventFixture {
  type: MigrationEventType;
  fixtureId: `hobo-575.migration.${string}`;
  proofMode: "reference-fixture";
  aggregateId: `migration/${string}`;
  payload: {
    phase?: MigrationPhase;
    source?: string;
    target?: string;
    snapshotId?: string;
    verification?: string;
    adoptedResources?: string[];
    stillExternalResources?: string[];
    cutoverWindow?: string;
  };
}

// domain-view: parse-produced draft-proof record; its wire form is the MigrationRequest proto message in data-models/.
export interface MigrationRequest {
  requestId: string;
  command: `hobo ${string}`;
  source: {
    kind: "terraform-state";
    uri: string;
  };
  target: {
    camp: string;
    cloud: "azure" | "aws";
  };
  phases: MigrationPhase[];
  adoptedResources: string[];
  stillExternalResources: string[];
  safety: {
    requireSnapshot: boolean;
    requireGatekeeper: boolean;
    requirePactCompatibility: boolean;
    requireCanDeploy: boolean;
    allowDestructiveContract: false;
  };
}

// domain-view: parse-produced draft-proof record; its wire form is the MigrationExample proto message in data-models/.
export interface MigrationExample {
  request: MigrationRequest;
  resultEnvelope: MigrationResultEnvelope;
}

// domain-view: parse-produced draft-proof record; its wire form is the MigrationExamples proto message in data-models/.
export interface MigrationExamples {
  sdk: MigrationExample & {
    snippet: string;
  };
  api: MigrationExample & {
    method: "POST";
    path: "/v1/migrations";
  };
}

// domain-view: parse-produced draft-proof record; its wire form is the CliMigrationTranscriptPrototype proto message in data-models/.
export interface CliMigrationTranscriptPrototype {
  issue: "HOBO-575";
  parentIssue: "HOBO-566";
  phase: "M2";
  targetPackage: "src/draft/exp-proofs/dx/cli-migration-transcript-prototype";
  proofNote: "docs/design/proofs/cli-migration-transcript-prototype/README.md";
  designAnchors: string[];
  transcriptSteps: TranscriptStep[];
  eventFixtures: MigrationEventFixture[];
  examples: MigrationExamples;
  scopeBoundary: {
    in: string[];
    out: string[];
  };
}

export type ParsedCliMigrationTranscriptPrototype = CliMigrationTranscriptPrototype & {
  readonly parsed: true;
};

const migrationRequest: MigrationRequest = {
  requestId: "migration-request/adopt-billing-db",
  command: "hobo import terraform ./brownfield/billing-db.tfstate --migration billing-db --json",
  source: {
    kind: "terraform-state",
    uri: "fixtures/input/billing-db.tfstate.json",
  },
  target: {
    camp: "prod",
    cloud: "aws",
  },
  phases: ["expand", "backfill", "contract"],
  adoptedResources: ["azure.postgres.billing-db"],
  stillExternalResources: ["stripe.customer-ledger"],
  safety: {
    requireSnapshot: true,
    requireGatekeeper: true,
    requirePactCompatibility: true,
    requireCanDeploy: true,
    allowDestructiveContract: false,
  },
};

const readyForCutover: MigrationResultEnvelope = {
  status: "ok",
  code: "migration.ready_for_cutover",
  humanMessage: "Migration imported, verified, and ready for cutover.",
  remediation: "Run hobo up --migration billing-db --cutover-window approved-window --json.",
  proofMode: "reference-fixture",
  fixtureId: "hobo-575.migration.ready-for-cutover",
};

export const CLI_MIGRATION_TRANSCRIPT_PROTOTYPE: CliMigrationTranscriptPrototype = {
  issue: "HOBO-575",
  parentIssue: "HOBO-566",
  phase: "M2",
  targetPackage: "src/draft/exp-proofs/dx/cli-migration-transcript-prototype",
  proofNote: "docs/design/proofs/cli-migration-transcript-prototype/README.md",
  designAnchors: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/sdk-api.md#plan-02",
    "docs/design/control-plane.md#plan-04",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/data-plane.md#plan-32",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
  ],
  transcriptSteps: [
    {
      case: "adopt-in-place",
      actor: "platform engineer",
      command: "hobo import terraform ./brownfield/billing-db.tfstate --adopt --json",
      output: "resource.Adopted keeps azure.postgres.billing-db authoritative-external while the HoBo plan models ownership debt.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.Planned"],
      gateOutcome: {
        blocked: false,
        blockers: [],
        safeNextSteps: ["snapshot before any phase applies"],
      },
      resultEnvelope: {
        status: "ok",
        code: "migration.adopted",
        humanMessage: "Terraform state imported as adopted external resource.",
        remediation: "Run hobo plan --migration billing-db --json to preview expand/backfill/contract.",
        proofMode: "reference-fixture",
        fixtureId: "hobo-575.migration.adopted",
      },
      notes: ["No real Terraform import runs; fixture state is parsed as a transcript proof."],
    },
    {
      case: "still-external",
      actor: "app developer",
      command: "hobo plan --migration billing-db --show-external --json",
      output: "stripe.customer-ledger remains authoritative-external and is excluded from cutover ownership.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.Planned"],
      gateOutcome: {
        blocked: false,
        blockers: [],
        safeNextSteps: ["keep external debt marker visible in the plan"],
      },
      resultEnvelope: {
        status: "ok",
        code: "migration.external_preserved",
        humanMessage: "Plan preserves still-external resources.",
        remediation: "Review non-portable debt before cutover.",
        proofMode: "reference-fixture",
        fixtureId: "hobo-575.migration.external-preserved",
      },
      notes: ["External resources stay explicit instead of being silently adopted."],
    },
    {
      case: "safe-additive-migration",
      actor: "DevOps operator",
      command: "hobo up --migration billing-db --phase expand --phase backfill --json",
      output: "expand adds nullable invoice_status, backfill populates it, and Gatekeeper allows the additive shape.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.SnapshotTaken", "migration.PhaseApplied", "migration.PhaseApplied", "migration.Verified"],
      gateOutcome: {
        blocked: false,
        blockers: [],
        safeNextSteps: ["continue to contract only after Pact compatibility stays green"],
      },
      resultEnvelope: {
        status: "ok",
        code: "migration.additive_applied",
        humanMessage: "Expand and backfill phases applied from fixture evidence.",
        remediation: "Run hobo verify --migration billing-db --json.",
        proofMode: "reference-fixture",
        fixtureId: "hobo-575.migration.additive-applied",
      },
      notes: ["Snapshot evidence is mandatory before phase application."],
    },
    {
      case: "blocked-destructive-contract",
      actor: "release manager",
      command: "hobo up --migration billing-db --phase contract --json",
      output: "breaking schema change blocked by Gatekeeper because Pact compatibility and can-deploy are not satisfied.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.PhaseApplied"],
      gateOutcome: {
        blocked: true,
        blockers: [...REQUIRED_GATEKEEPER_BLOCKERS],
        safeNextSteps: [...REQUIRED_SAFE_NEXT_STEPS],
      },
      resultEnvelope: {
        status: "blocked",
        code: "migration.contract_blocked",
        humanMessage: "Contract phase would remove a field still used by consumers.",
        remediation: "Keep dual-publish active, apply safe phases only, then rerun can-deploy.",
        proofMode: "reference-fixture",
        fixtureId: "hobo-575.migration.contract-blocked",
      },
      notes: ["Destructive contract is modeled only as a blocked transcript result."],
    },
    {
      case: "snapshot-restore",
      actor: "SRE",
      command: "hobo up --migration billing-db --rollback --to snapshot/hobo-575-pre-backfill --json",
      output: "snapshot restore replays the read-store projection to the pre-backfill point and emits rollback evidence.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.RolledBack"],
      gateOutcome: {
        blocked: false,
        blockers: [],
        safeNextSteps: ["verify replayed projection before retrying backfill"],
      },
      resultEnvelope: {
        status: "rolled-back",
        code: "migration.rolled_back",
        humanMessage: "Migration restored to the pre-backfill snapshot.",
        remediation: "Rerun hobo verify --migration billing-db --from-snapshot snapshot/hobo-575-pre-backfill.",
        proofMode: "reference-fixture",
        fixtureId: "hobo-575.migration.rolled-back",
      },
      notes: ["Rollback is a fixture transcript, not a live database restore."],
    },
    {
      case: "cross-cloud-export-import-cutover",
      actor: "platform engineer",
      command: "hobo up --migration billing-db --export azure --import aws --cutover-window approved-window --json",
      output: "exported Azure snapshot imports into AWS, verification passes, and cutover publishes the new authoritative owner.",
      requestId: migrationRequest.requestId,
      eventTypes: ["migration.Exported", "migration.Imported", "migration.CutOver"],
      gateOutcome: {
        blocked: false,
        blockers: [],
        safeNextSteps: ["record cutover receipt and keep original snapshot for rollback window"],
      },
      resultEnvelope: readyForCutover,
      notes: ["Cross-cloud work is export/import/cutover transcript evidence only."],
    },
  ],
  eventFixtures: [
    {
      type: "migration.Planned",
      fixtureId: "hobo-575.migration.planned",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        source: "terraform-state",
        target: "aws/prod",
        adoptedResources: ["azure.postgres.billing-db"],
        stillExternalResources: ["stripe.customer-ledger"],
      },
    },
    {
      type: "migration.SnapshotTaken",
      fixtureId: "hobo-575.migration.snapshot-taken",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        snapshotId: "snapshot/hobo-575-pre-backfill",
      },
    },
    {
      type: "migration.PhaseApplied",
      fixtureId: "hobo-575.migration.phase-expand",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        phase: "expand",
      },
    },
    {
      type: "migration.PhaseApplied",
      fixtureId: "hobo-575.migration.phase-backfill",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        phase: "backfill",
      },
    },
    {
      type: "migration.PhaseApplied",
      fixtureId: "hobo-575.migration.phase-contract",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        phase: "contract",
      },
    },
    {
      type: "migration.Verified",
      fixtureId: "hobo-575.migration.verified",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        verification: "Gatekeeper, Pact compatibility, and can-deploy are green for additive phases.",
      },
    },
    {
      type: "migration.RolledBack",
      fixtureId: "hobo-575.migration.rolled-back",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        snapshotId: "snapshot/hobo-575-pre-backfill",
      },
    },
    {
      type: "migration.Exported",
      fixtureId: "hobo-575.migration.exported",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        source: "azure/prod",
      },
    },
    {
      type: "migration.Imported",
      fixtureId: "hobo-575.migration.imported",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        target: "aws/prod",
      },
    },
    {
      type: "migration.CutOver",
      fixtureId: "hobo-575.migration.cut-over",
      proofMode: "reference-fixture",
      aggregateId: "migration/billing-db",
      payload: {
        cutoverWindow: "approved-window",
      },
    },
  ],
  examples: {
    sdk: {
      snippet:
        "await hobo.migrations.plan({ requestId: 'migration-request/adopt-billing-db', source: terraformState('./brownfield/billing-db.tfstate'), target: camp('prod').cloud('aws'), phases: ['expand', 'backfill', 'contract'] })",
      request: cloneMigrationRequest(migrationRequest),
      resultEnvelope: { ...readyForCutover },
    },
    api: {
      method: "POST",
      path: "/v1/migrations",
      request: cloneMigrationRequest(migrationRequest),
      resultEnvelope: { ...readyForCutover },
    },
  },
  scopeBoundary: {
    in: [
      "terminal-first transcript shape",
      "reference migration event fixtures",
      "SDK/API request and result envelope examples",
      "Gatekeeper, Pact compatibility, and can-deploy blocking transcript",
    ],
    out: [
      "real Terraform import",
      "live databases",
      "automatic cross-engine remodelling",
      "irreversible destructive migrations",
      "hand-written .down migration claims",
    ],
  },
};

function cloneMigrationRequest(request: MigrationRequest): MigrationRequest {
  return {
    ...request,
    source: { ...request.source },
    target: { ...request.target },
    phases: [...request.phases],
    adoptedResources: [...request.adoptedResources],
    stillExternalResources: [...request.stillExternalResources],
    safety: { ...request.safety },
  };
}

export function parseCliMigrationTranscriptPrototype(
  input: CliMigrationTranscriptPrototype,
): ParsedCliMigrationTranscriptPrototype {
  rejectMigrationScopeCreep(input.scopeBoundary.in.join(" "));

  if (input.issue !== "HOBO-575") {
    throw new Error("HOBO-575 proof must identify issue HOBO-575");
  }

  assertExactSequence(
    input.transcriptSteps.map((step) => step.case),
    REQUIRED_TRANSCRIPT_CASES,
    "transcript cases",
  );
  assertExactSequence(
    input.eventFixtures.map((event) => event.type),
    REQUIRED_MIGRATION_EVENTS,
    "migration events",
  );

  const blockedContract = input.transcriptSteps.find((step) => step.case === "blocked-destructive-contract");
  if (!blockedContract?.gateOutcome.blocked) {
    throw new Error("blocked destructive contract case must fail closed");
  }
  assertExactSequence(blockedContract.gateOutcome.blockers, REQUIRED_GATEKEEPER_BLOCKERS, "gate blockers");
  assertExactSequence(blockedContract.gateOutcome.safeNextSteps, REQUIRED_SAFE_NEXT_STEPS, "safe next steps");

  const parity = assertMigrationExampleParity(input.examples);
  if (!parity.equivalent) {
    throw new Error("SDK and API examples must share the same migration request and result envelope");
  }

  for (const step of input.transcriptSteps) {
    if (!step.command.startsWith("hobo ")) {
      throw new Error(`${step.case} must be terminal-first`);
    }
    if (!step.resultEnvelope.code.startsWith("migration.")) {
      throw new Error(`${step.case} must use a migration result envelope`);
    }
  }

  return {
    ...input,
    parsed: true,
  };
}

export interface MigrationExampleParity {
  equivalent: boolean;
  requestId: string;
  resultCode: string;
}

export function assertMigrationExampleParity(examples: MigrationExamples): MigrationExampleParity {
  const requestEqual = JSON.stringify(examples.sdk.request) === JSON.stringify(examples.api.request);
  const resultEqual = JSON.stringify(examples.sdk.resultEnvelope) === JSON.stringify(examples.api.resultEnvelope);

  return {
    equivalent: requestEqual && resultEqual,
    requestId: examples.sdk.request.requestId,
    resultCode: examples.sdk.resultEnvelope.code,
  };
}

export function rejectMigrationScopeCreep(text: string): void {
  const normalized = text.toLowerCase();

  if (/real terraform import|production state|terraform import against/.test(normalized)) {
    throw new Error("real Terraform import is scope-out");
  }
  if (/live database|customer data/.test(normalized)) {
    throw new Error("live databases are scope-out");
  }
  if (/automatic cross-engine remodelling|automatically remodel|cross-engine remodel/.test(normalized)) {
    throw new Error("automatic cross-engine remodelling is scope-out");
  }
  if (/irreversible destructive migration|irreversible destruction/.test(normalized)) {
    throw new Error("irreversible destructive migrations are scope-out");
  }
  if (/hand-written .*\.down|hand written .*\.down|\.down migration/.test(normalized)) {
    throw new Error("hand-written down migrations are scope-out");
  }
}

function assertExactSequence<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  label: string,
): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} must match the accepted HOBO-575 sequence`);
  }
}
