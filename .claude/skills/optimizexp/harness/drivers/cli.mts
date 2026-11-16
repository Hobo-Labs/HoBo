import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactText } from "../lib/redaction.mts";

export type CliCaptureInput = {
	command: string;
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
};

export type CaptureTiming = {
	durationMs: number;
	/** ms from spawn to the first stdout/stderr byte — perceptual latency. */
	timeToFirstOutputMs: number | null;
};

export type CliCaptureResult = {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	combined: string;
	durationMs: number;
	timing: CaptureTiming;
	screen: { cols: number | null; rows: number | null };
	primaryFile: string;
	/**
	 * Honest kind: a buffered one-shot capture is a `transcript`, never a
	 * `recording`. Only a real timed recording (asciinema via the tui driver)
	 * may claim `recording` — synthetic single-frame casts were how a frozen
	 * TUI got certified as replayable evidence.
	 */
	kind: "transcript";
};

function termSize(): { cols: number | null; rows: number | null } {
	return {
		cols: process.stdout.columns ?? null,
		rows: process.stdout.rows ?? null,
	};
}

export function captureCli(
	outDir: string,
	input: CliCaptureInput,
): Promise<CliCaptureResult> {
	mkdirSync(outDir, { recursive: true });
	const started = Date.now();
	// pipefail so `cmd | head` reports the failing command's status, not head's 0
	const wrapped = `set -o pipefail; ${input.command}`;
	return new Promise((resolve) => {
		const child = spawn("bash", ["-lc", wrapped], {
			cwd: input.cwd,
			env: { ...process.env, ...input.env },
		});
		let stdoutRaw = "";
		let stderrRaw = "";
		let firstOutputAt: number | null = null;
		const markFirst = () => {
			if (firstOutputAt === null) firstOutputAt = Date.now();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			markFirst();
			if (stdoutRaw.length < 8 * 1024 * 1024) stdoutRaw += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			markFirst();
			if (stderrRaw.length < 8 * 1024 * 1024) stderrRaw += chunk;
		});
		const timeout = setTimeout(
			() => child.kill("SIGKILL"),
			input.timeoutMs ?? 120_000,
		);
		const finish = (status: number | null) => {
			clearTimeout(timeout);
			const durationMs = Date.now() - started;
			const timing: CaptureTiming = {
				durationMs,
				timeToFirstOutputMs:
					firstOutputAt === null ? null : firstOutputAt - started,
			};
			const stdout = redactText(stdoutRaw);
			const stderr = redactText(stderrRaw);
			const combinedText = `${stdout}\n${stderr}`;
			// Prefer spawn status; if still 0, recover body-level lifecycle failures
			let exitCode: number | null = status;
			if (exitCode === 0) {
				const elifecycle = combinedText.match(/ELIFECYCLE[^\n]*exit code (\d+)/i);
				if (elifecycle?.[1]) exitCode = Number(elifecycle[1]);
				else if (
					/ERR_MODULE_NOT_FOUND|Cannot find package|node_modules missing/i.test(
						combinedText,
					)
				) {
					exitCode = 1;
				}
			}
			const screen = termSize();
			const header = [
				`# OptimizeXP CLI evidence`,
				`command: ${input.command}`,
				`cwd: ${input.cwd}`,
				`exitCode: ${exitCode}`,
				`spawnStatus: ${status}`,
				`durationMs: ${durationMs}`,
				`timeToFirstOutputMs: ${timing.timeToFirstOutputMs ?? "none"}`,
				`screen: ${screen.cols ?? "?"}x${screen.rows ?? "?"} (cols x rows)`,
				`capturedAt: ${new Date().toISOString()}`,
				``,
				`## stdout`,
				stdout || "(empty)",
				``,
				`## stderr`,
				stderr || "(empty)",
				``,
			].join("\n");
			writeFileSync(path.join(outDir, "terminal.txt"), header, "utf8");
			// The primary artifact is the honest transcript — no synthetic .cast.
			const primaryFile = path.join(outDir, "primary.txt");
			writeFileSync(primaryFile, header, "utf8");
			resolve({
				exitCode,
				stdout,
				stderr,
				combined: header,
				durationMs,
				timing,
				screen,
				primaryFile,
				kind: "transcript",
			});
		};
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code));
	});
}
