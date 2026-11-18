import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export const UPGRADE_DRY_RUN_SCHEMA = "hobo.upgrade-rollback-dry-run/v1";
export const UPGRADE_DRY_RUN_ACTION = "evaluate-upgrade-dry-run";
export type UpgradeDryRunAction = typeof UPGRADE_DRY_RUN_ACTION;

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

export interface CompatibilityInputs {
	readonly currentVersion: string;
	readonly targetVersion: string;
	readonly deploymentMode: UpgradeDeploymentMode;
	readonly componentHostPin: string;
	readonly manifestVersion: string;
	readonly contractCompatibility: ContractCompatibilityResult;
	readonly dataSchemaPosture: DataSchemaPosture;
	readonly providerStateDependency: string | null;
	readonly backupPrerequisite: BackupPrerequisite;
	readonly rollbackEvidenceRef: string | null;
	readonly supportHandoffOwner: string;
}

export type RollbackState =
	| "available"
	| "unavailable"
	| "required-before-execution"
	| "recoverable";

export interface RollbackEvidence {
	readonly state: RollbackState;
	readonly immutableSetRef: string | null;
	readonly snapshotRef: string | null;
	readonly restorePrerequisite?: string;
	readonly blockedRestoreReason?: string;
	readonly escalationOwner: string;
}

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

function onlyKeys(
	input: JsonObject,
	allowed: readonly string[],
	path: string,
): void {
	for (const key of Object.keys(input)) {
		if (!allowed.includes(key)) {
			throw new UpgradePreflightParseError(
				`${path}.${key}`,
				`only fields ${allowed.join(", ")}`,
				input[key],
			);
		}
	}
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
	onlyKeys(
		input,
		[
			"currentVersion",
			"targetVersion",
			"deploymentMode",
			"componentHostPin",
			"manifestVersion",
			"contractCompatibility",
			"dataSchemaPosture",
			"providerStateDependency",
			"backupPrerequisite",
			"rollbackEvidenceRef",
			"supportHandoffOwner",
		],
		path,
	);
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
	onlyKeys(
		input,
		[
			"state",
			"immutableSetRef",
			"snapshotRef",
			"restorePrerequisite",
			"blockedRestoreReason",
			"escalationOwner",
		],
		path,
	);
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

export function classifyUpgradeDryRunDecision(
	decision: string,
): UpgradeDryRunDecision {
	return decision === UPGRADE_DRY_RUN_ACTION
		? { owner: "Upgrade & Migration Engine", inScope: true }
		: { owner: "Out of scope", inScope: false };
}

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
	readonly action?: UpgradeDryRunAction;
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
	readonly mutationCommands: readonly never[];
	readonly digest: string;
}

const MIGRATION_PHASES = new Set<UpgradeDryRunMigrationStep["phase"]>([
	"expand",
	"backfill",
	"contract",
]);

function list(value: JsonValue, path: string): readonly JsonValue[] {
	if (!Array.isArray(value)) {
		throw new UpgradePreflightParseError(path, "array", value);
	}
	return value;
}

function optionalString(value: JsonValue, path: string): string | undefined {
	return value === undefined ? undefined : str(value, path);
}

export function parseUpgradeDryRunRequest(
	value: JsonValue,
): UpgradeDryRunRequest {
	const input = record(value, "upgradeDryRun");
	onlyKeys(
		input,
		[
			"id",
			"action",
			"compatibility",
			"migration",
			"rollback",
			"unsupportedPath",
			"releaseNotes",
			"support",
		],
		"upgradeDryRun",
	);
	const action = optionalString(input.action, "requestedAction");
	if (action !== undefined) assertUpgradeScopeBoundary(action);
	const migration = record(input.migration, "migration");
	onlyKeys(migration, ["steps", "failure"], "migration");
	const steps = list(migration.steps, "migration.steps").map((value, index) => {
		const path = `migration.steps[${index}]`;
		const step = record(value, path);
		onlyKeys(step, ["phase", "summary"], path);
		return Object.freeze({
			phase: member(step.phase, MIGRATION_PHASES, `${path}.phase`),
			summary: str(step.summary, `${path}.summary`),
		});
	});
	const order = [...MIGRATION_PHASES];
	for (let index = 1; index < steps.length; index += 1) {
		const previous = steps[index - 1];
		const current = steps[index];
		if (
			previous &&
			current &&
			order.indexOf(previous.phase) > order.indexOf(current.phase)
		) {
			throw new UpgradePreflightParseError(
				`migration.steps[${index}].phase`,
				"phases in expand, backfill, contract order",
				current.phase,
			);
		}
	}
	const failure =
		migration.failure === undefined
			? undefined
			: record(migration.failure, "migration.failure");
	if (failure) onlyKeys(failure, ["phase", "reason"], "migration.failure");
	const release = record(input.releaseNotes, "releaseNotes");
	onlyKeys(release, ["requiredInputs", "knownLimitation"], "releaseNotes");
	const knownLimitation = optionalString(
		release.knownLimitation,
		"releaseNotes.knownLimitation",
	);
	const support = record(input.support, "support");
	onlyKeys(
		support,
		["owner", "handoff", "nextAction", "escalation"],
		"support",
	);
	const nextAction = optionalString(support.nextAction, "support.nextAction");
	const escalation = optionalString(support.escalation, "support.escalation");
	const unsupported =
		input.unsupportedPath === undefined
			? undefined
			: record(input.unsupportedPath, "unsupportedPath");
	if (unsupported)
		onlyKeys(unsupported, ["reason", "remediation"], "unsupportedPath");
	return Object.freeze({
		id: str(input.id, "id"),
		...(action === undefined ? undefined : { action: UPGRADE_DRY_RUN_ACTION }),
		compatibility: parseCompatibilityInputs(
			input.compatibility,
			"compatibility",
		),
		migration: Object.freeze({
			steps: Object.freeze(steps),
			...(failure === undefined
				? undefined
				: {
						failure: Object.freeze({
							phase: member(
								failure.phase,
								MIGRATION_PHASES,
								"migration.failure.phase",
							),
							reason: str(failure.reason, "migration.failure.reason"),
						}),
					}),
		}),
		rollback: parseRollbackEvidence(input.rollback, "rollback"),
		...(unsupported === undefined
			? undefined
			: {
					unsupportedPath: Object.freeze({
						reason: str(unsupported.reason, "unsupportedPath.reason"),
						remediation: str(
							unsupported.remediation,
							"unsupportedPath.remediation",
						),
					}),
				}),
		releaseNotes: Object.freeze({
			requiredInputs: Object.freeze(
				list(release.requiredInputs, "releaseNotes.requiredInputs").map(
					(entry, index) => str(entry, `releaseNotes.requiredInputs[${index}]`),
				),
			),
			...(knownLimitation === undefined ? undefined : { knownLimitation }),
		}),
		support: Object.freeze({
			owner: str(support.owner, "support.owner"),
			handoff: str(support.handoff, "support.handoff"),
			...(nextAction === undefined ? undefined : { nextAction }),
			...(escalation === undefined ? undefined : { escalation }),
		}),
	});
}

export function evaluateUpgradeDryRun(
	request: UpgradeDryRunRequest,
): UpgradeDryRunReport {
	const input = parseUpgradeDryRunRequest(JSON.parse(JSON.stringify(request)));
	const blockedReasons: string[] = [];
	if (input.compatibility.contractCompatibility === "unsupported") {
		blockedReasons.push("contract-compatibility-unsupported");
	}
	if (input.compatibility.contractCompatibility === "needs-review") {
		blockedReasons.push("contract-compatibility-needs-review");
	}
	if (input.compatibility.backupPrerequisite === "required-but-missing") {
		blockedReasons.push("backup-prerequisite-missing");
	}
	if (
		input.migration.steps.some((step) => step.phase === "contract") &&
		(input.rollback.state === "unavailable" ||
			input.rollback.state === "required-before-execution")
	) {
		blockedReasons.push("rollback-evidence-unavailable");
	}
	const failed = input.migration.failure !== undefined;
	const status = failed
		? "failed"
		: blockedReasons.length > 0
			? "blocked"
			: "passed";
	return Object.freeze({
		schema: UPGRADE_DRY_RUN_SCHEMA,
		fixtureId: input.id,
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
		compatibility: input.compatibility,
		backupRequirement: input.compatibility.backupPrerequisite,
		migrationPlan:
			status === "blocked"
				? Object.freeze({ steps: Object.freeze([]) })
				: input.migration,
		blockedReasons: Object.freeze(blockedReasons),
		rollbackEvidence: input.rollback,
		releaseNotes: input.releaseNotes,
		supportHandoff: input.support,
		unsupportedPath: input.unsupportedPath ?? null,
		mutationCommands: Object.freeze([]) as readonly never[],
		digest: stableDigest(JSON.parse(JSON.stringify(input)) as JsonObject),
	});
}

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
