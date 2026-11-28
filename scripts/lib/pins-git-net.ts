import { isAbsolute } from "node:path";
import { PinsError } from "./pins.ts";
import { type GitResult, git } from "./pins-git-core.ts";
import { terminalHint } from "./pins-git-hint.ts";
import { netTimeoutMs } from "./pins-net.ts";

export interface NetOptions {
	readonly allowLocal: boolean;
}

export function allowedProtocols(
	allowLocal: boolean,
	allowFile: boolean,
): string {
	const names = ["https", "ssh"];
	if (allowLocal) names.push("http", "file");
	else if (allowFile) names.push("file");
	return names.join(":");
}

export function isAllowedTransport(url: string, allowLocal: boolean): boolean {
	if (/^https:\/\//iu.test(url)) return true;
	return (
		allowLocal &&
		(isAbsolute(url) ||
			/^(file:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/iu.test(url))
	);
}

export function netArgs(args: readonly string[]): string[] {
	return [
		"-c",
		"protocol.allow=never",
		"-c",
		"http.lowSpeedLimit=1000",
		"-c",
		"http.lowSpeedTime=30",
		...args,
	];
}

export function netGit(
	cwd: string,
	args: readonly string[],
	options: NetOptions,
	allowFile = false,
): GitResult {
	return git(
		cwd,
		netArgs(args),
		{ GIT_ALLOW_PROTOCOL: allowedProtocols(options.allowLocal, allowFile) },
		{ ms: netTimeoutMs(), what: `git ${args.join(" ")}` },
	);
}

function mustNet(
	cwd: string,
	args: readonly string[],
	options: NetOptions,
	what: string,
): string {
	const result = netGit(cwd, args, options);
	if (result.status !== 0) {
		throw new PinsError(
			"GIT_FAILED",
			`${what} failed: git ${args.join(" ")}\n${result.stderr}${terminalHint(result.stderr)}`,
		);
	}
	return result.stdout;
}

export function remoteTip(
	cwd: string,
	url: string,
	branch: string,
	options: NetOptions,
): string {
	const out = mustNet(
		cwd,
		["ls-remote", url, `refs/heads/${branch}`],
		options,
		"ls-remote",
	);
	const tip = out.split(/\s+/u)[0] ?? "";
	if (!/^[0-9a-f]{40}$/u.test(tip)) {
		throw new PinsError("GIT_FAILED", `${url} has no branch ${branch}`);
	}
	return tip;
}

export const NOT_SERVED =
	/not our ref|unadvertised object|couldn't find remote ref/iu;
