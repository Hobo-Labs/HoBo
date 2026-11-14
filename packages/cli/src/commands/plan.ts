import { manifestHostingPolicy } from "@hobo/cloud";
import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import {
	createYardClient,
	planHostingAuthoritatively,
	type YardPreflightRuntime,
	type YardRuntime,
	type YardSession,
} from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface PlanCommandDeps {
	// Injected Yard runtime (tests / dev wiring). Its provider registry drives the
	// pure Planner; store/executor/broker are unused by the read-only plan path.
	readonly runtime?: YardRuntime;
	/** Production planning uses the read-only hosting authority, not the
	 * mutation-capable Yard runtime. */
	readonly preflightRuntime?: YardPreflightRuntime;
	readonly session?: YardSession;
}

// `hobo plan` — dry-run the up decision (read-only). It parses the project's
// Bindle manifest, runs the pure @hobo/cloud Planner against the injected
// provider registry, and renders the content-addressed DeploymentPlan diff. An
// unsatisfiable manifest surfaces the machine-readable remediation and exits
// non-zero. With no runtime injected (adapter-free default), it stays a stub.
export function createPlanCommand(deps: PlanCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime || deps.preflightRuntime),
		run: async ({ context, flags, args }) => {
			const { runtime, preflightRuntime } = deps;
			if (!runtime && !preflightRuntime) {
				return stubResult("plan");
			}
			if (
				preflightRuntime &&
				(args.length ||
					flags.camp ||
					flags.target ||
					flags.broker ||
					flags.brokerUri)
			)
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_PLAN_TARGET_UNAVAILABLE",
					message:
						"The configured hosting authority cannot verify that target selector",
					remediation: ["Select the intended project with --cwd and retry."],
				};

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("plan");
			}

			// Fold any providers installed via `hobo add` from the durable registry
			// stream into the matchable snapshot before planning.
			if (!preflightRuntime) await runtime?.registry.refresh?.();

			const deploymentId = deploymentIdFor(projectDir);
			const budgetId =
				flags.budgetId ??
				preflightRuntime?.defaultHostingBudgetId ??
				runtime?.defaultHostingBudgetId;
			const session = deps.session ?? (await loadSession(projectDir));
			if (preflightRuntime && !session)
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_HOSTING_SESSION_REQUIRED",
					message: "Log in to the hosting Yard before planning this deployment",
					remediation: ["Authenticate with hobo login and retry."],
				};
			const config = {
				...(budgetId ? { budgetId } : undefined),
				...(flags.region ? { region: flags.region } : undefined),
			};
			const rendered =
				preflightRuntime && session
					? await planHostingAuthoritatively(preflightRuntime, bindle, {
							deploymentId,
							session,
							config,
							requireYardBinding: true,
						})
					: runtime && (budgetId || manifestHostingPolicy(bindle).required)
						? await planHostingAuthoritatively(runtime, bindle, {
								deploymentId,
								session: session ?? createFixtureSession(),
								config,
							})
						: runtime
							? createYardClient(runtime).plan(bindle, { deploymentId, config })
							: undefined;
			if (!rendered) return stubResult("plan");

			if (!rendered.ok) {
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_PLAN_REJECTED",
					message: `hobo plan rejected: ${rendered.reason}`,
					remediation: rendered.remediations.map(
						(item) => `${item.resource} (${item.code}): ${item.remediation}`,
					),
					data: {
						command: "plan",
						deploymentId,
						reason: rendered.reason,
						remediations: rendered.remediations,
					},
				};
			}

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo plan ok (${rendered.resources.length} resources, planHash ${rendered.planHash})`,
				data: {
					command: "plan",
					deploymentId,
					planHash: rendered.planHash,
					dependencyOrder: rendered.dependencyOrder,
					resources: rendered.resources,
					plan: rendered.plan,
				},
			};
		},
	};
}
