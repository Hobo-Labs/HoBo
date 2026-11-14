import { manifestHostingPolicy, parseDeploymentMode } from "@hobo/cloud";
import { externalBoundaryRefusal } from "../cloud/boundaries.js";
import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import { changeSummaryLine, upWhatIf } from "../cloud/what-if.js";
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
			let mode: ReturnType<typeof parseDeploymentMode>;
			try {
				mode = parseDeploymentMode(flags.mode);
			} catch (error) {
				return {
					ok: false,
					status: "usage_error",
					code: "HOBO_USAGE",
					message: `hobo plan: ${error instanceof Error ? error.message : String(error)}`,
					remediation: ["Pass --mode incremental or --mode complete."],
				};
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("plan");
			}

			// A Yard holds nothing external: refuse before planning.
			const boundary = await externalBoundaryRefusal(projectDir, "plan");
			if (boundary !== undefined) return boundary;

			// Fold any providers installed via `hobo add` from the durable registry
			// stream into the matchable snapshot before planning.
			await runtime.registry.refresh?.();

			const deploymentId = deploymentIdFor(projectDir);
			const yard = createYardClient(runtime);
			const budgetId = flags.budgetId ?? runtime.defaultHostingBudgetId;
			if (
				flags.mode &&
				(budgetId ||
					runtime.hostingBudgetRequired ||
					manifestHostingPolicy(bindle).required)
			)
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
					message: "Budgeted hosting does not support --mode.",
					remediation: ["Omit --mode for this hosting deployment."],
					data: { command: "plan", deploymentId },
				};
			const rendered =
				budgetId ||
				runtime.hostingBudgetRequired ||
				manifestHostingPolicy(bindle).required
					? await yard.planAuthoritatively(bindle, {
							deploymentId,
							session:
								(await loadSession(projectDir)) ?? createFixtureSession(),
							config: {
								...(budgetId ? { budgetId } : undefined),
								...(flags.region ? { region: flags.region } : undefined),
							},
						})
					: yard.plan(bindle, {
							deploymentId,
							config: flags.region ? { region: flags.region } : {},
						});

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

			// The what-if: the change set `up` would apply against what the log
			// recorded (create / update / no-op / delete / retain).
			let changes: Awaited<ReturnType<typeof upWhatIf>>;
			try {
				changes = await upWhatIf(
					runtime.store,
					deploymentId,
					rendered.plan,
					mode,
					budgetId ||
						runtime.hostingBudgetRequired ||
						manifestHostingPolicy(bindle).required
						? undefined
						: runtime.delivery,
				);
			} catch (error) {
				return {
					ok: false,
					status: "unavailable",
					code: "HOBO_PREVIEW_UNAVAILABLE",
					message: `hobo plan: ${error instanceof Error ? error.message : String(error)}`,
					remediation: [
						"Wait for the current deployment to converge, then retry the preview.",
					],
					data: { command: "plan", deploymentId },
				};
			}

			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo plan ok (${rendered.resources.length} resources, ${changeSummaryLine(changes)}, planHash ${rendered.planHash})`,
				data: {
					command: "plan",
					deploymentId,
					planHash: rendered.planHash,
					dependencyOrder: rendered.dependencyOrder,
					resources: rendered.resources,
					plan: rendered.plan,
					changes,
				},
			};
		},
	};
}
