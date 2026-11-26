/**
 * Git calls that touch the network.
 *
 * Which transports a pin may use is decided here, not left to git's defaults
 * or to the user's configuration: https (and ssh, because a `url.*.insteadOf`
 * rewrite of an https URL is a normal thing to have). `ext::`, `fd::`, `git://`
 * and plain `http://` are refused, as is `file:` unless the tests (or a
 * `--reference` clone the operator named) need it. GIT_ALLOW_PROTOCOL
 * overrides any configured `protocol.<name>.allow`, so a repository or global
 * config that enables `ext` cannot widen this. Every call has a deadline
 * (HOBO_PINS_NET_TIMEOUT_MS, `pins-net.ts`) and a low-speed limit.
 *
 * Erasable TypeScript with node builtins only.
 */
import { isAbsolute } from "node:path";
import { PinsError } from "./pins.ts";
import { type GitResult, git } from "./pins-git-core.ts";
import { terminalHint } from "./pins-git-hint.ts";
import { netTimeoutMs } from "./pins-net.ts";

export interface NetOptions {
	/** Tests only: loopback http and local repositories (HOBO_PINS_ALLOW_LOCAL). */
	readonly allowLocal: boolean;
}

/** The value of GIT_ALLOW_PROTOCOL for one call. */
export function allowedProtocols(
	allowLocal: boolean,
	allowFile: boolean,
): string {
	const names = ["https", "ssh"];
	if (allowLocal) names.push("http", "file");
	else if (allowFile) names.push("file");
	return names.join(":");
}

/** Whether a repository URL names a transport a pin may use. */
export function isAllowedTransport(url: string, allowLocal: boolean): boolean {
	if (/^https:\/\//iu.test(url)) return true;
	return (
		allowLocal &&
		(isAbsolute(url) ||
			/^(file:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/iu.test(url))
	);
}

/**
 * The argument vector of a network git call: no protocol unless allowed by
 * name, and give up on a link slower than 1000 bytes/s for 30 s.
 */
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

/**
 * `git <args>` with the transport allow-list pinned. `allowFile` is for the one
 * place a local path is the remote on purpose: a `--reference` clone.
 */
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

/** The commit `branch` of `url` points at. */
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

/** What a server says when it will not serve a commit (protocol v2, v0, and a missing ref). */
export const NOT_SERVED =
	/not our ref|unadvertised object|couldn't find remote ref/iu;
