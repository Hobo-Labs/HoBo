import { readFile } from "node:fs/promises";
import path from "node:path";
import { deploymentIdFor, loadProjectManifest } from "../cloud/manifest.js";
import { createFixtureSession, loadSession } from "../cloud/session.js";
import { stubResult } from "../cloud/stub.js";
import type { DeployConfig } from "../cloud/yard-client.js";
import {
	createYardClient,
	type DeliverOptions,
	FREIGHT_FILE,
	type ProgressEvent,
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

// `hobo up` — declare desired state (plan 0024 D13). With `runtime.delivery`
// wired it records LOCAL_BUILD Freight (the `.hobo/freight.json` that `hobo
// build` wrote, else the declaration alone), promotes it into the deployment
// Camp and converges it with an in-process conductor, streaming progress.
// `--to <freight|alias>` re-promotes recorded Freight, `--rollback` re-applies
// the predecessor Set, `--anonymous`/`--temporary` deploy as the anonymous
// principal for a later claim. Without delivery wired it keeps the direct
// gateway + orchestrator lane (legacy, until the composition root binds CD).

function progressLine(step: ProgressEvent): string {
	return step.resourceId
		? `${step.type} ${step.resourceId}: ${step.detail}`
		: `${step.type}: ${step.detail}`;
}

async function readFreightFile(
	projectDir: string,
): Promise<Uint8Array | undefined> {
	try {
		return await readFile(path.join(projectDir, FREIGHT_FILE));
	} catch {
		// No build output: `up` records the declaration alone.
		return undefined;
	}
}
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

			const anonymous = flags.anonymous || flags.temporary;
			// `--anonymous` never borrows a persisted login: the deploy is
			// attributed to the anonymous principal until it is claimed.
			const session = anonymous
				? createFixtureSession()
				: (deps.session ??
					(await loadSession(projectDir)) ??
					createFixtureSession());
			const deploymentId = deploymentIdFor(projectDir);
			const yard = createYardClient(runtime);
			const config: {
				-readonly [Key in keyof DeployConfig]: DeployConfig[Key];
			} = {};
			if (flags.budgetId) config.budgetId = flags.budgetId;
			if (flags.region) config.region = flags.region;
			const streamed = runtime.delivery !== undefined;
			const freightManifest = streamed
				? await readFreightFile(projectDir)
				: undefined;
			const options: DeliverOptions = {
				deploymentId,
				session,
				config,
				freightManifest,
				to: flags.to ?? undefined,
				rollback: flags.rollback,
				anonymous,
				onProgress: (step) => emitProgress(progressLine(step)),
			};
			const { result, receipt } = await yard.deliver(bindle, options);

			if (result.status === "rejected") {
				return {
					ok: false,
					status: "rejected",
					code: receipt?.refusal ?? "HOBO_PLAN_REJECTED",
					message: `hobo up rejected: ${result.reason}`,
					remediation: result.remediations.map(
						(item) => `${item.resource} (${item.code}): ${item.remediation}`,
					),
					data: {
						command: "up",
						deploymentId,
						reason: result.reason,
						remediations: result.remediations,
						delivery: receipt,
					},
				};
			}

			// The CD lane streamed progress while it converged; the legacy lane
			// reports it once the orchestrator returns.
			if (!streamed)
				for (const step of result.progress) emitProgress(progressLine(step));

			const deployed = result.status === "deployed";
			return {
				ok: deployed,
				status: deployed ? "deployed" : result.status,
				code: deployed ? "HOBO_OK" : "HOBO_UP_INCOMPLETE",
				message: deployed
					? `hobo up deployed ${result.provisioned.length} resources (${result.provisioned.join(", ")})${receipt?.claimHint ? `. ${receipt.claimHint}` : ""}`
					: `hobo up did not converge (status ${result.status})`,
				data: {
					command: "up",
					deploymentId,
					planHash: result.planHash,
					provisioned: result.provisioned,
					resources: result.plan.resources,
					progress: result.progress,
					identity: session.principal.id,
					delivery: receipt,
				},
			};
		},
	};
}
