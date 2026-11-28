import { createHash } from "node:crypto";
import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export const UPGRADE_DRY_RUN_FIXTURES = Object.freeze({
  cleanUpgrade: Object.freeze({
    id: "clean-upgrade",
    sourceVersion: "1.0.0",
    targetVersion: "1.1.0",
    deploymentMode: "self-host-yard",
    compatibility: Object.freeze({
      matrixRef: "compatibility-matrix#yard-1.0-to-1.1",
      result: "supported",
      componentHostPin: "wasmcloud-1.4.2",
      manifestVersion: "hobo.manifest/v1",
    }),
    backup: Object.freeze({
      requirement: "required-and-satisfied",
      evidenceRef: "backup-drill:2026-06-29:self-host-yard",
    }),
    migration: Object.freeze({
      steps: Object.freeze([
        Object.freeze({ phase: "expand", summary: "Add compatible projection columns before readers switch." }),
        Object.freeze({ phase: "backfill", summary: "Backfill projection rows from event-store snapshots." }),
        Object.freeze({ phase: "contract", summary: "Retire prior projection shape after compatibility window." }),
      ]),
    }),
    rollback: Object.freeze({
      state: "available",
      immutableSetRef: "deployment-set:yard-prod:rev-41",
      snapshotRef: "snapshot:yard-prod:pre-upgrade-1.0.0",
      escalationOwner: "Support Workflow",
    }),
    releaseNotes: Object.freeze({
      requiredInputs: Object.freeze([
        "supported-version-window",
        "known-limitations",
        "rollback-guidance",
        "support-contact",
      ]),
    }),
    support: Object.freeze({
      owner: "Support Workflow",
      handoff: "Attach dry-run report, backup evidence, rollback evidence, and escalation owner.",
    }),
  }),
  blockedUpgrade: Object.freeze({
    id: "blocked-upgrade",
    sourceVersion: "0.9.4",
    targetVersion: "1.1.0",
    deploymentMode: "self-host-yard",
    compatibility: Object.freeze({
      matrixRef: "compatibility-matrix#yard-0.9-to-1.1",
      result: "unsupported",
      componentHostPin: "wasmcloud-0.82.0",
      manifestVersion: "hobo.manifest/v1",
    }),
    backup: Object.freeze({
      requirement: "required-but-missing",
      evidenceRef: null,
    }),
    migration: Object.freeze({
      steps: Object.freeze([]),
    }),
    rollback: Object.freeze({
      state: "unavailable",
      immutableSetRef: null,
      snapshotRef: null,
      escalationOwner: "Support Workflow",
    }),
    unsupportedPath: Object.freeze({
      reason: "component-host-pin-below-floor",
      remediation: "Upgrade to a supported 1.0.x bridge release before targeting 1.1.0.",
    }),
    releaseNotes: Object.freeze({
      requiredInputs: Object.freeze([
        "unsupported-version-window",
        "known-limitations",
        "manual-upgrade-path",
        "support-contact",
      ]),
      knownLimitation: "Self-host Yard 0.9.x cannot upgrade directly to 1.1.0.",
    }),
    support: Object.freeze({
      owner: "Support Workflow",
      handoff: "Attach blocked dry-run report and unsupported path reason.",
      nextAction: "route-to-upgrade-support",
    }),
  }),
  failedMigration: Object.freeze({
    id: "failed-migration",
    sourceVersion: "1.0.2",
    targetVersion: "1.1.0",
    deploymentMode: "hosted-control-plane",
    compatibility: Object.freeze({
      matrixRef: "compatibility-matrix#hosted-1.0-to-1.1",
      result: "supported",
      componentHostPin: "wasmcloud-1.4.2",
      manifestVersion: "hobo.manifest/v1",
    }),
    backup: Object.freeze({
      requirement: "required-and-satisfied",
      evidenceRef: "backup-drill:2026-06-28:hosted-control-plane",
    }),
    migration: Object.freeze({
      steps: Object.freeze([
        Object.freeze({ phase: "expand", summary: "Add nullable tenant region column." }),
        Object.freeze({ phase: "backfill", summary: "Backfill tenant region from deployment event store." }),
      ]),
      failure: Object.freeze({
        phase: "contract",
        reason: "contract-phase-would-drop-active-column",
      }),
    }),
    rollback: Object.freeze({
      state: "required-before-execution",
      immutableSetRef: "deployment-set:hosted-control-plane:rev-208",
      snapshotRef: "snapshot:hosted-control-plane:pre-upgrade-1.0.2",
      restorePrerequisite: "pre-migration-snapshot",
      escalationOwner: "Support Workflow",
    }),
    releaseNotes: Object.freeze({
      requiredInputs: Object.freeze([
        "failed-migration-limitation",
        "rollback-guidance",
        "manual-review-owner",
        "support-contact",
      ]),
    }),
    support: Object.freeze({
      owner: "Support Workflow",
      handoff: "Attach dry-run failure, snapshot prerequisite, and release owner decision.",
      escalation: "release-owner-and-data-plane",
    }),
  }),
  rollbackReady: Object.freeze({
    id: "rollback-ready",
    sourceVersion: "1.0.0",
    targetVersion: "1.0.1",
    deploymentMode: "local-dev-runtime",
    compatibility: Object.freeze({
      matrixRef: "compatibility-matrix#local-dev-1.0-to-1.0.1",
      result: "supported",
      componentHostPin: "wasmcloud-1.4.2",
      manifestVersion: "hobo.manifest/v1",
    }),
    backup: Object.freeze({
      requirement: "optional-local-snapshot-present",
      evidenceRef: "local-snapshot:2026-06-29:dev-yard",
    }),
    migration: Object.freeze({
      steps: Object.freeze([
        Object.freeze({ phase: "expand", summary: "Apply local projection compatibility shim." }),
      ]),
    }),
    rollback: Object.freeze({
      state: "recoverable",
      immutableSetRef: "deployment-set:local-dev:rev-12",
      snapshotRef: "snapshot:local-dev:pre-upgrade-1.0.0",
      restorePrerequisite: "local-runtime-snapshot",
      escalationOwner: "Support Workflow",
    }),
    releaseNotes: Object.freeze({
      requiredInputs: Object.freeze([
        "local-dev-version-window",
        "rollback-guidance",
        "known-limitations",
        "support-contact",
      ]),
    }),
    support: Object.freeze({
      owner: "Support Workflow",
      handoff: "Attach local dry-run report and rollback-ready fixture evidence.",
    }),
  }),
});

export function evaluateUpgradeDryRun(input: JsonValue) {
  const request = parseUpgradeDryRunRequest(input);
  const blocked = request.compatibility.result === "unsupported" || request.backup.requirement.endsWith("-missing");
  const failed = Boolean(request.migration.failure);

  return {
    schema: "hobo.upgrade-rollback-dry-run/v1",
    fixtureId: request.id,
    status: failed ? "failed" : blocked ? "blocked" : "passed",
    preflight: {
      status: failed ? "failed" : blocked ? "blocked" : "passed",
      checked: ["compatibility", "backup", "migration-plan", "rollback"],
    },
    compatibility: request.compatibility,
    backup: request.backup,
    migrationPlan: request.migration,
    rollbackEvidence: request.rollback,
    releaseNotes: request.releaseNotes,
    supportHandoff: request.support,
    unsupportedPath: request.unsupportedPath ?? null,
    mutationCommands: [],
    digest: stableDigest(request),
  };
}

export function classifyUpgradeDryRunDecision(decision: string) {
  if (
    /\b(live migration|execute|runner|rollback executor|backup restore|provider state rewrite|support automation|support ticket|publish release notes)\b/i.test(
      decision,
    )
  ) {
    return { owner: "Out of scope", inScope: false };
  }

  return { owner: "Upgrade & Migration Engine", inScope: true };
}

export function stableDigest(value: JsonValue) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function parseUpgradeDryRunRequest(input: JsonValue) {
  if (!isRecord(input)) {
    throw new Error("upgrade dry-run request must be an object");
  }
  if ("requestedAction" in input && classifyUpgradeDryRunDecision(String(input.requestedAction)).inScope === false) {
    throw new Error("dry-run contract does not execute live migration, rollback, provider mutation, or support automation");
  }

  // SAFETY: `return input as {` is required at this I/O or test boundary.
  return input as {
    id: string;
    compatibility: { result: string };
    backup: { requirement: string };
    migration: { steps: Array<{ phase: string; summary: string }>; failure?: { phase: string; reason: string } };
    rollback: { state: string; restorePrerequisite?: string };
    unsupportedPath?: { reason: string; remediation: string };
    releaseNotes: { requiredInputs: string[]; knownLimitation?: string };
    support: { owner: string; handoff: string; nextAction?: string; escalation?: string };
  };
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null && !Array.isArray(value);
}
