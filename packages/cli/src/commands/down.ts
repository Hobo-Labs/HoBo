import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
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

// `hobo down` — tear down what up realized. With `runtime.delivery` wired it
// is a teardown Delta (plan 0024 D13): promotion intent `down` through the
// same gate, converged by the in-process conductor, with progress streamed.
// Without delivery wired it reconstructs the DeploymentPlan from the Bindle and
// drives the @hobo/cloud compensation path (legacy). DownResult is unchanged.

function progressLine(step: ProgressEvent): string {
	return step.resourceId
		? `${step.type} ${step.resourceId}: ${step.detail}`
		: `${step.type}: ${step.detail}`;
}
export function createDownCommand(deps: DownCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime),
		run: async ({ context, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return stubResult("down");
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("down");
			}

			// Fold any providers installed via `hobo add` from the durable registry
			// stream so the reconstructed plan matches what `up` realized.
			await runtime.registry.refresh?.();

			const session =
				deps.session ??
				(await loadSession(projectDir)) ??
				createFixtureSession();
			const deploymentId = deploymentIdFor(projectDir);
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
				...(destroyed
					? {}
					: {
							remediation: [
								"Inspect the Camp with `hobo deploy status` and the progress above, fix the cause, then rerun `hobo down`.",
							],
						}),
				data: {
					command: "down",
					deploymentId,
					destroyed: result.destroyed,
					progress: result.progress,
					identity: session.principal.id,
					...(receipt ? { delivery: receipt } : {}),
				},
			};
		},
	};
}
