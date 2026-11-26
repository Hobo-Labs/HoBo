/**
 * The one git a person watches: `git submodule update`, run by setup and
 * pins:fetch. It runs under the same deadline wrapper as every network git
 * (its own process group, ended with every helper at the deadline, a signal
 * from the terminal passed on), but asynchronously, so its stderr can be
 * passed on as it arrives.
 *
 * On a terminal (the script's stderr is a TTY) the caller asks git for
 * `--progress` and every chunk is written through at once; the last 64 KiB
 * are kept for the failure hint. Without a terminal git prints no progress
 * and its stderr (up to 64 MiB) is printed once the call returns.
 *
 * Erasable TypeScript with node builtins only.
 */
import { spawn } from "node:child_process";

import { PinsError } from "./pins.ts";
import {
	endedBySignal,
	exitStatus,
	type GitResult,
	gitEnvironment,
	UNDER_DEADLINE,
} from "./pins-git-core.ts";
import { allowedProtocols, type NetOptions, netArgs } from "./pins-git-net.ts";
import { netTimeout, netTimeoutMs } from "./pins-net.ts";

const TAIL_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 ** 2;

/** What a caller knows of a stream: whether it is a terminal. */
export interface MaybeTerminal {
	readonly isTTY?: boolean;
}

/** Whether a person is watching: the script's stderr is a terminal. */
export function onTerminal(stream: MaybeTerminal = process.stderr): boolean {
	return stream.isTTY === true;
}

/** `--progress` for the watched git when a person is watching, else nothing. */
export function progressArgs(
	stream: MaybeTerminal = process.stderr,
): readonly string[] {
	return onTerminal(stream) ? ["--progress"] : [];
}

/** `git <args>` with the network rules and deadline, stderr passed on; resolves with a tail of it. */
export function netGitWatched(
	cwd: string,
	args: readonly string[],
	options: NetOptions,
	live: boolean = onTerminal(),
): Promise<GitResult> {
	const ms = netTimeoutMs();
	const child = spawn(
		process.execPath,
		["-e", UNDER_DEADLINE, String(ms), ...netArgs(args)],
		{
			cwd,
			stdio: ["ignore", "inherit", "pipe"],
			env: {
				...gitEnvironment(),
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
				GIT_ALLOW_PROTOCOL: allowedProtocols(options.allowLocal, false),
			},
		},
	);
	let tail = "";
	const held: Buffer[] = [];
	let heldBytes = 0;
	child.stderr.on("data", (chunk: Buffer) => {
		if (live) process.stderr.write(chunk);
		else if (heldBytes < MAX_BUFFERED_BYTES) {
			held.push(chunk);
			heldBytes += chunk.length;
		}
		tail = `${tail}${chunk.toString("utf8")}`.slice(-TAIL_BYTES);
	});
	return new Promise<GitResult>((resolve, reject) => {
		child.on("error", (error) => {
			reject(new PinsError("GIT_FAILED", `cannot run git: ${error.message}`));
		});
		child.on("close", (code, signal) => {
			if (!live && heldBytes > 0) process.stderr.write(Buffer.concat(held));
			if (code === 124) {
				reject(netTimeout(`git ${args.join(" ")}`, ms));
				return;
			}
			const status = exitStatus(code, signal);
			const stderr = tail.trim();
			const ended = endedBySignal(code, signal, true);
			resolve(
				ended === null
					? { status, stdout: "", stderr }
					: { status, stdout: "", stderr, signal: ended },
			);
		});
	});
}
