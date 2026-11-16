import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export function sha256File(filePath: string): string {
	const buf = readFileSync(filePath);
	return createHash("sha256").update(buf).digest("hex");
}

export function clearPrimaryArtifacts(dir: string): boolean {
	if (!existsSync(dir)) return false;
	let had = false;
	for (const name of readdirSync(dir)) {
		if (name.startsWith("primary.")) {
			rmSync(path.join(dir, name), { force: true });
			had = true;
		}
	}
	return had;
}

export function writeJson(filePath: string, data: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function which(bin: string): string | null {
	const r = spawnSync("bash", ["-lc", `command -v ${bin}`], {
		encoding: "utf8",
	});
	const out = (r.stdout || "").trim();
	return r.status === 0 && out ? out : null;
}

export function tryStitchFrames(
	framesDir: string,
	outBase: string,
): { file: string; kind: string } | null {
	if (!existsSync(framesDir)) return null;
	const frames = readdirSync(framesDir)
		.filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
		.sort()
		.map((f) => path.join(framesDir, f));
	if (frames.length === 0) return null;

	const ffmpeg = which("ffmpeg");
	if (ffmpeg && frames.length >= 2) {
		const mp4 = `${outBase}.mp4`;
		// pattern: frames must be sequential; copy to numbered list via concat demuxer
		const listFile = path.join(framesDir, "_list.txt");
		const listBody = frames
			.map((f) => `file '${f.replace(/'/g, `'\\''`)}'\nduration 0.8`)
			.join("\n");
		writeFileSync(listFile, `${listBody}\n`, "utf8");
		const r = spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				listFile,
				"-vsync",
				"vfr",
				"-pix_fmt",
				"yuv420p",
				mp4,
			],
			{ encoding: "utf8" },
		);
		rmSync(listFile, { force: true });
		if (r.status === 0 && existsSync(mp4)) {
			return { file: mp4, kind: "video" };
		}
		// gif fallback via ffmpeg
		const gif = `${outBase}.gif`;
		const g = spawnSync(
			ffmpeg,
			[
				"-y",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				listFile,
				"-vf",
				"fps=2,scale=800:-1:flags=lanczos",
				gif,
			],
			{ encoding: "utf8" },
		);
		// rewrite list for gif attempt
		writeFileSync(listFile, `${listBody}\n`, "utf8");
		if (g.status === 0 && existsSync(gif)) {
			rmSync(listFile, { force: true });
			return { file: gif, kind: "gif" };
		}
		rmSync(listFile, { force: true });
	}

	// single frame → primary png copy reference
	if (frames.length === 1) {
		return { file: frames[0]!, kind: "image" };
	}
	return null;
}

export function fileBytes(p: string): number {
	return existsSync(p) ? statSync(p).size : 0;
}
