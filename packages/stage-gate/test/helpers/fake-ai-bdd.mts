
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface RunPlan {
	readonly exit: number;
	readonly report?: string;
	readonly runCopy?: "same" | "different" | "none" | "no-directory" | "linked";
	readonly startedAt?: string;
	readonly runsDir?: string;
	readonly sleepMs?: number;
	readonly pidFile?: string;
	readonly detachedPidFile?: string;
	readonly pauseAfterBrowserMs?: number;
	readonly outputBytes?: number;
	readonly printedRun?: "other" | "none";
}

interface Plan {
	readonly compileCheck: number;
	readonly run: RunPlan;
	readonly verifyRun: number;
}

const plan = JSON.parse(process.env.FAKE_AI_BDD ?? "{}") as Plan;
const [command = "", ...rest] = process.argv.slice(2);
appendFileSync(
	process.env.FAKE_AI_BDD_LOG ?? join(process.cwd(), "fake-ai-bdd.log"),
	`${JSON.stringify([command, ...rest])}\n`,
);

function writeReport(run: RunPlan): string | undefined {
	if (run.report === undefined) return undefined;
	const report = JSON.parse(readFileSync(run.report, "utf8")) as {
		runId: string;
		startedAt: string;
		finishedAt: string;
	};
	report.runId = randomUUID();
	report.startedAt = run.startedAt ?? new Date().toISOString();
	report.finishedAt = new Date().toISOString();
	const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
	const runsDir = run.runsDir ?? join(".ai-bdd", "runs");
	const latest = join(dirname(runsDir), "report");
	mkdirSync(latest, { recursive: true });
	writeFileSync(join(latest, "report.json"), bytes);
	const runDir = join(runsDir, report.runId);
	if (run.runCopy === "no-directory") return runDir;
	if (run.runCopy === "linked") {
		const elsewhere = resolve(dirname(runsDir), "elsewhere", report.runId);
		mkdirSync(elsewhere, { recursive: true });
		mkdirSync(runsDir, { recursive: true });
		symlinkSync(elsewhere, runDir, "dir");
	}
	mkdirSync(runDir, { recursive: true });
	if (run.runCopy === "none") return runDir;
	writeFileSync(
		join(runDir, "report.json"),
		run.runCopy === "different"
			? Buffer.concat([bytes, Buffer.from(" ")])
			: bytes,
	);
	return runDir;
}

function printedRunLine(run: RunPlan, runDir: string | undefined): string {
	if (runDir === undefined || run.printedRun === "none") return "";
	if (run.printedRun !== "other") return `Run: ${runDir}\n`;
	const other = join(dirname(runDir), randomUUID());
	mkdirSync(other, { recursive: true });
	return `Run: ${other}\n`;
}

if (command === "compile" && rest[0] === "--check") {
	if (plan.compileCheck === 4) {
		process.stdout.write(
			"PLAN_STALE docs/release-notes.md: the plan does not describe the doc\nExit code: 4\n",
		);
	}
	process.exitCode = plan.compileCheck;
} else if (command === "run") {
	if (plan.run.sleepMs !== undefined) {
		const child = spawn(
			process.execPath,
			["-e", "setTimeout(() => {}, 60000)"],
			{ stdio: "ignore" },
		);
		child.unref();
		if (plan.run.pidFile !== undefined) {
			writeFileSync(plan.run.pidFile, String(child.pid));
		}
		if (plan.run.detachedPidFile !== undefined) {
			let browserPid: number | undefined;
			for (const [signal, code] of [
				["SIGTERM", 143],
				["SIGINT", 130],
			] as const) {
				process.once(signal, () => {
					try {
						if (browserPid !== undefined) process.kill(-browserPid, "SIGTERM");
					} catch {
					}
					process.exit(code);
				});
			}
			const browser = spawn(
				process.execPath,
				["-e", "setTimeout(() => {}, 60000)"],
				{ stdio: "ignore", detached: true },
			);
			browser.unref();
			browserPid = browser.pid;
			writeFileSync(plan.run.detachedPidFile, String(browser.pid));
			if (plan.run.pauseAfterBrowserMs !== undefined) {
				await new Promise((done) =>
					setTimeout(done, plan.run.pauseAfterBrowserMs),
				);
			}
		}
		await new Promise((done) => setTimeout(done, plan.run.sleepMs));
	}
	const chunk = `${"x".repeat(1023)}\n`;
	for (
		let written = 0;
		written < (plan.run.outputBytes ?? 0);
		written += 1024
	) {
		process.stdout.write(chunk);
	}
	const runDir =
		plan.run.exit === 0 || plan.run.exit === 1 || plan.run.exit === 3
			? writeReport(plan.run)
			: undefined;
	process.stdout.write(
		`Model calls: 0\n${printedRunLine(plan.run, runDir)}Exit code: ${plan.run.exit}\n`,
	);
	process.exitCode = plan.run.exit;
} else if (command === "verify-run") {
	process.stdout.write(
		plan.verifyRun === 0 ? "OK\n" : "modified: artifacts/0.png\n",
	);
	process.exitCode = plan.verifyRun;
} else {
	process.stderr.write(`USAGE: unknown command ${command}\n`);
	process.exitCode = 2;
}
