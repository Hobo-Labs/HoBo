import { manifestHostingPolicy } from "@hobo/cloud";
import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import { createYardClient, type YardRuntime } from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface PlanCommandDeps {
	// Injected Yard runtime (tests / dev wiring). Its provider registry drives the
	// pure Planner; store/executor/broker are unused by the read-only plan path.
	readonly runtime?: YardRuntime;
}

// `hobo plan` — dry-run the up decision (read-only). It parses the project's
// Bindle manifest, runs the pure @hobo/cloud Planner against the injected
// provider registry, and renders the content-addressed DeploymentPlan diff. An
// unsatisfiable manifest surfaces the machine-readable remediation and exits
// non-zero. With no runtime injected (adapter-free default), it stays a stub.
export function createPlanCommand(deps: PlanCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime),
		run: async ({ context, flags }) => {
			const { runtime } = deps;
			if (!runtime) {
				return stubResult("plan");
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("plan");
			}

			// Fold any providers installed via `hobo add` from the durable registry
			// stream into the matchable snapshot before planning.
			await runtime.registry.refresh?.();

			const deploymentId = deploymentIdFor(projectDir);
			const yard = createYardClient(runtime);
			const budgetId = flags.budgetId ?? runtime.defaultHostingBudgetId;
			const rendered =
				budgetId || manifestHostingPolicy(bindle).required
					? await yard.planAuthoritatively(bindle, {
							deploymentId,
							session:
								(await loadSession(projectDir)) ?? createFixtureSession(),
							config: budgetId ? { budgetId } : {},
						})
					: yard.plan(bindle, { deploymentId });

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
