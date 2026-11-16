/**
 * Fail if required Playwright screenshots + MP4s are missing/too small,
 * or digests in evidence-manifest.json do not match disk.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = join(ROOT, "public", "shots");
const MANIFEST = join(SHOTS, "evidence-manifest.json");

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

let errors = 0;
function fail(msg: string) {
	console.error(`FAIL: ${msg}`);
	errors += 1;
}

if (!existsSync(MANIFEST)) {
	fail(
		`missing ${MANIFEST} — run: pnpm --filter @hobo/control-yard run evidence`,
	);
	process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
	generatedAt?: string;
	files?: Record<string, { bytes: number; sha256: string }>;
};

if (!manifest.files || typeof manifest.files !== "object") {
	fail("evidence-manifest.json missing files map");
}

for (const req of REQUIRED) {
	const abs = join(SHOTS, req.path);
	if (!existsSync(abs)) {
		fail(`missing required evidence: ${req.path}`);
		continue;
	}
	const st = statSync(abs);
	if (st.size < req.minBytes) {
		fail(
			`${req.path} too small (${st.size} < ${req.minBytes} bytes) — likely empty/stub`,
		);
	} else {
		console.log(`OK  ${req.path} (${st.size} bytes)`);
	}
	const dig = sha256(abs);
	// Strict digest for all files except the manifest itself (self-hash chicken/egg).
	if (req.path === "evidence-manifest.json") continue;
	const entry = manifest.files?.[req.path];
	if (!entry) {
		fail(`manifest missing entry for ${req.path}`);
	} else if (entry.sha256 !== dig) {
		fail(
			`digest mismatch ${req.path}: manifest=${entry.sha256.slice(0, 12)}… disk=${dig.slice(0, 12)}…`,
		);
	} else if (entry.bytes !== st.size) {
		fail(`size mismatch ${req.path}: manifest=${entry.bytes} disk=${st.size}`);
	}
}

// MP4 structural check via ffprobe when available
for (const req of REQUIRED.filter((r) => r.kind === "mp4")) {
	const abs = join(SHOTS, req.path);
	if (!existsSync(abs)) continue;
	const { spawnSync } = await import("node:child_process");
	const r = spawnSync(
		"ffprobe",
		["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", abs],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) {
		fail(`ffprobe failed for ${req.path}: ${r.stderr || r.stdout}`);
		continue;
	}
	const dur = Number(String(r.stdout).trim());
	if (!Number.isFinite(dur) || dur < 1.5) {
		fail(`${req.path} duration ${dur}s < 1.5s — recording too short / static`);
	} else {
		console.log(`OK  ${req.path} duration=${dur.toFixed(2)}s`);
	}
}

if (errors > 0) {
	console.error(`\nevidence:check failed (${errors} error(s))`);
	process.exit(1);
}
console.log("\nevidence:check passed");
