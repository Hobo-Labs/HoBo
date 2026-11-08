/**
 * Main full gate secret scan. Sparse S0 uses `filter: blob:none`; unbounded
 * `gitleaks git` then hangs on promisor blob fetches and never writes the
 * exit file (Fabric 42016105215). Push scans the landed range; schedule and
 * other events backfill blobs then scan full history. Either path wraps
 * gitleaks in a timeout that always writes `$dir/exit`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const ZERO_SHA = "0".repeat(40);
export const RANGE_TIMEOUT_SECONDS = 90;
export const FULL_FETCH_TIMEOUT_SECONDS = 120;
export const FULL_SCAN_TIMEOUT_SECONDS = 90;
export const RANGE_WAIT_SECONDS = 105;
export const FULL_WAIT_SECONDS = 240;

export type GitleaksScanPlan =
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

export function planMainGitleaksScan(input: {
	eventName: string;
	pushBefore: string | undefined;
	sha: string;
	commitExists: (rev: string) => boolean;
}): GitleaksScanPlan {
	const before = input.pushBefore?.trim() ?? "";
	if (
		input.eventName === "push" &&
		before &&
		before !== ZERO_SHA &&
		input.commitExists(before)
	) {
		return {
			mode: "range",
			logOpts: `${before}..${input.sha}`,
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

export function gitleaksArgs(plan: GitleaksScanPlan): readonly string[] {
	const args = [
		"git",
		"--config",
		".gitleaks.toml",
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

export async function runBackgroundScan(dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "pid"), `${process.pid}\n`);
	writeFileSync(join(dir, "log"), "");
	const plan = planMainGitleaksScan({
		eventName: process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "",
		pushBefore: process.env.PUSH_BEFORE ?? process.env.GITHUB_EVENT_BEFORE,
		sha: process.env.SCAN_SHA ?? process.env.GITHUB_SHA ?? "",
		commitExists,
	});
	writeFileSync(join(dir, "plan.json"), `${JSON.stringify(plan)}\n`);
	writeFileSync(join(dir, "wait"), `${plan.waitSeconds}\n`);
	appendLog(
		dir,
		`gitleaks-main-scan mode=${plan.mode} fetchBlobs=${plan.fetchBlobs} timeout=${plan.timeoutSeconds}s\n`,
	);
	try {
		if (plan.fetchBlobs) {
			appendLog(
				dir,
				"fetching blobs (--no-filter) before full-history gitleaks\n",
			);
			await runTimed(
				"git",
				[...gitFetchBlobArgs()],
				FULL_FETCH_TIMEOUT_SECONDS * 1_000,
				(chunk) => appendLog(dir, chunk),
			);
		}
		const status = await runTimed(
			"gitleaks",
			gitleaksArgs(plan),
			plan.timeoutSeconds * 1_000,
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
		console.error("gitleaks-main-scan: --background|--wait --dir <path>");
		process.exit(1);
	}
	if (command === "--wait") runWait(dir);
	else await runBackgroundScan(dir);
}
