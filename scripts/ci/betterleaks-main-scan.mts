/**
 * Main full gate secret scan. Sparse S0 uses `filter: blob:none`; unbounded
 * `betterleaks git` then hangs on promisor blob fetches and never writes the
 * exit file (Fabric 42016105215). Push scans the landed range; schedule and
 * other events backfill blobs then scan full history. Either path wraps
 * betterleaks in a timeout that always writes `$dir/exit`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { fetchLastGreenMainSha } from "./resolve-main-test-base.mts";

export const ZERO_SHA = "0".repeat(40);
export const RANGE_TIMEOUT_SECONDS = 90;
export const FULL_FETCH_TIMEOUT_SECONDS = 300;
export const FULL_SCAN_TIMEOUT_SECONDS = 600;
export const RANGE_WAIT_SECONDS = 105;
export const FULL_WAIT_SECONDS = 720;
export const BETTERLEAKS_BASELINE_REL = "docs/ci/betterleaks-main-baseline.sha";

export type BetterleaksScanPlan =
	| {
			mode: "range";
			logOpts: string;
			fetchBlobs: false;
			timeoutSeconds: typeof RANGE_TIMEOUT_SECONDS;
			waitSeconds: typeof RANGE_WAIT_SECONDS;
	  }
	| {
			mode: "full";
			logOpts: null;
			fetchBlobs: true;
			timeoutSeconds: typeof FULL_SCAN_TIMEOUT_SECONDS;
			waitSeconds: typeof FULL_WAIT_SECONDS;
	  };

export type WaitVerdict =
	| "ok"
	| "missing-start"
	| "died-without-exit"
	| "timeout"
	| "waiting";

export function readBetterleaksBaselineSha(
	root: string = process.cwd(),
): string | undefined {
	const path = join(root, BETTERLEAKS_BASELINE_REL);
	if (!existsSync(path)) return undefined;
	const sha = readFileSync(path, "utf8").trim();
	return /^[0-9a-f]{40}$/iu.test(sha) ? sha : undefined;
}

export function isAncestor(ancestor: string, commit: string): boolean {
	return (
		spawnSync("git", ["merge-base", "--is-ancestor", ancestor, commit], {
			stdio: "ignore",
		}).status === 0
	);
}

export function planMainBetterleaksScan(input: {
	eventName: string;
	pushBefore: string | undefined;
	sha: string;
	commitExists: (rev: string) => boolean;
	baselineSha?: string;
	/** The last main commit whose Fabric push run went green. */
	lastGreenSha?: string;
	isAncestor?: (ancestor: string, commit: string) => boolean;
}): BetterleaksScanPlan {
	const ancestorOk = input.isAncestor ?? isAncestor;
	const before = input.pushBefore?.trim() ?? "";
	if (
		input.eventName === "push" &&
		before &&
		before !== ZERO_SHA &&
		input.commitExists(before)
	) {
		// A push that waited behind a running main run and was dropped never ran
		// this scan; start from the last green main commit so its range is covered.
		const green = input.lastGreenSha?.trim() ?? "";
		const from =
			green &&
			green !== before &&
			input.commitExists(green) &&
			ancestorOk(green, before)
				? green
				: before;
		return {
			mode: "range",
			logOpts: `${from}..${input.sha}`,
			fetchBlobs: false,
			timeoutSeconds: RANGE_TIMEOUT_SECONDS,
			waitSeconds: RANGE_WAIT_SECONDS,
		};
	}
	const baseline = input.baselineSha?.trim();
	if (
		input.eventName === "push" &&
		baseline &&
		baseline !== input.sha &&
		input.commitExists(baseline) &&
		ancestorOk(baseline, input.sha)
	) {
		return {
			mode: "range",
			logOpts: `${baseline}..${input.sha}`,
			fetchBlobs: false,
			timeoutSeconds: RANGE_TIMEOUT_SECONDS,
			waitSeconds: RANGE_WAIT_SECONDS,
		};
	}
	return {
		mode: "full",
		logOpts: null,
		fetchBlobs: true,
		timeoutSeconds: FULL_SCAN_TIMEOUT_SECONDS,
		waitSeconds: FULL_WAIT_SECONDS,
	};
}

export function betterleaksArgs(plan: BetterleaksScanPlan): readonly string[] {
	const args = [
		"git",
		"--config",
		".betterleaks.toml",
		"--redact",
		"--exit-code",
		"1",
	];
	if (plan.mode === "range") args.push("--log-opts", plan.logOpts);
	return args;
}

export function gitFetchBlobArgs(): readonly string[] {
	return ["fetch", "--refetch", "--no-filter"];
}

/** Fetch both sides of every change, including files deleted within the range. */
export function prefetchRangeBlobs(
	logOpts: string,
	timeoutMs: number,
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (!/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/iu.test(logOpts)) {
		throw new Error("invalid secret scan commit range");
	}
	const deadline = Date.now() + timeoutMs;
	const remaining = (): number => {
		const ms = deadline - Date.now();
		if (ms <= 0) throw new Error("secret scan blob prefetch timed out");
		return ms;
	};
	const changes = spawnSync(
		"git",
		[
			"log",
			"--format=",
			"--raw",
			"--no-abbrev",
			"--no-renames",
			"-m",
			"-z",
			logOpts,
		],
		{
			cwd,
			env,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: remaining(),
		},
	);
	if (changes.error || changes.status !== 0) {
		throw new Error("could not enumerate secret scan range changes");
	}
	const records = changes.stdout.split("\0");
	if (records.pop() !== "" || records.length % 2 !== 0) {
		throw new Error("invalid git change records for secret scan");
	}
	const blobs = new Set<string>();
	for (let i = 0; i < records.length; i += 2) {
		const match =
			/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]$/u.exec(
				records[i] ?? "",
			);
		if (!match || !records[i + 1]) {
			throw new Error("invalid git change record for secret scan");
		}
		for (const [mode, oid] of [
			[match[1], match[3]],
			[match[2], match[4]],
		]) {
			if (mode === "000000" || mode === "160000") continue;
			if (
				!mode ||
				!oid ||
				!/^(100[0-7]{3}|120000)$/u.test(mode) ||
				oid === ZERO_SHA
			) {
				throw new Error("invalid git blob in secret scan range");
			}
			blobs.add(oid);
		}
	}
	if (blobs.size === 0) return 0;
	const ids = [...blobs];
	const fetched = spawnSync(
		"git",
		["cat-file", "--batch-check=%(objectname) %(objecttype)"],
		{
			cwd,
			env,
			encoding: "utf8",
			input: `${ids.join("\n")}\n`,
			maxBuffer: 64 * 1024 * 1024,
			timeout: remaining(),
		},
	);
	const results = fetched.stdout?.trimEnd().split("\n") ?? [];
	if (
		fetched.error ||
		fetched.status !== 0 ||
		results.length !== ids.length ||
		results.some((line, i) => line !== `${ids[i]} blob`)
	) {
		throw new Error("could not fetch every blob in secret scan range");
	}
	return ids.length;
}

export function pollScanWait(input: {
	exitPath: string;
	logPath: string;
	pidPath: string;
	elapsedSeconds: number;
	budgetSeconds: number;
	pidAlive: (pid: number) => boolean;
}): WaitVerdict {
	if (existsSync(input.exitPath)) return "ok";
	if (!existsSync(input.logPath) && !existsSync(input.pidPath))
		return "missing-start";
	if (existsSync(input.pidPath)) {
		const pid = Number(readFileSync(input.pidPath, "utf8").trim());
		if (Number.isInteger(pid) && pid > 0 && !input.pidAlive(pid))
			return "died-without-exit";
	}
	if (input.elapsedSeconds >= input.budgetSeconds) return "timeout";
	return "waiting";
}

export function writeExitFile(dir: string, status: number): void {
	const tmp = join(dir, "exit.tmp");
	writeFileSync(tmp, `${status}\n`);
	renameSync(tmp, join(dir, "exit"));
}

export function commitExists(rev: string): boolean {
	return (
		spawnSync("git", ["cat-file", "-e", `${rev}^{commit}`], {
			stdio: "ignore",
		}).status === 0
	);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function appendLog(dir: string, text: string): void {
	writeFileSync(join(dir, "log"), text, { flag: "a" });
}

function runTimed(
	command: string,
	args: readonly string[],
	timeoutMs: number,
	log: (chunk: string) => void,
): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* already gone */
				}
			}, 2_000).unref();
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => log(chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => log(chunk.toString()));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(new Error(`${command} timed out after ${timeoutMs}ms`));
				return;
			}
			resolvePromise(code ?? 1);
		});
	});
}

/**
 * A scan started early, beside the plan, may only be a range scan: a full
 * scan first refetches every blob into the clone, which must not happen while
 * other steps use it. Such a scan is left to the last step.
 */
export function deferredByRangeOnly(
	plan: BetterleaksScanPlan,
	rangeOnly: boolean,
): boolean {
	return rangeOnly && plan.fetchBlobs;
}

// public-contract: marker the early start leaves when it defers a full scan to the last step.
export const DEFERRED_MARKER = "deferred";

export async function runBackgroundScan(
	dir: string,
	options: Readonly<{ rangeOnly?: boolean }> = {},
): Promise<void> {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pid"), `${process.pid}\n`);
	writeFileSync(join(dir, "log"), "");
	const baselineSha = readBetterleaksBaselineSha();
	const planInput: Parameters<typeof planMainBetterleaksScan>[0] = {
		eventName: process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "",
		pushBefore: process.env.PUSH_BEFORE ?? process.env.GITHUB_EVENT_BEFORE,
		sha: process.env.SCAN_SHA ?? process.env.GITHUB_SHA ?? "",
		commitExists,
	};
	if (baselineSha !== undefined) planInput.baselineSha = baselineSha;
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
	if (planInput.eventName === "push" && token && repository) {
		const lastGreen = await fetchLastGreenMainSha({
			repository,
			token,
			workflowBasename: "hobo-ci.yml",
			head: planInput.sha,
			fetch: globalThis.fetch,
		}).catch(() => undefined);
		if (lastGreen !== undefined) planInput.lastGreenSha = lastGreen;
	}
	const plan = planMainBetterleaksScan(planInput);
	if (deferredByRangeOnly(plan, options.rangeOnly === true)) {
		rmSync(join(dir, "pid"), { force: true });
		writeFileSync(join(dir, DEFERRED_MARKER), "full\n");
		return;
	}
	writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan)}\n`);
	writeFileSync(join(dir, "wait"), `${plan.waitSeconds}\n`);
	appendLog(
		dir,
		`betterleaks-main-scan mode=${plan.mode} fetchBlobs=${plan.fetchBlobs} timeout=${plan.timeoutSeconds}s\n`,
	);
	try {
		const deadline = Date.now() + plan.timeoutSeconds * 1_000;
		if (plan.fetchBlobs) {
			appendLog(
				dir,
				"fetching blobs (--no-filter) before full-history betterleaks\n",
			);
			const fetchStatus = await runTimed(
				"git",
				[...gitFetchBlobArgs()],
				FULL_FETCH_TIMEOUT_SECONDS * 1_000,
				(chunk) => appendLog(dir, chunk),
			);
			if (fetchStatus !== 0) throw new Error("full-history blob fetch failed");
		} else {
			const count = prefetchRangeBlobs(
				plan.logOpts,
				plan.timeoutSeconds * 1_000,
			);
			appendLog(dir, `prefetched ${count} blobs in secret scan range\n`);
		}
		const scanTimeout =
			plan.mode === "range"
				? deadline - Date.now()
				: plan.timeoutSeconds * 1_000;
		if (scanTimeout <= 0)
			throw new Error("secret scan range timed out before scanning");
		const status = await runTimed(
			"betterleaks",
			betterleaksArgs(plan),
			scanTimeout,
			(chunk) => appendLog(dir, chunk),
		);
		writeExitFile(dir, status);
	} catch (error) {
		appendLog(
			dir,
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		writeExitFile(dir, 1);
	}
}

function waitBudgetFromPlan(dir: string): number {
	const waitPath = join(dir, "wait");
	if (!existsSync(waitPath)) return RANGE_WAIT_SECONDS;
	const budget = Number(readFileSync(waitPath, "utf8").trim());
	if (Number.isFinite(budget) && budget > 0) return budget;
	return RANGE_WAIT_SECONDS;
}

function runWait(dir: string): void {
	const budget = waitBudgetFromPlan(dir);
	const started = Date.now();
	const tick = (): void => {
		const verdict = pollScanWait({
			exitPath: join(dir, "exit"),
			logPath: join(dir, "log"),
			pidPath: join(dir, "pid"),
			elapsedSeconds: Math.floor((Date.now() - started) / 1_000),
			budgetSeconds: budget,
			pidAlive,
		});
		if (verdict === "waiting") {
			setTimeout(tick, 1_000);
			return;
		}
		if (existsSync(join(dir, "log"))) {
			process.stdout.write(readFileSync(join(dir, "log"), "utf8"));
		}
		if (verdict === "missing-start") {
			console.error(
				"::error::Secret scan did not start: exit file and log are both absent.",
			);
			process.exit(1);
		}
		if (verdict === "died-without-exit") {
			console.error(
				"::error::Secret scan process died without writing an exit file (hang pattern).",
			);
			process.exit(1);
		}
		if (verdict === "timeout") {
			console.error(
				`::error::Timed out after ${budget} seconds waiting for the secret scan.`,
			);
			process.exit(1);
		}
		const status = Number(readFileSync(join(dir, "exit"), "utf8").trim());
		process.exit(Number.isInteger(status) ? status : 1);
	};
	tick();
}

const invokedPath = process.argv[1];
if (
	invokedPath &&
	import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
	const command = process.argv[2];
	const dirFlag = process.argv.indexOf("--dir");
	const dir = dirFlag >= 0 ? process.argv[dirFlag + 1] : undefined;
	if ((command !== "--background" && command !== "--wait") || !dir) {
		console.error(
			"betterleaks-main-scan: --background [--range-only]|--wait --dir <path>",
		);
		process.exit(1);
	}
	if (command === "--wait") runWait(dir);
	else
		await runBackgroundScan(dir, {
			rangeOnly: process.argv.includes("--range-only"),
		});
}
