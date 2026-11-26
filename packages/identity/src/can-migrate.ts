/**
 * can-migrate Gatekeeper dimension (compatible with can-deploy / upgrade-migration dry-run).
 * Offline-capable; no live IdP required when MappingSpec + dual oracle fixtures present.
 */
import type { MappingSpec } from "./mapping-spec.js";
import type { IdentityMigrationRecord } from "./migration-aggregate.js";

// public-contract: can-migrate dry-run schema version.
export const CAN_MIGRATE_SCHEMA_VERSION = "hobo.can-migrate/v1" as const;

export type CanMigrateReason = Readonly<{
	code:
		| "mapping-spec-missing"
		| "mapping-spec-invalid"
		| "adapters-identical"
		| "policy-denied"
		| "conflicting-migration"
		| "dual-oracle-not-ready"
		| "residency-conflict";
	message: string;
}>;

export type CanMigrateResult = Readonly<{
	schemaVersion: typeof CAN_MIGRATE_SCHEMA_VERSION;
	ok: boolean;
	dimension: "can-migrate";
	reasons: readonly CanMigrateReason[];
	summary: string;
	evidence: Readonly<{
		sourceAdapter?: string;
		targetAdapter?: string;
		mappingSpecHash?: string;
		mode: "jit" | "shadow" | "background";
		continuousDefault: true;
		dryRun: true;
		rollbackPosture: "compensate-to-source";
	}>;
}>;

export type CanMigrateInput = Readonly<{
	sourceAdapter: string;
	targetAdapter: string;
	mapping?: MappingSpec;
	/** Policy pack allows continuous migration (default true — continuous by default). */
	policyAllowsContinuous?: boolean;
	/** Existing active migration for same tenant (conflict). */
	activeMigration?: IdentityMigrationRecord | null;
	/** Dual oracle fixture ready (local/dev). */
	dualOracleReady?: boolean;
	/** Residency obligation conflict. */
	residencyConflict?: boolean;
	preferredMode?: "jit" | "shadow" | "background";
}>;

/**
 * Dry-run can-migrate evidence. Continuous dual mode is default when adapters differ
 * and MappingSpec is present — zero Bindle fields required.
 */
export function evaluateCanMigrate(input: CanMigrateInput): CanMigrateResult {
	const reasons: CanMigrateReason[] = [];
	const mode = input.preferredMode ?? "jit";

	if (!input.sourceAdapter || !input.targetAdapter) {
		reasons.push({
			code: "mapping-spec-invalid",
			message: "sourceAdapter and targetAdapter required",
		});
	} else if (input.sourceAdapter === input.targetAdapter) {
		reasons.push({
			code: "adapters-identical",
			message: "source and target adapters must differ",
		});
	}

	if (!input.mapping) {
		reasons.push({
			code: "mapping-spec-missing",
			message:
				"MappingSpec missing — platform should auto-derive defaultContinuousMappingSpec",
		});
	} else {
		if (input.mapping.sourceAdapter !== input.sourceAdapter) {
			reasons.push({
				code: "mapping-spec-invalid",
				message: "MappingSpec.sourceAdapter mismatch",
			});
		}
		if (input.mapping.targetAdapter !== input.targetAdapter) {
			reasons.push({
				code: "mapping-spec-invalid",
				message: "MappingSpec.targetAdapter mismatch",
			});
		}
	}

	if (input.policyAllowsContinuous === false) {
		reasons.push({
			code: "policy-denied",
			message: "policy pack denies continuous identity migration",
		});
	}

	if (
		input.activeMigration &&
		!["cutover", "compensated", "aborted", "failed", "idle"].includes(
			input.activeMigration.state,
		)
	) {
		reasons.push({
			code: "conflicting-migration",
			message: `active migration ${input.activeMigration.id} in state ${input.activeMigration.state}`,
		});
	}

	if (input.dualOracleReady === false) {
		reasons.push({
			code: "dual-oracle-not-ready",
			message: "dual-consistency oracle fixtures not ready",
		});
	}

	if (input.residencyConflict === true) {
		reasons.push({
			code: "residency-conflict",
			message: "residency obligation conflicts with target adapter",
		});
	}

	const ok = reasons.length === 0;
	return Object.freeze({
		schemaVersion: CAN_MIGRATE_SCHEMA_VERSION,
		ok,
		dimension: "can-migrate",
		reasons: Object.freeze(reasons),
		summary: ok
			? "can-migrate:ok continuous dual-path ready"
			: `can-migrate:blocked (${reasons[0]?.code})`,
		evidence: Object.freeze({
			...(input.sourceAdapter
				? { sourceAdapter: input.sourceAdapter }
				: undefined),
			...(input.targetAdapter
				? { targetAdapter: input.targetAdapter }
				: undefined),
			...(input.mapping
				? { mappingSpecHash: input.mapping.contentHash }
				: undefined),
			mode,
			continuousDefault: true as const,
			dryRun: true as const,
			rollbackPosture: "compensate-to-source" as const,
		}),
	});
}
