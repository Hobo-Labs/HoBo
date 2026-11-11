/**
 * Surface-map types + builders for OptimizeXP app exploration.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { repoRoot } from "./paths.mts";
import type { ProjectRef } from "./projects.mts";

export type SurfaceDriver = "cli" | "tui" | "web" | "native";

export type SurfaceCommand = {
	id: string;
	argv: string[];
	kind: string;
	summary?: string;
};

export type SurfaceMap = {
	schemaVersion: 1;
	projectId: string;
	scannedAt: string;
	productName: string;
	packageDir: string;
	binaries: {
		name: string;
		binPath: string;
		packageName?: string;
	}[];
	defaultEntry: {
		command: string;
		interactive: boolean;
		driver: SurfaceDriver;
		notes: string;
	} | null;
	nonInteractiveHelp: { command: string; driver: "cli" } | null;
	commands: SurfaceCommand[];
	interactiveSurfaces: {
		id: string;
		entry: string;
		driver: SurfaceDriver;
		slashCommands?: string[];
	}[];
	requiredJourneys: string[];
	probes: {
		command: string;
		exitCode: number | null;
		stdoutDigest: string;
		capturedAt: string;
		notes?: string;
	}[];
};

function digestText(s: string): string {
	return createHash("sha256").update(s.slice(0, 8000)).digest("hex").slice(0, 16);
}

function readJsonSafe<T>(p: string): T | null {
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

/** Prefer project package.json bin over monorepo root. */
export function discoverPackageBins(
	packageDir: string,
	root: string,
): SurfaceMap["binaries"] {
	const pkgPath = path.join(packageDir, "package.json");
	const pkg = readJsonSafe<{
		name?: string;
		bin?: string | Record<string, string>;
	}>(pkgPath);
	if (!pkg?.bin) return [];
	const out: SurfaceMap["binaries"] = [];
	const binField = pkg.bin;
	const entries =
		typeof binField === "string"
			? [[path.basename(packageDir), binField] as const]
			: Object.entries(binField);
	for (const [name, rel] of entries) {
		const abs = path.resolve(packageDir, rel);
		out.push({
			name,
			binPath: existsSync(abs) ? abs : path.join(packageDir, rel),
			packageName: pkg.name,
		});
	}
	void root;
	return out;
}

function probeCommand(
	command: string,
	cwd: string,
	timeoutMs = 20_000,
): SurfaceMap["probes"][0] {
	const r = spawnSync("bash", ["-lc", command], {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
		env: {
			...process.env,
			// Force non-interactive for explore probes
			CI: process.env.CI ?? "1",
		},
		maxBuffer: 2 * 1024 * 1024,
	});
	const combined = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
	return {
		command,
		exitCode: r.status,
		stdoutDigest: digestText(combined),
		capturedAt: new Date().toISOString(),
		notes: r.error ? String(r.error.message) : undefined,
	};
}

/** Parse HOBO_*_VERBS = [ "a", "b" ] arrays from package sources. */
function parseVerbEnumFromSources(packageDir: string): string[] {
	const found: string[] = [];
	const dirs = [
		path.join(packageDir, "src"),
		path.join(packageDir, "dist"),
	];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		const stack = [dir];
		while (stack.length) {
			const cur = stack.pop()!;
			let entries: string[] = [];
			try {
				entries = readdirSync(cur);
			} catch {
				continue;
			}
			for (const f of entries) {
				const abs = path.join(cur, f);
				if (f === "node_modules" || f === "_generated") continue;
				try {
					if (statSync(abs).isDirectory()) {
						stack.push(abs);
						continue;
					}
				} catch {
					continue;
				}
				if (!/\.(ts|js)$/.test(f)) continue;
				if (f.includes(".test.")) continue;
				let text = "";
				try {
					text = readFileSync(abs, "utf8");
				} catch {
					continue;
				}
				const m = text.match(
					/HOBO_[A-Z0-9_]*VERBS\s*=\s*\[([\s\S]*?)\]\s*as\s*const/,
				);
				if (!m) continue;
				for (const q of m[1]!.matchAll(/"([a-z][a-z0-9-]*)"/g)) {
					if (!found.includes(q[1]!)) found.push(q[1]!);
				}
			}
		}
		if (found.length) break;
	}
	return found;
}

function parseVerbsFromHelp(helpText: string): SurfaceCommand[] {
	const cmds: SurfaceCommand[] = [];
	const seen = new Set<string>();
	// Lines like: "  auth       Login to a Station"
	for (const line of helpText.split("\n")) {
		const m = line.match(/^\s{2}([a-z][a-z0-9-]{1,24})\s{2,}(\S.+)$/i);
		if (!m) continue;
		const id = m[1]!.toLowerCase();
		if (seen.has(id) || id === "usage" || id === "flags" || id === "env") continue;
		seen.add(id);
		cmds.push({
			id,
			argv: [id],
			kind: id === "help" ? "discoverability" : "verb",
			summary: m[2]!.trim().slice(0, 120),
		});
	}
	return cmds;
}

function detectInteractiveFromSources(packageDir: string): {
	interactive: boolean;
	notes: string[];
} {
	const notes: string[] = [];
	const candidates = [
		path.join(packageDir, "src/bin"),
		path.join(packageDir, "dist/bin"),
		path.join(packageDir, "bin"),
	];
	let interactive = false;
	for (const dir of candidates) {
		if (!existsSync(dir)) continue;
		try {
			for (const f of readdirSync(dir)) {
				if (!/\.(ts|js|mjs|cjs)$/.test(f)) continue;
				const text = readFileSync(path.join(dir, f), "utf8");
				if (
					/isTTY|title screen|launchPi|interactive|chatVerb|asciinema|splash/i.test(
						text,
					)
				) {
					interactive = true;
					notes.push(`interactive markers in ${path.join(dir, f)}`);
				}
			}
		} catch {
			/* ignore */
		}
	}
	const readme = path.join(packageDir, "README.md");
	if (existsSync(readme)) {
		const t = readFileSync(readme, "utf8");
		if (/bare.*TTY|interactive TTY|chat surface|Pi/i.test(t)) {
			interactive = true;
			notes.push("interactive markers in README");
		}
	}
	return { interactive, notes };
}

/**
 * Build a surface map for a project package directory.
 */
export function buildSurfaceMap(input: {
	project: ProjectRef;
	root?: string;
	/** Skip live probes (unit tests) */
	skipProbes?: boolean;
}): SurfaceMap {
	const root = input.root ?? repoRoot();
	const packageDir = path.join(root, input.project.path || ".");
	const pkg = readJsonSafe<{ name?: string; description?: string }>(
		path.join(packageDir, "package.json"),
	);
	const binaries = discoverPackageBins(packageDir, root);
	const primaryBin = binaries[0] ?? null;
	const { interactive, notes: iNotes } = detectInteractiveFromSources(packageDir);

	const commands: SurfaceCommand[] = [];
	const probes: SurfaceMap["probes"] = [];
	let helpCmd: string | null = null;

	// Static verb enum from source (works offline / skipProbes)
	const verbEnum = parseVerbEnumFromSources(packageDir);
	for (const id of verbEnum) {
		commands.push({
			id,
			argv: [id],
			kind: id === "help" ? "discoverability" : "verb",
		});
	}

	if (primaryBin && !input.skipProbes) {
		const binName = primaryBin.name;
		// Prefer built dist via node when path is .js; else pnpm exec
		const runHelp =
			primaryBin.binPath.endsWith(".js") && existsSync(primaryBin.binPath)
				? `node ${JSON.stringify(primaryBin.binPath)} help`
				: `pnpm --filter ${pkg?.name ?? binName} exec ${binName} help 2>/dev/null || ${binName} help`;
		const helpProbe = probeCommand(runHelp, packageDir);
		probes.push(helpProbe);
		helpCmd = `${binName} help`;
		const r = spawnSync("bash", ["-lc", runHelp], {
			cwd: packageDir,
			encoding: "utf8",
			timeout: 20_000,
			env: { ...process.env, CI: "1" },
			maxBuffer: 2 * 1024 * 1024,
		});
		const helpText = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
		for (const c of parseVerbsFromHelp(helpText)) {
			if (!commands.some((x) => x.id === c.id)) commands.push(c);
		}
	}

	if (primaryBin && commands.length === 0) {
		for (const id of ["help", "status", "auth", "config", "agent"]) {
			commands.push({
				id,
				argv: [id],
				kind: id === "help" ? "discoverability" : "verb",
			});
		}
	}
	if (primaryBin && !helpCmd) {
		helpCmd = `${primaryBin.name} help`;
	}

	const requiredJourneys = ["help-discoverability", "happy-critical-path", "failure-actionable"];
	if (primaryBin) requiredJourneys.unshift("default-entry-cold-start");
	if (interactive) requiredJourneys.push("in-session-discoverability");

	const interactiveSurfaces: SurfaceMap["interactiveSurfaces"] = interactive
		? [
				{
					id: "default-tty-chat",
					entry: "bare-tty",
					driver: "tui",
					slashCommands: ["/verbs", "/agent", "/config", "/help"].filter(Boolean),
				},
			]
		: [];

	return {
		schemaVersion: 1,
		projectId: input.project.id,
		scannedAt: new Date().toISOString(),
		productName: primaryBin?.name ?? pkg?.name ?? input.project.id,
		packageDir: input.project.path || ".",
		binaries,
		defaultEntry: primaryBin
			? {
					command: primaryBin.name,
					interactive,
					driver: interactive ? "tui" : "cli",
					notes: iNotes.join("; ") || "from package bin",
				}
			: null,
		nonInteractiveHelp: helpCmd
			? { command: `${primaryBin!.name} help`, driver: "cli" }
			: null,
		commands,
		interactiveSurfaces,
		requiredJourneys,
		probes,
	};
}

export function surfaceMapPath(project: ProjectRef, root = repoRoot()): string {
	const base =
		!project.path || project.path === "." || project.id === "root"
			? path.join(root, ".optimizexp")
			: path.join(root, project.path, ".optimizexp");
	return path.join(base, "surface-map.json");
}

export function writeSurfaceMap(map: SurfaceMap, project: ProjectRef, root = repoRoot()): string {
	const p = surfaceMapPath(project, root);
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(map, null, 2)}\n`, "utf8");
	return p;
}

export function readSurfaceMap(project: ProjectRef, root = repoRoot()): SurfaceMap | null {
	return readJsonSafe<SurfaceMap>(surfaceMapPath(project, root));
}

export function validateSurfaceMap(map: SurfaceMap): string[] {
	const problems: string[] = [];
	if (map.schemaVersion !== 1) problems.push("schemaVersion must be 1");
	if (!map.projectId) problems.push("projectId required");
	// Library packages / site without package.json bin are valid — no default CLI entry.
	if (map.binaries.length > 0 && !map.defaultEntry) {
		problems.push("defaultEntry required when binaries exist");
	}
	if (map.commands.length === 0 && map.binaries.length > 0) {
		problems.push("commands empty despite binaries");
	}
	if (
		map.defaultEntry?.interactive &&
		map.interactiveSurfaces.length === 0
	) {
		problems.push("interactive default without interactiveSurfaces");
	}
	if (!map.requiredJourneys.includes("default-entry-cold-start") && map.binaries.length) {
		problems.push("requiredJourneys missing default-entry-cold-start");
	}
	return problems;
}
