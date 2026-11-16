import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzeCast, type CastStats } from "../lib/cast-stats.mts";
import { which } from "../lib/media.mts";
import {
	captureCli,
	type CaptureTiming,
	type CliCaptureInput,
	type CliCaptureResult,
} from "./cli.mts";

export type TuiCaptureResult = Omit<CliCaptureResult, "kind"> & {
	kind: "recording" | "transcript";
	castFile?: string;
	/** Frame-level perceptual stats parsed from the real recording. */
	frameStats?: CastStats;
	degraded: boolean;
	notes: string[];
};

/**
 * TUI capture: a real asciinema recording is the only non-degraded path — a
 * TUI claim needs replayable frames with honest timing. The recording is
 * analyzed into frameStats (first output, silent gaps, byte volume) so
 * responsiveness/flicker budgets are machine-checkable.
 */
export async function captureTui(
	outDir: string,
	input: CliCaptureInput,
): Promise<TuiCaptureResult> {
	mkdirSync(outDir, { recursive: true });
	const notes: string[] = [];
	const screen = {
		cols: process.stdout.columns ?? null,
		rows: process.stdout.rows ?? null,
	};
	const asciinema = which("asciinema");
	if (asciinema) {
		const castPath = path.join(outDir, "session.cast");
		const started = Date.now();
		const r = spawnSync(
			asciinema,
			[
				"rec",
				"--overwrite",
				"--command",
				input.command,
				"--idle-time-limit",
				"2",
				castPath,
			],
			{
				cwd: input.cwd,
				env: { ...process.env, ...input.env },
				encoding: "utf8",
				timeout: input.timeoutMs ?? 180_000,
			},
		);
		const durationMs = Date.now() - started;
		if (r.status === 0 && existsSync(castPath)) {
			const primaryCast = path.join(outDir, "primary.cast");
			renameSync(castPath, primaryCast);
			const frameStats =
				analyzeCast(readFileSync(primaryCast, "utf8")) ?? undefined;
			const timing: CaptureTiming = {
				durationMs,
				timeToFirstOutputMs: frameStats?.firstOutputMs ?? null,
			};
			const summary = [
				`# OptimizeXP TUI evidence`,
				`command: ${input.command}`,
				`cwd: ${input.cwd}`,
				`exitCode: ${r.status}`,
				`durationMs: ${durationMs}`,
				`timeToFirstOutputMs: ${timing.timeToFirstOutputMs ?? "none"}`,
				`maxSilentGapMs: ${frameStats?.maxSilentGapMs ?? "none"}`,
				`outputEvents: ${frameStats?.eventCount ?? "none"} · bytes: ${frameStats?.totalOutputBytes ?? "none"}`,
				`screen: ${screen.cols ?? "?"}x${screen.rows ?? "?"} (cols x rows)`,
				`recording: primary.cast (asciinema)`,
				`capturedAt: ${new Date().toISOString()}`,
				``,
				`## note`,
				`Full terminal recording is primary.cast; this text is the repro summary.`,
				``,
			].join("\n");
			writeFileSync(path.join(outDir, "terminal.txt"), summary, "utf8");
			notes.push("asciinema cast stored as primary.cast");
			return {
				exitCode: r.status,
				stdout: "",
				stderr: r.stderr ?? "",
				combined: summary,
				durationMs,
				timing,
				screen,
				primaryFile: primaryCast,
				kind: "recording",
				castFile: primaryCast,
				...(frameStats !== undefined ? { frameStats } : {}),
				degraded: false,
				notes,
			};
		}
		notes.push(`asciinema failed (status ${r.status}); fell back to transcript`);
	} else {
		notes.push("asciinema not installed; transcript + screen size only");
	}
	const text = await captureCli(outDir, input);
	return { ...text, degraded: true, notes };
}
