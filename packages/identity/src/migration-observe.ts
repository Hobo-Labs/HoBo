/**
 * Observe-only surfaces for continuous identity migration.
 * Agents re-attest on identity.Migrated with zero configuration.
 */
import { agentRebindHint } from "./dual-adapter.js";
import type { IdentityMigrationRecord } from "./migration-aggregate.js";
import {
	IDENTITY_MIGRATION_EVENTS,
	type IdentityMigrationEvent,
} from "./migration-events.js";

export type MigrationStatusView = Readonly<{
	present: boolean;
	migrationId?: string;
	tenant?: string;
	state?: string;
	sourceAdapter?: string;
	targetAdapter?: string;
	rampPercent?: number;
	linkedPrincipals?: number;
	failedChecks?: number;
	cohortFlagId?: string;
	reason?: string;
	mode?: string;
	mappingSpecHash?: string;
	outcomeReason?: string;
	continuousDefault: true;
	bindleConfigRequired: false;
}>;

export function migrationStatusView(
	record: IdentityMigrationRecord | null | undefined,
): MigrationStatusView {
	if (!record) {
		return Object.freeze({
			present: false,
			continuousDefault: true as const,
			bindleConfigRequired: false as const,
		});
	}
	return Object.freeze({
		present: true,
		migrationId: record.id,
		tenant: record.tenant,
		state: record.state,
		sourceAdapter: record.sourceAdapter,
		targetAdapter: record.targetAdapter,
		rampPercent: record.rampPercent,
		linkedPrincipals: record.linkedPrincipals,
		failedChecks: record.failedChecks,
		cohortFlagId: record.cohortFlagId,
		reason: record.reason,
		mode: record.mode,
		mappingSpecHash: record.mappingSpecHash,
		...(record.outcomeReason !== undefined
			? { outcomeReason: record.outcomeReason }
			: undefined),
		continuousDefault: true as const,
		bindleConfigRequired: false as const,
	});
}

export type AgentRebindAction = Readonly<{
	principalRef: string;
	action: "re-attest-svid";
	reason: "identity-migrated";
	migrationId: string;
}>;

/**
 * Reactive fold: any identity.Migrated event yields a zero-config agent rebind.
 * Sessions / MCP subscriptions call this on subscription delivery.
 */
export function agentActionsForMigrationEvents(
	events: readonly IdentityMigrationEvent[],
): readonly AgentRebindAction[] {
	const out: AgentRebindAction[] = [];
	for (const e of events) {
		if (e.type !== IDENTITY_MIGRATION_EVENTS.Migrated) continue;
		const principalRef = String(e.data.principalRef ?? "");
		if (!principalRef) continue;
		const hint = agentRebindHint(principalRef);
		out.push(
			Object.freeze({
				...hint,
				migrationId: String(e.data.migrationId),
			}),
		);
	}
	return Object.freeze(out);
}

/** Detect dual-state / migration events that require reactive re-scope. */
export function isMigrationReactiveEvent(type: string): boolean {
	return (
		type === IDENTITY_MIGRATION_EVENTS.Migrated ||
		type === IDENTITY_MIGRATION_EVENTS.DualLinked ||
		type === IDENTITY_MIGRATION_EVENTS.MigrationCutover ||
		type === IDENTITY_MIGRATION_EVENTS.MigrationCompensated ||
		type === IDENTITY_MIGRATION_EVENTS.MigrationAborted
	);
}
