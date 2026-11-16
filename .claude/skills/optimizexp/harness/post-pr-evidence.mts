#!/usr/bin/env node
/**
 * Post OptimizeXP feature evidence to a GitHub PR (size-aware, multi-comment).
 *
 * node --import tsx .agents/skills/optimizexp/harness/post-pr-evidence.mts --feature <id> [--pr N]
 */
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
	evidenceDir,
	evidenceDirInScope,
	featureDir,
	findFeature,
	repoRoot,
} from "./lib/paths.mts";
import { which, fileBytes } from "./lib/media.mts";

const IMAGE_MAX = 1_000_000;
const GIF_MAX = 2_000_000;
const VIDEO_MAX = 5_000_000;

function parseArgs(argv: string[]) {
	const out: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--feature") out.feature = argv[++i] ?? "";
		else if (a === "--pr") out.pr = argv[++i] ?? "";
		else if (a === "--dry-run") out.dryRun = "1";
		else if (a === "--help" || a === "-h") out.help = "1";
	}
	return out;
}

function detectPr(): string | null {
	const r = spawnSync(
		"gh",
		["pr", "view", "--json", "number", "-q", ".number"],
		{ encoding: "utf8" },
	);
	if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	return null;
}

function stackHint(): string {
	const ext = spawnSync("gh", ["extension", "list"], { encoding: "utf8" });
	const list = ext.stdout || "";
	if (/stack/i.test(list)) {
		return "Stacked PR tooling detected (`gh extension list` matches stack). Prefer one stack entry per optimizexp iteration.";
	}
	const gt = which("gt");
	if (gt) return "Graphite `gt` detected — acceptable stack alternate.";
	return "No gh stack extension detected; using a single linear PR is fine.";
}

function loadScenarios(featureId: string, root: string) {
	const loc = findFeature(featureId, root);
	const dir = loc?.dir ?? featureDir(featureId, root);
	const evidenceRoot = path.join(dir, "evidence");
	if (!existsSync(evidenceRoot)) return [];
	return readdirSync(evidenceRoot)
		.filter((d) => existsSync(path.join(evidenceRoot, d, "manifest.json")))
		.map((slug) => {
			const eDir = loc
				? evidenceDirInScope(featureId, slug, loc.scope)
				: evidenceDir(featureId, slug, root);
			const man = JSON.parse(
				readFileSync(path.join(eDir, "manifest.json"), "utf8"),
			) as { primaryPath: string; kind: string; updatedAt?: string };
			const primary = path.join(eDir, man.primaryPath);
			const bytes = existsSync(primary) ? fileBytes(primary) : 0;
			return {
				slug,
				kind: man.kind,
				primaryPath: path.relative(root, primary),
				bytes,
				updatedAt: man.updatedAt,
				abs: primary,
			};
		});
}

function canInline(kind: string, bytes: number): boolean {
	if (kind === "image" || kind === "png" || /\.png$/i.test(kind))
		return bytes <= IMAGE_MAX;
	if (kind === "gif" || /\.gif$/i.test(kind)) return bytes <= GIF_MAX;
	if (kind === "video" || /\.(mp4|webm)$/i.test(kind)) return bytes <= VIDEO_MAX;
	if (kind === "transcript" || kind === "recording") return bytes <= IMAGE_MAX;
	return bytes <= IMAGE_MAX;
}

function postComment(pr: string, body: string, dry: boolean) {
	if (dry) {
		console.log("--- dry-run comment ---");
		console.log(body.slice(0, 2000));
		console.log(body.length > 2000 ? "…[truncated]" : "");
		return { ok: true };
	}
	const r = spawnSync(
		"gh",
		["pr", "comment", pr, "--body", body],
		{ encoding: "utf8" },
	);
	return { ok: r.status === 0, stderr: r.stderr, stdout: r.stdout };
}

function tryCompress(abs: string, root: string): string | null {
	const ffmpeg = which("ffmpeg");
	if (!ffmpeg) return null;
	const outDir = path.join(root, ".optimizexp", "runs", "_pr-compress");
	mkdirSync(outDir, { recursive: true });
	const base = path.basename(abs, path.extname(abs));
	const out = path.join(outDir, `${base}-small.gif`);
	const r = spawnSync(
		ffmpeg,
		["-y", "-i", abs, "-vf", "fps=4,scale=640:-1:flags=lanczos", out],
		{ encoding: "utf8" },
	);
	if (r.status === 0 && existsSync(out) && statSync(out).size < statSync(abs).size) {
		return out;
	}
	return null;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(`post-pr-evidence --feature <id> [--pr N] [--dry-run]`);
		return;
	}
	const root = repoRoot();
	const featureId = args.feature;
	if (!featureId) {
		console.error("--feature required");
		process.exit(2);
	}
	const pr = args.pr || detectPr();
	if (!pr) {
		console.error("No PR detected; pass --pr <number>");
		process.exit(2);
	}
	const dry = args.dryRun === "1";
	const scenarios = loadScenarios(featureId, root);
	if (scenarios.length === 0) {
		console.error("no evidence scenarios found");
		process.exit(1);
	}

	const indexLines = [
		`## OptimizeXP evidence — \`${featureId}\``,
		``,
		stackHint(),
		``,
		`| Scenario | Kind | Size | Path |`,
		`|---|---|---:|---|`,
		...scenarios.map(
			(s) =>
				`| \`${s.slug}\` | ${s.kind} | ${s.bytes} | \`${s.primaryPath}\` |`,
		),
		``,
		`Canonical evidence lives on the branch under \`.optimizexp/features/${featureId}/evidence/\`. New captures **overwrite** the prior primary per scenario.`,
		``,
	];
	const indexResult = postComment(pr, indexLines.join("\n"), dry);
	if (!indexResult.ok) {
		console.error("failed to post index comment", indexResult.stderr);
		process.exit(1);
	}

	const results: unknown[] = [{ kind: "index", ok: true }];
	for (const s of scenarios) {
		let body: string;
		let abs = s.abs;
		let bytes = s.bytes;
		if (!canInline(s.kind, bytes) && /\.(mp4|webm|mov|png|gif)$/i.test(abs)) {
			const compressed = tryCompress(abs, root);
			if (compressed) {
				abs = compressed;
				bytes = fileBytes(compressed);
			}
		}
		if (canInline(s.kind, bytes) && /\.(png|gif|jpe?g|webp)$/i.test(abs)) {
			// gh cannot always embed local files; link path + optional upload via gh api is limited
			body = [
				`### Scenario \`${s.slug}\``,
				``,
				`Kind: **${s.kind}** (${bytes} bytes)`,
				``,
				`Path: \`${s.primaryPath}\``,
				``,
				`![${s.slug}](${s.primaryPath})`,
				``,
				`_If the image does not render in the comment, open the path on the PR branch._`,
			].join("\n");
		} else if (
			canInline(s.kind, bytes) &&
			(s.kind === "transcript" || /\.txt$/i.test(abs))
		) {
			const text = readFileSync(abs, "utf8");
			const clipped = text.length > 12000 ? `${text.slice(0, 12000)}\n…[clipped]` : text;
			body = [
				`### Scenario \`${s.slug}\` (transcript)`,
				``,
				`Path: \`${s.primaryPath}\``,
				``,
				"```text",
				clipped,
				"```",
			].join("\n");
		} else {
			body = [
				`### Scenario \`${s.slug}\` (too large for inline API upload)`,
				``,
				`Kind: **${s.kind}** (${s.bytes} bytes)`,
				``,
				`See committed path: \`${s.primaryPath}\``,
				``,
				`Size exceeded inline thresholds; open the file on the PR branch or download from the commit.`,
			].join("\n");
		}
		const r = postComment(pr, body, dry);
		results.push({ slug: s.slug, ok: r.ok, bytes });
		if (!r.ok) {
			// split failure: still continue other scenarios
			results.push({ slug: s.slug, error: r.stderr });
		}
	}

	console.log(JSON.stringify({ ok: true, pr, featureId, results }, null, 2));
}

main();
