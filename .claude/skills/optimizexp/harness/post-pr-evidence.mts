#!/usr/bin/env node
/**
 * Post OptimizeXP feature evidence to a GitHub PR (size-aware, multi-comment).
 *
 * node --import tsx .agents/skills/optimizexp/harness/post-pr-evidence.mts --feature <id> [--pr N]
 */
import {
	existsSync,
	lstatSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
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
import { normalizeCliOptions } from "./lib/cli-options.mts";
import { isPathIdentifier } from "./lib/slug.mts";
import { optimizexpWriteProblem } from "./lib/write-containment.mts";
import { validateEvidenceArtifact, validateEvidenceReview } from "./lib/evidence-review.mts";

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

/** Check path components without following links, including for dry runs. */
function safeEvidenceEntry(root: string, target: string, kind: "directory" | "file", optional = false) {
	const relative = path.relative(root, path.resolve(target));
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error("Evidence path is outside the repository");
	}
	const parts = relative.split(path.sep);
	let current = root;
	for (let i = 0; i < parts.length; i++) {
		current = path.join(current, parts[i]!);
		let stat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if (optional && error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw new Error(`Evidence path is missing or unreadable: ${current}`);
		}
		if (stat.isSymbolicLink()) throw new Error(`Evidence path contains a symbolic link: ${current}`);
		const last = i === parts.length - 1;
		if (!last || kind === "directory") {
			if (!stat.isDirectory()) throw new Error(`Evidence path is not a directory: ${current}`);
		} else if (!stat.isFile() || stat.nlink > 1) {
			throw new Error(`Evidence path is not a single-linked regular file: ${current}`);
		}
		if (last) return stat;
	}
	return null;
}

/** Manifest paths are relative to their own scenario, never another scenario. */
function primaryEvidencePath(directory: string, value: unknown): string {
	if (typeof value !== "string" || !value || path.isAbsolute(value) || path.win32.parse(value).root || value.includes("\\") || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
		throw new Error("Invalid evidence manifest primaryPath");
	}
	const parts = value.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error("Invalid evidence manifest primaryPath");
	}
	return path.join(directory, ...parts);
}

function loadScenarios(featureId: string, root: string) {
	const loc = findFeature(featureId, root);
	const dir = loc?.dir ?? featureDir(featureId, root);
	const evidenceRoot = path.join(dir, "evidence");
	const evidencePath = `${path.relative(root, evidenceRoot).split(path.sep).join("/")}/`;
	if (!safeEvidenceEntry(root, evidenceRoot, "directory", true)) return { evidencePath, scenarios: [] };
	const scenarios = readdirSync(evidenceRoot, { withFileTypes: true })
		.filter((entry) => {
			if (entry.isSymbolicLink()) throw new Error(`Evidence scenario contains a symbolic link: ${entry.name}`);
			return entry.isDirectory();
		})
		.flatMap((entry) => {
			const slug = entry.name;
			const eDir = loc
				? evidenceDirInScope(featureId, slug, loc.scope)
				: evidenceDir(featureId, slug, root);
			const manifest = path.join(eDir, "manifest.json");
			if (!safeEvidenceEntry(root, manifest, "file", true)) return [];
			const man = JSON.parse(
				readFileSync(manifest, "utf8"),
			) as { primaryPath?: unknown; kind?: unknown; updatedAt?: string } | null;
			if (!man || typeof man.kind !== "string" || !man.kind) throw new Error("Invalid evidence manifest kind");
			const primary = primaryEvidencePath(eDir, man.primaryPath);
			const stat = safeEvidenceEntry(root, primary, "file");
			if (!stat) throw new Error("Evidence primary file is missing");
			const artifactProblems = validateEvidenceArtifact(eDir, root);
			if (artifactProblems.length) throw new Error(`Evidence artifact is inconsistent: ${artifactProblems.join(", ")}`);
			const reviewPath = path.join(eDir, "review.json");
			let reviewStatus = "unreviewed";
			if (safeEvidenceEntry(root, reviewPath, "file", true)) {
				const review = JSON.parse(readFileSync(reviewPath, "utf8")) as { status?: unknown } | null;
				if (!review || !["pending", "rejected", "accepted"].includes(String(review.status))) throw new Error("Invalid evidence review status");
				reviewStatus = String(review.status);
				if (reviewStatus === "accepted") {
					const reviewProblems = validateEvidenceReview(eDir, root);
					if (reviewProblems.length) throw new Error(`Accepted evidence review is inconsistent: ${reviewProblems.join(", ")}`);
				}
			}
			return [{
				slug,
				kind: man.kind,
				primaryPath: path.relative(root, primary),
				bytes: stat.size,
				updatedAt: man.updatedAt,
				abs: primary,
				reviewStatus,
			}];
		});
	return { evidencePath, scenarios };
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
	return { ok: r.status === 0, stderr: r.stderr || r.error?.message || (r.signal ? `gh ended by ${r.signal}` : `gh exited with status ${r.status}`), stdout: r.stdout };
}

/** A PR number is a positive decimal, never a gh option or repository path. */
function isPrNumber(value: string): boolean {
	return /^\d+$/.test(value) && /[1-9]/.test(value);
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
	const input = normalizeCliOptions(process.argv.slice(2), {
		values: ["--feature", "--pr"],
		flags: ["--dry-run", "--help", "-h"],
	});
	if (input.error || input.positionals.length) {
		console.error(input.error ?? `Unexpected positional argument: ${input.positionals[0]}`);
		process.exit(2);
	}
	const args = parseArgs(input.argv);
	if (args.help) {
		console.log(`post-pr-evidence --feature <id> [--pr N] [--dry-run]`);
		return;
	}
	if (args.pr !== undefined && !isPrNumber(args.pr)) {
		console.error("--pr must be a positive decimal PR number");
		process.exit(2);
	}
	const root = realpathSync(repoRoot());
	const featureId = args.feature;
	if (!featureId || !isPathIdentifier(featureId)) {
		console.error("--feature must be a valid feature id");
		process.exit(2);
	}
	const dry = args.dryRun === "1";
	if (!dry) {
		const location = findFeature(featureId, root);
		const problem = optimizexpWriteProblem(root, ["", location?.scope.projectPath ?? ""]);
		if (problem) {
			console.error(problem);
			process.exit(2);
		}
	}
	let evidence;
	try {
		evidence = loadScenarios(featureId, root);
	} catch (error) {
		console.error(`Invalid evidence: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	const { evidencePath, scenarios } = evidence;
	if (scenarios.length === 0) {
		console.error("no evidence scenarios found");
		process.exit(1);
	}
	const pr = args.pr || detectPr();
	if (!pr || !isPrNumber(pr)) {
		console.error("No valid PR number detected; pass --pr <number>");
		process.exit(2);
	}

	const indexLines = [
		`## OptimizeXP evidence — \`${featureId}\``,
		``,
		stackHint(),
		``,
		`| Scenario | Kind | Size | Path | Review |`,
		`|---|---|---:|---|---|`,
		...scenarios.map(
			(s) =>
				`| \`${s.slug}\` | ${s.kind} | ${s.bytes} | \`${s.primaryPath}\` | ${s.reviewStatus} |`,
		),
		``,
		`Canonical evidence lives on the branch under \`${evidencePath}\`. New captures **overwrite** the prior primary per scenario.`,
		``,
	];
	const indexResult = postComment(pr, indexLines.join("\n"), dry);
	const results: { kind?: string; slug?: string; ok: boolean; bytes?: number; error?: string }[] = [
		{ kind: "index", ok: indexResult.ok, ...(!indexResult.ok ? { error: indexResult.stderr } : {}) },
	];
	if (!indexResult.ok) {
		console.error("failed to post index comment", indexResult.stderr);
		console.log(JSON.stringify({ ok: false, pr, featureId, results }, null, 2));
		process.exitCode = 1;
		return;
	}

	for (const s of scenarios) {
		let body: string;
		let abs = s.abs;
		let bytes = s.bytes;
		if (!dry && !canInline(s.kind, bytes) && /\.(mp4|webm|mov|png|gif)$/i.test(abs)) {
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
		results.push({ slug: s.slug, ok: r.ok, bytes, ...(!r.ok ? { error: r.stderr } : {}) });
	}

	const ok = results.every((result) => result.ok);
	console.log(JSON.stringify({ ok, pr, featureId, results }, null, 2));
	if (!ok) process.exitCode = 1;
}

main();
