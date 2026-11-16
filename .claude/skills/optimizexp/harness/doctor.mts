#!/usr/bin/env node
/**
 * OptimizeXP doctor — audit + safe repair of optimizexp workspaces.
 *
 * node --import tsx .agents/skills/optimizexp/harness/doctor.mts --help
 * node --import tsx .agents/skills/optimizexp/harness/doctor.mts check --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/doctor.mts repair --project hobo
 * node --import tsx .agents/skills/optimizexp/harness/doctor.mts snapshot --project hobo
 */
import process from "node:process";
import { resolveProjects } from "./lib/projects.mts";
import { repoRoot } from "./lib/paths.mts";
import {
	runDoctorCheck,
	runDoctorRepair,
	runDoctorSnapshot,
} from "./lib/doctor.mts";

function parseArgs(argv: string[]) {
	const out: Record<string, string> = { mode: "check" };
	const projectTokens: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") out.help = "1";
		else if (a === "--mode") out.mode = argv[++i] ?? "check";
		else if (
			a === "check" ||
			a === "repair" ||
			a === "fix" ||
			a === "snapshot" ||
			a === "snap"
		) {
			out.mode = a === "fix" ? "repair" : a === "snap" ? "snapshot" : a;
		} else if (a === "--project" || a === "--projects") {
			const v = argv[++i] ?? "";
			if (v) projectTokens.push(v);
		} else if (a === "--all-projects") {
			projectTokens.push("all");
		} else if (a === "--json") out.json = "1";
		else if (a === "--out") out.out = argv[++i] ?? "";
		else if (a === "--only") out.only = argv[++i] ?? "";
		else if (a === "--shallow") out.shallow = "1";
	}
	if (projectTokens.length) out.projects = projectTokens.join(",");
	return out;
}

function help() {
	console.log(`optimizexp doctor — workspace health for OptimizeXP

Usage:
  doctor.mts [check|repair|snapshot] [options]

Modes:
  check      Audit only (default). Exit 1 if any error-severity findings.
  repair     Apply safe repairs (structure, config, gitignore, persona stubs,
             EXPERIENCE.md skeletons, surface-map + experience-catalog).
  snapshot   Write a safe metadata snapshot under .optimizexp/snapshots/
             (personas, feature.json, EXPERIENCE.md, catalogs — no large media).

Options:
  --project <id> | --projects a,b | --all-projects
  --json                 Machine-readable full report (default: summary + findings)
  --out <dir>            Snapshot output directory (snapshot mode)
  --only action,action   Limit repair actions (e.g. ensure-config,build-catalog)
  --shallow              Skip deep per-feature Gherkin/rubberduck scan

What doctor audits:
  · Repo structure (.optimizexp dirs, config.json, managed .gitignore, bus/runs)
  · Persona formalization (schemaVersion, experiences binding, v2 KYC sections)
  · Feature relevance/quality (template-only Gherkin ban, EXPERIENCE.md, discovery traps)
  · Surface-map + experience-catalog (default entry / interactive coverage)
  · Safe initial-state snapshots for workspaces

Does NOT:
  · Force-push, delete user WIP, or invent product capabilities
  · Call live third-party services
  · Mark optimizexp review complete (still need dual-regime loop)

Examples:
  node --import tsx .agents/skills/optimizexp/harness/doctor.mts check --project hobo
  node --import tsx .agents/skills/optimizexp/harness/doctor.mts repair --project hobo
  node --import tsx .agents/skills/optimizexp/harness/doctor.mts snapshot --project hobo --json
`);
}

function printHuman(report: {
	ok: boolean;
	mode: string;
	summary: { errors: number; warns: number; infos: number; repairable: number };
	findings: { severity: string; scope: string; message: string; id: string }[];
	repairsApplied: string[];
	snapshotPath?: string;
}) {
	const icon = report.ok ? "✓" : "✕";
	console.log(
		`${icon} optimizexp doctor ${report.mode} · errors=${report.summary.errors} warns=${report.summary.warns} infos=${report.summary.infos} repairable=${report.summary.repairable}`,
	);
	if (report.repairsApplied.length) {
		console.log(`  repairs: ${report.repairsApplied.join(", ")}`);
	}
	if (report.snapshotPath) {
		console.log(`  snapshot: ${report.snapshotPath}`);
	}
	const show = report.findings.filter((f) => f.severity !== "info").slice(0, 40);
	for (const f of show) {
		const mark = f.severity === "error" ? "E" : f.severity === "warn" ? "W" : "I";
		console.log(`  [${mark}] ${f.scope}: ${f.message}`);
	}
	if (report.findings.length > show.length) {
		console.log(`  … +${report.findings.length - show.length} more (use --json)`);
	}
	if (!report.ok) {
		console.log(
			"  next: doctor repair --project …   or fix findings, then re-check",
		);
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help === "1") {
		help();
		return;
	}
	const root = repoRoot();
	const selection = resolveProjects(args.projects || "all", root);
	const mode = args.mode || "check";

	let report;
	if (mode === "repair") {
		report = runDoctorRepair({
			root,
			selection,
			only: args.only ? args.only.split(/[,\s]+/).filter(Boolean) : undefined,
		});
	} else if (mode === "snapshot") {
		report = runDoctorSnapshot({
			root,
			selection,
			outDir: args.out || undefined,
		});
	} else {
		report = runDoctorCheck({
			root,
			selection,
			deepFeatures: args.shallow !== "1",
		});
	}

	if (args.json === "1") {
		console.log(JSON.stringify(report, null, 2));
	} else {
		printHuman(report);
	}
	process.exitCode = report.ok ? 0 : 1;
}

main();
