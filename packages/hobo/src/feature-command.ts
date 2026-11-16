/**
 * `hobo feature` — OpenFeature-native flag observe / local set / eval.
 * Subcommands: list | eval | set | kill | status
 */

import type { CommandModule } from "@hobo/cli";
import {
	createContractAssertedHarnessFixtures,
	createHarness,
	enrichEvaluationContext,
	type FeatureFlagStore,
} from "@hobo/identity";
import { isJsonString, type JsonObject } from "./json.js";

export interface FeatureCommandDeps {
	readonly store?: FeatureFlagStore;
	readonly env?: NodeJS.ProcessEnv;
}

const SUBS = [
	"list",
	"eval",
	"set",
	"kill",
	"status",
	"canary",
	"experiment",
] as const;

export function createFeatureCommand(
	deps: FeatureCommandDeps = {},
): CommandModule {
	return {
		run: async ({ args, flags, emitProgress }) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const f = flags as JsonObject;
			const fixtures = createContractAssertedHarnessFixtures({
				tenant:
					(isJsonString(f.tenant) && f.tenant) ||
					deps.env?.HOBO_TENANT ||
					"local",
			});
			const store = deps.store ?? fixtures.store;
			const harness = createHarness({ store });
			// SAFETY: assertion required at this I/O or test boundary.
			const sub = (args[0] ?? "list") as string;

			// SAFETY: assertion required at this I/O or test boundary.
			if (!(SUBS as readonly string[]).includes(sub)) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_FEATURE_USAGE",
					message: `hobo feature: unknown subcommand "${sub}"`,
					remediation: [
						"hobo feature list",
						"hobo feature eval <key>",
						"hobo feature set <key> --percent 25",
						"hobo feature kill <key>",
						"hobo feature canary status",
						"hobo feature experiment status",
					],
					data: { command: "feature", subcommands: [...SUBS] },
				};
			}

			if (sub === "list" || sub === "status") {
				const flagsList = store.list();
				emitProgress(`features: ${flagsList.length} flag(s)`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_FEATURE_LIST",
					message: `hobo feature: ${flagsList.length} flag(s)`,
					data: {
						command: "feature",
						subcommand: sub,
						flags: flagsList.map((x) => ({
							key: x.key,
							enabled: x.enabled,
							percentage: x.percentage,
							killSwitch: x.killSwitch,
							defaultVariant: x.defaultVariant,
						})),
						provider: "hobo-feature-flag",
						openFeatureOnly: true,
					},
				};
			}

			if (sub === "canary") {
				const rollouts = harness.delivery.list();
				return {
					ok: true,
					status: "ok",
					code: "HOBO_CANARY_STATUS",
					message: `canary: ${rollouts.length} rollout(s)`,
					data: {
						command: "feature",
						subcommand: "canary",
						rollouts: rollouts.map((r) => ({
							id: r.id,
							flag: r.policy.flag,
							status: r.status,
							percent: r.percent,
							gatewayWeightPercent: r.gatewayWeightPercent,
						})),
					},
				};
			}

			if (sub === "experiment") {
				return {
					ok: true,
					status: "ok",
					code: "HOBO_EXPERIMENT_STATUS",
					message: `experiments: ${harness.experiment.list().length}`,
					data: {
						command: "feature",
						subcommand: "experiment",
						experiments: harness.experiment.list(),
					},
				};
			}

			const key = args[1];
			if (!isJsonString(key) || !key) {
				return {
					ok: false,
					status: "usage",
					code: "HOBO_FEATURE_KEY_REQUIRED",
					message: "hobo feature requires <key>",
					data: { command: "feature", subcommand: sub },
				};
			}

			if (sub === "eval") {
				const ctx = enrichEvaluationContext({
					tenant: (isJsonString(f.tenant) && f.tenant) || "local",
					principal: {
						id: (isJsonString(f.subject) && f.subject) || "user:local",
					},
					environment: (isJsonString(f.env) && f.env) || "local-dev",
				});
				// Evaluate against the active store (injected or fixture), never a stale client.
				const detail = store.evaluateBoolean(key, ctx, false);
				emitProgress(
					`eval ${key}=${detail.value} variant=${detail.variant} reason=${detail.reason}`,
				);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_FEATURE_EVAL",
					message: `feature ${key} → ${detail.value}`,
					data: {
						command: "feature",
						subcommand: "eval",
						flagKey: detail.flagKey,
						value: detail.value,
						variant: detail.variant,
						reason: detail.reason,
						rulesetSeq: detail.rulesetSeq,
						openFeatureOnly: true,
						provider: "hobo-feature-flag",
					},
				};
			}

			if (sub === "set") {
				const percent = Number(f.percent ?? f.percentage ?? 100);
				const enabled = f.enabled !== "false" && f.enabled !== false;
				const def = store.define({
					key,
					percentage: Number.isFinite(percent) ? percent : 100,
					enabled: Boolean(enabled),
					state: enabled ? "ENABLED" : "DISABLED",
				});
				emitProgress(`set ${key} percent=${def.percentage}`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_FEATURE_SET",
					message: `feature ${key} updated (dev/local)`,
					data: {
						command: "feature",
						subcommand: "set",
						flag: {
							key: def.key,
							percentage: def.percentage,
							enabled: def.enabled,
						},
						note: "production mutations are policy-gated",
					},
				};
			}

			if (sub === "kill") {
				const def = store.activateKillSwitch(
					key,
					(isJsonString(f.actor) && f.actor) || "cli",
				);
				if (!def) {
					return {
						ok: false,
						status: "not_found",
						code: "HOBO_FEATURE_NOT_FOUND",
						message: `flag not found: ${key}`,
						data: { command: "feature", subcommand: "kill", key },
					};
				}
				emitProgress(`kill-switch activated for ${key}`);
				return {
					ok: true,
					status: "ok",
					code: "HOBO_FEATURE_KILL",
					message: `kill-switch on ${key}`,
					data: {
						command: "feature",
						subcommand: "kill",
						key,
						invalidationSeq: store.rulesetSeq,
					},
				};
			}

			return {
				ok: false,
				status: "usage",
				code: "HOBO_FEATURE_USAGE",
				message: "unhandled subcommand",
				data: { command: "feature" },
			};
		},
	};
}
