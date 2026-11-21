import { readFile } from "node:fs/promises";
import path from "node:path";
import { externalBoundaryRefusal } from "../cloud/boundaries.js";
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
import { createPlanCommand } from "./plan.js";

export interface UpCommandDeps {
	readonly runtime?: YardRuntime;
	readonly session?: YardSession;
}


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
		return undefined;
	}
}
export function createUpCommand(deps: UpCommandDeps = {}): CommandModule {
	return {
		implemented: Boolean(deps.runtime),
		run: async (input) => {
			const { context, flags, emitProgress } = input;
			const { runtime } = deps;
			if (!runtime) {
				return stubResult("up");
			}
			if (flags.whatIf) {
				const session =
					flags.anonymous || flags.temporary
						? createFixtureSession()
						: deps.session;
				const planned = await createPlanCommand({
					runtime,
					...(session ? { session } : undefined),
				}).run(input);
				return {
					...planned,
					...(planned.message !== undefined
						? {
								message: planned.message.replace(
									/^hobo plan/,
									"hobo up --what-if",
								),
							}
						: undefined),
					data: { ...planned.data, command: "up", whatIf: true },
				};
			}

			const projectDir = context.projectDir ?? context.cwd;
			const bindle = await loadProjectManifest(projectDir);
			if (!bindle) {
				return stubResult("up");
			}

			const boundary = await externalBoundaryRefusal(projectDir, "up");
			if (boundary !== undefined) return boundary;

			await runtime.registry.refresh?.();

			const anonymous = flags.anonymous || flags.temporary;
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
			if (flags.mode === "incremental" || flags.mode === "complete")
				config.mode = flags.mode;
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
