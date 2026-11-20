import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	captureChecksSchema,
	captureErrorsSchema,
	captureFailureMessages,
} from "./capture-failures.mts";

const REQUIRED: {
	path: string;
	minBytes: number;
	kind: "png" | "mp4" | "json";
}[] = [
	{ path: "evidence-manifest.json", minBytes: 200, kind: "json" },
	{ path: "visual-report.json", minBytes: 100, kind: "json" },
	{ path: "01-boot-live.png", minBytes: 2048, kind: "png" },
	{ path: "02-connection-bay-sheet.png", minBytes: 2048, kind: "png" },
	{ path: "03-cost-booth.png", minBytes: 2048, kind: "png" },
	{ path: "04-policy-board.png", minBytes: 2048, kind: "png" },
	{ path: "05-error-bunker.png", minBytes: 2048, kind: "png" },
	{ path: "06-after-actions.png", minBytes: 2048, kind: "png" },
	{ path: "07-walk.png", minBytes: 2048, kind: "png" },
	{ path: "canvas-only.png", minBytes: 2048, kind: "png" },
	{ path: "anim-bo-idle.png", minBytes: 2048, kind: "png" },
	{ path: "anim-bo-walk-east.png", minBytes: 2048, kind: "png" },
	{ path: "anim-bo-walk-west.png", minBytes: 2048, kind: "png" },
	{ path: "recordings/01-yard-loop.mp4", minBytes: 10_000, kind: "mp4" },
	{ path: "recordings/02-connection-sheet.mp4", minBytes: 10_000, kind: "mp4" },
	{
		path: "recordings/03-bo-walk-east-west.mp4",
		minBytes: 10_000,
		kind: "mp4",
	},
	{ path: "recordings/04-rail-cost-doctor.mp4", minBytes: 10_000, kind: "mp4" },
];

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type VideoProbeResult = {
	status: number | null;
	stdout: string;
	stderr: string;
};
type VideoProbe = (path: string) => VideoProbeResult;

function probeVideo(path: string): VideoProbeResult {
	const result = spawnSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"stream=codec_type,width,height,duration:format=duration",
			"-of",
			"json",
			path,
		],
		{ encoding: "utf8" },
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr || result.error?.message || "",
	};
}

export function validateEvidence(
	shots: string,
	lock: string,
	probe: VideoProbe = probeVideo,
	trustedRoot?: string,
): number {
	const evidenceDir = resolve(shots);
	const manifestPath = join(evidenceDir, "evidence-manifest.json");
	let errors = 0;
	function fail(msg: string) {
		console.error(`FAIL: ${msg}`);
		errors += 1;
	}

	if (existsSync(lock)) {
		fail(`capture in progress or interrupted; check the lock at ${lock}`);
	}
	if (
		existsSync(join(evidenceDir, ".capture-incomplete")) ||
		existsSync(join(dirname(lock), ".capture-incomplete"))
	) {
		fail(
			"capture incomplete; run pnpm --filter @hobo/control-yard run evidence again",
		);
	}

	let evidenceRoot: string;
	let canonicalTrustedRoot: string | undefined;
	try {
		if (lstatSync(evidenceDir).isSymbolicLink()) {
			fail(`evidence directory is a symlink: ${shots}`);
			return errors;
		}
		if (trustedRoot) {
			const root = resolve(trustedRoot);
			const rel = relative(root, evidenceDir);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
				fail(`evidence directory is outside its trusted root: ${shots}`);
				return errors;
			}
			canonicalTrustedRoot = realpathSync(root);
			let current = canonicalTrustedRoot;
			for (const component of rel.split(sep).filter(Boolean)) {
				current = join(current, component);
				if (lstatSync(current).isSymbolicLink()) {
					fail(`evidence directory traverses a symlink: ${current}`);
					return errors;
				}
			}
		}
		evidenceRoot = realpathSync(evidenceDir);
		if (canonicalTrustedRoot) {
			const actual = relative(canonicalTrustedRoot, evidenceRoot);
			if (
				actual === ".." ||
				actual.startsWith(`..${sep}`) ||
				isAbsolute(actual)
			) {
				fail(`evidence directory resolves outside its trusted root: ${shots}`);
				return errors;
			}
		}
	} catch {
		fail(`cannot resolve evidence directory: ${shots}`);
		return errors;
	}
	if (!existsSync(manifestPath)) {
		fail(
			`missing ${manifestPath} — run: pnpm --filter @hobo/control-yard run evidence`,
		);
		return errors;
	}
	const invalidPaths = new Set<string>();
	const evidencePath = (path: string, label: string): string | undefined => {
		const reject = (reason: string): undefined => {
			if (!invalidPaths.has(label)) {
				fail(`${reason}: ${label}`);
				invalidPaths.add(label);
			}
			return undefined;
		};
		const rel = relative(evidenceDir, resolve(path));
		if (
			rel === "" ||
			rel === ".." ||
			rel.startsWith(`..${sep}`) ||
			isAbsolute(rel)
		)
			return reject("evidence path escapes the evidence directory");
		try {
			let current = evidenceRoot;
			for (const component of rel.split(sep)) {
				current = join(current, component);
				if (lstatSync(current).isSymbolicLink())
					return reject("evidence path traverses a symlink");
			}
			return current;
		} catch {
			return reject("cannot resolve evidence path");
		}
	};
	const containedManifest = evidencePath(
		manifestPath,
		"evidence-manifest.json",
	);
	if (!containedManifest) return errors;

	const manifestSchema = z.object({
		errors: z.unknown().optional(),
		checks: z.unknown().optional(),
		files: z
			.record(z.string(), z.object({ bytes: z.number(), sha256: z.string() }))
			.optional(),
	});
	const manifestSource = readFileSync(containedManifest, "utf8");
	const parsedManifest = (() => {
		try {
			return manifestSchema.safeParse(JSON.parse(manifestSource));
		} catch {
			return undefined;
		}
	})();
	if (!parsedManifest) {
		fail(
			"evidence-manifest.json is not valid JSON — rerun: pnpm --filter @hobo/control-yard run evidence",
		);
		return errors;
	}
	if (!parsedManifest.success) {
		fail("evidence-manifest.json has invalid fields");
		return errors;
	}
	const manifest = parsedManifest.data;

	let reportErrors = captureErrorsSchema.safeParse(undefined);
	let reportChecks = captureChecksSchema.safeParse(undefined);
	const reportPath = join(evidenceDir, "visual-report.json");
	if (existsSync(reportPath)) {
		const containedReport = evidencePath(reportPath, "visual-report.json");
		if (containedReport) {
			try {
				const report = z
					.object({
						errors: z.unknown().optional(),
						checks: z.unknown().optional(),
					})
					.safeParse(JSON.parse(readFileSync(containedReport, "utf8")));
				if (!report.success) {
					fail("visual-report.json is not an object");
				} else {
					reportErrors = captureErrorsSchema.safeParse(report.data.errors);
					reportChecks = captureChecksSchema.safeParse(report.data.checks);
				}
			} catch {
				fail("visual-report.json is not valid JSON");
			}
		}
	}
	for (const error of captureFailureMessages(
		captureErrorsSchema.safeParse(manifest.errors),
		reportErrors,
		captureChecksSchema.safeParse(manifest.checks),
		reportChecks,
	)) {
		fail(error);
	}

	if (!manifest.files) {
		fail("evidence-manifest.json missing files map");
	}

	for (const req of REQUIRED) {
		const abs = join(evidenceDir, req.path);
		if (!existsSync(abs)) {
			fail(`missing required evidence: ${req.path}`);
			continue;
		}
		const contained = evidencePath(abs, req.path);
		if (!contained) continue;
		const st = statSync(contained);
		if (st.size < req.minBytes) {
			fail(
				`${req.path} too small (${st.size} < ${req.minBytes} bytes) — likely empty/stub`,
			);
		} else {
			console.log(`OK  ${req.path} (${st.size} bytes)`);
		}
		if (req.path === "evidence-manifest.json") continue;
		const entry = manifest.files?.[req.path];
		if (!entry) {
			fail(`manifest missing entry for ${req.path}`);
		}
	}

	for (const [path, entry] of Object.entries(manifest.files ?? {})) {
		if (path === "evidence-manifest.json") continue;
		const abs = resolve(evidenceDir, path);
		const rel = relative(evidenceDir, abs);
		if (
			isAbsolute(path) ||
			path.includes("\\") ||
			/^[A-Za-z]:/u.test(path) ||
			rel === "" ||
			rel === ".." ||
			rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
		) {
			fail(`invalid manifested path: ${path}`);
			continue;
		}
		if (!existsSync(abs)) {
			fail(`missing manifested evidence: ${path}`);
			continue;
		}
		const contained = evidencePath(abs, path);
		if (!contained) continue;
		const st = statSync(contained);
		if (!st.isFile()) {
			fail(`manifested evidence is not a file: ${path}`);
			continue;
		}
		const dig = sha256(contained);
		if (entry.sha256 !== dig) {
			fail(
				`digest mismatch ${path}: manifest=${entry.sha256.slice(0, 12)}… disk=${dig.slice(0, 12)}…`,
			);
		} else if (entry.bytes !== st.size) {
			fail(`size mismatch ${path}: manifest=${entry.bytes} disk=${st.size}`);
		}
	}

	const duration = z.union([z.string(), z.number()]);
	const videoSchema = z.object({
		streams: z.array(
			z.object({
				codec_type: z.string(),
				width: z.number().optional(),
				height: z.number().optional(),
				duration: duration.optional(),
			}),
		),
		format: z.object({ duration: duration.optional() }),
	});
	for (const req of REQUIRED.filter((r) => r.kind === "mp4")) {
		const abs = join(evidenceDir, req.path);
		if (!existsSync(abs)) continue;
		const contained = evidencePath(abs, req.path);
		if (!contained) continue;
		const r = probe(contained);
		if (r.status !== 0) {
			fail(`ffprobe failed for ${req.path}: ${r.stderr || r.stdout}`);
			continue;
		}
		const parsed = (() => {
			try {
				return videoSchema.safeParse(JSON.parse(r.stdout));
			} catch {
				return undefined;
			}
		})();
		if (!parsed?.success) {
			fail(`ffprobe returned invalid video metadata for ${req.path}`);
			continue;
		}
		const video = parsed.data.streams[0];
		if (
			video?.codec_type !== "video" ||
			!video.width ||
			video.width <= 0 ||
			!video.height ||
			video.height <= 0
		) {
			fail(`${req.path} has no usable video stream`);
			continue;
		}
		const streamDuration = Number(video.duration);
		const containerDuration = Number(parsed.data.format.duration);
		if (
			!Number.isFinite(streamDuration) ||
			streamDuration < 1.5 ||
			!Number.isFinite(containerDuration) ||
			containerDuration < 1.5
		) {
			fail(
				`${req.path} has insufficient video or container duration (video=${streamDuration}s, container=${containerDuration}s; minimum 1.5s)`,
			);
		} else {
			console.log(
				`OK  ${req.path} video=${streamDuration.toFixed(2)}s container=${containerDuration.toFixed(2)}s`,
			);
		}
	}

	return errors;
}
