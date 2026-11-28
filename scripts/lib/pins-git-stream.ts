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

export interface MaybeTerminal {
	readonly isTTY?: boolean;
}

export function onTerminal(stream: MaybeTerminal = process.stderr): boolean {
	return stream.isTTY === true;
}

export function progressArgs(
	stream: MaybeTerminal = process.stderr,
): readonly string[] {
	return onTerminal(stream) ? ["--progress"] : [];
}

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
