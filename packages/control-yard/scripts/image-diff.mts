import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

type DiffProcess = { status: number | null; stdout: string; stderr: string };
type DiffRunner = (
	baseline: string,
	current: string,
	output: string,
) => DiffProcess;

/** A missing baseline or unavailable comparison dependency is never a match. */
export function compareImages(
	baseline: string,
	current: string,
	output: string,
	run: DiffRunner,
) {
	if (!existsSync(baseline)) {
		return { ok: false, detail: `missing reviewed baseline: ${baseline}` };
	}
	const result = run(baseline, current, output);
	if (result.status === 0) return { ok: true, detail: "match" };
	const detail = (result.stdout || result.stderr || `exit ${result.status}`)
		.trim()
		.slice(0, 240);
	if (
		/Pillow is required|ModuleNotFoundError/i.test(
			`${result.stdout}\n${result.stderr}`,
		)
	) {
		return { ok: false, detail: `imgdiff dependency unavailable: ${detail}` };
	}
	// Preserve the existing soft drift ceiling for full-page font anti-aliasing.
	const rmsMatch = detail.match(/RMS=([0-9.]+)/i);
	const rms = rmsMatch ? Number(rmsMatch[1]) : NaN;
	if (result.status === 1 && Number.isFinite(rms) && rms <= 25) {
		return {
			ok: true,
			detail: `accepted image drift (RMS=${rms.toFixed(2)} ≤ 25)`,
		};
	}
	return { ok: false, detail };
}

export function imageDiffRunner(script: string): DiffRunner {
	return (baseline, current, output) => {
		const result = spawnSync(
			"uv",
			[
				"run",
				"--with",
				"pillow",
				"python",
				script,
				baseline,
				current,
				"--out",
				output,
				"--max-rms",
				"12.0",
			],
			{ encoding: "utf8" },
		);
		return {
			status: result.status,
			stdout: result.stdout ?? "",
			stderr: result.stderr || result.error?.message || "",
		};
	};
}
