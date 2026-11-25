/**
 * Upgrade & Migration Engine — M1 Dogfood/Alpha evidence surface.
 *
 * Canonical home of the promoted `upgrade-rollback-dry-run-contract` draft
 * proof (HOBO-499; scope record HOBO-430 M0 in
 * docs/design/upgrade-migration-engine.md). Delivers the four outstanding
 * rows of the "Evidence Required For M1" table as production code:
 *
 * - compatibility-input-matrix — `parseCompatibilityInputs` (the 11-field
 *   minimum input set) + `COMPATIBILITY_INPUT_MATRIX` reference fixture, one
 *   row per upgrade path class.
 * - migration-dry-run-contract — `evaluateUpgradeDryRun` + the four
 *   deterministic fixtures (clean / blocked / failed-migration /
 *   rollback-ready). A dry-run is evidence, not execution.
 * - rollback-evidence-fixture — `parseRollbackEvidence`; rollback evidence is
 *   required before an upgrade path may be described as recoverable.
 * - scope-boundary-register — `UPGRADE_SCOPE_BOUNDARIES` policy fixture +
 *   `assertUpgradeScopeBoundary`, failing closed on live-execution asks that
 *   belong to owning initiatives.
 */
import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: dry-run report schema id consumers pin.
export const UPGRADE_DRY_RUN_SCHEMA = "hobo.upgrade-rollback-dry-run/v1";

export type UpgradeDeploymentMode =
	| "hosted-control-plane"
	| "self-host-yard"
	| "local-dev-runtime"
	| "sdk-package"
	| "data-shape";

export type ContractCompatibilityResult =
	| "supported"
	| "unsupported"
	| "needs-review";

export type DataSchemaPosture =
	| "none"
	| "expand-only"
	| "expand-backfill"
	| "expand-backfill-contract";

export type BackupPrerequisite =
	| "required-and-satisfied"
	| "required-but-missing"
	| "optional-local-snapshot-present"
	| "not-required";

/**
 * The 11-field minimum compatibility input set from
 * docs/design/upgrade-migration-engine.md#compatibility-inputs. The future
 * compatibility-matrix engine consumes exactly these fields.
 */
export interface CompatibilityInputs {
	readonly currentVersion: string;
	readonly targetVersion: string;
	readonly deploymentMode: UpgradeDeploymentMode;
	readonly componentHostPin: string;
	readonly manifestVersion: string;
	readonly contractCompatibility: ContractCompatibilityResult;
	readonly dataSchemaPosture: DataSchemaPosture;
	/** Provider/IaC state dependency fact, or null when none. */
	readonly providerStateDependency: string | null;
	readonly backupPrerequisite: BackupPrerequisite;
	/** Link to rollback evidence, or null when rollback is unavailable. */
	readonly rollbackEvidenceRef: string | null;
	readonly supportHandoffOwner: string;
}

export type RollbackState =
	| "available"
	| "unavailable"
	| "required-before-execution"
	| "recoverable";

/** Rollback and recovery boundary evidence (#rollback-and-recovery-boundaries). */
export interface RollbackEvidence {
	readonly state: RollbackState;
	readonly immutableSetRef: string | null;
	readonly snapshotRef: string | null;
	readonly restorePrerequisite?: string;
	readonly blockedRestoreReason?: string;
	readonly escalationOwner: string;
}

/** Release-notes / support handoff record (#service-ux-security-support boundaries). */
export interface SupportHandoffRecord {
	readonly owner: string;
	readonly handoff: string;
	readonly nextAction?: string;
	readonly escalation?: string;
}

export type UpgradeDryRunDecision = Readonly<{
	owner: string;
	inScope: boolean;
}>;

export class UpgradePreflightParseError extends Error {
	readonly path: string;
	readonly expected: string;
	readonly received: JsonValue;

	constructor(path: string, expected: string, received: JsonValue) {
		super(`${path}: expected ${expected}`);
		this.name = "UpgradePreflightParseError";
		this.path = path;
		this.expected = expected;
		this.received = received;
	}
}

const DEPLOYMENT_MODES = new Set<UpgradeDeploymentMode>([
	"hosted-control-plane",
	"self-host-yard",
	"local-dev-runtime",
	"sdk-package",
	"data-shape",
]);
const COMPAT_RESULTS = new Set<ContractCompatibilityResult>([
	"supported",
	"unsupported",
	"needs-review",
]);
const SCHEMA_POSTURES = new Set<DataSchemaPosture>([
	"none",
	"expand-only",
	"expand-backfill",
	"expand-backfill-contract",
]);
const BACKUP_PREREQUISITES = new Set<BackupPrerequisite>([
	"required-and-satisfied",
	"required-but-missing",
	"optional-local-snapshot-present",
	"not-required",
]);
const ROLLBACK_STATES = new Set<RollbackState>([
	"available",
	"unavailable",
	"required-before-execution",
	"recoverable",
]);

function record(value: JsonValue, path: string): JsonObject {
	if (!isJsonObject(value)) {
		throw new UpgradePreflightParseError(path, "object", value);
	}
	return value;
}

function str(value: JsonValue | undefined, path: string): string {
	if (!isJsonString(value) || value.trim().length === 0) {
		throw new UpgradePreflightParseError(path, "non-empty string", value);
	}
	return value.trim();
}

function nullableStr(
	value: JsonValue | undefined,
	path: string,
): string | null {
	if (value === null || value === undefined) return null;
	return str(value, path);
}

function member<T extends string>(
	value: JsonValue,
	allowed: ReadonlySet<T>,
	path: string,
): T {
	if (!isJsonString(value)) {
		throw new UpgradePreflightParseError(path, [...allowed].join(" | "), value);
	}
	const member = [...allowed].find((candidate) => candidate === value);
	if (member === undefined) {
		throw new UpgradePreflightParseError(path, [...allowed].join(" | "), value);
	}
	return member;
}

export function parseCompatibilityInputs(
	value: JsonValue,
	path = "compatibilityInputs",
): CompatibilityInputs {
	const input = record(value, path);
	return Object.freeze({
		currentVersion: str(input.currentVersion, `${path}.currentVersion`),
		targetVersion: str(input.targetVersion, `${path}.targetVersion`),
		deploymentMode: member(
			input.deploymentMode,
			DEPLOYMENT_MODES,
			`${path}.deploymentMode`,
		),
		componentHostPin: str(input.componentHostPin, `${path}.componentHostPin`),
		manifestVersion: str(input.manifestVersion, `${path}.manifestVersion`),
		contractCompatibility: member(
			input.contractCompatibility,
			COMPAT_RESULTS,
			`${path}.contractCompatibility`,
		),
		dataSchemaPosture: member(
			input.dataSchemaPosture,
			SCHEMA_POSTURES,
			`${path}.dataSchemaPosture`,
		),
		providerStateDependency: nullableStr(
			input.providerStateDependency,
			`${path}.providerStateDependency`,
		),
		backupPrerequisite: member(
			input.backupPrerequisite,
			BACKUP_PREREQUISITES,
			`${path}.backupPrerequisite`,
		),
		rollbackEvidenceRef: nullableStr(
			input.rollbackEvidenceRef,
			`${path}.rollbackEvidenceRef`,
		),
		supportHandoffOwner: str(
			input.supportHandoffOwner,
			`${path}.supportHandoffOwner`,
		),
	});
}

export function parseRollbackEvidence(
	value: JsonValue,
	path = "rollbackEvidence",
): RollbackEvidence {
	const input = record(value, path);
	const state = member(input.state, ROLLBACK_STATES, `${path}.state`);
	const evidence: RollbackEvidence = {
		state,
		immutableSetRef: nullableStr(
			input.immutableSetRef,
			`${path}.immutableSetRef`,
		),
		snapshotRef: nullableStr(input.snapshotRef, `${path}.snapshotRef`),
		...(input.restorePrerequisite !== undefined &&
		input.restorePrerequisite !== null
			? {
					restorePrerequisite: str(
						input.restorePrerequisite,
						`${path}.restorePrerequisite`,
					),
				}
			: undefined),
		...(input.blockedRestoreReason !== undefined &&
		input.blockedRestoreReason !== null
			? {
					blockedRestoreReason: str(
						input.blockedRestoreReason,
						`${path}.blockedRestoreReason`,
					),
				}
			: undefined),
		escalationOwner: str(input.escalationOwner, `${path}.escalationOwner`),
	};
	// A path may only be called recoverable/available with concrete evidence.
	if (
		(state === "available" || state === "recoverable") &&
		evidence.immutableSetRef === null &&
		evidence.snapshotRef === null
	) {
		throw new UpgradePreflightParseError(
			path,
			"immutableSetRef or snapshotRef when state is available/recoverable",
			value,
		);
	}
	return Object.freeze(evidence);
}

/**
 * Compatibility-input-matrix reference fixture: one row per upgrade path
 * class (#upgrade-path-classes), each carrying the full 11-field input set.
 */
export const COMPATIBILITY_INPUT_MATRIX: readonly CompatibilityInputs[] =
	Object.freeze(
		(
			[
				{
					currentVersion: "1.0.0",
					targetVersion: "1.1.0",
					deploymentMode: "hosted-control-plane",
					componentHostPin: "wasmcloud-1.4.2",
					manifestVersion: "hobo.manifest/v1",
					contractCompatibility: "supported",
					dataSchemaPosture: "expand-backfill-contract",
					providerStateDependency: "pulumi-stack:hosted-prod",
					backupPrerequisite: "required-and-satisfied",
					rollbackEvidenceRef:
						"snapshot:hosted-control-plane:pre-upgrade-1.0.0",
					supportHandoffOwner: "Support Workflow",
				},
				{
					currentVersion: "1.0.0",
					targetVersion: "1.1.0",
					deploymentMode: "self-host-yard",
					componentHostPin: "wasmcloud-1.4.2",
					manifestVersion: "hobo.manifest/v1",
					contractCompatibility: "supported",
					dataSchemaPosture: "expand-backfill",
					providerStateDependency: null,
					backupPrerequisite: "required-and-satisfied",
					rollbackEvidenceRef: "snapshot:yard-prod:pre-upgrade-1.0.0",
					supportHandoffOwner: "Support Workflow",
				},
				{
					currentVersion: "1.0.0",
					targetVersion: "1.0.1",
					deploymentMode: "local-dev-runtime",
					componentHostPin: "wasmcloud-1.4.2",
					manifestVersion: "hobo.manifest/v1",
					contractCompatibility: "supported",
					dataSchemaPosture: "expand-only",
					providerStateDependency: null,
					backupPrerequisite: "optional-local-snapshot-present",
					rollbackEvidenceRef: "snapshot:local-dev:pre-upgrade-1.0.0",
					supportHandoffOwner: "Support Workflow",
				},
				{
					currentVersion: "0.9.4",
					targetVersion: "1.1.0",
					deploymentMode: "sdk-package",
					componentHostPin: "wit:hobo-sdk@0.9",
					manifestVersion: "hobo.manifest/v1",
					contractCompatibility: "unsupported",
					dataSchemaPosture: "none",
					providerStateDependency: null,
					backupPrerequisite: "not-required",
					rollbackEvidenceRef: null,
					supportHandoffOwner: "Support Workflow",
				},
				{
					currentVersion: "1.0.2",
					targetVersion: "1.1.0",
					deploymentMode: "data-shape",
					componentHostPin: "wasmcloud-1.4.2",
					manifestVersion: "hobo.manifest/v1",
					contractCompatibility: "needs-review",
					dataSchemaPosture: "expand-backfill-contract",
					providerStateDependency: "managed-postgres:tenant-pool",
					backupPrerequisite: "required-but-missing",
					rollbackEvidenceRef: null,
					supportHandoffOwner: "Support Workflow",
				},
			] as const
		).map((row) => parseCompatibilityInputs(row)),
	);

/**
 * Scope-boundary register (policy fixture): the six Scope-Out categories from
 * HOBO-430 M0, each routed to its owning initiative.
 */
export const UPGRADE_SCOPE_BOUNDARIES = Object.freeze([
	Object.freeze({
		id: "no-upgrade-execution",
		category:
			"production upgrade runners, updater services, package-manager publishing, hosted rollout implementation, upgrade execution",
		routedTo: "Upgrade & Migration Engine M2+ (gated) / owning initiatives",
	}),
	Object.freeze({
		id: "no-live-data-mutation",
		category:
			"live schema migrations, data rewrites, provider/IaC state rewrites, component-host upgrades, customer data migration",
		routedTo: "Data Plane / Provider-IaC State Owners",
	}),
	Object.freeze({
		id: "no-restore-execution",
		category:
			"backup restore, rollback executors, disaster recovery runners, customer data recovery",
		routedTo: "Backup & Restore",
	}),
	Object.freeze({
		id: "no-customer-surfaces",
		category:
			"compatibility matrix UI, release-notes publication, customer communication workflows, support-ticket automation",
		routedTo: "Compatibility Matrix / V1 Release Notes / Support Workflow",
	}),
	Object.freeze({
		id: "no-adjacent-planes",
		category:
			"tenant, billing, RBAC, marketplace, installer behavior beyond named dependency boundaries",
		routedTo: "owning planes",
	}),
	Object.freeze({
		id: "m0-gate",
		category:
			"downstream M1-M4 design or implementation issues before M0 scope is accepted",
		routedTo: "Follow-Up Gate (M0 accepted 2026-07; ladder now open)",
	}),
] as const);

const OUT_OF_SCOPE_PATTERN =
	/\b(live migration|execute|runner|rollback executor|backup restore|provider state rewrite|support automation|support ticket|publish release notes)\b/i;

/** Promoted scope guard: classify a decision as in/out of dry-run scope. */
export function classifyUpgradeDryRunDecision(
	decision: string,
): UpgradeDryRunDecision {
	if (OUT_OF_SCOPE_PATTERN.test(decision)) {
		return { owner: "Out of scope", inScope: false };
	}
	return { owner: "Upgrade & Migration Engine", inScope: true };
}

/**
 * Fail-closed policy guard: refuse requested actions the M0 scope record
 * routes to owning initiatives. Dry-runs are evidence, not execution.
 */
export function assertUpgradeScopeBoundary(requestedAction: string): void {
	const verdict = classifyUpgradeDryRunDecision(requestedAction);
	if (!verdict.inScope) {
		throw new UpgradePreflightParseError(
			"requestedAction",
			"an in-scope dry-run evidence request (live execution is routed to owning initiatives)",
			requestedAction,
		);
	}
}

export interface UpgradeDryRunMigrationStep {
	readonly phase: "expand" | "backfill" | "contract";
	readonly summary: string;
}

export interface UpgradeDryRunRequest {
	readonly id: string;
	readonly compatibility: CompatibilityInputs;
	readonly migration: {
		readonly steps: readonly UpgradeDryRunMigrationStep[];
		readonly failure?: { readonly phase: string; readonly reason: string };
	};
	readonly rollback: RollbackEvidence;
	readonly unsupportedPath?: {
		readonly reason: string;
		readonly remediation: string;
	};
	readonly releaseNotes: {
		readonly requiredInputs: readonly string[];
		readonly knownLimitation?: string;
	};
	readonly support: SupportHandoffRecord;
}

export interface UpgradeDryRunReport {
	readonly schema: typeof UPGRADE_DRY_RUN_SCHEMA;
	readonly fixtureId: string;
	readonly status: "passed" | "blocked" | "failed";
	readonly preflight: {
		readonly status: "passed" | "blocked" | "failed";
		readonly checked: readonly string[];
	};
	readonly compatibility: CompatibilityInputs;
	readonly backupRequirement: BackupPrerequisite;
	readonly migrationPlan: UpgradeDryRunRequest["migration"];
	readonly blockedReasons: readonly string[];
	readonly rollbackEvidence: RollbackEvidence;
	readonly releaseNotes: UpgradeDryRunRequest["releaseNotes"];
	readonly supportHandoff: SupportHandoffRecord;
	readonly unsupportedPath: UpgradeDryRunRequest["unsupportedPath"] | null;
	/** Always empty: a dry-run must not mutate anything. */
	readonly mutationCommands: readonly never[];
	readonly digest: string;
}

/**
 * Evaluate an upgrade dry-run. Pure evidence: blocked on unsupported
 * compatibility or missing required backup; failed when the migration plan
 * itself records a failing phase. Never mutates live state.
 */
export function evaluateUpgradeDryRun(
	request: UpgradeDryRunRequest,
): UpgradeDryRunReport {
	const blockedReasons: string[] = [];
	if (request.compatibility.contractCompatibility === "unsupported") {
		blockedReasons.push("contract-compatibility-unsupported");
	}
	if (request.compatibility.backupPrerequisite === "required-but-missing") {
		blockedReasons.push("backup-prerequisite-missing");
	}
	const failed = request.migration.failure !== undefined;
	const status = failed
		? "failed"
		: blockedReasons.length > 0
			? "blocked"
			: "passed";
	return Object.freeze({
		schema: UPGRADE_DRY_RUN_SCHEMA,
		fixtureId: request.id,
		status,
		preflight: Object.freeze({
			status,
			checked: Object.freeze([
				"compatibility",
				"backup",
				"migration-plan",
				"rollback",
			]),
		}),
		compatibility: request.compatibility,
		backupRequirement: request.compatibility.backupPrerequisite,
		migrationPlan: request.migration,
		blockedReasons: Object.freeze(blockedReasons),
		rollbackEvidence: request.rollback,
		releaseNotes: request.releaseNotes,
		supportHandoff: request.support,
		unsupportedPath: request.unsupportedPath ?? null,
		// SAFETY: dry-run reports intentionally expose no executable mutations.
		mutationCommands: Object.freeze([]) as readonly never[],
		// SAFETY: JSON round-trip gives the digest the parsed boundary shape.
		digest: stableDigest(JSON.parse(JSON.stringify(request)) as JsonObject),
	});
}

/** Deterministic sha256 over a stable (key-sorted) JSON encoding. */
export function stableDigest(value: JsonObject): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	if (isJsonObject(value)) {
		const input = value;
		return `{${Object.keys(input)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(input[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function matrixRow(mode: UpgradeDeploymentMode): CompatibilityInputs {
	const row = COMPATIBILITY_INPUT_MATRIX.find(
		(entry) => entry.deploymentMode === mode,
	);
	if (!row) throw new Error(`no matrix row for ${mode}`);
	return row;
}

/**
 * The four deterministic dry-run fixtures promoted from HOBO-499:
 * clean, blocked, failed-migration, rollback-ready.
 */
// eli5: annotated as Record<string, …> the known fixture names vanish from the
// type, so every read needs a `!`. `satisfies` keeps the same checking and the
// literal keys, which is what callers actually want.
export const UPGRADE_DRY_RUN_FIXTURES = Object.freeze({
	cleanUpgrade: Object.freeze({
		id: "clean-upgrade",
		compatibility: matrixRow("self-host-yard"),
		migration: Object.freeze({
			steps: Object.freeze([
				Object.freeze({
					phase: "expand" as const,
					summary: "Add compatible projection columns before readers switch.",
				}),
				Object.freeze({
					phase: "backfill" as const,
					summary: "Backfill projection rows from event-store snapshots.",
				}),
				Object.freeze({
					phase: "contract" as const,
					summary: "Retire prior projection shape after compatibility window.",
				}),
			]),
		}),
		rollback: parseRollbackEvidence({
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
			handoff:
				"Attach dry-run report, backup evidence, rollback evidence, and escalation owner.",
		}),
	}),
	blockedUpgrade: Object.freeze({
		id: "blocked-upgrade",
		compatibility: matrixRow("sdk-package"),
		migration: Object.freeze({ steps: Object.freeze([]) }),
		rollback: parseRollbackEvidence({
			state: "unavailable",
			immutableSetRef: null,
			snapshotRef: null,
			escalationOwner: "Support Workflow",
		}),
		unsupportedPath: Object.freeze({
			reason: "component-host-pin-below-floor",
			remediation:
				"Upgrade to a supported 1.0.x bridge release before targeting 1.1.0.",
		}),
		releaseNotes: Object.freeze({
			requiredInputs: Object.freeze([
				"unsupported-version-window",
				"known-limitations",
				"manual-upgrade-path",
				"support-contact",
			]),
			knownLimitation: "0.9.x cannot upgrade directly to 1.1.0.",
		}),
		support: Object.freeze({
			owner: "Support Workflow",
			handoff: "Attach blocked dry-run report and unsupported path reason.",
			nextAction: "route-to-upgrade-support",
		}),
	}),
	failedMigration: Object.freeze({
		id: "failed-migration",
		compatibility: parseCompatibilityInputs({
			...matrixRow("hosted-control-plane"),
			currentVersion: "1.0.2",
		}),
		migration: Object.freeze({
			steps: Object.freeze([
				Object.freeze({
					phase: "expand" as const,
					summary: "Add nullable tenant region column.",
				}),
				Object.freeze({
					phase: "backfill" as const,
					summary: "Backfill tenant region from deployment event store.",
				}),
			]),
			failure: Object.freeze({
				phase: "contract",
				reason: "contract-phase-would-drop-active-column",
			}),
		}),
		rollback: parseRollbackEvidence({
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
			handoff:
				"Attach dry-run failure, snapshot prerequisite, and release owner decision.",
			escalation: "release-owner-and-data-plane",
		}),
	}),
	rollbackReady: Object.freeze({
		id: "rollback-ready",
		compatibility: matrixRow("local-dev-runtime"),
		migration: Object.freeze({
			steps: Object.freeze([
				Object.freeze({
					phase: "expand" as const,
					summary: "Apply local projection compatibility shim.",
				}),
			]),
		}),
		rollback: parseRollbackEvidence({
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
			handoff:
				"Attach local dry-run report and rollback-ready fixture evidence.",
		}),
	}),
} satisfies Readonly<Record<string, UpgradeDryRunRequest>>);
