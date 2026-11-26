/**
 * What `buildLaunch` returns: the command, the argv and the environment that
 * `spawn` needs, in a frozen value that prints none of them in full. The
 * environment holds the store passphrase when the caller lists it in `passEnv`,
 * and the argv holds the caller's command, which may carry a token as an
 * argument, so logging, serialising, enumerating or copying a Launch
 * (`util.inspect`, `console.log` and `console.dir`, `JSON.stringify`, a template
 * string, `Object.entries`, a spread, `structuredClone`, an assertion message)
 * shows the names of the environment and the arguments that are the adapter's
 * own, or nothing, and never a value.
 */

import { inspect } from "node:util";

export type LaunchParts = Readonly<{
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
}>;

/** What a Launch shows of itself. */
export type LaunchSummary = Readonly<{
	command: string;
	args: readonly string[];
	env: Readonly<Record<string, "[redacted]">>;
}>;

const REDACTED = "[redacted]";
/** `dev --agent --schema <file> run --`: the arguments that are the adapter's, before the caller's command. */
const FIXED_ARGS = 6;

function summaryOf(parts: LaunchParts): LaunchSummary {
	const own = parts.args.slice(0, FIXED_ARGS);
	const rest = parts.args.length - own.length;
	return {
		command: parts.command,
		args:
			rest > 0 ? [...own, `[${rest} arguments of the command omitted]`] : own,
		env: Object.fromEntries(
			Object.keys(parts.env).map((name) => [name, REDACTED]),
		),
	};
}

/**
 * A frozen Launch. `command` is the executable, which is no secret and is what
 * enumerating one shows. `args` (the caller's command may carry a token as an
 * argument) and `env` (the store passphrase, when listed in `passEnv`) are
 * accessors over private fields: `launch.args` and `launch.env` are what `spawn`
 * is given, and nothing that enumerates, copies or dumps the object reaches them
 * (`Object.keys` and `entries`, a spread, `Object.assign`, `structuredClone`,
 * `inspect` with `customInspect: false` and `showHidden`, which is what
 * `console.dir` and `node:assert` messages do). The printers are on the
 * prototype too, so they are not enumerable either. Reading `launch.env` is
 * deliberate; logging it is the caller's.
 */
export class Launch implements LaunchParts {
	readonly command: string;
	readonly #args: readonly string[];
	readonly #env: NodeJS.ProcessEnv;

	constructor(parts: LaunchParts) {
		this.command = parts.command;
		this.#args = parts.args;
		this.#env = parts.env;
		Object.freeze(this);
	}

	get args(): readonly string[] {
		return this.#args;
	}

	get env(): NodeJS.ProcessEnv {
		return this.#env;
	}

	toJSON(): LaunchSummary {
		return summaryOf(this);
	}

	toString(): string {
		return `Launch ${inspect(summaryOf(this), { depth: 3 })}`;
	}

	[inspect.custom](): string {
		return this.toString();
	}
}
