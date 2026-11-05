/**
 * Main full gate secret scan: bounded git history (not whole-repo `gitleaks git`
 * on sparse S0), with an exit marker always written so the wait step cannot hang.
 *
 * CLI:
 *   … start <scanDir>   — background worker (nohup from workflow)
 *   … wait <scanDir>    — poll exit file, print log, propagate status
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GITLEAKS_TIMEOUT_MS = 240_000;
const WAIT_ATTEMPTS = 120;
const WAIT_INTERVAL_MS = 1000;

export type GitleaksGateScan =
	| { readonly kind: "git"; readonly logOpts: string }
	| { readonly kind: "detect"; readonly reason: string };

export function commitExists(ref: string): boolean {
	if (!ref) return false;
	const result = spawnSync("git", ["cat-file", "-e", `${ref}^{commit}`], {
		encoding: "utf8",
	});
	return result.status === 0;
}

/** Mirrors PR secret-scan scoping; avoids full-history walks on sparse checkout. */
export function resolveGitleaksGateScan(
	eventName: string,
	pushBefore: string | undefined,
	exists: (ref: string) => boolean = commitExists,
): GitleaksGateScan {
	const emptyBefore =
		!pushBefore || pushBefore === "0000000000000000000000000000000000000000";

	if (eventName === "push" && !emptyBefore && exists(pushBefore!)) {
		return { kind: "git", logOpts: `${pushBefore}..HEAD` };
	}

	if (eventName === "workflow_dispatch") {
		const parent = spawnSync("git", ["rev-parse", "HEAD~1"], {
			encoding: "utf8",
		});
		const base = parent.stdout?.trim();
		if (parent.status === 0 && base && exists(base)) {
			return { kind: "git", logOpts: `${base}..HEAD` };
		}
	}

	if (eventName === "schedule") {
		return { kind: "git", logOpts: "--since=7.days" };
	}

	if (eventName === "push" && emptyBefore) {
		return {
			kind: "detect",
			reason: "push before SHA missing (force push or new branch)",
		};
	}

	return {
		kind: "detect",
		reason: `no bounded git range for event ${eventName}`,
	};
}

function writeExit(scanDir: string, status: number): void {
	const tmp = join(scanDir, "exit.tmp");
	const dest = join(scanDir, "exit");
	writeFileSync(tmp, `${status}\n`, "utf8");
	renameSync(tmp, dest);
}

function gitleaksArgs(spec: GitleaksGateScan): string[] {
	const common = ["--config", ".gitleaks.toml", "--redact", "--exit-code", "1"];
	if (spec.kind === "git") {
		return ["git", ...common, `--log-opts=${spec.logOpts}`];
	}
	return ["detect", "--source", ".", ...common];
}

function runScan(scanDir: string, spec: GitleaksGateScan): number {
	mkdirSync(scanDir, { recursive: true });
	const logPath = join(scanDir, "log");
	const logFd = openSync(logPath, "w");
	let status = 1;
	try {
		const result = spawnSync("gitleaks", gitleaksArgs(spec), {
			timeout: GITLEAKS_TIMEOUT_MS,
			stdio: ["ignore", logFd, logFd],
		});
		if (
			result.error &&
			"code" in result.error &&
			result.error.code === "ETIMEDOUT"
		) {
			status = 124;
			return status;
		}
		status = result.status ?? 1;
		return status;
	} finally {
		writeExit(scanDir, status);
	}
}

function startBackground(scanDir: string): void {
	const eventName = process.env.EVENT_NAME ?? "";
	const pushBefore = process.env.PUSH_BEFORE?.trim() || undefined;
	const spec = resolveGitleaksGateScan(eventName, pushBefore);
	mkdirSync(scanDir, { recursive: true });
	writeFileSync(join(scanDir, "log"), "", "utf8");
	writeFileSync(
		join(scanDir, "spec.json"),
		`${JSON.stringify(spec)}\n`,
		"utf8",
	);

	const self = fileURLToPath(import.meta.url);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", self, "run", scanDir, JSON.stringify(spec)],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();
	if (child.pid === undefined) {
		writeExit(scanDir, 1);
		process.exit(1);
	}
}

function waitForScan(scanDir: string): never {
	if (!existsSync(join(scanDir, "log"))) {
		console.error("::error::Secret scan did not start: log file is absent.");
		process.exit(1);
	}
	for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
		if (existsSync(join(scanDir, "exit"))) break;
		spawnSync("sleep", [`${WAIT_INTERVAL_MS / 1000}`]);
	}
	const logPath = join(scanDir, "log");
	if (existsSync(logPath)) {
		process.stdout.write(readFileSync(logPath, "utf8"));
	}
	const exitPath = join(scanDir, "exit");
	if (!existsSync(exitPath)) {
		console.error(
			`::error::Timed out after ${WAIT_ATTEMPTS} seconds waiting for the secret scan.`,
		);
		process.exit(1);
	}
	const status = Number.parseInt(readFileSync(exitPath, "utf8").trim(), 10);
	process.exit(Number.isFinite(status) ? status : 1);
}

function main(): void {
	const [, , command, scanDir, specJson] = process.argv;
	if (!command || !scanDir) {
		console.error("usage: gitleaks-main-gate.mts <start|run|wait> <scanDir>");
		process.exit(2);
	}
	if (command === "start") {
		startBackground(scanDir);
		process.exit(0);
	}
	if (command === "run") {
		// SAFETY: child passes JSON we wrote from resolveGitleaksGateScan in-process.
		const spec = JSON.parse(specJson ?? "{}") as GitleaksGateScan;
		process.exit(runScan(scanDir, spec));
	}
	if (command === "wait") {
		waitForScan(scanDir);
	}
	console.error(`unknown command: ${command}`);
	process.exit(2);
}

if (
	process.argv[1] &&
	resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
) {
	main();
}
