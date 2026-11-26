/**
 * `hobo trails` — observe-only continuous migration surface.
 *
 * Subcommands: status | plan | inspect
 * Mutations (run/cutover) are Matching/policy-gated platform ops or
 * progressive Harness ramps — not exposed as unconstrained CLI mutations.
 * Pure continuous identity requires zero Trail authoring (hands-off).
 */

import type { CommandModule } from "@hobo/cli";
import {
	createContractAssertedTrailFixtures,
	evaluateCanTrail,
	goldenIdentityHandsOff,
	identityContinuousTrail,
	type LocalTrailFixtures,
} from "@hobo/trails";
import { defaultHoboHome } from "./bare-metal-yard.js";
import { loadHoboProfile } from "./hobo-profile.js";
import { isJsonString, type JsonObject } from "./json.js";

export interface TrailsCommandDeps {
	readonly env?: NodeJS.ProcessEnv;
	readonly hoboHome?: string;
	/** Injectable fixtures for tests. */
	readonly fixtures?: LocalTrailFixtures;
}

const SUBCOMMANDS = ["status", "plan", "inspect"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

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

function resolveTarget(flags: JsonObject, env: NodeJS.ProcessEnv): string {
	const flag = flags.target;
	if (isJsonString(flag) && flag.length > 0) return flag;
	if (isJsonString(env.HOBO_TRAIL_TARGET) && env.HOBO_TRAIL_TARGET.length > 0) {
		return env.HOBO_TRAIL_TARGET;
	}
	return "local-dev";
}

export function createTrailsCommand(
	deps: TrailsCommandDeps = {},
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
					code: "HOBO_TRAILS_USAGE",
					message: `hobo trails: unknown subcommand "${sub}"`,
					remediation: [
						"Use `hobo trails status`, `hobo trails plan`, or `hobo trails inspect <trailId>`.",
						"Pure continuous identity needs zero Trail authoring — Matching/policy activates dual path.",
					],
					data: { command: "trails", subcommands: [...SUBCOMMANDS] },
				};
			}

			const tenant = resolveTenant(
				hoboHome,
				// SAFETY: assertion required at this I/O or test boundary.
				flags as JsonObject,
				env,
			);
			// SAFETY: assertion required at this I/O or test boundary.
			const target = resolveTarget(flags as JsonObject, env);
			const fixtures =
				deps.fixtures ??
				createContractAssertedTrailFixtures({ tenant, target });
			const identityTrail = identityContinuousTrail();
			const identityCan = evaluateCanTrail({
				trail: identityTrail,
				dualOracleReady: true,
				policyAllows: true,
			});
			const handsOff = goldenIdentityHandsOff({
				bindleConfigRequired: false,
				continuousDefault: true,
			});

			if (sub === "plan") {
				const plan = fixtures.runner.plan(fixtures.appTrail);
				emitProgress(
					`trail plan ${plan.canTrail.evidence.trailId}: ${plan.canTrail.summary}`,
				);
				return {
					ok: plan.canTrail.ok,
					status: plan.canTrail.ok ? "planned" : "blocked",
					code: plan.canTrail.ok
						? "HOBO_TRAILS_PLAN_OK"
						: "HOBO_TRAILS_PLAN_BLOCKED",
					message: plan.canTrail.summary,
					data: {
						command: "trails",
						subcommand: "plan" satisfies Subcommand,
						plan: {
							trailId: plan.canTrail.evidence.trailId,
							trailVersion: plan.canTrail.evidence.trailVersion,
							orderedStepIds: plan.orderedStepIds,
							identityContinuous: plan.identityContinuous,
							bindleConfigRequired: plan.bindleConfigRequired,
							dryRun: true,
							canTrail: plan.canTrail,
						},
						identityHandsOff: {
							trailId: identityTrail.id,
							bindleConfigRequired: false,
							canTrailOk: identityCan.ok,
							continuousDefault: true,
						},
						fidelity: fixtures.fidelity,
						observeOnly: true,
					},
				};
			}

			if (sub === "inspect") {
				const id = args[1] ?? fixtures.appTrail.id;
				const trail =
					id === identityTrail.id
						? identityTrail
						: id === fixtures.appTrail.id
							? fixtures.appTrail
							: null;
				if (!trail) {
					return {
						ok: false,
						status: "not_found",
						code: "HOBO_TRAILS_NOT_FOUND",
						message: `no trail ${id} in local fixtures`,
						remediation: [
							`Known fixtures: ${identityTrail.id}, ${fixtures.appTrail.id}`,
						],
						data: {
							command: "trails",
							subcommand: "inspect",
							trailId: id,
							tenant,
						},
					};
				}
				const can = evaluateCanTrail({
					trail,
					dualOracleReady: true,
					policyAllows: true,
				});
				const plan = fixtures.runner.plan(trail);
				emitProgress(
					`trail ${trail.id}@${trail.version}: steps=${trail.steps.length} can=${can.ok}`,
				);
				return {
					ok: true,
					status: can.ok ? "ready" : "blocked",
					code: "HOBO_TRAILS_INSPECT",
					message: `trail ${trail.id}@${trail.version}`,
					data: {
						command: "trails",
						subcommand: "inspect" satisfies Subcommand,
						trail: {
							id: trail.id,
							version: trail.version,
							description: trail.description,
							contentHash: trail.contentHash,
							stepIds: trail.steps.map((s) => s.id),
							recipeList: trail.recipeList ?? [],
						},
						canTrail: can,
						plan: {
							orderedStepIds: plan.orderedStepIds,
							identityContinuous: plan.identityContinuous,
							bindleConfigRequired: plan.bindleConfigRequired,
							dryRun: true,
						},
						// Pure identity continuous never requires Bindle/Trail authoring.
						bindleConfigRequired:
							trail.id === identityTrail.id ? false : plan.bindleConfigRequired,
						fidelity: fixtures.fidelity,
						observeOnly: true,
					},
				};
			}

			// status — dual fixtures + hands-off identity continuous + app sample
			const plan = fixtures.runner.plan(fixtures.appTrail);
			const message = plan.canTrail.ok
				? `trails ready: identity continuous hands-off + app sample ${fixtures.appTrail.id} (fidelity=${fixtures.fidelity})`
				: `trails blocked: ${plan.canTrail.summary}`;
			emitProgress(message);
			return {
				ok: plan.canTrail.ok && handsOff.ok,
				status: plan.canTrail.ok ? "ready" : "blocked",
				code: plan.canTrail.ok ? "HOBO_TRAILS_READY" : "HOBO_TRAILS_BLOCKED",
				message,
				data: {
					command: "trails",
					subcommand: "status" satisfies Subcommand,
					identityContinuous: {
						trailId: identityTrail.id,
						bindleConfigRequired: false,
						canTrailOk: identityCan.ok,
						continuousDefault: true,
						handsOff: true,
						principalRef: fixtures.identity.fixtures.principalRef,
						fidelity: fixtures.identity.fixtures.fidelity,
					},
					appTrail: {
						id: fixtures.appTrail.id,
						version: fixtures.appTrail.version,
						canTrailOk: plan.canTrail.ok,
						identityContinuous: plan.identityContinuous,
						orderedStepIds: plan.orderedStepIds,
					},
					handsOffOracle: {
						oracle: handsOff.oracle,
						ok: handsOff.ok,
						summary: handsOff.summary,
					},
					fidelity: fixtures.fidelity,
					label: fixtures.label,
					observeOnly: true,
					// Architecture guarantee surface for agents/doctor.
					bindleConfigRequiredForIdentityContinuous: false,
				},
			};
		},
	};
}
