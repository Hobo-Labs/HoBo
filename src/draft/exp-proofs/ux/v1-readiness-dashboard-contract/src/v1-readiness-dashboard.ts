import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_DASHBOARD_FIELDS = [
  "acceptedRisks",
  "blockers",
  "cutline",
  "evidenceLinks",
  "lastVerifiedAt",
  "milestoneHealth",
  "owners"
] as const;

type DashboardFieldName = (typeof REQUIRED_DASHBOARD_FIELDS)[number];

type EmptyStateColor = "green" | "yellow" | "red" | "gray";

type EmptyState = {
  label: string;
  color: EmptyStateColor;
  launchMeaning: string;
};

type DashboardField = {
  name: DashboardFieldName;
  label: string;
  sourceOfTruth: string;
  updateCadence: string;
  ownerProject: string;
  emptyState: EmptyState;
};

type DashboardScope = {
  kind: "release-evidence-aggregate";
  implementsFeatureWork: boolean;
  aggregatesOnly: string[];
  scopeOut: string[];
};

type V1ReadinessDashboard = {
  schema: string;
  issue: string;
  project: string;
  purpose: string;
  sourceRecords: string[];
  fields: DashboardField[];
  scope: DashboardScope;
};

type ValidationResult = {
  ok: boolean;
  errors: string[];
};

export const v1ReadinessDashboard: V1ReadinessDashboard = {
  schema: "hobo.v1.readiness-dashboard/2026-06-30",
  issue: "HOBO-482",
  project: "V1 Release Program & Cutline",
  purpose:
    "Aggregate release decision evidence so blockers, gaps, risks, owners, and verification age cannot appear green without evidence.",
  sourceRecords: [
    "HOBO-401",
    "docs/design/v1-readiness-dashboard.md",
    "docs/design/launch-blocker-taxonomy.md",
    "src/draft/technical-proofs/v1-cutline-contract/README.md"
  ],
  fields: [
    {
      name: "cutline",
      label: "Cutline",
      sourceOfTruth: "Accepted V1 cutline contract plus V1 Release Program & Cutline Linear project",
      updateCadence: "On M0 acceptance and before beta, release-candidate, and GA decisions",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "Cutline missing",
        color: "red",
        launchMeaning: "Release cannot claim a shared v1 boundary."
      }
    },
    {
      name: "blockers",
      label: "Blockers",
      sourceOfTruth: "Launch Blocker Taxonomy records, failed gates, and open Linear blocker issues",
      updateCadence: "Every gate run, blocker triage, and go/no-go review",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "Unknown blockers",
        color: "red",
        launchMeaning: "Unknown blocker state is treated as not ready."
      }
    },
    {
      name: "milestoneHealth",
      label: "Milestone health",
      sourceOfTruth: "Linear project milestone state and latest status update",
      updateCadence: "At milestone transition and before each readiness review",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "No milestone health",
        color: "yellow",
        launchMeaning: "Readiness owner must refresh status before decision."
      }
    },
    {
      name: "evidenceLinks",
      label: "Evidence links",
      sourceOfTruth: "Traceability row, proof README, PR link, and verification command output",
      updateCadence: "Whenever evidence changes or a release decision is prepared",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "Missing evidence",
        color: "red",
        launchMeaning: "Missing evidence cannot support a ready or green state."
      }
    },
    {
      name: "acceptedRisks",
      label: "Accepted risks",
      sourceOfTruth: "Launch Blocker Taxonomy exception records with approver, mitigation, and expiry",
      updateCadence: "On risk acceptance, expiry, mitigation change, or go/no-go review",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "No accepted risks",
        color: "gray",
        launchMeaning: "No accepted risk is neutral, not proof that blockers are closed."
      }
    },
    {
      name: "owners",
      label: "Owners",
      sourceOfTruth: "Linear project owners, initiative owners, and named readiness owner fields",
      updateCadence: "On ownership change and before every release decision",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "Owner missing",
        color: "red",
        launchMeaning: "Unowned evidence or blocker cannot be marked ready."
      }
    },
    {
      name: "lastVerifiedAt",
      label: "Last verified",
      sourceOfTruth: "Latest verification run timestamp attached to the proof or release record",
      updateCadence: "Every verification run and immediately before release decision",
      ownerProject: "V1 Release Program & Cutline",
      emptyState: {
        label: "Never verified",
        color: "red",
        launchMeaning: "Unverified evidence cannot count as current readiness."
      }
    }
  ],
  scope: {
    kind: "release-evidence-aggregate",
    implementsFeatureWork: false,
    aggregatesOnly: [
      "cutline decisions",
      "blocker classifications",
      "milestone status",
      "proof links",
      "accepted-risk records",
      "owners",
      "verification timestamps"
    ],
    scopeOut: [
      "feature-implementation",
      "runtime-dashboard-ui",
      "provider-deploy-work",
      "legal-approval",
      "support-tooling",
      "launch-decision-automation"
    ]
  }
};

export function validateV1ReadinessDashboard(record: JsonValue): ValidationResult {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["v1 readiness dashboard record is required"] };
  }

  // SAFETY: `const candidate = record as Partial<V1ReadinessDashboard>;` is required at this I/O or test boundary.
  const candidate = record as Partial<V1ReadinessDashboard>;

  if (candidate.issue !== "HOBO-482") {
    errors.push("dashboard contract must be owned by HOBO-482");
  }

  if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) {
    errors.push("fields must be a non-empty list");
  }

  const fieldNames = new Set((candidate.fields ?? []).map((field) => field.name));
  for (const requiredField of REQUIRED_DASHBOARD_FIELDS) {
    if (!fieldNames.has(requiredField)) {
      errors.push(`${requiredField} field is required`);
    }
  }

  for (const field of candidate.fields ?? []) {
    if (!field.name || !field.label) {
      errors.push("each field must have a name and label");
    }
    if (!field.sourceOfTruth || !field.updateCadence || !field.ownerProject) {
      errors.push(`${field.name ?? "<missing>"} must have sourceOfTruth, updateCadence, and ownerProject`);
    }
    if (!field.emptyState?.label || !field.emptyState.launchMeaning) {
      errors.push(`${field.name ?? "<missing>"} must define explicit empty state semantics`);
    }
    if (!["green", "yellow", "red", "gray"].includes(field.emptyState?.color ?? "")) {
      errors.push(`${field.name ?? "<missing>"} must use a known empty state color`);
    }
    if (field.name === "evidenceLinks" && field.emptyState?.color === "green") {
      errors.push("missing evidence cannot render as green");
    }
  }

  if (candidate.scope?.kind !== "release-evidence-aggregate") {
    errors.push("dashboard scope must be a release evidence aggregate");
  }
  if (candidate.scope?.implementsFeatureWork !== false) {
    errors.push("readiness dashboard must not implement feature work");
  }
  for (const requiredScopeOut of ["feature-implementation", "runtime-dashboard-ui"]) {
    if (!candidate.scope?.scopeOut?.includes(requiredScopeOut)) {
      errors.push(`${requiredScopeOut} must remain out of scope`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertV1ReadinessDashboard(record: JsonValue = v1ReadinessDashboard): V1ReadinessDashboard {
  const result = validateV1ReadinessDashboard(record);

  if (!result.ok) {
    throw new Error(`v1 readiness dashboard contract invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return record as V1ReadinessDashboard;` is required at this I/O or test boundary.
  return record as V1ReadinessDashboard;
}
