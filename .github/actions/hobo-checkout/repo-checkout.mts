import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CHECKOUT_RETRY_DELAYS_MS = [0, 8, 16] as const;

export type CheckoutAttemptResult = Readonly<{
	ok: boolean;
	attempt: number;
	stderr: string;
	stdout: string;
}>;

export function classifyCheckoutTransportError(text: string): boolean {
	return (
		/HTTP\/2 stream .*PROTOCOL_ERROR/i.test(text) ||
		/\bcurl 92\b/i.test(text) ||
		/was not closed cleanly/i.test(text) ||
		/could not fetch [0-9a-f]+ from promisor remote/i.test(text) ||
		/expected 'packfile'/i.test(text)
	);
}

export function mirrorObjectsPath(mirrorGitDir: string): string {
	return join(resolve(mirrorGitDir), "objects");
}

export function writeAlternates(gitDir: string, mirrorGitDir: string): void {
	const info = join(gitDir, "objects", "info");
	mkdirSync(info, { recursive: true });
	const alternates = join(info, "alternates");
	const line = `${mirrorObjectsPath(mirrorGitDir)}\n`;
	writeFileSync(alternates, line, "utf8");
}

type GitCommandResult = Readonly<{
	ok: boolean;
	stdout: string;
	stderr: string;
}>;

function git(
	cwd: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): GitCommandResult {
	const result = spawnSync("git", args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (result.error) {
		return {
			ok: false,
			stdout,
			stderr: `${stderr}\n${result.error.message}`.trim(),
		} satisfies GitCommandResult;
	}
	return {
		ok: result.status === 0,
		stdout,
		stderr,
	} satisfies GitCommandResult;
}

export type MirrorCheckoutOptions = Readonly<{
	workDir: string;
	sha: string;
	mirrorGitDir: string;
	originUrl: string;
	fetchDepth?: number;
	submodules?: boolean;
	retryDelaysMs?: readonly number[];
	markerPath?: string;
}>;

type MirrorCheckoutOptionsDraft = {
	workDir: string;
	sha: string;
	mirrorGitDir: string;
	originUrl: string;
	submodules: boolean;
	fetchDepth?: number;
	markerPath?: string;
};

export function checkoutFromBareMirror(
	options: MirrorCheckoutOptions,
): CheckoutAttemptResult {
	const retryDelaysMs =
		options.retryDelaysMs ?? DEFAULT_CHECKOUT_RETRY_DELAYS_MS;
	const env = { ...process.env };
	const workDir = resolve(options.workDir);
	const gitDir = join(workDir, ".git");
	rmSync(gitDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });

	let last: CheckoutAttemptResult = {
		ok: false,
		attempt: 0,
		stderr: "no attempts",
		stdout: "",
	};

	for (const [index, delayMs] of retryDelaysMs.entries()) {
		const attempt = index + 1;
		if (delayMs > 0) {
			spawnSync("sleep", [String(Math.ceil(delayMs / 1000))], { stdio: "ignore" });
		}
		rmSync(gitDir, { recursive: true, force: true });
		if (git(workDir, ["init", "-q", "-b", "main"], env).ok === false) continue;
		if (
			git(workDir, ["remote", "add", "origin", options.originUrl], env).ok ===
			false
		)
			continue;
		writeAlternates(gitDir, options.mirrorGitDir);

		const httpVersion = "HTTP/1.1";
		const depth =
			options.fetchDepth !== undefined && options.fetchDepth > 0
				? ["--depth", String(options.fetchDepth)]
				: [];
		const fetch = git(
			workDir,
			[
				"-c",
				`http.version=${httpVersion}`,
				"-c",
				"protocol.version=2",
				"fetch",
				"--no-tags",
				"--prune",
				...depth,
				"origin",
				options.sha,
			],
			env,
		);
		const checkout = fetch.ok
			? git(workDir, ["checkout", "-f", "FETCH_HEAD"], env)
			: fetch;
		const combined = `${fetch.stderr}\n${fetch.stdout}\n${checkout.stderr}\n${checkout.stdout}`;
		const ok =
			checkout.ok &&
			(!options.markerPath ||
				existsSync(join(workDir, options.markerPath)));
		last = {
			ok,
			attempt,
			stderr: combined.trim(),
			stdout: checkout.stdout,
		};
		if (ok) return last;
	}
	return last;
}

export function submodulesEnabledFromCliArg(value: string): boolean {
	return value === "true" || value === "recursive";
}

function parseArgs(args: readonly string[]) {
	let sha = "";
	let mirror = "";
	let origin = "";
	let workDir = process.env.GITHUB_WORKSPACE ?? process.cwd();
	let fetchDepth: number | undefined;
	let submodules = false;
	let marker = "";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--sha") sha = args[++i] ?? "";
		else if (arg === "--mirror") mirror = args[++i] ?? "";
		else if (arg === "--origin") origin = args[++i] ?? "";
		else if (arg === "--workdir") workDir = args[++i] ?? workDir;
		else if (arg === "--fetch-depth") {
			const raw = args[++i] ?? "";
			fetchDepth = raw === "0" ? 0 : Number(raw);
		} else if (arg === "--submodules") {
			submodules = submodulesEnabledFromCliArg(args[++i] ?? "");
		}
		else if (arg === "--marker") marker = args[++i] ?? "";
	}
	return { sha, mirror, origin, workDir, fetchDepth, submodules, marker };
}

function mirrorCheckoutOptionsFromParsed(
	parsed: ReturnType<typeof parseArgs>,
): MirrorCheckoutOptions {
	const options: MirrorCheckoutOptionsDraft = {
		workDir: parsed.workDir,
		sha: parsed.sha,
		mirrorGitDir: parsed.mirror,
		originUrl: parsed.origin,
		submodules: parsed.submodules,
	};
	if (parsed.fetchDepth !== undefined) {
		options.fetchDepth = parsed.fetchDepth;
	}
	if (parsed.marker) {
		options.markerPath = parsed.marker;
	}
	return options satisfies MirrorCheckoutOptions;
}

function runCli(args: readonly string[]): number {
	const parsed = parseArgs(args);
	if (!/^[0-9a-f]{40}$/i.test(parsed.sha)) {
		console.log("hobo_ci_repo_checkout=fail reason=invalid-sha");
		return 1;
	}
	if (!parsed.mirror || !parsed.origin) {
		console.log("hobo_ci_repo_checkout=fail reason=missing-mirror-or-origin");
		return 1;
	}
	const result = checkoutFromBareMirror(mirrorCheckoutOptionsFromParsed(parsed));
	if (!result.ok) {
		const reason = result.stderr.replace(/[\r\n]+/g, " ").slice(0, 500);
		console.log(
			`hobo_ci_repo_checkout=fail attempts=${result.attempt} transport=${classifyCheckoutTransportError(result.stderr)} reason=${reason}`,
		);
		return 1;
	}
	if (parsed.submodules) {
		const env = { ...process.env };
		const sync = git(parsed.workDir, ["submodule", "sync", "--recursive"], env);
		const update = git(
			parsed.workDir,
			["submodule", "update", "--init", "--recursive", "--depth", "1"],
			env,
		);
		if (!sync.ok || !update.ok) {
			console.log("hobo_ci_repo_checkout=fail reason=submodule-update");
			return 1;
		}
	}
	console.log(`hobo_ci_repo_checkout=ok attempts=${result.attempt}`);
	return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	process.exit(runCli(process.argv.slice(2)));
}
