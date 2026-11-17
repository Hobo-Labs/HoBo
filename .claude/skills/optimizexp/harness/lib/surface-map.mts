/**
 * Surface-map types + builders for OptimizeXP app exploration.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { repoRoot } from "./paths.mts";
import type { ProjectRef } from "./projects.mts";
import { assertSafeOptimizexpWriteScopes } from "./write-containment.mts";

export type SurfaceDriver = "cli" | "tui" | "web" | "native";

export type SurfaceCommand = {
	id: string;
	argv: string[];
	kind: string;
	summary?: string;
};

/** Applicability is limited to the package.json bin field, not other surfaces. */
export type CliAssessment = {
	status: "present" | "not-applicable" | "unverified";
	scope: "package.json bin";
	evidence: string;
};

export type SurfaceMap = {
	schemaVersion: 1;
	projectId: string;
	scannedAt: string;
	productName: string;
	packageDir: string;
	cliAssessment?: CliAssessment;
	binaries: {
		name: string;
		binPath: string;
		packageName?: string;
	}[];
	binAssessments?: { name: string; status: "observed-help" | "unverified"; evidence: string }[];
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
		binName?: string;
		kind?: "help";
		executableDigest?: string;
	}[];
};

function digestText(s: string): string {
	return createHash("sha256").update(s.slice(0, 8000)).digest("hex").slice(0, 16);
}

/** Bind generated catalogs to the complete saved map, including observations. */
export function surfaceMapDigest(map: SurfaceMap): string {
	return createHash("sha256").update(JSON.stringify(map)).digest("hex");
}

function executableDigest(file: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

/** Validate saved executable bytes and the operator's scoped freshness assertion. */
export function validateCurrentSurface(map: SurfaceMap, root: string, options?: {
	confirmedSurfaces?: string[];
	freshProbe?: boolean;
}): string[] {
	if (map.cliAssessment?.status !== "present" || map.binaries.length === 0) return [];
	const primary = map.binaries[0]!;
	const probe = map.probes.find((item) => item.binName === primary.name && item.kind === "help" && item.exitCode === 0);
	if (!probe?.executableDigest || !/^[a-f0-9]{64}$/.test(probe.executableDigest)) {
		return [`binary ${primary.name} observation is unverified: no executable digest`];
	}
	if (executableDigest(path.resolve(root, primary.binPath)) !== probe.executableDigest) {
		return [`binary ${primary.name} observation is stale: executable changed or is unreadable`];
	}
	const assertion = `${map.projectId}:${surfaceMapDigest(map)}`;
	if (options?.freshProbe !== true && !options?.confirmedSurfaces?.includes(assertion)) {
		return [`surface observation is unverified: independently confirm imports, configuration, and environment, then pass --confirm-surface-current=${assertion}`];
	}
	return [];
}

function readJsonSafe<T>(p: string): T | null {
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
}

function inspectPackageBins(
	packageDir: string,
	root: string,
): { assessment: CliAssessment; binaries: SurfaceMap["binaries"] } {
	const pkgPath = path.join(packageDir, "package.json");
	const pkg = readJsonSafe<{
		name?: string;
		bin?: unknown;
	}>(pkgPath);
	const evidencePath = path.relative(root, pkgPath).split(path.sep).join("/");
	const result = (status: CliAssessment["status"], detail: string) => ({
		assessment: {
			status,
			scope: "package.json bin" as const,
			evidence: `${evidencePath}: ${detail}`,
		},
		binaries: [],
	});
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
		return result("unverified", "manifest missing or invalid");
	}
	if (!Object.hasOwn(pkg, "bin")) {
		return result("not-applicable", "no package bin is declared");
	}
	const binField = pkg.bin;
	let entries: [string, string][];
	if (typeof binField === "string" && binField.trim()) {
		const binName = typeof pkg.name === "string" && pkg.name.trim()
			? pkg.name.split("/").at(-1)
			: undefined;
		if (!binName) return result("unverified", "string bin requires a package name");
		entries = [[binName, binField]];
	} else if (
		binField &&
		typeof binField === "object" &&
		!Array.isArray(binField)
	) {
		const raw = Object.entries(binField);
		if (raw.length === 0)
			return result("not-applicable", "package bin is empty");
		entries = [];
		for (const [name, value] of raw) {
			if (!name.trim() || typeof value !== "string" || !value.trim()) {
				return result("unverified", "package bin entries are malformed");
			}
			entries.push([name, value]);
		}
	} else {
		return result("unverified", "package bin is malformed");
	}
	const out: SurfaceMap["binaries"] = [];
	for (const [name, rel] of entries) {
		const abs = path.resolve(packageDir, rel);
		out.push({
			name,
			binPath: path.relative(root, abs).split(path.sep).join("/"),
			packageName: typeof pkg.name === "string" ? pkg.name : undefined,
		});
	}
	return {
		assessment: {
			status: "present",
			scope: "package.json bin",
			evidence: `${evidencePath}: declares ${entries.map(([name, rel]) => `${name}=${rel}`).join(", ")}`,
		},
		binaries: out,
	};
}

export function assessPackageCli(
	packageDir: string,
	root: string,
): CliAssessment {
	return inspectPackageBins(packageDir, root).assessment;
}

/** Prefer the project's declared package binaries over the monorepo root. */
export function discoverPackageBins(
	packageDir: string,
	root: string,
): SurfaceMap["binaries"] {
	return inspectPackageBins(packageDir, root).binaries;
}

function probeCommand(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs = 20_000,
): { probe: SurfaceMap["probes"][0]; stdout: string } {
	const r = spawnSync(command, args, {
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
		probe: {
			command: [command, ...args].map((arg) => JSON.stringify(arg)).join(" "),
			exitCode: r.status,
			stdoutDigest: digestText(combined),
			capturedAt: new Date().toISOString(),
			notes: r.error ? String(r.error.message) : undefined,
		},
		stdout: r.stdout ?? "",
	};
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

function detectInteractiveFromSources(packageDir: string, primaryBin: string): {
	interactive: boolean;
	notes: string[];
} {
	const notes: string[] = [];
	const relativeBin = path.relative(packageDir, primaryBin);
	const sourceBin = path.join(packageDir, relativeBin.replace(/^dist[/\\]/, "src/").replace(/\.[cm]?js$/, ".ts"));
	const candidates = new Set([primaryBin, sourceBin]);
	let interactive = false;
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		try {
			const text = readFileSync(file, "utf8");
			if (/title screen|launchPi|chatVerb|interactive\s+(?:TTY|session|shell)/i.test(text)) {
				interactive = true;
				notes.push(`interactive markers in ${path.relative(packageDir, file)}`);
			}
		} catch {
			/* ignore */
		}
	}
	const readme = path.join(packageDir, "README.md");
	if (existsSync(readme)) {
		const t = readFileSync(readme, "utf8");
		const positiveDefault = t.split("\n").some((line) =>
			!/\b(?:not|no|never)\b/i.test(line) &&
			/\b(?:default|bare)\b[^\n]{0,100}\b(?:TTY|chat surface)\b|\binteractive\s+TTY\b[^\n]{0,60}\bby default\b/i.test(line),
		);
		if (positiveDefault) {
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
	/** Execute the primary binary with --help; runs trusted project code with inherited environment. */
	probeBinary?: boolean;
	/** Explicitly disable probing, including when requested. */
	skipProbes?: boolean;
}): SurfaceMap {
	const root = input.root ?? repoRoot();
	const packageDir = path.join(root, input.project.path || ".");
	const pkg = readJsonSafe<{ name?: string; description?: string }>(
		path.join(packageDir, "package.json"),
	);
	const { assessment: cliAssessment, binaries } = inspectPackageBins(packageDir, root);
	const primaryBin = binaries[0] ?? null;
	const detection = primaryBin ? detectInteractiveFromSources(packageDir, path.resolve(root, primaryBin.binPath)) : { interactive: false, notes: [] };
	const { interactive, notes: iNotes } = detection;

	const commands: SurfaceCommand[] = [];
	const probes: SurfaceMap["probes"] = [];
	let helpCmd: string | null = null;

	const binAssessments: NonNullable<SurfaceMap["binAssessments"]> = binaries.map((bin, index) => ({
		name: bin.name,
		status: "unverified",
		evidence: index === 0 ? "primary binary help was not observed" : "additional binary was not assessed; it may use a non-CLI protocol",
	}));

	if (primaryBin && input.probeBinary === true && !input.skipProbes) {
		const binName = primaryBin.name;
		const absoluteBin = path.resolve(root, primaryBin.binPath);
		if (!existsSync(absoluteBin)) {
			probes.push({
				command: `${binName} --help`,
				exitCode: null,
				stdoutDigest: digestText(""),
				capturedAt: new Date().toISOString(),
				notes: "declared binary is not built; no PATH fallback was run",
			});
		} else {
			const isNodeScript = /\.[cm]?[jt]s$/.test(absoluteBin);
			const command = isNodeScript ? process.execPath : absoluteBin;
			const args = isNodeScript ? [absoluteBin, "--help"] : ["--help"];
			const before = executableDigest(absoluteBin);
			const { probe, stdout } = probeCommand(command, args, packageDir);
			const after = executableDigest(absoluteBin);
			probe.binName = binName;
			probe.kind = "help";
			if (before && before === after) probe.executableDigest = before;
			else probe.notes = "executable changed or was unreadable during the probe";
			probes.push(probe);
			if (probe.exitCode === 0 && probe.executableDigest) {
				binAssessments[0] = { name: binName, status: "observed-help", evidence: "successful explicit --help probe with unchanged executable bytes" };
				helpCmd = `${binName} --help`;
				for (const c of parseVerbsFromHelp(stdout)) {
					if (!commands.some((x) => x.id === c.id)) commands.push(c);
				}
			}
		}
	}

	const requiredJourneys = ["happy-critical-path"];
	if (helpCmd) requiredJourneys.unshift("help-discoverability");
	if (primaryBin)
		requiredJourneys.unshift("default-entry-cold-start", "failure-actionable");
	if (interactive) requiredJourneys.push("in-session-discoverability");

	const interactiveSurfaces: SurfaceMap["interactiveSurfaces"] = interactive
		? [
				{
					id: "default-tty-chat",
					entry: "bare-tty",
					driver: "tui",
					slashCommands: [],
				},
			]
		: [];

	return {
		schemaVersion: 1,
		projectId: input.project.id,
		scannedAt: new Date().toISOString(),
		productName: primaryBin?.name ?? pkg?.name ?? input.project.id,
		packageDir: input.project.path || ".",
		cliAssessment,
		binaries,
		binAssessments,
		defaultEntry: primaryBin
			? {
					command: primaryBin.name,
					interactive,
					driver: interactive ? "tui" : "cli",
					notes: iNotes.join("; ") || "from package bin",
				}
			: null,
		nonInteractiveHelp: helpCmd ? { command: helpCmd, driver: "cli" } : null,
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
	assertSafeOptimizexpWriteScopes(root, [project.path]);
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
	if (
		!map.cliAssessment ||
		map.cliAssessment.scope !== "package.json bin" ||
		typeof map.cliAssessment.evidence !== "string" ||
		!map.cliAssessment.evidence.trim() ||
		!["present", "not-applicable", "unverified"].includes(
			map.cliAssessment.status,
		)
	) {
		problems.push(
			"package-bin CLI applicability is unverified: no manifest assessment",
		);
	} else if (map.cliAssessment.status === "unverified") {
		problems.push(
			`package-bin CLI applicability is unverified: ${map.cliAssessment.evidence}`,
		);
	} else if (
		(map.cliAssessment.status === "present") !==
		map.binaries.length > 0
	) {
		problems.push("package-bin assessment conflicts with discovered binaries");
	}
	const assessments = Array.isArray(map.binAssessments) ? map.binAssessments : [];
	for (const [index, bin] of map.binaries.entries()) {
		if (index > 0) {
			problems.push(`binary ${bin.name} is unverified; secondary-bin journeys are not assessed`);
			continue;
		}
		const matches = assessments.filter((assessment) => assessment.name === bin.name);
		if (matches.length !== 1 || matches[0]?.status !== "observed-help" ||
			!map.probes.some((probe) => probe.binName === bin.name && probe.kind === "help" && probe.exitCode === 0 && /^[a-f0-9]{64}$/.test(probe.executableDigest ?? ""))) {
			problems.push(`binary ${bin.name} is unverified; no matching successful help observation`);
		}
	}
	if (assessments.some((assessment) => !map.binaries.some((bin) => bin.name === assessment.name))) {
		problems.push("binary assessment names an undeclared bin");
	}
	// Library packages / site without package.json bin are valid — no default CLI entry.
	if (map.binaries.length > 0 && !map.defaultEntry) {
		problems.push("defaultEntry required when binaries exist");
	}
	if (map.commands.length === 0 && map.binaries.length > 0) {
		problems.push("commands empty despite binaries");
	}
	if (map.cliAssessment?.status === "present" && !map.nonInteractiveHelp) {
		problems.push("package CLI help is unverified");
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
