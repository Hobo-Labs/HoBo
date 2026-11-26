import { isJsonObject } from "./json.js";
export const REQUIRED_LAUNCH_PERSONAS = [
  "app developer",
  "platform engineer",
  "admin",
  "support/operator",
  "security reviewer",
  "customer/buyer",
];

export const launchE2ePersonaMatrix = {
  issue: "HOBO-500",
  project: "E2E Test Matrix",
  phase: "M0",
  goal:
    "Define the v1 launch e2e persona matrix and pass-fail thresholds so beta and GA readiness depend on named user journeys, evidence, and fallback rules instead of a generic gate.",
  ownership: {
    issueOwned: true,
    sourceIssue: "HOBO-500",
    relatedScopeIssue: "HOBO-438",
    relatedOutcomeIssues: ["HOBO-508", "HOBO-509"],
  },
  journeys: [
    {
      id: "app-developer-first-deploy",
      persona: "app developer",
      environment: "release-candidate workspace with local CLI and mocked provider apply",
      fixtureData: ["hello-bindle manifest", "pre-launch outcome baseline", "safe-test fixture"],
      boundary: {
        mocked: ["cloud provider apply", "billing write", "product notification delivery"],
        live: ["CLI command transcript", "contract validator", "local browser smoke"],
      },
      expectedEvidence: ["safe-test-result-pack", "plan-diff-baseline", "launch-status-snapshot"],
      threshold: {
        pass: "Collect, preview, approve, and reach simulated launch status with no launch blockers.",
        fail: "Missing plan/diff, unsafe approval, unknown fixture, or unresolved launch blocker.",
        blocksBeta: true,
      },
    },
    {
      id: "platform-engineer-policy-review",
      persona: "platform engineer",
      environment: "staged Yard fixture with policy, quota, and cost gates enabled",
      fixtureData: ["yard policy pack", "cost-cap baseline", "topology diff"],
      boundary: {
        mocked: ["provider quota API", "live infrastructure mutation"],
        live: ["policy decision fixture", "topology contract", "cost guardrail evaluation"],
      },
      expectedEvidence: ["policy-decision", "cost-guardrail", "topology-summary"],
      threshold: {
        pass: "Risky actions are blocked or routed to approval with cost and topology evidence.",
        fail: "Policy denial, quota breach, or cost-cap ambiguity is hidden from launch decision.",
        blocksBeta: true,
      },
    },
    {
      id: "admin-member-entitlement-review",
      persona: "admin",
      environment: "tenant admin fixture with RBAC, entitlement, and audit boundaries",
      fixtureData: ["workspace members", "role assignments", "entitlement state"],
      boundary: {
        mocked: ["identity provider write", "payment processor"],
        live: ["RBAC evaluator fixture", "audit event validator"],
      },
      expectedEvidence: ["rbac-decision", "entitlement-snapshot", "admin-audit-record"],
      threshold: {
        pass: "Admin can verify who can launch, approve, pause, or inspect before beta claim.",
        fail: "Privilege, entitlement, or audit gaps are not visible to the admin.",
        blocksBeta: true,
      },
    },
    {
      id: "support-operator-failure-recovery",
      persona: "support/operator",
      environment: "release support fixture with failed deploy, rollback, and escalation states",
      fixtureData: ["failed deployment event", "rollback expectation", "support runbook"],
      boundary: {
        mocked: ["customer support system", "provider incident API"],
        live: ["failure classifier", "support export contract", "rollback decision record"],
      },
      expectedEvidence: ["failure-classification", "support-handoff", "rollback-decision"],
      threshold: {
        pass: "Support can explain status, next owner, rollback path, and customer-safe message.",
        fail: "Failure route is unknown, unactionable, or missing customer-safe evidence.",
        blocksBeta: true,
      },
    },
    {
      id: "security-reviewer-launch-claim",
      persona: "security reviewer",
      environment: "security verification fixture with secret, provenance, and access checks",
      fixtureData: ["capability manifest", "provenance attestation", "secretless config"],
      boundary: {
        mocked: ["external vulnerability scanner", "cloud IAM write"],
        live: ["secret scanner fixture", "provenance verifier", "capability policy validator"],
      },
      expectedEvidence: ["secretless-proof", "provenance-check", "capability-scope-decision"],
      threshold: {
        pass: "No stored secret, unscoped capability, or unproven artifact reaches launch claim.",
        fail: "Security evidence is missing, stale, or contradicted by fixture output.",
        blocksBeta: true,
      },
    },
    {
      id: "customer-buyer-value-proof",
      persona: "customer/buyer",
      environment: "moderated beta fixture with buyer-safe outcome and value proof view",
      fixtureData: ["plain-language outcome", "success signal", "value proof summary"],
      boundary: {
        mocked: ["live ROI analytics", "customer-success workflow"],
        live: ["outcome baseline contract", "value proof copy review", "known-limitation register"],
      },
      expectedEvidence: ["outcome-baseline", "value-proof-summary", "known-limitation-link"],
      threshold: {
        pass: "Buyer can see what was tested, what value was proven, and what remains limited.",
        fail: "Launch copy implies untested value, unsupported compatibility, or hidden limitation.",
        blocksBeta: false,
      },
    },
  ],
  flakePolicy: {
    maxRetryAttempts: 1,
    quarantineRoute: "release-blocker-candidate-or-explicit-follow-up",
    repeatedFailureBlocksLaunch: true,
    evidenceRequired: ["raw run log", "fixture version", "owner decision"],
  },
  manualEvidenceFallback: {
    allowedWhen: "A non-blocking environment or lab gap prevents automation, and the owning release reviewer accepts substitute evidence.",
    requiredFields: ["reason", "evidenceLink", "approver"],
    cannotOverride: ["launch blockers", "security denials", "unsupported compatibility claims"],
  },
  scopeBoundary: {
    implementsFullE2eHarness: false,
    implementsLiveProviderExecution: false,
    implementsDeviceLab: false,
    statement:
      "HOBO-500 defines the v1 launch persona matrix and thresholds. It does not implement a full e2e harness, live provider execution, or broad device-lab coverage.",
  },
};

export function validateLaunchE2ePersonaMatrix(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch e2e persona matrix record is required"] };
  }
  if (record.issue !== "HOBO-500") {
    errors.push("issue must be HOBO-500");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.ownership?.issueOwned) {
    errors.push("generic gates are insufficient; HOBO-500 must own the persona matrix");
  }

  const personas = (record.journeys ?? []).map((journey) => journey.persona);
  for (const persona of REQUIRED_LAUNCH_PERSONAS) {
    if (!personas.includes(persona)) {
      errors.push(`missing persona journey: ${persona}`);
    }
  }

  for (const journey of record.journeys ?? []) {
    if (!journey.environment) {
      errors.push(`${journey.id ?? "<missing>"} missing environment`);
    }
    if (!Array.isArray(journey.fixtureData) || journey.fixtureData.length === 0) {
      errors.push(`${journey.id ?? "<missing>"} missing fixture data`);
    }
    if (!Array.isArray(journey.boundary?.mocked) || !Array.isArray(journey.boundary?.live)) {
      errors.push(`${journey.id ?? "<missing>"} missing mocked/live boundary`);
    } else if (journey.boundary.mocked.length === 0 && journey.boundary.live.length === 0) {
      errors.push(`${journey.id ?? "<missing>"} missing mocked/live boundary`);
    }
    if (!Array.isArray(journey.expectedEvidence) || journey.expectedEvidence.length === 0) {
      errors.push(`${journey.id ?? "<missing>"} missing expected evidence`);
    }
    if (!journey.threshold?.pass) {
      errors.push(`${journey.id ?? "<missing>"} missing pass threshold`);
    }
    if (!journey.threshold?.fail) {
      errors.push(`${journey.id ?? "<missing>"} missing fail threshold`);
    }
  }

  if (!record.flakePolicy?.quarantineRoute || record.flakePolicy.maxRetryAttempts === undefined) {
    errors.push("flake policy must define retry limit and quarantine route");
  }
  if (!record.flakePolicy?.repeatedFailureBlocksLaunch) {
    errors.push("flake policy must block launch on repeated failure");
  }

  for (const field of ["reason", "evidenceLink", "approver"]) {
    if (!record.manualEvidenceFallback?.requiredFields?.includes(field)) {
      errors.push(`manual evidence fallback must require ${field}`);
    }
  }
  if (!record.manualEvidenceFallback?.cannotOverride?.includes("launch blockers")) {
    errors.push("manual evidence fallback must not override launch blockers");
  }

  if (record.scopeBoundary?.implementsFullE2eHarness) {
    errors.push("full e2e harness implementation is scope-out");
  }
  if (record.scopeBoundary?.implementsLiveProviderExecution) {
    errors.push("live provider execution is scope-out");
  }

  return { ok: errors.length === 0, errors };
}

export function evaluateJourneyEvidence(journey, evidence) {
  const errors = [];

  if (!journey) {
    return { ok: false, errors: ["journey is required"] };
  }
  const required = new Set(journey.expectedEvidence ?? []);
  const provided = new Set(evidence?.requiredEvidence ?? []);
  for (const item of required) {
    if (!provided.has(item)) {
      errors.push(`missing evidence: ${item}`);
    }
  }

  if (evidence?.launchBlockerOpen) {
    errors.push("manual evidence cannot override launch blockers");
  }

  if (evidence?.status === "flaky") {
    if (!evidence.quarantineTicket || evidence.retryAttempts > launchE2ePersonaMatrix.flakePolicy.maxRetryAttempts) {
      errors.push("flaky journey must route through quarantine before launch confidence can pass");
    }
  }

  if (evidence?.status === "manual-substitute") {
    for (const field of launchE2ePersonaMatrix.manualEvidenceFallback.requiredFields) {
      if (!evidence.manualFallback?.[field]) {
        errors.push(`manual fallback missing ${field}`);
      }
    }
  }

  if (evidence?.status === "failed") {
    errors.push("journey status failed cannot pass");
  }

  if (evidence?.status === "passed" && errors.length === 0) {
    return { ok: true, errors: [] };
  }
  if (evidence?.status === "manual-substitute" && errors.length === 0) {
    return { ok: true, errors: [] };
  }
  if (!["passed", "manual-substitute", "flaky", "failed"].includes(evidence?.status)) {
    errors.push(`unsupported journey evidence status: ${evidence?.status ?? "<missing>"}`);
  }

  return { ok: false, errors };
}
