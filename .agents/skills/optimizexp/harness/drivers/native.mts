import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { redactText } from "../lib/redaction.mts";

export type NativeCaptureInput = {
	/** Shell command that should write media into outDir (env OUT_DIR set). */
	command?: string;
	cwd: string;
	timeoutMs?: number;
};

export type NativeCaptureResult = {
	exitCode: number | null;
	primaryFile: string;
	kind: "video" | "image" | "transcript";
	degraded: boolean;
	notes: string[];
	screen: {
		widthPx: number | null;
		heightPx: number | null;
		cols: null;
		rows: null;
	};
};

/**
 * Native / computer-use capture.
 * Set OPTIMIZEXP_NATIVE_CAPTURE or pass --native-cmd:
 * a shell command that writes screenshot/video into $OUT_DIR.
 */
export function captureNative(
	outDir: string,
	input: NativeCaptureInput,
): NativeCaptureResult {
	mkdirSync(outDir, { recursive: true });
	const notes: string[] = [];
	let exitCode: number | null = null;
	const cmd =
		input.command ||
		process.env.OPTIMIZEXP_NATIVE_CAPTURE ||
		process.env.OPTIMIZEXP_COMPUTER_USE_CAPTURE ||
		"";

	if (cmd) {
		const before = new Map(
			readdirSync(outDir).map((file) => {
				const stat = statSync(path.join(outDir, file));
				return [file, `${stat.mtimeMs}:${stat.size}`];
			}),
		);
		const r = spawnSync("bash", ["-lc", cmd], {
			cwd: input.cwd,
			env: { ...process.env, OUT_DIR: outDir },
			encoding: "utf8",
			timeout: input.timeoutMs ?? 180_000,
		});
		exitCode = r.status;
		notes.push(`native command exit ${r.status}`);
		if (r.stderr) notes.push(redactText(r.stderr).slice(0, 300));
		const files = readdirSync(outDir).filter((file) => {
			const stat = statSync(path.join(outDir, file));
			return before.get(file) !== `${stat.mtimeMs}:${stat.size}`;
		});
		const video = files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
		const image = files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
		if (video) {
			const primary = path.join(outDir, "primary" + path.extname(video));
			const src = path.join(outDir, video);
			if (src !== primary) renameSync(src, primary);
			return {
				exitCode: r.status,
				primaryFile: primary,
				kind: "video",
				degraded: r.status !== 0,
				notes,
				screen: { widthPx: null, heightPx: null, cols: null, rows: null },
			};
		}
		if (image) {
			const primary = path.join(outDir, "primary" + path.extname(image));
			const src = path.join(outDir, image);
			if (src !== primary) renameSync(src, primary);
			return {
				exitCode: r.status,
				primaryFile: primary,
				kind: "image",
				degraded: true,
				notes: [...notes, "image only; prefer video when possible"],
				screen: { widthPx: null, heightPx: null, cols: null, rows: null },
			};
		}
	} else {
		notes.push(
			"No OPTIMIZEXP_NATIVE_CAPTURE / --native-cmd; writing computer-use handoff",
		);
	}

	const brief = path.join(outDir, "primary.txt");
	writeFileSync(
		brief,
		[
			`# OptimizeXP native evidence — computer-use handoff`,
			`capturedAt: ${new Date().toISOString()}`,
			`outDir: ${outDir}`,
			``,
			`Agent with computer-use:`,
			`1. Drive the native UI for the scenario`,
			`2. Prefer screen recording → save as primary.mp4/webm in this directory`,
			`3. Else screenshots at key moments into frames/ then stitch`,
			`4. Overwrite any previous primary.*`,
			``,
			...notes.map((n) => `note: ${n}`),
			``,
		].join("\n"),
		"utf8",
	);
	return {
		exitCode,
		primaryFile: brief,
		kind: "transcript",
		degraded: true,
		notes,
		screen: { widthPx: null, heightPx: null, cols: null, rows: null },
	};
}
