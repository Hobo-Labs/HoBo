/**
 * Matching/policy triggers for continuous identity migration.
 * Continuous dual mode is the default when adapters or tenancy spectrum change.
 * Zero required Bindle configuration.
 */
import { createHash, randomUUID } from "node:crypto";

import {
	defaultContinuousMappingSpec,
	type MappingSpec,
} from "./mapping-spec.js";
import type { MigrationMode, MigrationReason } from "./migration-aggregate.js";

// public-contract: match decision schema for identity migration triggers.
export const IDENTITY_MIGRATION_MATCH_SCHEMA =
	"hobo.identity-migration-match/v1" as const;

export type IdentityMigrationMatchDecision = Readonly<{
	schemaVersion: typeof IDENTITY_MIGRATION_MATCH_SCHEMA;
	decisionId: string;
	tenant: string;
	/** Continuous dual path is preferred by default. */
	continuousDefault: true;
	shouldStartMigration: boolean;
	reason: MigrationReason;
	mode: MigrationMode;
	sourceAdapter: string;
	targetAdapter: string;
	mapping: MappingSpec;
	ranking: readonly string[];
	/** Full reason string for match.Decided audit. */
	explanation: string;
	time: string;
}>;

export type MatchingMigrationInput = Readonly<{
	tenant: string;
	/** Current / source identity adapter id. */
	sourceAdapter: string;
	/** Desired / target identity adapter id (from Matching / policy). */
	targetAdapter?: string;
	/** Optional preferred adapters from Bindle — never required. */
	preferredAdapters?: readonly string[];
	/** Tenancy spectrum change (pooled→siloed etc.). */
	spectrumPromotion?: boolean;
	/** Residency obligation forces adapter / region change. */
	residencyShift?: boolean;
	/** Claim schema version bump. */
	claimSchemaChanged?: boolean;
	/** Yard move / control-plane relocate. */
	yardMove?: boolean;
	/** Explicit policy pack requires continuous migration. */
	policyRequiresMigration?: boolean;
	/** Policy forbids continuous (rare ceiling). */
	policyDeniesContinuous?: boolean;
	/** Optional platform-derived MappingSpec; auto-default when absent. */
	mapping?: MappingSpec;
	now?: string;
}>;

/**
 * Decide whether continuous identity migration should start.
 * Default: when source ≠ target adapter (or spectrum/residency/schema/yard signals),
 * continuous dual path is preferred — no Bindle dual-adapter block required.
 */
export function decideIdentityMigration(
	input: MatchingMigrationInput,
): IdentityMigrationMatchDecision {
	const target =
		input.targetAdapter ??
		input.preferredAdapters?.find((a) => a !== input.sourceAdapter) ??
		input.sourceAdapter;

	const adaptersDiffer = target !== input.sourceAdapter;
	const reason: MigrationReason = input.residencyShift
		? "residency"
		: input.spectrumPromotion
			? "spectrum"
			: input.claimSchemaChanged
				? "schema"
				: input.yardMove
					? "yard-move"
					: input.policyRequiresMigration
						? "policy"
						: "adapter-change";

	const shouldStart =
		input.policyDeniesContinuous !== true &&
		(adaptersDiffer ||
			input.spectrumPromotion === true ||
			input.residencyShift === true ||
			input.claimSchemaChanged === true ||
			input.yardMove === true ||
			input.policyRequiresMigration === true);

	const mode: MigrationMode = input.spectrumPromotion
		? "background"
		: input.claimSchemaChanged
			? "shadow"
			: "jit";

	const mapping =
		input.mapping ??
		defaultContinuousMappingSpec({
			sourceAdapter: input.sourceAdapter,
			targetAdapter: target,
		});

	const ranking = Object.freeze([
		"continuous-dual-default",
		`mode:${mode}`,
		`reason:${reason}`,
		adaptersDiffer ? "adapter-change-detected" : "adapter-stable",
		input.preferredAdapters?.length
			? "optional-preferredAdapters-present"
			: "no-bindle-adapter-config",
	]);

	const decisionId = `match-idmig-${createHash("sha256")
		.update(
			`${input.tenant}:${input.sourceAdapter}:${target}:${reason}:${input.now ?? ""}`,
		)
		.digest("hex")
		.slice(0, 12)}`;

	const explanation = shouldStart
		? `continuous identity migration recommended (${reason}); dual path preferred; zero Bindle config required`
		: input.policyDeniesContinuous
			? "continuous identity migration denied by policy ceiling"
			: "no identity adapter or tenancy signal requiring migration";

	return Object.freeze({
		schemaVersion: IDENTITY_MIGRATION_MATCH_SCHEMA,
		decisionId: decisionId || `match-idmig-${randomUUID().slice(0, 8)}`,
		tenant: input.tenant,
		continuousDefault: true as const,
		shouldStartMigration: shouldStart,
		reason,
		mode,
		sourceAdapter: input.sourceAdapter,
		targetAdapter: target,
		mapping,
		ranking,
		explanation,
		time: input.now ?? new Date().toISOString(),
	});
}
