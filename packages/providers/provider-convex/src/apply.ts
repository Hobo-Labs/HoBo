/**
 * Apply a realized convex-deploy DriverProgram against Cloud or self-host.
 * This is the missing execute side of realize() (IR alone is not enough).
 */
import {
	type ConvexSpawn,
	type DeployConvexAppResult,
	deployConvexApp,
} from "./deploy.js";
import { assertDriverProgram, type DriverProgram } from "./driver-program.js";

export type ApplyConvexDriverInput = {
	readonly program: DriverProgram;
	/** App tree whose `convex/` functions are pushed (Bindle convexApp root). */
	readonly root: string;
	readonly deployKey?: string;
	readonly selfHostedUrl?: string;
	readonly selfHostedAdminKey?: string;
	readonly spawn?: ConvexSpawn;
	readonly mock?: boolean;
};

export type ApplyConvexDriverResult = {
	readonly ok: true;
	readonly deploymentUrl: string;
	readonly deploymentName: string;
	readonly connectionRefs: Readonly<Record<string, string>>;
	readonly mocked: boolean;
	readonly mode: DeployConvexAppResult["mode"];
	readonly program: DriverProgram;
};

/**
 * Execute the driver: push functions via `convex deploy`, materialize
 * connection refs (URL only — never keys) for frontend / Bindle wiring.
 */
export async function applyDriverProgram(
	input: ApplyConvexDriverInput,
): Promise<ApplyConvexDriverResult> {
	const program = assertDriverProgram(input.program);

	const deployed = await deployConvexApp({
		root: input.root,
		...(input.deployKey ? { deployKey: input.deployKey } : undefined),
		...(input.selfHostedUrl
			? { selfHostedUrl: input.selfHostedUrl }
			: undefined),
		...(input.selfHostedAdminKey
			? { selfHostedAdminKey: input.selfHostedAdminKey }
			: undefined),
		deploymentName: program.deployment,
		...(input.spawn ? { spawn: input.spawn } : undefined),
		...(input.mock !== undefined ? { mock: input.mock } : undefined),
	});

	const connectionRefs = Object.freeze({
		deploymentUrl: deployed.deploymentUrl,
		connectionRef: deployed.deploymentUrl,
	});

	return Object.freeze({
		ok: true as const,
		deploymentUrl: deployed.deploymentUrl,
		deploymentName: deployed.deploymentName,
		connectionRefs,
		mocked: deployed.mocked,
		mode: deployed.mode,
		program,
	});
}
