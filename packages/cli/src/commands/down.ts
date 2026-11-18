import { collectStream, manifestHostingPolicy } from "@hobo/cloud";
import {
	deploymentIdFor,
	loadProjectManifest,
	missingProjectBindle,
} from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import { downWhatIf } from "../cloud/what-if.js";
import {
	createYardClient,
	type ProgressEvent,
	type YardRuntime,
	type YardSession,
} from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface DownCommandDeps {
	readonly runtime?: YardRuntime;
	readonly session?: YardSession;
}

function progressLine(step: ProgressEvent): string {
	return step.resourceId
		? `${step.type} ${step.resourceId}: ${step.detail}`
		: `${step.type}: ${step.detail}`;
}
export function createDownCommand(deps: DownCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime),
		run: async ({ context, flags, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return stubResult("down");
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return missingProjectBindle("down", projectDir);
			}

			await runtime.registry.refresh?.();

			const session =
				deps.session ??
				(await loadSession(projectDir)) ??
				createFixtureSession();
			const deploymentId = deploymentIdFor(projectDir);
			if (flags.whatIf) {
				const history = await collectStream(
					runtime.store,
					`deployment:${deploymentId}`,
				);
				let wouldDestroy: string[];
				try {
					wouldDestroy = await downWhatIf(
						runtime.store,
						deploymentId,
						runtime.hostingBudgetRequired ||
							manifestHostingPolicy(bindle).required ||
							history.some((event) => event.type === "hosting.BudgetReserved")
							? undefined
							: runtime.delivery,
					);
				} catch (error) {
					return {
						ok: false,
						status: "unavailable",
						code: "HOBO_PREVIEW_UNAVAILABLE",
						message: `hobo down --what-if: ${error instanceof Error ? error.message : String(error)}`,
						remediation: [
							"Wait for the current deployment to converge, then retry the preview.",
						],
						data: { command: "down", deploymentId },
					};
				}
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo down --what-if would destroy ${wouldDestroy.length} resources${wouldDestroy.length > 0 ? ` (${wouldDestroy.join(", ")})` : ""}`,
					data: {
						command: "down",
						deploymentId,
						whatIf: true,
						wouldDestroy,
					},
				};
			}
			const yard = createYardClient(runtime);
			const streamed = runtime.delivery !== undefined;
			const { result, receipt } = await yard.teardown(bindle, {
				deploymentId,
				session,
				onProgress: (step) => emitProgress(progressLine(step)),
			});

			if (!streamed)
				for (const step of result.progress)
					if (step.type.startsWith("resource."))
						emitProgress(progressLine(step));

			const destroyed = result.status === "destroyed";
			return {
				ok: destroyed,
				status: result.status,
				code: destroyed ? "HOBO_OK" : "HOBO_DOWN_INCOMPLETE",
				message: destroyed
					? `hobo down destroyed ${result.destroyed.length} resources (${result.destroyed.join(", ")})`
					: `hobo down needs attention (status ${result.status})`,
				remediation: destroyed
					? []
					: [
							"Inspect the Camp with `hobo deploy status` and the progress above, fix the cause, then rerun `hobo down`.",
						],
				data: {
					command: "down",
					deploymentId,
					destroyed: result.destroyed,
					progress: result.progress,
					identity: session.principal.id,
					delivery: receipt,
				},
			};
		},
	};
}
