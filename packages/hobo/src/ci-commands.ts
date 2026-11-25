import type { CredentialResolver } from "@hobo/cd";
import type { CommandResult, CommandRunInput } from "@hobo/cli";
import { CI_ACTIVITY_COMMAND } from "./ci-activity.js";
import { CI_MACHINE_CONNECT_COMMAND } from "./ci-machine-connect.js";
import { CI_PERFORMANCE_COMMAND } from "./ci-performance.js";
import { CI_PROVIDER_HEALTH_COMMAND } from "./ci-provider-health.js";
import { CI_RUNNERS_COMMAND } from "./ci-runners.js";
import { CI_USAGE_COMMAND } from "./ci-usage.js";

export type CiLocalRepository = Readonly<{
	root: string;
	repository: string | undefined;
}>;

export type CiCommandContext = Readonly<{
	args: readonly string[];
	flags: CommandRunInput["flags"];
	emitProgress: (message: string) => void;
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	now: () => number;
	credentials: CredentialResolver | undefined;

	localRepository: (repo: string | undefined) => Promise<CiLocalRepository>;
}>;

export type CiCommand = Readonly<{
	name: string;

	summary: string;
	run: (context: CiCommandContext) => Promise<CommandResult>;
}>;

export const CI_COMMANDS: readonly CiCommand[] = [
	CI_MACHINE_CONNECT_COMMAND,
	CI_RUNNERS_COMMAND,
	CI_PROVIDER_HEALTH_COMMAND,
	CI_ACTIVITY_COMMAND,
	CI_USAGE_COMMAND,
	CI_PERFORMANCE_COMMAND,
];

export function findCiCommand(
	name: string,
	table: readonly CiCommand[] = CI_COMMANDS,
): CiCommand | undefined {
	return table.find((command) => command.name === name);
}
