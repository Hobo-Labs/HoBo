/**
 * The env-spec bridge OpenSesame is told to run, when the caller names one.
 * OPENSESAME_ENV_PARSE is a program path that Node runs as a script, as
 * OPENSESAME_NODE is the program path Node itself is, and an OpenSesame older
 * than its commit c403ba90a runs it with the whole environment, store passphrase
 * included. So a path the environment names is held to what the executable is:
 * absolute (a relative one is the working directory's, where a checkout puts
 * files) and in a trusted place (`trust.ts`: owned by the user or root and not
 * writable by others, not under `node_modules/.bin`, not in the working
 * directory's tree). Unset, nothing is passed and OpenSesame uses its own.
 */

import path from "node:path";

import { OpenSesameAdapterError } from "./errors.js";
import { placeProblem, type Trust } from "./trust.js";

export type BridgeInput = Readonly<{
	/** The caller's environment. */
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	trust: Trust;
}>;

const NAME = "OPENSESAME_ENV_PARSE";

function refuse(why: string): OpenSesameAdapterError {
	return new OpenSesameAdapterError(
		"bridge_missing",
		`${NAME} ${why}; nothing was started and the store passphrase went nowhere. Name the bridge by an absolute path in a directory only you and root can write, or unset it`,
	);
}

/**
 * The values of the variable in `env` that reach OpenSesame. The allowlist compares
 * names without case on Windows, so a plain object holding `opensesame_env_parse` (or
 * both spellings) passes it on, and each of them is checked.
 */
function bridgesIn(
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): string[] {
	const found: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		const same =
			platform === "win32" ? name.toUpperCase() === NAME : name === NAME;
		if (same && value !== undefined) found.push(value);
	}
	return found;
}

/** Throws a typed refusal unless the bridge is unset, or an absolute path to something that exists, in a trusted place. */
export function checkBridge(input: BridgeInput): void {
	const flavour = input.platform === "win32" ? path.win32 : path.posix;
	for (const bridge of bridgesIn(input.env, input.platform)) {
		if (!flavour.isAbsolute(bridge)) {
			throw refuse(
				"must be an absolute path: a relative one means the working directory",
			);
		}
		const why = placeProblem(bridge, input.trust);
		if (why !== undefined)
			throw refuse(`names a bridge that cannot be used: ${why}`);
	}
}
