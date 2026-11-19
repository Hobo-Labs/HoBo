import type { CommandResult } from "@hobo/cli";
import type { CiRelayDeployInput } from "./ci-relay-deploy.js";
import {
	CI_DEPLOY_MANAGED_OPTIONS,
	runCiRelayManaged,
} from "./ci-relay-managed.js";

export async function runCiRelayDeploy(
	input: CiRelayDeployInput,
): Promise<CommandResult> {
	const allowed = new Set<string>([...CI_DEPLOY_MANAGED_OPTIONS, "wait"]);
	if (
		Object.entries(input.values).some(
			([key, value]) => value !== undefined && !allowed.has(key),
		) ||
		input.fetch !== undefined ||
		input.runVercelCli !== undefined ||
		input.probe !== undefined
	)
		return {
			ok: false,
			status: "rejected",
			code: "HOBO_CI_MANAGED_REQUIRED",
			message:
				"Legacy Git-linked delivery options and transports are unavailable. Use HoBo managed pinned-source delivery.",
		};
	return runCiRelayManaged({
		cwd: input.cwd,
		values:
			input.values.managed === true
				? input.values
				: { ...input.values, target: input.values.target ?? "preview" },
		env: input.env,
		...(input.credentials ? { credentials: input.credentials } : undefined),
		...(input.ownerSession ? { ownerSession: input.ownerSession } : undefined),
		...(input.ownerSettings
			? { ownerSettings: input.ownerSettings }
			: undefined),
		...(input.sleep ? { sleep: input.sleep } : undefined),
		...(input.now ? { now: input.now } : undefined),
		...(input.home ? { home: input.home } : undefined),
		emitProgress: input.emitProgress,
	});
}
