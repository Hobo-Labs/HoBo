/**
 * The `hobo ci` commands that dispatch through a table: each is one file that
 * exports a `CiCommand`, and one line in `CI_COMMANDS` wires it in. The
 * command parses its own arguments; `ci-command.ts` hands it what it cannot
 * reach itself (the working directory, the environment, the transport, the
 * clock, the local repository) and returns what it returns.
 *
 * Commands named in `RELAY_CI_COMMANDS` (`@hobo/ci`, ADR-0183) are added here.
 * A name already handled in `ci-command.ts` is never looked up in the table.
 */
import type { CommandResult, CommandRunInput } from "@hobo/cli";
import { CI_ACTIVITY_COMMAND } from "./ci-activity.js";
import { CI_MACHINE_CONNECT_COMMAND } from "./ci-machine-connect.js";
import { CI_PERFORMANCE_COMMAND } from "./ci-performance.js";
import { CI_PROVIDER_HEALTH_COMMAND } from "./ci-provider-health.js";
import { CI_USAGE_COMMAND } from "./ci-usage.js";

/** The checkout a command runs in, and its GitHub repository when one is known. */
export type CiLocalRepository = Readonly<{
	root: string;
	repository: string | undefined;
}>;

export type CiCommandContext = Readonly<{
	/** The arguments after the command's name. */
	args: readonly string[];
	flags: CommandRunInput["flags"];
	emitProgress: (message: string) => void;
	env: NodeJS.ProcessEnv;
	fetch: typeof fetch;
	now: () => number;
	/**
	 * The checkout at the working directory and its repository: `repo` when it
	 * is a valid `owner/name`, otherwise the `origin` remote's.
	 */
	localRepository: (repo: string | undefined) => Promise<CiLocalRepository>;
}>;

export type CiCommand = Readonly<{
	/** The word after `hobo ci`. */
	name: string;
	/** One line for help. */
	summary: string;
	run: (context: CiCommandContext) => Promise<CommandResult>;
}>;

/** Every table-dispatched `hobo ci` command, one entry each. */
export const CI_COMMANDS: readonly CiCommand[] = [
	// One entry per line, so adding a command only adds a line.
	// `machine`: `connect` runs in ci-machine-connect.ts, every other word in ci-machine.ts.
	CI_MACHINE_CONNECT_COMMAND,
	CI_PROVIDER_HEALTH_COMMAND,
	CI_ACTIVITY_COMMAND,
	CI_USAGE_COMMAND,
	CI_PERFORMANCE_COMMAND,
];

/** The command named `name` in `table`, or undefined. */
export function findCiCommand(
	name: string,
	table: readonly CiCommand[] = CI_COMMANDS,
): CiCommand | undefined {
	return table.find((command) => command.name === name);
}
