import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import type { DeployConfig } from "../cloud/yard-client.js";
import {
	createYardClient,
	type YardRuntime,
	type YardSession,
} from "../cloud/yard-client.js";
import type { CommandModule } from "../shell/registry.js";

export interface UpCommandDeps {
	// Injected Yard runtime (tests / dev wiring): in-memory/runtime-local
	// EventStore + ActorHost, the in-process Executor with an injected
	// IacProvider, credential broker, and provider registry. Adapter-free `src/`
	// leaves it undefined, so the verb stays a shell stub until wired.
	readonly runtime?: YardRuntime;
	// Explicit session override (tests). Otherwise the persisted `hobo login`
	// session is used, falling back to an anonymous fixture principal the gateway
	// still accepts.
	readonly session?: YardSession;
}

// `hobo up` — realize the object graph (mocked lane). It parses the Bindle,
// drives the @hobo/cloud gateway (Deploy -> facts -> DeploymentPlan) then the
// orchestrator (choreographed ResourceActors -> deployment.Deployed) in-process
// against the injected runtime, streaming exec.*/resource.* progress. No real
// cloud calls: provisioning runs through the injected in-memory IacProvider.
export function createUpCommand(deps: UpCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime),
		run: async ({ context, flags, emitProgress }) => {
			const { runtime } = deps;
			if (!runtime) {
				return stubResult("up");
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("up");
			}

			// Fold any providers installed via `hobo add` from the durable registry
			// stream into the matchable snapshot before planning.
			await runtime.registry.refresh?.();

			const session =
				deps.session ??
				(await loadSession(projectDir)) ??
				createFixtureSession();
			const deploymentId = deploymentIdFor(projectDir);
			const yard = createYardClient(runtime);
			const config: {
				-readonly [Key in keyof DeployConfig]: DeployConfig[Key];
			} = {};
			if (flags.budgetId) config.budgetId = flags.budgetId;
			if (flags.region) config.region = flags.region;
			const result = await yard.up(bindle, { deploymentId, session, config });

			if (result.status === "rejected") {
				return {
					ok: false,
					status: "rejected",
					code: "HOBO_PLAN_REJECTED",
					message: `hobo up rejected: ${result.reason}`,
					remediation: result.remediations.map(
						(item) => `${item.resource} (${item.code}): ${item.remediation}`,
					),
					data: {
						command: "up",
						deploymentId,
						reason: result.reason,
						remediations: result.remediations,
					},
				};
			}

			for (const step of result.progress) {
				emitProgress(
					step.resourceId
						? `${step.type} ${step.resourceId}: ${step.detail}`
						: `${step.type}: ${step.detail}`,
				);
			}

			const deployed = result.status === "deployed";
			return {
				ok: deployed,
				status: deployed ? "deployed" : result.status,
				code: deployed ? "HOBO_OK" : "HOBO_UP_INCOMPLETE",
				message: deployed
					? `hobo up deployed ${result.provisioned.length} resources (${result.provisioned.join(", ")})`
					: `hobo up did not converge (status ${result.status})`,
				data: {
					command: "up",
					deploymentId,
					planHash: result.planHash,
					provisioned: result.provisioned,
					resources: result.plan.resources,
					progress: result.progress,
					identity: session.principal.id,
				},
			};
		},
	};
}
