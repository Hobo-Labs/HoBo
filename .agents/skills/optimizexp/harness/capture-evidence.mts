#!/usr/bin/env node
/**
 * OptimizeXP evidence harness — drive scenarios and capture persona-visible evidence.
 *
 * node --import tsx .agents/skills/optimizexp/harness/capture-evidence.mts --help
 * node --experimental-strip-types .agents/skills/optimizexp/harness/capture-evidence.mts --help
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { captureCli } from "./drivers/cli.mts";
import { captureTui } from "./drivers/tui.mts";
import { captureWeb } from "./drivers/web.mts";
import { captureNative } from "./drivers/native.mts";
import {
	clearPrimaryArtifacts,
	fileBytes,
	sha256File,
	tryStitchFrames,
	writeJson,
} from "./lib/media.mts";
import {
	evidenceDir,
	evidenceDirInScope,
	featureDir,
	featuresRoot,
	findFeature,
	listFeatures,
	relFromRepo,
	repoRoot,
	writeScopeFromSelection,
	type FeatureLocation,
} from "./lib/paths.mts";
import { resolveProjects } from "./lib/projects.mts";
import { scenarioSlug } from "./lib/slug.mts";
import { type EvidenceClaim, validateEvidenceReview } from "./lib/evidence-review.mts";

type FeatureMeta = {
	id: string;
	title?: string;
	experiences?: string[];
	personas?: string[];
	interfaces?: string[];
	driver?: string;
	surfaces?: string[];
	tags?: string[];
};

function parseArgs(argv: string[]) {
	const out: Record<string, string> = { mode: "help" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") out.mode = "help";
		else if (a === "--mode") out.mode = argv[++i] ?? "help";
		else if (a === "--id" || a === "--feature") out.feature = argv[++i] ?? "";
		else if (a === "--scenario") out.scenario = argv[++i] ?? "";
		else if (a === "--driver") out.driver = argv[++i] ?? "";
		else if (a === "--command") out.command = argv[++i] ?? "";
		else if (a === "--url") out.url = argv[++i] ?? "";
		else if (a === "--native-cmd") out.nativeCmd = argv[++i] ?? "";
		else if (a === "--run-id") out.runId = argv[++i] ?? "";
		else if (a === "--personas") out.personas = argv[++i] ?? "";
		else if (a === "--experiences") out.experiences = argv[++i] ?? "";
		else if (a === "--title") out.title = argv[++i] ?? "";
		else if (a === "--reviewer") out.reviewer = argv[++i] ?? "";
		else if (a === "--relevant") out.relevant = argv[++i] ?? "";
		else if (a === "--complete") out.complete = argv[++i] ?? "";
		else if (a === "--covered-claims") out.coveredClaims = argv[++i] ?? "";
		else if (a === "--notes") out.notes = argv[++i] ?? "";
		else if (a === "--project" || a === "--projects") {
			const v = argv[++i] ?? "";
			out.projects = out.projects ? `${out.projects},${v}` : v;
		} else if (a === "--strict") out.strict = "1";
		else if (!a.startsWith("-") && out.mode === "help") out.mode = a;
	}
	return out;
}

function help() {
	console.log(`optimizexp capture-evidence

Modes:
  init-feature   --id <slug> [--title …] [--personas a,b] [--experiences dx] [--driver cli]
  list-scenarios --feature <id>
  capture        --feature <id> --scenario <slug|title> [--driver cli|tui|web|native]
                 [--command '…'] [--url https://…] [--native-cmd '…'] [--run-id …]
  review         --feature <id> --scenario <slug> --reviewer <id>
                 [--relevant yes|no] [--complete yes|no] [--covered-claims all|id,…]
  stitch         --feature <id> --scenario <slug>
  validate       [--feature <id>] [--strict]

Evidence is written to:
  .optimizexp/features/<feature>/evidence/<scenario-slug>/   (global)
  or <project>/.optimizexp/features/<feature>/evidence/…    (project-local)
and overwrites the previous primary artifact for that scenario.
`);
}

function resolveFeatureLoc(
	featureId: string,
	root: string,
	preferredProject?: string,
): FeatureLocation {
	const loc = findFeature(featureId, root, {
		preferredProjectId: preferredProject,
	});
	if (!loc || !existsSync(loc.featureJsonPath)) {
		throw new Error(
			`missing feature.json for ${featureId} (searched global + project .optimizexp/features/)`,
		);
	}
	return loc;
}

function loadFeature(featureId: string, root: string): FeatureMeta {
	const loc = resolveFeatureLoc(featureId, root);
	return JSON.parse(readFileSync(loc.featureJsonPath, "utf8")) as FeatureMeta;
}

function initFeature(args: Record<string, string>) {
	const root = repoRoot();
	const id = args.feature || args.id;
	if (!id) {
		console.error("--id required");
		process.exit(2);
	}
	const selection = resolveProjects(args.projects ?? args.project, root);
	const scope = writeScopeFromSelection(selection, root);
	const dir = path.join(scope.optimizexpDir, "features", id);
	mkdirSync(path.join(dir, "evidence"), { recursive: true });
	mkdirSync(path.join(dir, "steps"), { recursive: true });
	const personas = (args.personas || "developer")
		.split(/[,\s]+/)
		.filter(Boolean);
	const experiences = (args.experiences || "dx")
		.split(/[,\s]+/)
		.filter(Boolean);
	const driver = args.driver || "cli";
	const title = args.title || id;
	const meta: FeatureMeta = {
		id,
		title,
		experiences,
		personas,
		interfaces: [driver === "web" ? "gui" : driver],
		driver,
		surfaces: [],
		tags: ["@optimizexp"],
	};
	writeJson(path.join(dir, "feature.json"), meta);
	const featureFile = path.join(dir, `${id}.feature`);
	if (!existsSync(featureFile)) {
		const personaTag = personas.map((p) => `@persona:${p}`).join(" ");
		writeFileSync(
			featureFile,
			`@optimizexp ${personaTag} @interface:${driver}
Feature: ${title}
  As a persona under optimizexp review
  I want a reproducible journey with captured evidence
  So that harms, friction, and uncertainty can be scored against what I see

  Scenario: Placeholder scenario for ${id}
    Given persona "${personas[0]}" is active
    When the surface under test is exercised
    Then evidence is captured under evidence/
`,
			"utf8",
		);
	}
	if (!existsSync(path.join(dir, "README.md"))) {
		writeFileSync(
			path.join(dir, "README.md"),
			`# ${title}\n\nFeature id: \`${id}\`\n\nPersonas: ${personas.join(", ")}\n\nEvidence: \`evidence/<scenario-slug>/\` (one primary recording per scenario; new runs overwrite).\n`,
			"utf8",
		);
	}
	console.log(JSON.stringify({ ok: true, dir, meta }, null, 2));
}

function parseScenarios(featureId: string, root: string) {
	const loc = findFeature(featureId, root);
	const dir = loc?.dir ?? featureDir(featureId, root);
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith(".feature"));
	const scenarios: { name: string; slug: string; file: string }[] = [];
	for (const f of files) {
		const text = readFileSync(path.join(dir, f), "utf8");
		for (const line of text.split(/\r?\n/)) {
			const m = line.match(/^\s*Scenario(?: Outline)?:\s*(.+)\s*$/);
			if (m) {
				const name = m[1]!.trim();
				scenarios.push({ name, slug: scenarioSlug(name), file: f });
			}
		}
	}
	return scenarios;
}

function scenarioClaims(featureId: string, scenario: string, root: string): EvidenceClaim[] {
	const loc = findFeature(featureId, root);
	if (!loc) return [];
	const claims: EvidenceClaim[] = [];
	let active = false;
	for (const file of readdirSync(loc.dir).filter((f) => f.endsWith(".feature"))) {
		const lines = readFileSync(path.join(loc.dir, file), "utf8").split(/\r?\n/);
		for (const line of lines) {
			const scenarioMatch = line.match(/^\s*Scenario(?: Outline)?:\s*(.+)\s*$/);
			if (scenarioMatch) active = scenarioSlug(scenarioMatch[1]!) === scenario;
			if (!active) continue;
			const step = line.match(/^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/);
			if (step) {
				const text = `${step[1]} ${step[2]}`;
				claims.push({ id: `claim-${claims.length + 1}`, text });
			}
		}
	}
	return claims;
}

function listScenarios(featureId: string) {
	const root = repoRoot();
	const scenarios = parseScenarios(featureId, root);
	console.log(JSON.stringify({ featureId, scenarios }, null, 2));
}

function writeReplayPage(
	dir: string,
	featureId: string,
	scenario: string,
	meta: Record<string, unknown>,
): void {
	const primary = (meta.primary ?? {}) as Record<string, unknown>;
	const file = typeof primary.file === "string" ? primary.file : "";
	const kind = typeof primary.kind === "string" ? primary.kind : "transcript";
	const playback = kind === "video"
		? `<video controls preload="metadata" src="${file}"></video>`
		: /^(image|gif)$/i.test(kind)
			? `![Captured evidence](${file})`
			: kind === "recording"
				? `[Open terminal replay](REPLAY.html) ([raw cast](${file}))`
			: file
				? `[Open captured transcript](${file})`
				: "No primary artifact was produced.";
	const screen = meta.screen && typeof meta.screen === "object"
		? `\n### Parsed screen\n\n\`\`\`json\n${JSON.stringify(meta.screen, null, 2)}\n\`\`\`\n`
		: "";
	writeFileSync(path.join(dir, "REPLAY.md"),
		`# Replay: ${featureId} / ${scenario}\n\n` +
		`Captured: ${String(meta.capturedAt ?? "unknown")}  \n` +
		`Driver: ${String(meta.driver ?? "unknown")}  \n` +
		`Run: ${String(meta.runId || "unscoped")}  \n` +
		`Primary SHA-256: ${String(primary.sha256 ?? "unknown")}\n\n` +
		`## Playback\n\n${playback}\n${screen}`,
		"utf8",
	);
}

function writeReplayHtml(dir: string, featureId: string, scenario: string, primaryFile: string, kind: string): void {
	const relative = path.basename(primaryFile);
	if (kind !== "recording") return;
	let frames: unknown[] = [];
	try {
		const lines = readFileSync(primaryFile, "utf8").split(/\r?\n/).filter(Boolean);
		frames = lines.slice(1).map((line) => JSON.parse(line));
	} catch {
		frames = [];
	}
	writeFileSync(path.join(dir, "REPLAY.html"), `<!doctype html>
<meta charset="utf-8"><title>OptimizeXP replay: ${featureId} / ${scenario}</title>
<style>body{background:#111;color:#eee;font:14px monospace;margin:2rem}pre{background:#000;padding:1rem;min-height:12rem;white-space:pre-wrap}button{padding:.5rem 1rem}</style>
<h1>${featureId} / ${scenario}</h1><p>Replayable terminal capture: <a href="${relative}">${relative}</a></p>
<button type="button" id="play">Play</button> <button type="button" id="stop">Stop</button><pre id="screen"></pre>
<script>const frames=${JSON.stringify(frames)};let timer=0,stopped=false;const screen=document.querySelector('#screen');document.querySelector('#stop').onclick=()=>{stopped=true;clearTimeout(timer)};document.querySelector('#play').onclick=()=>{stopped=false;screen.textContent='';let i=0;const next=()=>{if(stopped||i>=frames.length)return;const [delay,type,text]=frames[i++];if(type==='o')screen.textContent+=text;timer=setTimeout(next,Math.max(10,delay*1000))};next()};</script>
`, "utf8");
}

function resolveScenarioSlug(
	featureId: string,
	scenarioArg: string,
	root: string,
): string {
	const slug = scenarioSlug(scenarioArg);
	const known = parseScenarios(featureId, root);
	const hit = known.find((s) => s.slug === slug || s.name === scenarioArg);
	return hit?.slug ?? slug;
}

async function capture(args: Record<string, string>) {
	const root = repoRoot();
	const featureId = args.feature;
	if (!featureId) {
		console.error("--feature required");
		process.exit(2);
	}
	const loc = resolveFeatureLoc(featureId, root, args.projects?.split(/[,\s]+/)[0]);
	const meta = JSON.parse(
		readFileSync(loc.featureJsonPath, "utf8"),
	) as FeatureMeta;
	const scenario = resolveScenarioSlug(
		featureId,
		args.scenario || "default",
		root,
	);
	const outDir = evidenceDirInScope(featureId, scenario, loc.scope);
	mkdirSync(outDir, { recursive: true });
	const hadPrevious = clearPrimaryArtifacts(outDir);
	// clear stale handoff scripts
	for (const f of readdirSync(outDir)) {
		if (f.startsWith("_")) rmSync(path.join(outDir, f), { force: true });
	}

	const driver = (args.driver || meta.driver || "cli").toLowerCase();
	const runId = args.runId || "";
	const personaIds = meta.personas || [];
	const claims = scenarioClaims(featureId, scenario, root);

	let primaryFile = "";
	let kind = "transcript";
	let screen: Record<string, unknown> = {};
	let degraded = false;
	let notes: string[] = [];
	let exitCode: number | null = null;
	let repro: Record<string, unknown> = {};
	let timing: Record<string, unknown> | undefined;
	let frameStats: Record<string, unknown> | undefined;

	if (driver === "cli") {
		const command = args.command || meta.surfaces?.[0];
		if (!command) {
			console.error("--command required for cli driver (or feature.surfaces[0])");
			process.exit(2);
		}
		const r = await captureCli(outDir, { command, cwd: root });
		primaryFile = r.primaryFile;
		kind = r.kind;
		screen = r.screen;
		exitCode = r.exitCode;
		timing = r.timing as unknown as Record<string, unknown>;
		repro = { command, cwd: "." };
	} else if (driver === "tui") {
		const command = args.command || meta.surfaces?.[0];
		if (!command) {
			console.error("--command required for tui driver");
			process.exit(2);
		}
		const r = await captureTui(outDir, { command, cwd: root });
		primaryFile = r.castFile || r.primaryFile;
		kind = r.castFile ? "recording" : r.kind;
		screen = r.screen;
		exitCode = r.exitCode;
		degraded = r.degraded;
		notes = r.notes;
		timing = r.timing as unknown as Record<string, unknown>;
		if (r.frameStats) {
			frameStats = r.frameStats as unknown as Record<string, unknown>;
		}
		repro = { command, cwd: "." };
	} else if (driver === "web") {
		const url = args.url || meta.surfaces?.[0];
		if (!url) {
			console.error("--url required for web driver");
			process.exit(2);
		}
		const r = captureWeb(outDir, { url, cwd: root, video: true });
		primaryFile = r.primaryFile;
		kind = r.kind;
		screen = r.screen;
		degraded = r.degraded;
		notes = r.notes;
		repro = { url };
	} else if (driver === "native") {
		const r = captureNative(outDir, {
			command: args.nativeCmd,
			cwd: root,
		});
		primaryFile = r.primaryFile;
		kind = r.kind;
		screen = r.screen;
		exitCode = r.exitCode;
		degraded = r.degraded;
		notes = r.notes;
		repro = { nativeCmd: args.nativeCmd || process.env.OPTIMIZEXP_NATIVE_CAPTURE };
	} else {
		console.error(`unknown driver: ${driver}`);
		process.exit(2);
	}

	const primaryName = path.basename(primaryFile);
	// ensure primary.* naming
	if (!primaryName.startsWith("primary.")) {
		const dest = path.join(
			outDir,
			`primary${path.extname(primaryFile) || ".bin"}`,
		);
		if (primaryFile !== dest && existsSync(primaryFile)) {
			writeFileSync(dest, readFileSync(primaryFile));
			primaryFile = dest;
		}
	}

	const metaOut = {
		featureId,
		scenarioSlug: scenario,
		personaIds,
		interface: driver,
		driver,
		capturedAt: new Date().toISOString(),
		runId,
		screen,
		primary: {
			file: path.basename(primaryFile),
			kind,
			bytes: fileBytes(primaryFile),
			sha256: existsSync(primaryFile) ? sha256File(primaryFile) : null,
		},
		claims,
		frames: existsSync(path.join(outDir, "frames"))
			? readdirSync(path.join(outDir, "frames"))
			: [],
		repro: {
			...repro,
			// Stamp: assert-complete requires harness capture, not handwritten primary only
			via: "capture-evidence",
		},
		exitCode,
		...(timing !== undefined ? { timing } : {}),
		...(frameStats !== undefined ? { frameStats } : {}),
		degraded,
		notes,
	};
	writeJson(path.join(outDir, "meta.json"), metaOut);
	writeJson(path.join(outDir, "review.json"), {
		status: "pending",
		reviewer: "",
		relevance: "pending",
		completeness: "pending",
		coverageMode: "single-state",
		coveredClaims: [],
		artifactSha256: metaOut.primary.sha256,
		reviewedAt: "",
		notes: "Playback review required before this evidence can support a score.",
	});
	writeJson(path.join(outDir, "manifest.json"), {
		scenarioSlug: scenario,
		primaryPath: path.basename(primaryFile),
		kind,
		updatedAt: metaOut.capturedAt,
		overridesPrevious: hadPrevious,
	});
	writeReplayPage(outDir, featureId, scenario, metaOut);
	writeReplayHtml(outDir, featureId, scenario, primaryFile, kind);

	console.log(
		JSON.stringify(
			{
				ok: true,
				featureId,
				scenario,
				path: path.relative(root, outDir),
				primary: path.relative(root, primaryFile),
				kind,
				overridesPrevious: hadPrevious,
				degraded,
				notes,
			},
			null,
			2,
		),
	);
}

function review(args: Record<string, string>) {
	const root = repoRoot();
	if (!args.feature || !args.scenario || !args.reviewer) {
		console.error("--feature, --scenario, and --reviewer required");
		process.exit(2);
	}
	const loc = resolveFeatureLoc(args.feature, root, args.projects?.split(/[,.\s]+/)[0]);
	const scenario = resolveScenarioSlug(args.feature, args.scenario, root);
	const dir = evidenceDirInScope(args.feature, scenario, loc.scope);
	const metaPath = path.join(dir, "meta.json");
	if (!existsSync(metaPath)) {
		console.error("capture evidence before reviewing it");
		process.exit(1);
	}
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { claims?: EvidenceClaim[]; primary?: { sha256?: string } };
	const relevant = /^(yes|true|relevant)$/i.test(args.relevant || "");
	const complete = /^(yes|true|complete)$/i.test(args.complete || "");
	const all = (meta.claims ?? []).map((claim) => claim.id);
	const covered = args.coveredClaims === "all" || !args.coveredClaims
		? all
		: args.coveredClaims.split(/[,.\s]+/).filter(Boolean);
	const accepted = relevant && complete && covered.length === all.length && all.every((id) => covered.includes(id));
	writeJson(path.join(dir, "review.json"), {
		status: accepted ? "accepted" : "rejected",
		reviewer: args.reviewer,
		relevance: relevant ? "relevant" : "irrelevant",
		completeness: complete ? "complete" : "partial",
		coverageMode: complete ? "full-journey" : "single-state",
		coveredClaims: covered,
		artifactSha256: meta.primary?.sha256 ?? "",
		reviewedAt: new Date().toISOString(),
		notes: args.notes || "",
	});
	const problems = validateEvidenceReview(dir);
	console.log(JSON.stringify({ ok: problems.length === 0, accepted, problems }, null, 2));
	if (problems.length > 0) process.exitCode = 1;
}

function stitch(args: Record<string, string>) {
	const root = repoRoot();
	const featureId = args.feature;
	const scenario = resolveScenarioSlug(
		featureId!,
		args.scenario || "",
		root,
	);
	if (!featureId || !scenario) {
		console.error("--feature and --scenario required");
		process.exit(2);
	}
	const loc = findFeature(featureId, root);
	const outDir = loc
		? evidenceDirInScope(featureId, scenario, loc.scope)
		: evidenceDir(featureId, scenario, root);
	const framesDir = path.join(outDir, "frames");
	const result = tryStitchFrames(framesDir, path.join(outDir, "_stitch"));
	if (!result) {
		console.error("no frames to stitch or stitch failed");
		process.exit(1);
	}
	const ext = path.extname(result.file) || ".bin";
	const primary = path.join(outDir, `primary${ext}`);
	const bytes = readFileSync(result.file);
	clearPrimaryArtifacts(outDir);
	writeFileSync(primary, bytes);
	if (result.file.startsWith(path.join(outDir, "_stitch"))) {
		rmSync(result.file, { force: true });
	}
	const metaPath = path.join(outDir, "meta.json");
	const meta = existsSync(metaPath)
		? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>)
		: {};
	meta.primary = {
		file: path.basename(primary),
		kind: result.kind,
		bytes: fileBytes(primary),
		sha256: sha256File(primary),
	};
	meta.capturedAt = new Date().toISOString();
	writeJson(metaPath, meta);
	writeJson(path.join(outDir, "manifest.json"), {
		scenarioSlug: scenario,
		primaryPath: path.basename(primary),
		kind: result.kind,
		updatedAt: meta.capturedAt,
		overridesPrevious: true,
	});
	console.log(
		JSON.stringify(
			{ ok: true, primary: path.relative(root, primary), kind: result.kind },
			null,
			2,
		),
	);
}

function validate(args: Record<string, string>) {
	const root = repoRoot();
	const selection = resolveProjects(args.projects ?? "all", root);
	const strict = args.strict === "1" || args.strict === "true";
	const locations = args.feature
		? (() => {
				const hit = findFeature(args.feature, root, { selection });
				return hit ? [hit] : [];
			})()
		: listFeatures(root, selection);
	if (locations.length === 0) {
		console.log(JSON.stringify({ ok: true, features: 0, problems: [], missing: [] }));
		return;
	}
	const problems: string[] = [];
	const missing: string[] = [];
	for (const loc of locations) {
		const id = loc.id;
		const scenarios = parseScenarios(id, root);
		for (const s of scenarios) {
			const dir = evidenceDirInScope(id, s.slug, loc.scope);
			const man = path.join(dir, "manifest.json");
			if (!existsSync(man)) {
				missing.push(`${loc.scope.id}:${id}/${s.slug}`);
				if (strict) {
					problems.push(
						`${loc.scope.id}:${id}/${s.slug}: missing evidence/manifest.json`,
					);
				}
				continue;
			}
			const m = JSON.parse(readFileSync(man, "utf8")) as {
				primaryPath?: string;
			};
			if (!m.primaryPath || !existsSync(path.join(dir, m.primaryPath))) {
				problems.push(`${loc.scope.id}:${id}/${s.slug}: primary missing`);
			}
			if (strict) {
				problems.push(
					...validateEvidenceReview(dir).map(
						(p) => `${loc.scope.id}:${id}/${s.slug}: ${p}`,
					),
				);
			}
			const primaries = existsSync(dir)
				? readdirSync(dir).filter((f) => f.startsWith("primary."))
				: [];
			if (primaries.length > 1) {
				problems.push(
					`${loc.scope.id}:${id}/${s.slug}: multiple primary.* files: ${primaries.join(",")}`,
				);
			}
		}
		// also validate any evidence dirs that exist without scenarios
		const eRoot = path.join(loc.dir, "evidence");
		if (existsSync(eRoot)) {
			for (const slug of readdirSync(eRoot)) {
				const dir = path.join(eRoot, slug);
				const man = path.join(dir, "manifest.json");
				if (!existsSync(man)) {
					problems.push(
						`${loc.scope.id}:${id}/${slug}: evidence dir without manifest.json`,
					);
				}
			}
		}
	}
	const ok = problems.length === 0;
	console.log(
		JSON.stringify(
			{
				ok,
				features: locations.length,
				scopes: [...new Set(locations.map((l) => l.scope.id))],
				problems,
				missing,
				strict,
			},
			null,
			2,
		),
	);
	if (!ok) process.exitCode = 1;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const mode = args.mode || "help";
	if (mode === "help") return help();
	if (mode === "init-feature") return initFeature(args);
	if (mode === "list-scenarios") {
		if (!args.feature) {
			console.error("--feature required");
			process.exit(2);
		}
		return listScenarios(args.feature);
	}
	if (mode === "capture") {
		void capture(args).catch((err) => {
			console.error(err instanceof Error ? err.message : String(err));
			process.exit(1);
		});
		return;
	}
	if (mode === "review") return review(args);
	if (mode === "stitch") return stitch(args);
	if (mode === "validate") return validate(args);
	console.error(`unknown mode: ${mode}`);
	help();
	process.exit(2);
}

main();
