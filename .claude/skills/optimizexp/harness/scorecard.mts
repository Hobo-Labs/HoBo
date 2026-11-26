#!/usr/bin/env node
/**
 * Validate / build / compare formal metric scorecards for bus entries.
 *
 * node --import tsx .agents/skills/optimizexp/harness/scorecard.mts --help
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
	makeComparison,
	makeScorecard,
	validateComparison,
	validateScorecard,
	type MetricScorecard,
	type PrimaryScores,
} from "./lib/scorecard.mts";

function parseArgs(argv: string[]) {
	const out: Record<string, string> = { mode: "help" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") out.mode = "help";
		else if (a === "--mode") out.mode = argv[++i] ?? "help";
		else if (a === "--entry") out.entry = argv[++i] ?? "";
		else if (a === "--expect") out.expect = argv[++i] ?? "";
		else if (a === "--act") out.act = argv[++i] ?? "";
		else if (a === "--outcome") out.outcome = argv[++i] ?? "";
		else if (a === "--out") out.out = argv[++i] ?? "";
		else if (a === "--phase") out.phase = argv[++i] ?? "";
		else if (a === "--persona") out.persona = argv[++i] ?? "";
		else if (a === "--surface") out.surface = argv[++i] ?? "";
		else if (a === "--harms") out.harms = argv[++i] ?? "0";
		else if (a === "--friction") out.friction = argv[++i] ?? "0";
		else if (a === "--uncertainty") out.uncertainty = argv[++i] ?? "0";
		else if (a === "--behavior-matched") out.behaviorMatched = argv[++i] ?? "false";
		else if (a === "--expect-id") out.expectId = argv[++i] ?? "";
		else if (a === "--act-id") out.actId = argv[++i] ?? "";
		else if (a === "--tolerance") out.tolerance = argv[++i] ?? "0";
		else if (!a.startsWith("-") && out.mode === "help") out.mode = a;
	}
	return out;
}

function help() {
	console.log(`optimizexp scorecard

  --mode validate --entry <bus-entry.json>
  --mode build --phase expect|act|outcome --persona p --surface s \\
      --harms N --friction N --uncertainty N [--out file]
  --mode compare --expect e.json --act a.json --outcome o.json
      (or build comparison from score fields with --expect-id …)

Formal scores (harms/friction/uncertainty + optional HCD) are required on every
expect, act, and outcome bus entry. See references/metric-scorecard.md.
`);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

function entryScores(entry: unknown): MetricScorecard | null {
	if (!entry || typeof entry !== "object") return null;
	const s = (entry as { scores?: unknown }).scores;
	return s && typeof s === "object" ? (s as MetricScorecard) : null;
}

function validateEntry(path: string) {
	const entry = readJson(path) as {
		kind?: string;
		scores?: unknown;
		comparison?: unknown;
		expects?: string;
	};
	const problems: string[] = [];
	if (!entry.kind || !["expect", "act", "outcome"].includes(entry.kind)) {
		problems.push("kind must be expect|act|outcome");
	}
	problems.push(
		...validateScorecard(
			entry.scores,
			entry.kind as "expect" | "act" | "outcome" | undefined,
		),
	);
	if (entry.kind === "outcome") {
		if (!entry.expects) problems.push("outcome.expects required");
		const scores = entryScores(entry);
		problems.push(
			...validateComparison(
				entry.comparison,
				undefined,
				undefined,
				scores?.primary,
			),
		);
	}
	const ok = problems.length === 0;
	console.log(JSON.stringify({ ok, path, problems }, null, 2));
	if (!ok) process.exitCode = 1;
}

function build(args: Record<string, string>) {
	const phase = args.phase as "expect" | "act" | "outcome";
	if (!["expect", "act", "outcome"].includes(phase)) {
		console.error("--phase expect|act|outcome required");
		process.exit(2);
	}
	const card = makeScorecard({
		phase,
		persona: args.persona || "developer",
		surface: args.surface || "unknown",
		harms: Number(args.harms || 0),
		friction: Number(args.friction || 0),
		uncertainty: Number(args.uncertainty || 0),
		rationale: {
			harms: Number(args.harms || 0) >= 1 ? "See agent judgment." : "None predicted/observed.",
			friction:
				Number(args.friction || 0) >= 1 ? "See agent judgment." : "None predicted/observed.",
			uncertainty:
				Number(args.uncertainty || 0) >= 1
					? "See agent judgment."
					: "None predicted/observed.",
		},
		evidenceRefs: phase === "expect" ? [] : ["(set by agent)"],
	});
	const problems = validateScorecard(card, phase);
	if (problems.length) {
		console.error(JSON.stringify({ ok: false, problems }, null, 2));
		process.exit(1);
	}
	const text = `${JSON.stringify(card, null, 2)}\n`;
	if (args.out) writeFileSync(args.out, text, "utf8");
	console.log(text);
}

function compare(args: Record<string, string>) {
	if (!args.expect || !args.outcome) {
		console.error("--expect and --outcome required");
		process.exit(2);
	}
	const expectEntry = readJson(args.expect) as {
		id?: string;
		scores?: MetricScorecard;
	};
	const outcomeEntry = readJson(args.outcome) as {
		scores?: MetricScorecard;
		comparison?: unknown;
		expects?: string;
	};
	const actEntry = args.act
		? (readJson(args.act) as { id?: string; scores?: MetricScorecard })
		: null;

	const ep = expectEntry.scores?.primary as PrimaryScores | undefined;
	const ap = actEntry?.scores?.primary as PrimaryScores | undefined;
	const jp = outcomeEntry.scores?.primary as PrimaryScores | undefined;
	if (!ep || !jp) {
		console.error("expect and outcome must include scores.primary");
		process.exit(1);
	}

	const problems = [
		...validateScorecard(expectEntry.scores, "expect"),
		...(actEntry ? validateScorecard(actEntry.scores, "act") : []),
		...validateScorecard(outcomeEntry.scores, "outcome"),
	];

	const built = makeComparison({
		expectId: expectEntry.id || args.expectId || "unknown",
		actId: actEntry?.id,
		expectPrimary: ep,
		actPrimary: ap,
		judgedPrimary: jp,
		behaviorMatched: (args.behaviorMatched || "false") === "true",
		tolerance: Number(args.tolerance || 0),
	});

	if (outcomeEntry.comparison) {
		problems.push(...validateComparison(outcomeEntry.comparison, ep, ap, jp));
	}

	console.log(
		JSON.stringify(
			{
				ok: problems.length === 0,
				problems,
				builtComparison: built,
				existingComparison: outcomeEntry.comparison ?? null,
			},
			null,
			2,
		),
	);
	if (problems.length) process.exitCode = 1;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "help") return help();
	if (args.mode === "validate") {
		if (!args.entry || !existsSync(args.entry)) {
			console.error("--entry path required");
			process.exit(2);
		}
		return validateEntry(args.entry);
	}
	if (args.mode === "build") return build(args);
	if (args.mode === "compare") return compare(args);
	help();
	process.exit(2);
}

main();
