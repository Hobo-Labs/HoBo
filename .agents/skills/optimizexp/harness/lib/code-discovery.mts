/**
 * Best-effort discovery of real repo entrypoints that can back feature step implementations.
 * Never invents live service calls; prefers package.json scripts, documented CLIs, local files.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mts";

export type DiscoveredBinding = {
	kind: "package-script" | "shell-command" | "file" | "unknown";
	id: string;
	command?: string;
	scriptName?: string;
	path?: string;
	confidence: "high" | "medium" | "low";
	reason: string;
	implementsSteps: string[];
};

export type DiscoveryReport = {
	featureId: string;
	seed: string;
	scannedAt: string;
	bindings: DiscoveredBinding[];
	packageScripts: string[];
	notes: string[];
};

function readPackageScripts(root: string): Record<string, string> {
	const pkgPath = path.join(root, "package.json");
	if (!existsSync(pkgPath)) return {};
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			scripts?: Record<string, string>;
		};
		return pkg.scripts ?? {};
	} catch {
		return {};
	}
}

/** Extract `backtick commands` and pnpm/npm script hints from free text. */
export function extractCommandHints(text: string): string[] {
	const hints = new Set<string>();
	for (const m of text.matchAll(/`([^`]+)`/g)) {
		const cmd = m[1]!.trim();
		if (cmd.length > 0 && cmd.length < 200) hints.add(cmd);
	}
	// Do not also infer a HoBo command prefix from an unsafe shell expression
	// inside a backtick pair.
	const prose = text.replace(/`[^`]+`/g, " ");
	for (const m of text.matchAll(
		/\b(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+([a-zA-Z0-9:_:.-]+)/g,
	)) {
		hints.add(`pnpm run ${m[1]}`);
	}
	for (const m of prose.matchAll(/\bhobo[ \t]+[a-z][a-z0-9:-]*(?![a-z0-9:-]|[ \t]*[;&|<>()`$])/gi)) {
		hints.add(m[0]!);
	}
	return [...hints];
}

/** Accept literal shell words, including quoted values, but not expansion or operators. */
function literalShellWords(command: string): { value: string; quoted: boolean }[] | null {
	const words: { value: string; quoted: boolean }[] = [];
	let word = "";
	let quoted = false;
	let active = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const char = command[i]!;
		if (quote === "'") {
			if (char === "'") quote = null;
			else if (/[\x00-\x1f\x7f]/.test(char)) return null;
			else word += char;
		} else if (quote === '"') {
			if (char === '"') quote = null;
			else if (char === "$" || char === "`" || /[\x00-\x1f\x7f]/.test(char)) return null;
			else if (char === "\\") {
				const next = command[++i];
				if (!next || !'"\\$`'.includes(next)) return null;
				word += next;
			} else word += char;
		} else if (char === " " || char === "\t") {
			if (active) words.push({ value: word, quoted });
			word = "";
			quoted = false;
			active = false;
		} else if (char === "'" || char === '"') {
			quote = char;
			quoted = true;
			active = true;
		} else if (char === "\\") {
			const next = command[++i];
			if (!next || !/^[ -~]$/.test(next)) return null;
			word += next;
			quoted = true;
			active = true;
		} else if (/^[a-zA-Z0-9_./@:+,=-]$/.test(char)) {
			word += char;
			active = true;
		} else return null;
	}
	if (quote !== null) return null;
	if (active) words.push({ value: word, quoted });
	return words;
}

/** Live / egress package scripts must never be default feature primary for offline AX/DX. */
export function isLiveEgressScript(name: string): boolean {
	const n = name.toLowerCase();
	return (
		n === "eval:agent:live" ||
		n.endsWith(":live") ||
		n.includes("eval:agent:live") ||
		/^eval:agent$/.test(n)
	);
}

function scoreScript(
	name: string,
	body: string,
	keywords: string[],
): number {
	const hay = `${name} ${body}`.toLowerCase();
	let score = 0;
	for (const k of keywords) {
		if (!k || k.length < 3) continue;
		if (hay.includes(k.toLowerCase())) score += 2;
		if (name.toLowerCase().includes(k.toLowerCase())) score += 3;
	}
	// Demote live/egress scripts so keyword "agent" cannot promote eval:agent:live.
	if (isLiveEgressScript(name)) score = Math.min(score, 1);
	return score;
}

function keywordsFromSeed(seed: string): string[] {
	const stop = new Set([
		"the",
		"and",
		"for",
		"with",
		"that",
		"this",
		"from",
		"after",
		"before",
		"when",
		"then",
		"given",
		"want",
		"should",
		"must",
		"have",
		"does",
		"into",
		"over",
	]);
	return seed
		.toLowerCase()
		.replace(/[^a-z0-9\s:_-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length >= 3 && !stop.has(w))
		.slice(0, 24);
}

/** Scan Gherkin files for step text + command hints. */
export function collectFeatureText(featureDirPath: string): string {
	if (!existsSync(featureDirPath)) return "";
	const parts: string[] = [];
	for (const f of readdirSync(featureDirPath)) {
		if (f.endsWith(".feature") || f === "SEED.md" || f === "README.md") {
			parts.push(readFileSync(path.join(featureDirPath, f), "utf8"));
		}
	}
	return parts.join("\n");
}

export function discoverCode(input: {
	featureId: string;
	seed: string;
	featureDir: string;
	surfaces?: string[];
	root?: string;
	/** Prefer this package directory for bin/scripts (product scope). */
	packageDir?: string;
}): DiscoveryReport {
	const root = input.root ?? repoRoot();
	const packageDir = input.packageDir
		? path.isAbsolute(input.packageDir)
			? input.packageDir
			: path.join(root, input.packageDir)
		: root;
	const scripts = {
		...readPackageScripts(root),
		...readPackageScripts(packageDir),
	};
	const scriptNames = Object.keys(scripts);
	const text = [
		input.seed,
		...(input.surfaces ?? []),
		collectFeatureText(input.featureDir),
	].join("\n");
	const hints = extractCommandHints(text);
	// A default help command can be a plain surface rather than a quoted
	// command. Only promote a complete seed or surface, never a prose fragment.
	for (const candidate of [input.seed, ...(input.surfaces ?? [])]) {
		const command = candidate.trim();
		if (/^hobo[ \t]+(?:--help|-h)$/i.test(command)) hints.push(command);
	}
	// Also pull product bin verbs from EXPERIENCE.md
	const expPath = path.join(input.featureDir, "EXPERIENCE.md");
	if (existsSync(expPath)) {
		hints.push(...extractCommandHints(readFileSync(expPath, "utf8")));
	}
	const keywords = keywordsFromSeed(input.seed);
	const notes: string[] = [];
	const bindings: DiscoveredBinding[] = [];

	const allowLive =
		/\blive\b/i.test(input.seed) && !/without live|no live|offline|no cloud/i.test(input.seed);

	// Product binary commands (hobo …) beat monorepo scripts.
	// Reject feature ids and English prose false matches.
	const glue = new Set([
		"or",
		"and",
		"then",
		"the",
		"a",
		"to",
		"for",
		"with",
		"not",
		"only",
		"see",
		"stock",
		"chat",
		"strip",
		"product",
		"discoverability",
	]);
	const isPlausibleProductCli = (raw: string): string | null => {
		const cmd = raw.trim();
		const parts = cmd.length <= 120 ? literalShellWords(cmd) : null;
		if (!parts || parts[0]?.value.toLowerCase() !== "hobo" ||
			!parts[1] || !(/^[a-z]/i.test(parts[1].value) || ["--help", "-h"].includes(parts[1].value))) return null;
		for (const p of parts.slice(1)) {
			const t = p.value.toLowerCase();
			if (!p.quoted && (glue.has(t) || t.endsWith(":") || p.value.length > 48)) return null;
		}
		return cmd;
	};
	const seenCmds = new Set<string>();
	for (const hint of hints) {
		const cmd = isPlausibleProductCli(hint);
		if (!cmd || seenCmds.has(cmd)) continue;
		seenCmds.add(cmd);
		bindings.push({
			kind: "shell-command",
			id: `shell:${cmd.slice(0, 48)}`,
			command: cmd,
			confidence: "high",
			reason: "product CLI command from feature/EXPERIENCE/seed",
			implementsSteps: [
				"I exercise the surface as this persona would",
				"I observe the failure as this persona",
				"I start bare TTY",
			],
		});
	}

	// Explicit command hints win
	for (const hint of hints) {
		const runMatch = hint.match(/^(?:pnpm|npm|yarn)(?:\s+run)?\s+(\S+)/);
		if (runMatch) {
			const name = runMatch[1]!;
			if (scripts[name]) {
				if (isLiveEgressScript(name) && !allowLive) {
					notes.push(
						`skipped live/egress script "${name}" (offline default; seed did not opt into live)`,
					);
					continue;
				}
				bindings.push({
					kind: "package-script",
					id: `script:${name}`,
					scriptName: name,
					command: `pnpm run ${name}`,
					confidence: "high",
					reason: `package.json scripts["${name}"] exists; mentioned in feature/seed`,
					implementsSteps: [
						"I exercise the surface as this persona would",
						"I observe the failure as this persona",
					],
				});
				continue;
			}
		}
		// bare script name
		if (scripts[hint]) {
			if (isLiveEgressScript(hint) && !allowLive) {
				notes.push(
					`skipped live/egress script "${hint}" (offline default; seed did not opt into live)`,
				);
				continue;
			}
			bindings.push({
				kind: "package-script",
				id: `script:${hint}`,
				scriptName: hint,
				command: `pnpm run ${hint}`,
				confidence: "high",
				reason: `package.json scripts["${hint}"] exists`,
				implementsSteps: ["I exercise the surface as this persona would"],
			});
			continue;
		}
		// shell command with binary that might exist
		const bin = hint.split(/\s+/)[0]!;
		if (bin === "node" || bin === "pnpm" || bin === "git" || bin === "bash") {
			bindings.push({
				kind: "shell-command",
				id: `shell:${hint.slice(0, 40)}`,
				command: hint,
				confidence: "medium",
				reason: "explicit shell command in feature text",
				implementsSteps: ["I exercise the surface as this persona would"],
			});
		}
	}

	// Keyword match against scripts (agent-check, lint, test, doctor, …)
	const ranked = scriptNames
		.map((name) => ({
			name,
			body: scripts[name]!,
			score: scoreScript(name, scripts[name]!, keywords),
		}))
		.filter((x) => x.score >= 4 && (allowLive || !isLiveEgressScript(x.name)))
		.sort((a, b) => b.score - a.score)
		.slice(0, 5);

	for (const r of ranked) {
		const id = `script:${r.name}`;
		if (bindings.some((b) => b.id === id)) continue;
		bindings.push({
			kind: "package-script",
			id,
			scriptName: r.name,
			command: `pnpm run ${r.name}`,
			confidence: r.score >= 8 ? "high" : "medium",
			reason: `script "${r.name}" matched seed keywords (score ${r.score})`,
			implementsSteps: ["I exercise the surface as this persona would"],
		});
	}

	// Experience-proof navigation: classification manifest is the critical path (not gate:s1).
	if (/exp-proofs|experience proof|experience-proof/i.test(text)) {
		const classification = "src/draft/exp-proofs/_classification.md";
		const abs = path.join(root, classification);
		if (existsSync(abs)) {
			const cmd =
				"bash -lc 'test -f src/draft/exp-proofs/_classification.md && ls src/draft/exp-proofs && head -n 40 src/draft/exp-proofs/_classification.md'";
			bindings.unshift({
				kind: "shell-command",
				id: "shell:exp-proofs-classification",
				command: cmd,
				confidence: "high",
				reason:
					"seed targets exp-proofs navigation; _classification.md is the type map (dx/ux/cx/ax/api)",
				implementsSteps: [
					"I exercise the surface as this persona would",
					"I am on the critical path described by the feature seed",
				],
			});
			bindings.push({
				kind: "file",
				id: `file:${classification}`,
				path: classification,
				confidence: "high",
				reason: "classification manifest exists for experience-type folders",
				implementsSteps: ["I am on the critical path described by the feature seed"],
			});
		}
	}

	// Known HoBo agent-check surface
	if (
		/agent.?check|staged check|staged gate/i.test(text) &&
		scripts["agent:check"]
	) {
		const id = "script:agent:check";
		const staged = /\bstaged\b/i.test(text);
		const command = staged
			? "pnpm run agent:check -- --staged"
			: "pnpm run agent:check";
		const existing = bindings.find((b) => b.scriptName === "agent:check");
		if (existing) {
			existing.command = command;
			existing.confidence = "high";
			existing.reason =
				"seed/journey mentions agent check; script agent:check exists";
		} else {
			bindings.unshift({
				kind: "package-script",
				id,
				scriptName: "agent:check",
				command,
				confidence: "high",
				reason: "seed/journey mentions agent check; script agent:check exists",
				implementsSteps: [
					"I exercise the surface as this persona would",
					"I observe the failure as this persona",
				],
			});
		}
	}

	// File existence for docs paths mentioned
	for (const m of text.matchAll(
		/\b((?:docs|site|scripts|packages|src|\.agents|\.optimizexp)\/[\w./-]+)/g,
	)) {
		const rel = m[1]!;
		const abs = path.join(root, rel);
		if (existsSync(abs)) {
			bindings.push({
				kind: "file",
				id: `file:${rel}`,
				path: rel,
				confidence: "medium",
				reason: "path mentioned in feature exists on disk",
				implementsSteps: ["I am on the critical path described by the feature seed"],
			});
		}
	}

	if (bindings.length === 0) {
		notes.push(
			"No high-confidence code bindings found; step implementations will be stubs (pending).",
		);
	} else {
		notes.push(
			`Discovered ${bindings.length} candidate binding(s); high-confidence ones are wired into implementations.ts.`,
		);
	}

	return {
		featureId: input.featureId,
		seed: input.seed,
		scannedAt: new Date().toISOString(),
		bindings,
		packageScripts: scriptNames,
		notes,
	};
}

/** Prefer a single primary command for "exercise the surface". */
export function pickPrimaryCommand(
	report: DiscoveryReport,
): DiscoveredBinding | null {
	const runnable = (b: DiscoveredBinding) =>
		(b.kind === "package-script" || b.kind === "shell-command") &&
		Boolean(b.command) &&
		!(b.scriptName && isLiveEgressScript(b.scriptName));
	const high = report.bindings.filter((b) => b.confidence === "high" && runnable(b));
	// Product CLI (hobo …) always beats monorepo keyword scripts
	const productCli = high.find(
		(b) =>
			b.kind === "shell-command" &&
			b.command &&
			/^hobo\b/i.test(b.command),
	);
	if (productCli) return productCli;
	// Prefer journey-specific offline surfaces when present
	const preferredIds = [
		"shell:exp-proofs-classification",
		"script:doctor",
	];
	for (const id of preferredIds) {
		const hit = high.find((b) => b.id === id);
		if (hit) return hit;
	}
	// agent:check only when seed explicitly about agent-check gates — not keyword "agent"
	const preferredNames = ["doctor", "check:relevant:staged", "test:file"];
	for (const name of preferredNames) {
		const hit = high.find((b) => b.scriptName === name);
		if (hit) return hit;
	}
	if (
		/agent.?check|staged check|staged gate/i.test(report.seed) &&
		high.find((b) => b.scriptName === "agent:check")
	) {
		return high.find((b) => b.scriptName === "agent:check")!;
	}
	// Demote eval:agent:* and generic agent:check for product features
	const demoted = high.filter(
		(b) =>
			!(
				b.scriptName &&
				(b.scriptName.startsWith("eval:agent") ||
					b.scriptName === "agent:check")
			),
	);
	if (demoted[0]) return demoted[0]!;
	if (high[0]) return high[0]!;
	const med = report.bindings.filter((b) => b.confidence === "medium" && runnable(b));
	const medProduct = med.find(
		(b) => b.command && /^hobo\b/i.test(b.command),
	);
	return medProduct ?? med[0] ?? null;
}

export function fileExistsUnderRoot(rel: string, root = repoRoot()): boolean {
	try {
		const abs = path.join(root, rel);
		return existsSync(abs) && (statSync(abs).isFile() || statSync(abs).isDirectory());
	} catch {
		return false;
	}
}
