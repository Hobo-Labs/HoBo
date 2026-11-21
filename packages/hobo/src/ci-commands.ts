import type { CommandResult, CommandRunInput } from "@hobo/cli";
import { CI_MACHINE_COMMAND } from "./ci-machine.js";

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

	localRepository: (repo: string | undefined) => Promise<CiLocalRepository>;
}>;

export type CiCommand = Readonly<{
	name: string;

	summary: string;
	run: (context: CiCommandContext) => Promise<CommandResult>;
}>;

export const CI_COMMANDS: readonly CiCommand[] = [CI_MACHINE_COMMAND];

export function findCiCommand(
	name: string,
	table: readonly CiCommand[] = CI_COMMANDS,
): CiCommand | undefined {
	return table.find((command) => command.name === name);
}
