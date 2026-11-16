import { execFile, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { z } from "zod";

import { childEgressEnv, egressFrom } from "./egress.js";

/**
 * A secret store's own CLI, as the ceremony uses it: found on the machine,
 * or installed into HoBo's tools directory when the owner chooses the store
 * (never globally, so nothing else on the machine changes), then reused.
 */

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** Run a command; `interactive` lets the owner see and answer it (a sign-in). */
/** Variables for one command only, as name and value pairs (secrets never go on its command line). */
export type CommandEnv = readonly (readonly [string, string])[];

export type RunCommand = (
	command: string,
	args: readonly string[],
	options?: {
		readonly interactive?: boolean;
		/** Added to the command's environment, for this command only. */
		readonly env?: CommandEnv;
		/** Written to the command's standard input, then closed. */
		readonly input?: string;
	},
) => Promise<CommandResult>;

export interface StoreCli {
	/** The executable's name on PATH. */
	readonly bin: string;
	/** Where it lives once HoBo installed it. */
	readonly installedPath: (toolsDir: string) => string;
	/** Install it into `toolsDir` with the provider's official package. */
	readonly install: (
		run: RunCommand,
		toolsDir: string,
	) => Promise<CommandResult>;
}

// public-contract: the Infisical CLI release HoBo installs (npm @infisical/cli).
export const INFISICAL_CLI_VERSION = "0.45.8";

export const INFISICAL_CLI: StoreCli = {
	bin: "infisical",
	installedPath: (toolsDir) =>
		path.join(toolsDir, "node_modules", ".bin", "infisical"),
	install: (run, toolsDir) =>
		run("npm", [
			"install",
			"--prefix",
			toolsDir,
			"--no-fund",
			"--no-audit",
			`@infisical/cli@${INFISICAL_CLI_VERSION}`,
		]),
};

/** HoBo's tools directory: `$XDG_DATA_HOME/hobo/tools`, else `~/.local/share/hobo/tools`. */
export function hoboToolsDir(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	const base =
		env.XDG_DATA_HOME || path.join(env.HOME || homedir(), ".local", "share");
	return path.join(base, "hobo", "tools");
}

/** The first executable named `bin` on PATH, if any. */
export async function whichOnPath(
	bin: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
	for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const candidate = path.join(dir, bin);
		if (
			await access(candidate, constants.X_OK).then(
				() => true,
				() => false,
			)
		)
			return candidate;
	}
	return undefined;
}

export interface EnsureStoreCliOptions {
	readonly run: RunCommand;
	readonly which: (bin: string) => Promise<string | undefined>;
	readonly toolsDir: string;
	readonly exists?: (file: string) => boolean;
}

/** The command that runs `cli`: on PATH, already installed, or installed now. */
export async function ensureStoreCli(
	cli: StoreCli,
	options: EnsureStoreCliOptions,
): Promise<{ readonly command: string; readonly installed: boolean }> {
	if ((await options.which(cli.bin)) !== undefined)
		return { command: cli.bin, installed: false };
	const installedPath = cli.installedPath(options.toolsDir);
	if ((options.exists ?? existsSync)(installedPath))
		return { command: installedPath, installed: false };
	const result = await cli.install(options.run, options.toolsDir);
	if (result.code !== 0)
		throw new StoreCliInstallError(cli.bin, result.stderr || result.stdout);
	return { command: installedPath, installed: true };
}

export class StoreCliInstallError extends Error {
	constructor(
		readonly bin: string,
		detail: string,
	) {
		super(`Installing the ${bin} CLI failed: ${detail.trim().slice(0, 300)}`);
		this.name = "StoreCliInstallError";
	}
}

/**
 * Run commands on this machine: through the environment's proxy and CA, with
 * no secret variables. An interactive command shares the terminal, so the
 * owner sees and answers it (a CLI's sign-in).
 */
export function machineRunner(
	env: Readonly<Record<string, string | undefined>> = process.env,
): RunCommand {
	const childEnv = childEgressEnv(env, egressFrom(env));
	return (command, args, options) =>
		new Promise<CommandResult>((resolve) => {
			if (options?.interactive === true) {
				const child = spawn(command, [...args], {
					env: childEnv,
					stdio: "inherit",
				});
				child.on("error", (error) =>
					resolve({ code: 127, stdout: "", stderr: error.message }),
				);
				child.on("close", (code) =>
					resolve({ code: code ?? 1, stdout: "", stderr: "" }),
				);
				return;
			}
			const child = execFile(
				command,
				[...args],
				{
					env: { ...childEnv, ...Object.fromEntries(options?.env ?? []) },
					maxBuffer: 16 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					const exit = z.object({ code: z.number() }).safeParse(error);
					const code = error === null ? 0 : exit.success ? exit.data.code : 127;
					resolve({ code, stdout: String(stdout), stderr: String(stderr) });
				},
			);
			if (options?.input !== undefined) child.stdin?.end(options.input);
			else child.stdin?.end();
		});
}
