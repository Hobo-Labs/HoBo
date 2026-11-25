const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;
const REQUIRED_STAGE_IDS = [
  "invite",
  "workspace-setup",
  "project-choice",
  "first-deploy",
  "failure-recovery",
  "support-handoff",
  "feedback-capture",
] as const;
const REQUIRED_SUCCESS_CRITERIA = [
  "time-to-first-success",
  "blocker-categories",
  "handoff-quality",
  "unresolved-risk",
] as const;
const VALID_PROOF_MODES = new Set([
  "design-record",
  "reference-fixture",
  "support-handoff",
  "feedback-record",
]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /automate onboarding/i,
  /onboarding automation/i,
  /live customer data/i,
  /support tooling/i,
  /support tool/i,
  /production customer/i,
  /provision real/i,
  /billing conversion/i,
  /customer support platform/i,
];

const PILOT_NOTE_CATEGORIES = [
  "support-gap",
  "product-ux",
  "docs-gap",
  "engineering-gap",
  "go-no-go-risk",
] as const;
type PilotNoteCategory = (typeof PILOT_NOTE_CATEGORIES)[number];
interface PilotNoteRoutingMatrix {
  readonly [K in PilotNoteCategory]: string;
}

export type CustomerOnboardingScriptRecord = typeof CUSTOMER_ONBOARDING_SCRIPT;

export type ParsedCustomerOnboardingScript = CustomerOnboardingScriptRecord & {
  readonly contractId: "hobo.customer-onboarding-script.v1";
  readonly parsed: true;
};

type CustomerOnboardingScriptParseResult =
  | {
      readonly ok: true;
      readonly errors: [];
      readonly script: ParsedCustomerOnboardingScript;
    }
  | {
      readonly ok: false;
      readonly errors: string[];
    };

export const CUSTOMER_ONBOARDING_SCRIPT = {
  issue: "HOBO-487",
  project: "Customer Onboarding",
  phase: "M0",
  goal:
    "Define the first-customer onboarding script and success criteria so private-beta pilots are comparable, consented, supportable, and route gaps to the right HoBo launch surface without automating onboarding.",
  personas: [
    {
      role: "pilot customer champion",
      need: "Understand the first HoBo journey, choose a sample or real project, and know when to stop for support.",
    },
    {
      role: "customer success lead",
      need: "Run a repeatable script that captures comparable first-success and blocker evidence across pilots.",
    },
    {
      role: "support engineer",
      need: "Receive precise stalled-stage, owner, safe next action, and evidence links without reading private project data.",
    },
    {
      role: "release owner",
      need: "Classify pilot outcomes into cutline, docs, support, product UX, or engineering follow-up before beta or GA claims.",
    },
  ],
  scopeIn: [
    "Scripted invite, preparation, workspace setup, sample-or-real project choice, first deploy proof, failure recovery, support handoff, and feedback capture.",
    "Customer-visible success criteria for time-to-first-success, blocker categories, handoff quality, and unresolved risk.",
    "Routing matrix for pilot notes into cutline, docs, Workspace & Onboarding UX, Support Workflow, or owning engineering project.",
    "Evidence and consent gate for future pilot usage without collecting sensitive customer project data in this proof package.",
  ],
  scopeOut: [
    "No onboarding automation, product wizard, customer-success platform, support queue, or support tool implementation.",
    "No live customer data capture, production customer onboarding, billing conversion, legal approval, or public launch claim.",
    "No real cloud provisioning, provider credential handling, deploy runtime, or first-deploy execution.",
    "No M1-M4 downstream implementation issue creation before this script contract is accepted.",
  ],
  boundaries: {
    service:
      "Customer Onboarding owns the script, pilot evidence fields, and handoff record; account, workspace, deploy, billing, and support services remain with their owning projects.",
    ux:
      "The script references the first-run path but does not build onboarding UI, product tours, dashboards, or notification copy.",
    security:
      "Pilot evidence avoids secrets, provider credentials, raw customer project data, and policy bypasses; consent and unsupported-state labels are mandatory before use.",
    support:
      "Support receives stage, blocker category, safe next action, owner, and evidence link; support SLAs, ticket queues, and remediation remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/workspace-onboarding-ux.md",
      reason: "Defines first-run activation stages, stalled states, and support handoff fields consumed by pilot scripts.",
    },
    {
      source: "docs/design/example-apps.md",
      reason: "Supplies accepted sample-app proof modes when a pilot chooses a sample project instead of a real project.",
    },
    {
      source: "docs/design/beta-pilot-feedback.md",
      reason: "Defines comparable feedback intake and release-candidate exit rules for private-beta evidence.",
    },
    {
      source: "docs/design/launch-demo-golden-path.md",
      reason: "Keeps launch demo assets separate from customer onboarding while reusing proof-mode language.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines support escalation language that the script may hand off to without creating support tooling.",
    },
    {
      source: "docs/design/launch-blocker-taxonomy.md",
      reason: "Supplies blocker, high-risk non-blocker, launch-note, and post-GA follow-up classes for pilot outcomes.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Customer Onboarding",
      consumes: "Owns first-customer script, stage prompts, success criteria, pilot evidence, and follow-up routing.",
      scopeBoundary: "This issue defines the script contract; it does not run or automate customer onboarding.",
    },
    {
      owner: "Workspace & Onboarding UX",
      consumes: "Provides first-run states, activation evidence, and recovery boundaries.",
      scopeBoundary: "Workspace UX remains owner of product rail design and instrumentation.",
    },
    {
      owner: "Example Apps",
      consumes: "Provides accepted sample project proof modes and command paths for comparable pilot scripts.",
      scopeBoundary: "Example apps remain reference fixtures, not customer-success workflow implementation.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses stalled-stage, blocker category, safe next action, and evidence links from the script.",
      scopeBoundary: "Support queues, SLAs, escalation automation, and remediation execution stay in Support Workflow.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Classifies unresolved risks and blocker deltas from pilot outcomes.",
      scopeBoundary: "Go/no-go decisions and risk acceptance remain release-program scope.",
    },
    {
      owner: "V1 Release Notes & Upgrade Guide",
      consumes: "Receives docs gaps, known limitations, and supportable troubleshooting notes.",
      scopeBoundary: "Release-note publication and upgrade guidance remain docs/release scope.",
    },
  ],
  scriptStages: [
    {
      id: "invite",
      owner: "customer success lead",
      prompt: "Confirm pilot persona, consent, support window, workspace invite, and success definition before exposure.",
      expectedEvidence: "Pilot intake record with persona, consent, support owner, and target workflow.",
      proofMode: "design-record",
      source: "docs/design/customer-onboarding.md#script-stages",
    },
    {
      id: "workspace-setup",
      owner: "pilot customer champion",
      prompt: "Create or join the workspace, confirm organization/project context, and record the first blocked or ready state.",
      expectedEvidence: "Workspace setup note with owner, state, missing prerequisite, and safe next action.",
      proofMode: "reference-fixture",
      source: "docs/design/workspace-onboarding-ux.md",
    },
    {
      id: "project-choice",
      owner: "customer success lead",
      prompt: "Choose the accepted sample path or a customer-owned project and record why the choice is supportable.",
      expectedEvidence: "Sample-or-real project decision with proof mode, data boundary, and unsupported-state note.",
      proofMode: "design-record",
      source: "docs/design/example-apps.md",
    },
    {
      id: "first-deploy",
      owner: "pilot customer champion",
      prompt: "Attempt the first deploy path only inside accepted proof boundaries and record command/output evidence or refusal.",
      expectedEvidence: "First deploy evidence link, refusal, or blocker category with proof mode.",
      proofMode: "reference-fixture",
      source: "docs/design/launch-demo-golden-path.md",
    },
    {
      id: "failure-recovery",
      owner: "support engineer",
      prompt: "If blocked, capture the stage, blocker category, safe retry/remediation, owner, and unsupported-state label.",
      expectedEvidence: "Recovery note with blocker category, owner, safe next action, and escalation threshold.",
      proofMode: "support-handoff",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "support-handoff",
      owner: "support engineer",
      prompt: "Handoff unresolved blockers with consented evidence, customer-safe summary, owner, and expected response path.",
      expectedEvidence: "Support handoff record with severity, owner, evidence link, and customer-safe message.",
      proofMode: "support-handoff",
      source: "docs/design/support-sla-channels.md",
    },
    {
      id: "feedback-capture",
      owner: "release owner",
      prompt: "Capture outcome, time-to-first-success, unresolved risks, blocker classes, and route each note to an owning project.",
      expectedEvidence: "Feedback record routed to cutline, docs, product UX, support, or engineering follow-up.",
      proofMode: "feedback-record",
      source: "docs/design/beta-pilot-feedback.md",
    },
  ],
  successCriteria: [
    {
      id: "time-to-first-success",
      owner: "customer success lead",
      measures: "Elapsed time from invite acceptance to first accepted proof evidence or explicit blocker.",
    },
    {
      id: "blocker-categories",
      owner: "release owner",
      measures: "Each stop is classified as blocker, high-risk non-blocker, support gap, docs gap, product UX gap, or engineering gap.",
    },
    {
      id: "handoff-quality",
      owner: "support engineer",
      measures: "Every handoff names stage, owner, safe next action, evidence link, and customer-safe message.",
    },
    {
      id: "unresolved-risk",
      owner: "release owner",
      measures: "Open risks carry owner, mitigation, launch-note or cutline route, and revisit condition.",
    },
  ],
  routingMatrix: {
    "support-gap": "Support Workflow",
    "product-ux": "Workspace & Onboarding UX",
    "docs-gap": "V1 Release Notes & Upgrade Guide",
    "engineering-gap": "Owning engineering project",
    "go-no-go-risk": "V1 Release Program & Cutline",
  } satisfies PilotNoteRoutingMatrix,
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "Customer onboarding automation, pilot execution, support tooling, or downstream implementation work must wait until this script contract is accepted.",
  },
};

export function canUseCustomerOnboardingScript({
  m0Accepted,
  scriptReviewed,
  supportOwnerAssigned,
  customerConsentCaptured,
}: {
  m0Accepted: boolean;
  scriptReviewed: boolean;
  supportOwnerAssigned: boolean;
  customerConsentCaptured: boolean;
}) {
  return Boolean(m0Accepted && scriptReviewed && supportOwnerAssigned && customerConsentCaptured);
}

export function classifyPilotNote({ category }: { category: PilotNoteCategory }) {
  return CUSTOMER_ONBOARDING_SCRIPT.routingMatrix[category];
}

export function validateCustomerOnboardingScript(
  scope: CustomerOnboardingScriptRecord,
): CustomerOnboardingScriptParseResult {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-487") {
    errors.push("issue must be HOBO-487");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("first-customer onboarding")) {
    errors.push("goal must name first-customer onboarding");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("at least four personas are required");
  }
  if ((scope.scopeIn ?? []).length < 4) {
    errors.push("scope in must have at least four entries");
  }
  if ((scope.scopeOut ?? []).length < 4) {
    errors.push("scope out must have at least four entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const stageIds = (scope.scriptStages ?? []).map((stage) => stage.id);
  for (const id of REQUIRED_STAGE_IDS) {
    if (!stageIds.includes(id)) {
      errors.push(`missing script stage ${id}`);
    }
  }
  for (const stage of scope.scriptStages ?? []) {
    if (!stage.owner) {
      errors.push(`stage ${stage.id} must name an owner`);
    }
    if (!stage.expectedEvidence) {
      errors.push(`stage ${stage.id} must name expected evidence`);
    }
    if (!VALID_PROOF_MODES.has(stage.proofMode)) {
      errors.push(`stage ${stage.id} must declare a valid proof mode`);
    }
    if (!stage.source) {
      errors.push(`stage ${stage.id} must declare a source`);
    }
  }

  const criterionIds = (scope.successCriteria ?? []).map((criterion) => criterion.id);
  for (const id of REQUIRED_SUCCESS_CRITERIA) {
    if (!criterionIds.includes(id)) {
      errors.push(`missing success criterion ${id}`);
    }
  }

  for (const category of PILOT_NOTE_CATEGORIES) {
    if (!scope.routingMatrix?.[category]) {
      errors.push(`missing pilot note route ${category}`);
    }
  }

  if ((scope.dependencies ?? []).length < 6) {
    errors.push("dependencies must map onboarding, examples, beta feedback, demo, support, and blocker taxonomy");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }
  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors,
    };
  }

  return {
    ok: true,
    errors: [],
    script: {
      ...scope,
      contractId: "hobo.customer-onboarding-script.v1",
      parsed: true,
    },
  };
}
