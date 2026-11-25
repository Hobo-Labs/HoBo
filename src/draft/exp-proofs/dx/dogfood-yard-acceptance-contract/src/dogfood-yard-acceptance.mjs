const REQUIRED_SCENARIOS = [
  "hosted-yard-preview-path",
  "self-hosted-seed-handover",
  "yard-upgrade-and-rollback",
  "incident-debug-and-restore",
];
const REQUIRED_EVIDENCE_CHANNELS = [
  "logs",
  "traces",
  "status-views",
  "support-debug",
  "rollback-signals",
];
const REQUIRED_OWNER_CATEGORIES = ["operational", "admin", "bootstrap", "reliability"];
const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /build the .*yard/i,
  /hosted yard runtime/i,
  /production provider/i,
  /provider credential/i,
  /live customer data/i,
  /live customer deploy/i,
  /mark .*readiness/i,
];

export const DOGFOOD_YARD_ACCEPTANCE = {
  schema: "hobo.dogfood-yard-acceptance/v1",
  issue: "HOBO-403",
  project: "V1 Dogfood Yard & Hosted Operations",
  phase: "M0",
  goal:
    "Define Dogfood Yard acceptance scenarios and telemetry evidence so hosted and self-hosted Yard claims have explicit proof before beta readiness.",
  personas: [
    {
      role: "platform engineer dogfooder",
      need: "Stand up and operate a self-hosted Yard without private setup knowledge.",
    },
    {
      role: "hosted operations owner",
      need: "Prove the managed hosted Yard can run preview and default-provider workflows with inspectable evidence.",
    },
    {
      role: "sre/support responder",
      need: "Debug failed Yard operations from logs, traces, status views, and support-safe evidence.",
    },
    {
      role: "release readiness owner",
      need: "Classify dogfood gaps as beta blockers, launch notes, or follow-up work.",
    },
  ],
  workflows: [
    "Hosted Yard default-provider preview from first project to first deploy evidence.",
    "Self-host seed Yard bootstrap, Identity handover, and seed retirement evidence.",
    "Yard upgrade with rollback signal and status-page impact classification.",
    "Incident debug and restore-from-log drill without live customer data.",
  ],
  scenarios: [
    {
      id: "hosted-yard-preview-path",
      yardMode: "hosted",
      proves: "Hosted cloud can accept a first project, infer a Camp, run a preview deploy, and expose status evidence.",
    },
    {
      id: "self-hosted-seed-handover",
      yardMode: "self-hosted",
      proves: "A local seed Yard can bootstrap the real Yard, import provenance, hand over Identity, and retire the seed.",
    },
    {
      id: "yard-upgrade-and-rollback",
      yardMode: "hosted-or-self-hosted",
      proves: "Yard upgrades ride the normal deploy gate and emit rollback-ready signals.",
    },
    {
      id: "incident-debug-and-restore",
      yardMode: "hosted-or-self-hosted",
      proves: "Operators can diagnose and restore from event-log evidence without customer-data leakage.",
    },
  ],
  scopeOut: [
    "Do not build the Yard or any hosted operations runtime in this issue.",
    "Do not provision live cloud resources, store provider credentials, or call production provider APIs.",
    "Do not use live customer data for proof or support/debug fixtures.",
    "Do not mark beta or GA readiness; this issue defines the acceptance evidence required later.",
  ],
  dependencies: [
    {
      source: "docs/design/control-plane.md#plan-04",
      reason: "Defines the Yard control plane, self-host bootstrap ordering, and seed-to-real Yard handover.",
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines hosted versus self-hosted HoBo cloud flows and the DevOps self-host journey.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines inspect, logs, status, and command evidence users expect around Yard operations.",
    },
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines telemetry, traces, SLO signals, rollback evidence, and operational status inputs.",
    },
    {
      source: "docs/design/operators-sre.md#plan-40",
      reason: "Defines support, SRE, incident, and runbook handoff loops for Yard operations.",
    },
    {
      source: "docs/design/adr/01-architecture-core.md#adr-0092",
      reason: "Pins self-host bootstrap as disposable seed Yard, provenance import, and Identity handover.",
    },
  ],
  evidenceChannels: [
    {
      id: "logs",
      ownerCategory: "operational",
      proves: "Yard bootstrap, deploy, upgrade, incident, and recovery steps produce correlated operator-readable logs.",
      redactionRule: "No provider secrets, live customer payloads, or tenant data may appear in log fixtures.",
    },
    {
      id: "traces",
      ownerCategory: "reliability",
      proves: "Yard operations preserve request/deploy correlation across control-plane boundaries.",
      redactionRule: "Trace attributes stay to ids, timings, and state transitions; no customer payload spans.",
    },
    {
      id: "status-views",
      ownerCategory: "admin",
      proves: "Hosted and self-hosted Yard health, degraded state, maintenance, and readiness are visible to operators.",
      redactionRule: "Status views expose aggregate state and evidence links, not raw customer data.",
    },
    {
      id: "support-debug",
      ownerCategory: "admin",
      proves: "Support can inspect safe evidence bundles for bootstrap, deploy, incident, and recovery handoff.",
      redactionRule: "Debug bundles must be support-safe and tenant-scoped before export.",
    },
    {
      id: "rollback-signals",
      ownerCategory: "bootstrap",
      proves: "Yard upgrade, deploy failure, and restore paths emit rollback-ready state and operator action cues.",
      redactionRule: "Rollback evidence records state ids and prior Set/provenance pointers, not provider credentials.",
    },
  ],
  ownerMappings: [
    {
      category: "operational",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      consumes: "Owns hosted/self-hosted scenario acceptance and dogfood gap classification.",
      scopeBoundary: "Does not implement Yard runtime or mark launch readiness.",
    },
    {
      category: "admin",
      ownerProject: "Admin Console",
      consumes: "Owns status, support-safe debug, and operator visibility requirements.",
      scopeBoundary: "Does not build admin UI or support tooling in this M0 issue.",
    },
    {
      category: "bootstrap",
      ownerProject: "Bootstrap Installer",
      consumes: "Owns seed Yard bootstrap, handover, and local/self-host install evidence.",
      scopeBoundary: "Does not implement installer or bootstrap commands here.",
    },
    {
      category: "reliability",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      consumes: "Owns telemetry, trace correlation, SLO, rollback, and restore evidence quality.",
      scopeBoundary: "Does not create observability pipelines or production SLO gates.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 dogfood evidence, admin UI, bootstrap installer, and reliability implementation issues wait for accepted M0 evidence scope.",
  },
};

export function canCreateDogfoodFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateDogfoodYardAcceptance(record) {
  const errors = [];

  if (record.issue !== "HOBO-403") {
    errors.push("issue must be HOBO-403");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.goal?.toLowerCase().includes("dogfood yard")) {
    errors.push("goal must name Dogfood Yard");
  }
  if ((record.personas ?? []).length < 4) {
    errors.push("at least four dogfood personas are required");
  }
  if ((record.workflows ?? []).length < 4) {
    errors.push("at least four dogfood workflows are required");
  }

  const scenarioIds = new Set((record.scenarios ?? []).map((scenario) => scenario.id));
  for (const scenario of REQUIRED_SCENARIOS) {
    if (!scenarioIds.has(scenario)) {
      errors.push(`missing scenario ${scenario}`);
    }
  }

  if ((record.scopeOut ?? []).length < 4) {
    errors.push("scope out must protect the build, provider, customer-data, and readiness boundaries");
  }
  if ((record.dependencies ?? []).length < 6) {
    errors.push("design dependencies must map to Yard, walkthrough, DX, reliability, SRE, and bootstrap ADR sources");
  }
  const channelIds = new Set((record.evidenceChannels ?? []).map((channel) => channel.id));
  for (const channel of REQUIRED_EVIDENCE_CHANNELS) {
    if (!channelIds.has(channel)) {
      errors.push(`missing evidence channel ${channel}`);
    }
  }
  for (const channel of record.evidenceChannels ?? []) {
    if (!channel.ownerCategory || !channel.proves || !channel.redactionRule) {
      errors.push(`evidence channel ${channel.id ?? "<missing>"} must name owner, proof, and redaction rule`);
    }
  }
  const ownerCategories = new Set((record.ownerMappings ?? []).map((mapping) => mapping.category));
  for (const category of REQUIRED_OWNER_CATEGORIES) {
    if (!ownerCategories.has(category)) {
      errors.push(`missing owner category ${category}`);
    }
  }
  for (const mapping of record.ownerMappings ?? []) {
    if (!mapping.ownerProject || !mapping.consumes || !mapping.scopeBoundary) {
      errors.push(`owner mapping ${mapping.category ?? "<missing>"} must name ownerProject, consumption, and scope boundary`);
    }
  }
  const scopedTexts = [
    ...(record.scopeIn ?? []),
    ...(record.scenarios ?? []).map((scenario) => scenario.proves ?? ""),
    ...(record.evidenceChannels ?? []).map((channel) => channel.proves ?? ""),
  ];
  for (const text of scopedTexts) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push(`scope creep: ${text}`);
    }
  }
  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}
