import { isJsonObject } from "./json.js";
export const REQUIRED_ENVELOPE_SECTIONS = [
  "targetWorkflows",
  "betaLoadAssumptions",
  "thresholds",
  "capacityAssumptions",
  "loadTestFixtureContract",
  "nonGoals",
];

const ALLOWED_COST_OWNER_PROJECTS = new Set(["Usage Metering", "Billing & Credits", "Entitlements & Plan Limits"]);

export const LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE = {
  schema: "hobo.launch-performance-capacity-envelope/v1",
  issue: "HOBO-502",
  project: "Performance & Load Tests",
  phase: "M0",
  targetWorkflows: [
    {
      id: "workflow.first-plan",
      persona: "app developer",
      launchTier: "beta-required",
      evidenceOwner: "Plan/Diff Viewer",
    },
    {
      id: "workflow.first-deploy",
      persona: "app developer",
      launchTier: "beta-required",
      evidenceOwner: "Bootstrap Installer",
    },
    {
      id: "workflow.release-readiness-dashboard",
      persona: "release owner",
      launchTier: "rc-required",
      evidenceOwner: "V1 Release Program & Cutline",
    },
    {
      id: "workflow.support-evidence-lookup",
      persona: "support operator",
      launchTier: "beta-required",
      evidenceOwner: "Support Workflow",
    },
  ],
  betaLoadAssumptions: [
    {
      id: "load.private-beta-tenants",
      assumption: "Up to 25 private-beta workspaces, 5 concurrent active onboarding flows, and 2 concurrent first-deploy flows.",
      source: "V1 Beta Pilot & Feedback Loop",
    },
    {
      id: "load.synthetic-ci-smoke",
      assumption: "Every release-candidate run may execute deterministic smoke fixtures for SaaS, self-host, local, and cost-envelope replay paths.",
      source: "Bootstrap Installer",
    },
    {
      id: "load.support-lookups",
      assumption: "Support evidence lookup is optimized for launch triage, not bulk analytics or billing exports.",
      source: "Support Workflow",
    },
  ],
  thresholds: [
    {
      id: "threshold.first-plan-p95",
      metric: "first hobo plan or plan/diff fixture p95 latency",
      betaTarget: "<= 15s using deterministic fixture inputs",
      gaTarget: "<= 8s using accepted launch fixture inputs",
      supportAction: "Route misses to Plan/Diff Viewer and attach fixture id plus trace evidence.",
      releaseNotesImpact: "List as beta limitation if p95 remains above beta target at cutline.",
    },
    {
      id: "threshold.first-deploy-e2e-p95",
      metric: "first deploy smoke path p95 elapsed time",
      betaTarget: "<= 15m for synthetic SaaS path",
      gaTarget: "<= 8m for accepted SaaS path and documented self-host path",
      supportAction: "Route misses to Bootstrap Installer with bootstrap smoke artifact and failing step.",
      releaseNotesImpact: "Installation or first-deploy claim must narrow to the passing path.",
    },
    {
      id: "threshold.dashboard-readiness-p95",
      metric: "release readiness dashboard refresh p95 latency",
      betaTarget: "<= 30s against fixture project set",
      gaTarget: "<= 10s against accepted launch project set",
      supportAction: "Route misses to Release Program & Cutline with source-of-truth field id.",
      releaseNotesImpact: "Readiness dashboard cannot be described as live if refresh misses target.",
    },
    {
      id: "threshold.support-evidence-lookup-p95",
      metric: "support evidence lookup p95 latency",
      betaTarget: "<= 20s for known issue/workspace refs",
      gaTarget: "<= 10s for known issue/workspace refs",
      supportAction: "Route misses to Support Workflow with tenant/workspace redaction state.",
      releaseNotesImpact: "Support SLA text must exclude fast evidence lookup if target is unmet.",
    },
    {
      id: "threshold.cost-per-smoke-run",
      metric: "estimated provider and hosted infrastructure cost per launch smoke run",
      betaTarget: "<= 5 USD equivalent per synthetic run",
      gaTarget: "<= 2 USD equivalent per synthetic run or explicit accepted exception",
      supportAction: "Route misses to Usage Metering and Entitlements & Plan Limits before adding more smoke volume.",
      releaseNotesImpact: "High-cost smoke limitation must be listed before public self-host or SaaS scale claims.",
    },
  ],
  capacityAssumptions: [
    {
      id: "capacity.control-plane-default",
      assumption: "Launch envelope assumes hosted control-plane defaults from Plan 05, not tuned production capacity.",
      scalingBoundary: "Capacity changes require a later M1/M2 load-test issue.",
    },
    {
      id: "capacity.self-host-minimum",
      assumption: "Self-host path names minimum fixture resources but does not prove customer production sizing.",
      scalingBoundary: "Customer production sizing remains release-note and support guidance until drill evidence exists.",
    },
    {
      id: "capacity.synthetic-data-only",
      assumption: "Envelope fixtures use synthetic or replayable data only.",
      scalingBoundary: "No live tenant traffic or customer data is used for HOBO-502 proof.",
    },
  ],
  loadTestFixtureContract: [
    {
      id: "fixture.local-smoke",
      dataSet: "local deterministic sample workspace with one project, one plan, one deploy record, and no provider calls",
      measurementMode: "node test fixture",
      executesAgainstProduction: false,
    },
    {
      id: "fixture.saas-beta-synthetic",
      dataSet: "synthetic hosted workspace and first-deploy artifact ids",
      measurementMode: "contract fixture with stubbed provider timings",
      executesAgainstProduction: false,
    },
    {
      id: "fixture.self-host-synthetic",
      dataSet: "synthetic self-host bootstrap path, minimum resource class, and unsupported-state rows",
      measurementMode: "contract fixture with declared resource envelope",
      executesAgainstProduction: false,
    },
    {
      id: "fixture.cost-envelope-replay",
      dataSet: "usage, billing, and entitlement fixture facts with deterministic cost counters",
      measurementMode: "event replay fixture",
      executesAgainstProduction: false,
    },
  ],
  costGuardrails: [
    {
      id: "cost.usage-fact-lineage",
      ownerProject: "Usage Metering",
      sourceEvidence: "docs/design/usage-metering.md",
      launchRule: "Every cost threshold must trace to accepted usage fact classes and dimensions.",
      scopeBoundary: "HOBO-502 does not create a metering projection or ingest live usage.",
    },
    {
      id: "cost.billing-boundary",
      ownerProject: "Billing & Credits",
      sourceEvidence: "docs/design/billing-launch-policy.md",
      launchRule: "Envelope cost misses route to invoice/support wording but do not generate invoices.",
      scopeBoundary: "HOBO-502 does not add payment, invoice, refund, tax, or provider billing integration.",
    },
    {
      id: "cost.entitlement-limit-boundary",
      ownerProject: "Entitlements & Plan Limits",
      sourceEvidence: "HOBO-419",
      launchRule: "Capacity and cost limits that become customer-visible must map to entitlement policy before launch.",
      scopeBoundary: "HOBO-502 does not enforce quota, abuse response, rate limits, or suspension.",
    },
  ],
  nonGoals: [
    {
      id: "scope-out.production-load-execution",
      boundary: "Do not execute production load tests, use live customer traffic, or claim production capacity in HOBO-502.",
    },
    {
      id: "scope-out.capacity-autoscaling",
      boundary: "Do not tune autoscaling, provision capacity, or implement load-test infrastructure in HOBO-502.",
    },
    {
      id: "scope-out.billing-implementation",
      boundary: "Do not implement usage billing, invoices, payment collection, tax, refunds, or entitlements here.",
    },
  ],
};

export function validateLaunchPerformanceCapacityEnvelope(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch performance capacity envelope record is required"] };
  }

  if (record.issue !== "HOBO-502") {
    errors.push("issue must be HOBO-502");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const section of REQUIRED_ENVELOPE_SECTIONS) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }
  if (!Array.isArray(record.costGuardrails) || record.costGuardrails.length === 0) {
    errors.push("costGuardrails must be a non-empty list");
  }

  const scopeOutIds = new Set((record.nonGoals ?? []).map((item) => item.id));
  if (!scopeOutIds.has("scope-out.production-load-execution")) {
    errors.push("scope-out.production-load-execution is required");
  }

  for (const threshold of record.thresholds ?? []) {
    for (const field of ["metric", "betaTarget", "gaTarget", "supportAction", "releaseNotesImpact"]) {
      if (!threshold[field]) {
        errors.push(`${threshold.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const guardrail of record.costGuardrails ?? []) {
    if (!ALLOWED_COST_OWNER_PROJECTS.has(guardrail.ownerProject)) {
      errors.push(`${guardrail.ownerProject ?? "<missing>"} is not an allowed cost owner`);
    }
    for (const field of ["sourceEvidence", "launchRule", "scopeBoundary"]) {
      if (!guardrail[field]) {
        errors.push(`${guardrail.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const fixture of record.loadTestFixtureContract ?? []) {
    for (const field of ["dataSet", "measurementMode"]) {
      if (!fixture[field]) {
        errors.push(`${fixture.id ?? "<missing>"} missing ${field}`);
      }
    }
    if (fixture.executesAgainstProduction !== false) {
      errors.push(`${fixture.id ?? "<missing>"} must not execute against production`);
    }
  }

  return { ok: errors.length === 0, errors };
}
