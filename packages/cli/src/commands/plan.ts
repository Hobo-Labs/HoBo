import { manifestHostingPolicy, parseDeploymentMode } from "@hobo/cloud";
import { externalBoundaryRefusal } from "../cloud/boundaries.js";
import {
	deploymentIdFor,
	loadProjectManifest,
	missingProjectBindle,
} from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import { changeSummaryLine, upWhatIf } from "../cloud/what-if.js";
import {
	createYardClient,
	planHostingAuthoritatively,
	type YardPreflightRuntime,
	type YardRuntime,
	type YardSession,
} from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface PlanCommandDeps {
	readonly runtime?: YardRuntime;
	readonly preflightRuntime?: YardPreflightRuntime;
	readonly session?: YardSession;
}

export function createPlanCommand(deps: PlanCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime || deps.preflightRuntime),
		run: async ({ context, flags, args }) => {
			const { runtime, preflightRuntime } = deps;
			if (!runtime && !preflightRuntime) {
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
				return missingProjectBindle("plan", projectDir);
			}

			const boundary = await externalBoundaryRefusal(projectDir, "plan");
			if (boundary !== undefined) return boundary;

			const deploymentId = deploymentIdFor(projectDir);
			const budgetId =
				flags.budgetId ??
				preflightRuntime?.defaultHostingBudgetId ??
				runtime?.defaultHostingBudgetId;
			const hosted = Boolean(
				preflightRuntime ||
					budgetId ||
					runtime?.hostingBudgetRequired ||
					manifestHostingPolicy(bindle).required,
			);
			if (
				hosted &&
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
			if (flags.mode && hosted)
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
					message: "Budgeted hosting does not support --mode.",
					remediation: ["Omit --mode for this hosting deployment."],
					data: { command: "plan", deploymentId },
				};
			if (!preflightRuntime) await runtime?.registry.refresh?.();
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
						})
					: runtime && hosted
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

			const journaledRuntime = preflightRuntime ? undefined : runtime;
			let changes: Awaited<ReturnType<typeof upWhatIf>> | undefined;
			if (journaledRuntime) {
				try {
					changes = await upWhatIf(
						journaledRuntime.store,
						deploymentId,
						rendered.plan,
						mode,
						hosted ? undefined : journaledRuntime.delivery,
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
			}
			return {
				ok: true,
				status: "ok",
				code: "HOBO_OK",
				message: `hobo plan ok (${rendered.resources.length} resources, ${changes ? `${changeSummaryLine(changes)}, ` : "placement only, "}planHash ${rendered.planHash})`,
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
