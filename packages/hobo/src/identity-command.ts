/**
 * `hobo identity` — observe-only continuous identity migration surface.
 *
 * Subcommands: status | inspect
 * Mutations (start/link/cutover) are Matching/policy-gated platform ops —
 * not exposed here. Agents auto-rebind on identity.Migrated with zero config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "@hobo/cli";
import {
	createContractAssertedDualFixtures,
	dualVerifyClaims,
	evaluateCanMigrate,
	foldIdentityMigrationEvents,
	type IdentityMigrationEvent,
	type IdentityMigrationService,
	matchingSignalsFromResourceDecision,
	migrationStatusView,
} from "@hobo/identity";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface IdentityCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	/** Injectable service for tests. */
	readonly service?: IdentityMigrationService | null;
}

const SUBCOMMANDS = ["status", "inspect"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function migrationStorePath(hoboHome: string): string {
	return join(hoboHome, "identity-migrations", "events.jsonl");
}

function loadMigrationEvents(hoboHome: string): IdentityMigrationEvent[] {
	const path = migrationStorePath(hoboHome);
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
	// SAFETY: assertion required at this I/O or test boundary.
	return lines.map((line) => JSON.parse(line) as IdentityMigrationEvent);
}

function resolveTenant(
	hoboHome: string,
	flags: JsonObject,
	env: NodeJS.ProcessEnv,
): string {
	const flag = flags.tenant;
	if (isJsonString(flag) && flag.length > 0) return flag;
	if (isJsonString(env.HOBO_TENANT) && env.HOBO_TENANT.length > 0) {
		return env.HOBO_TENANT;
	}
	return loadHoboProfile(hoboHome)?.session?.tenant ?? "local";
}

/**
 * Persist migration events for local observe (platform writes; CLI is read-mostly).
 * Exported for tests that seed dual-path state.
 */
export function persistMigrationEvents(
	hoboHome: string,
	events: readonly IdentityMigrationEvent[],
): void {
	const dir = join(hoboHome, "identity-migrations");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		migrationStorePath(hoboHome),
		`${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
		"utf8",
	);
}

export function createIdentityCommand(
	deps: IdentityCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, flags, emitProgress }) => {
			const env = deps.env ?? process.env;
			const hoboHome =
				deps.hoboHome ??
				(isJsonString(env.HOBO_HOME) && env.HOBO_HOME.length > 0
					? env.HOBO_HOME
					: defaultHoboHome());
			// SAFETY: assertion required at this I/O or test boundary.
			const sub = (args[0] ?? "status") as string;
			// SAFETY: assertion required at this I/O or test boundary.
			if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_IDENTITY_USAGE",
					message: `hobo identity: unknown subcommand "${sub}"`,
					remediation: [
						"Use `hobo identity status` or `hobo identity inspect <migrationId>`.",
						"Continuous migration is Matching/policy-driven — nothing required in the Bindle.",
					],
					data: { command: "identity", subcommands: [...SUBCOMMANDS] },
				};
			}

			const tenant = resolveTenant(hoboHome, flags, env);
			const dual = createContractAssertedDualFixtures({ tenant });
			const dualOracle = dualVerifyClaims({
				mapping: dual.mapping,
				sourceClaims: dual.sourceClaims,
				targetClaims: dual.targetClaims,
				tenant: dual.tenant,
			});
			const canMigrate = evaluateCanMigrate({
				sourceAdapter: dual.sourceAdapter,
				targetAdapter: dual.targetAdapter,
				mapping: dual.mapping,
				dualOracleReady: dualOracle.ok,
			});

			const record =
				deps.service !== undefined
					? (deps.service?.snapshot() ?? null)
					: foldIdentityMigrationEvents(loadMigrationEvents(hoboHome), {
							tenant,
							mapping: dual.mapping,
						});

			if (sub === "inspect") {
				const id = args[1];
				if (!isJsonString(id) || id.length === 0) {
					return {
						ok: false,
						status: "usage",
						code: "HOBO_IDENTITY_INSPECT_USAGE",
						message: "hobo identity inspect requires <migrationId>",
						remediation: [
							"Run `hobo identity status` to list active migration state.",
						],
						data: { command: "identity", subcommand: "inspect" },
					};
				}
				if (!record || record.id !== id) {
					return {
						ok: false,
						status: "not_found",
						code: "HOBO_IDENTITY_MIGRATION_NOT_FOUND",
						message: `no migration ${id} for tenant ${tenant}`,
						data: {
							command: "identity",
							subcommand: "inspect",
							migrationId: id,
							tenant,
						},
					};
				}
				const view = migrationStatusView(record);
				emitProgress(
					`migration ${record.id}: state=${record.state} ramp=${record.rampPercent}% dual-failed=${record.failedChecks}`,
				);
				return {
					ok: true,
					status: record.state,
					code: "HOBO_IDENTITY_MIGRATION",
					message: `identity migration ${record.id} (${record.state})`,
					data: {
						command: "identity",
						subcommand: "inspect",
						migration: view,
						dualFixtures: {
							label: dual.label,
							fidelity: dual.fidelity,
							principalRef: dual.principalRef,
							dualOracleOk: dualOracle.ok,
						},
						canMigrate,
						bindleConfigRequired: false,
					},
				};
			}

			// status
			const view = migrationStatusView(record);
			const message = view.present
				? `identity migration ${view.migrationId}: ${view.state} (ramp ${view.rampPercent}%)`
				: "no active identity migration — continuous dual path available by default (zero Bindle config)";
			emitProgress(message);
			// Illustrate Matching→migration signal extraction (no Bindle fields).
			const exampleMatchSignal = matchingSignalsFromResourceDecision({
				tenant,
				port: "auth",
				previousProviderId: dual.sourceAdapter,
				winnerProviderId: dual.targetAdapter,
			});

			return {
				ok: true,
				status: view.present ? String(view.state) : "idle",
				code: view.present
					? "HOBO_IDENTITY_MIGRATION_ACTIVE"
					: "HOBO_IDENTITY_MIGRATION_IDLE",
				message,
				data: {
					command: "identity",
					subcommand: "status" satisfies Subcommand,
					migration: view,
					dualFixtures: {
						label: dual.label,
						fidelity: dual.fidelity,
						principalRef: dual.principalRef,
						sourceAdapter: dual.sourceAdapter,
						targetAdapter: dual.targetAdapter,
						dualOracleOk: dualOracle.ok,
					},
					canMigrate: {
						ok: canMigrate.ok,
						summary: canMigrate.summary,
						dimension: canMigrate.dimension,
						continuousDefault: true,
						dryRun: true,
					},
					matchingSignal: exampleMatchSignal,
					bindleConfigRequired: false,
					observeOnly: true,
				},
			};
		},
	};
}
