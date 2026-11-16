#!/usr/bin/env node
/**
 * OptimizeXP persona survey + experiment backlog helpers.
 *
 *   node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode template --run <id>
 *   node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode validate --path <file>
 *   node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode aggregate --run <id>
 *   node --import tsx .agents/skills/optimizexp/harness/survey.mts --mode rank-backlog --run <id> [--global]
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import {
	buildPositive,
	validatePositive,
	type PositiveScores,
} from "./lib/scorecard.mts";

const SURVEY_QUESTION_IDS = [
	"q_excitement",
	"q_ease",
	"q_optimal",
	"q_delight",
	"q_friction_feel",
	"q_one_change",
	"q_never",
	"q_recommend",
] as const;

const PROMPTS: Record<(typeof SURVEY_QUESTION_IDS)[number], string> = {
	q_excitement:
		"On a scale of 0–5, how excited are you to use this path again? Why?",
	q_ease:
		"On a scale of 0–5, how easy was the happy path? What still felt heavier than it should?",
	q_optimal:
		"On a scale of 0–5, how optimal does this feel vs how it should work? What is missing?",
	q_delight: "What, if anything, delighted you?",
	q_friction_feel:
		"Even if nothing broke, what felt annoying or dull?",
	q_one_change: "If you could demand one change next week, what is it?",
	q_never: "What should we never do on this path?",
	q_recommend: "Would you recommend this experience to a peer? (yes/mixed/no + why)",
};

type FeatureRequest = {
	id: string;
	title: string;
	problem: string;
	desiredOutcome: string;
	source: string;
	sourceAnswerIds?: string[];
	persona: string;
	featureIds?: string[];
	surfaces?: string[];
	impactOn: {
		excitement: number;
		easeOfUse: number;
		perceivedOptimality: number;
	};
	effortHint?: "S" | "M" | "L";
	priorityScore?: number;
	antiGoals?: string[];
	smallestExperiment?: string;
};

type SurveyResponse = {
	schemaVersion: number;
	kind: string;
	runId: string;
	persona: string;
	experiences?: string[];
	surfaces?: string[];
	featureIds?: string[];
	polledAt?: string;
	primaryPhaseStop?: string;
	answers: Array<{
		id: string;
		prompt?: string;
		score?: number;
		text?: string;
		recommend?: string;
	}>;
	positive: PositiveScores;
	featureRequests: FeatureRequest[];
	evidenceRefs?: string[];
};

type BacklogItem = {
	id: string;
	title: string;
	problem: string;
	desiredOutcome: string;
	hypothesis?: string;
	source: string;
	sourceRefs: string[];
	personas: string[];
	featureIds: string[];
	surfaces: string[];
	experiences: string[];
	impactOn: FeatureRequest["impactOn"];
	effort: "S" | "M" | "L";
	priorityScore: number;
	status: string;
	antiGoals: string[];
	smallestExperiment: string;
	createdAt: string;
	updatedAt: string;
	runId: string;
};

function repoRoot(): string {
	let dir = process.cwd();
	for (;;) {
		if (existsSync(path.join(dir, ".optimizexp"))) return dir;
		if (existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return process.cwd();
		dir = parent;
	}
}

function parseArgs(argv: string[]) {
	const out: Record<string, string | boolean> = { mode: "help" };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") out.mode = "help";
		else if (a === "--mode") out.mode = argv[++i] ?? "help";
		else if (a === "--run") out.run = argv[++i] ?? "";
		else if (a === "--path") out.path = argv[++i] ?? "";
		else if (a === "--global") out.global = "1";
		else if (a === "--personas") out.personas = argv[++i] ?? "";
		else if (!a.startsWith("-") && out.mode === "help") out.mode = a;
	}
	return out;
}

function help() {
	console.log(`optimizexp survey

Usage:
  survey.mts --mode template --run <id> [--personas a,b]
  survey.mts --mode validate --path <survey.json>
  survey.mts --mode aggregate --run <id>
  survey.mts --mode rank-backlog --run <id> [--global]

Persona survey + positive metrics + experiment backlog ranking.
See references/persona-survey.md and experiment-backlog.md.
`);
}

function isInt0to5(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
}

function slugify(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 48);
}

function validateSurvey(raw: unknown): string[] {
	const problems: string[] = [];
	if (!raw || typeof raw !== "object") return ["survey: not an object"];
	const s = raw as Partial<SurveyResponse>;
	if (s.schemaVersion !== 1) problems.push("schemaVersion must be 1");
	if (s.kind !== "persona-survey") problems.push("kind must be persona-survey");
	if (!s.runId) problems.push("runId required");
	if (!s.persona) problems.push("persona required");
	if (!Array.isArray(s.answers)) problems.push("answers must be array");
	else {
		const ids = new Set(s.answers.map((a) => a.id));
		for (const id of SURVEY_QUESTION_IDS) {
			if (!ids.has(id)) problems.push(`answers missing ${id}`);
		}
		for (const a of s.answers) {
			if (a.id === "q_excitement" || a.id === "q_ease" || a.id === "q_optimal") {
				if (!isInt0to5(a.score)) {
					problems.push(`${a.id}.score must be int 0-5`);
				}
			}
			if (a.id === "q_recommend" && a.recommend) {
				if (!["yes", "mixed", "no"].includes(a.recommend)) {
					problems.push("q_recommend.recommend must be yes|mixed|no");
				}
			}
		}
	}
	problems.push(...validatePositive(s.positive, "positive"));
	if (s.positive && Array.isArray(s.answers)) {
		const byId = Object.fromEntries(s.answers.map((a) => [a.id, a]));
		const map: [string, keyof PositiveScores][] = [
			["q_excitement", "excitement"],
			["q_ease", "easeOfUse"],
			["q_optimal", "perceivedOptimality"],
		];
		for (const [qid, key] of map) {
			const score = byId[qid]?.score;
			if (isInt0to5(score) && s.positive[key] !== score) {
				problems.push(`positive.${key} must match ${qid}.score (${score})`);
			}
		}
	}
	if (!Array.isArray(s.featureRequests)) {
		problems.push("featureRequests must be array");
	} else {
		const needsFr =
			(s.positive && s.positive.min <= 3) ||
			s.answers?.some(
				(a) => a.id === "q_one_change" && a.text && a.text.trim().length > 0,
			);
		if (needsFr && s.featureRequests.length === 0) {
			problems.push(
				"featureRequests must be non-empty when positive.min <= 3 or q_one_change is set",
			);
		}
		for (const fr of s.featureRequests) {
			if (!fr.id) problems.push("featureRequest.id required");
			if (!fr.title) problems.push(`featureRequest ${fr.id}: title required`);
			if (!fr.problem) problems.push(`featureRequest ${fr.id}: problem required`);
			if (!fr.desiredOutcome) {
				problems.push(`featureRequest ${fr.id}: desiredOutcome required`);
			}
			if (!fr.impactOn) problems.push(`featureRequest ${fr.id}: impactOn required`);
		}
	}
	return problems;
}

function modeTemplate(root: string, runId: string, personasCsv: string) {
	if (!runId) {
		console.error("--run required");
		process.exit(2);
	}
	const runDir = path.join(root, ".optimizexp", "runs", runId);
	const surveyDir = path.join(runDir, "survey");
	mkdirSync(surveyDir, { recursive: true });

	let personas = personasCsv
		? personasCsv.split(",").map((s) => s.trim()).filter(Boolean)
		: [];
	if (personas.length === 0) {
		const scopePath = path.join(runDir, "scope.json");
		if (existsSync(scopePath)) {
			const scope = JSON.parse(readFileSync(scopePath, "utf8")) as {
				personas?: string[];
			};
			personas = scope.personas ?? [];
		}
	}
	if (personas.length === 0) {
		const pdir = path.join(root, ".optimizexp", "personas");
		if (existsSync(pdir)) {
			personas = readdirSync(pdir)
				.filter((f) => f.endsWith(".md"))
				.map((f) => f.replace(/\.md$/, ""))
				.slice(0, 5);
		}
	}

	const written: string[] = [];
	for (const persona of personas) {
		const answers = SURVEY_QUESTION_IDS.map((id) => ({
			id,
			prompt: PROMPTS[id],
			score: id === "q_excitement" || id === "q_ease" || id === "q_optimal" ? 3 : undefined,
			text: "(agent: fill first-person as persona from evidence)",
			recommend: id === "q_recommend" ? "mixed" : undefined,
		}));
		const positive = buildPositive(3, 3, 3);
		const body: SurveyResponse = {
			schemaVersion: 1,
			kind: "persona-survey",
			runId,
			persona,
			polledAt: new Date().toISOString(),
			answers,
			positive,
			featureRequests: [
				{
					id: `fr-${slugify(persona)}-one-change`,
					title: "(agent: derive from q_one_change)",
					problem: "(agent)",
					desiredOutcome: "(agent)",
					source: "survey",
					sourceAnswerIds: ["q_one_change"],
					persona,
					impactOn: { excitement: 1, easeOfUse: 1, perceivedOptimality: 1 },
					effortHint: "S",
					smallestExperiment: "(agent: one file-level change)",
				},
			],
			evidenceRefs: [],
		};
		const out = path.join(surveyDir, `${persona}.json`);
		writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`);
		written.push(out);
	}

	const instrument = {
		schemaVersion: 1,
		questions: SURVEY_QUESTION_IDS.map((id) => ({ id, prompt: PROMPTS[id] })),
		notes: "Fill templates with persona-voice answers; then aggregate + rank-backlog.",
	};
	writeFileSync(
		path.join(surveyDir, "_instrument.json"),
		`${JSON.stringify(instrument, null, 2)}\n`,
	);

	console.log(
		JSON.stringify(
			{ ok: true, runId, surveyDir, written, count: written.length },
			null,
			2,
		),
	);
}

function modeValidate(filePath: string) {
	if (!filePath || !existsSync(filePath)) {
		console.error("--path required and must exist");
		process.exit(2);
	}
	const raw = JSON.parse(readFileSync(filePath, "utf8"));
	const problems = validateSurvey(raw);
	const ok = problems.length === 0;
	console.log(JSON.stringify({ ok, path: filePath, problems }, null, 2));
	if (!ok) process.exitCode = 1;
}

function loadSurveys(root: string, runId: string): SurveyResponse[] {
	const dir = path.join(root, ".optimizexp", "runs", runId, "survey");
	if (!existsSync(dir)) return [];
	const out: SurveyResponse[] = [];
	for (const f of readdirSync(dir).filter(
		(x) => x.endsWith(".json") && !x.startsWith("_"),
	)) {
		try {
			const body = JSON.parse(
				readFileSync(path.join(dir, f), "utf8"),
			) as SurveyResponse;
			if (body.kind === "persona-survey") out.push(body);
		} catch {
			/* skip */
		}
	}
	return out;
}

function modeAggregate(root: string, runId: string) {
	if (!runId) {
		console.error("--run required");
		process.exit(2);
	}
	const surveys = loadSurveys(root, runId);
	const problems: string[] = [];
	for (const s of surveys) {
		problems.push(
			...validateSurvey(s).map((p) => `${s.persona}: ${p}`),
		);
	}
	const featureRequests: FeatureRequest[] = [];
	let delight_total = 0;
	let delight_min = 5;
	let gap_max = 0;
	let n = 0;
	for (const s of surveys) {
		n += 1;
		delight_total += s.positive.total;
		delight_min = Math.min(delight_min, s.positive.min);
		gap_max = Math.max(gap_max, s.positive.gapMax);
		for (const fr of s.featureRequests ?? []) {
			featureRequests.push(fr);
		}
	}
	const aggregate = {
		schemaVersion: 1,
		runId,
		personaCount: surveys.length,
		delight_total,
		delight_min: surveys.length ? delight_min : 0,
		delight_mean: surveys.length ? delight_total / (surveys.length * 3) : 0,
		gap_max,
		featureRequestCount: featureRequests.length,
		featureRequests,
		problems,
		aggregatedAt: new Date().toISOString(),
	};
	const outDir = path.join(root, ".optimizexp", "runs", runId, "survey");
	mkdirSync(outDir, { recursive: true });
	const outPath = path.join(outDir, "aggregate.json");
	writeFileSync(outPath, `${JSON.stringify(aggregate, null, 2)}\n`);
	console.log(
		JSON.stringify(
			{
				ok: problems.length === 0,
				path: outPath,
				personaCount: surveys.length,
				featureRequestCount: featureRequests.length,
				delight_min: aggregate.delight_min,
				gap_max,
				problems,
			},
			null,
			2,
		),
	);
	if (problems.length) process.exitCode = 1;
}

function effortBonus(e: "S" | "M" | "L"): number {
	if (e === "S") return 15;
	if (e === "M") return 5;
	return -20;
}

function priorityScore(
	fr: FeatureRequest,
	personaCount: number,
	minPositive: number,
): number {
	const impact =
		(fr.impactOn?.excitement ?? 0) +
		(fr.impactOn?.easeOfUse ?? 0) +
		(fr.impactOn?.perceivedOptimality ?? 0);
	const effort = fr.effortHint ?? "M";
	return (
		10 * impact +
		5 * (5 - minPositive) +
		effortBonus(effort) +
		3 * Math.max(0, personaCount - 1)
	);
}

function modeRankBacklog(root: string, runId: string, global: boolean) {
	if (!runId) {
		console.error("--run required");
		process.exit(2);
	}
	const surveys = loadSurveys(root, runId);
	const now = new Date().toISOString();
	const byId = new Map<string, BacklogItem>();

	for (const s of surveys) {
		const minPos = s.positive?.min ?? 3;
		for (const fr of s.featureRequests ?? []) {
			const effort = fr.effortHint ?? "M";
			const score = priorityScore(fr, 1, minPos);
			const existing = byId.get(fr.id);
			const item: BacklogItem = {
				id: fr.id,
				title: fr.title,
				problem: fr.problem,
				desiredOutcome: fr.desiredOutcome,
				hypothesis: `If we deliver "${fr.desiredOutcome}", positive metrics rise on ${s.surfaces?.join(", ") || "target surfaces"}.`,
				source: fr.source || "survey",
				sourceRefs: [
					`.optimizexp/runs/${runId}/survey/${s.persona}.json`,
				],
				personas: [s.persona],
				featureIds: fr.featureIds ?? s.featureIds ?? [],
				surfaces: fr.surfaces ?? s.surfaces ?? [],
				experiences: s.experiences ?? [],
				impactOn: fr.impactOn,
				effort,
				priorityScore: score,
				status: "ready",
				antiGoals: fr.antiGoals ?? [],
				smallestExperiment:
					fr.smallestExperiment ||
					`Smallest safe change for: ${fr.title}`,
				createdAt: now,
				updatedAt: now,
				runId,
			};
			if (existing) {
				existing.personas = [
					...new Set([...existing.personas, ...item.personas]),
				];
				existing.featureIds = [
					...new Set([...existing.featureIds, ...item.featureIds]),
				];
				existing.surfaces = [
					...new Set([...existing.surfaces, ...item.surfaces]),
				];
				existing.sourceRefs = [
					...new Set([...existing.sourceRefs, ...item.sourceRefs]),
				];
				existing.priorityScore = priorityScore(
					fr,
					existing.personas.length,
					minPos,
				);
				existing.updatedAt = now;
				byId.set(fr.id, existing);
			} else {
				byId.set(fr.id, item);
			}
		}
	}

	const items = [...byId.values()].sort((a, b) => {
		if (b.priorityScore !== a.priorityScore) {
			return b.priorityScore - a.priorityScore;
		}
		const order = { S: 0, M: 1, L: 2 };
		if (order[a.effort] !== order[b.effort]) {
			return order[a.effort] - order[b.effort];
		}
		return a.id.localeCompare(b.id);
	});

	const runBacklog = {
		schemaVersion: 1,
		runId,
		rankedAt: now,
		implementableUpliftRemaining: items.filter(
			(i) => i.status === "ready" && (i.effort === "S" || i.effort === "M"),
		).length,
		items,
	};
	const runDir = path.join(root, ".optimizexp", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	const runPath = path.join(runDir, "backlog.json");
	writeFileSync(runPath, `${JSON.stringify(runBacklog, null, 2)}\n`);

	let globalPath: string | null = null;
	if (global) {
		const gdir = path.join(root, ".optimizexp", "backlog");
		mkdirSync(gdir, { recursive: true });
		globalPath = path.join(gdir, "experiments.json");
		let existing: { items?: BacklogItem[] } = { items: [] };
		if (existsSync(globalPath)) {
			try {
				existing = JSON.parse(readFileSync(globalPath, "utf8")) as {
					items?: BacklogItem[];
				};
			} catch {
				existing = { items: [] };
			}
		}
		const gmap = new Map<string, BacklogItem>();
		for (const it of existing.items ?? []) {
			if (it.status === "done" || it.status === "wontfix") {
				gmap.set(it.id, it);
			} else {
				gmap.set(it.id, it);
			}
		}
		for (const it of items) {
			const prev = gmap.get(it.id);
			if (!prev) {
				gmap.set(it.id, it);
			} else if (prev.status === "done" || prev.status === "wontfix") {
				// keep terminal
			} else if (it.priorityScore >= prev.priorityScore) {
				gmap.set(it.id, {
					...it,
					personas: [...new Set([...prev.personas, ...it.personas])],
					featureIds: [...new Set([...prev.featureIds, ...it.featureIds])],
					createdAt: prev.createdAt,
				});
			}
		}
		const gitems = [...gmap.values()]
			.sort((a, b) => b.priorityScore - a.priorityScore)
			.slice(0, 200);
		writeFileSync(
			globalPath,
			`${JSON.stringify(
				{
					schemaVersion: 1,
					updatedAt: now,
					itemCount: gitems.length,
					items: gitems,
				},
				null,
				2,
			)}\n`,
		);
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				runPath,
				globalPath,
				itemCount: items.length,
				implementableUpliftRemaining:
					runBacklog.implementableUpliftRemaining,
				top: items.slice(0, 5).map((i) => ({
					id: i.id,
					priorityScore: i.priorityScore,
					effort: i.effort,
					title: i.title,
				})),
			},
			null,
			2,
		),
	);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const root = repoRoot();
	const mode = String(args.mode || "help");
	if (mode === "help") {
		help();
		return;
	}
	if (mode === "template") {
		modeTemplate(root, String(args.run || ""), String(args.personas || ""));
		return;
	}
	if (mode === "validate") {
		modeValidate(String(args.path || ""));
		return;
	}
	if (mode === "aggregate") {
		modeAggregate(root, String(args.run || ""));
		return;
	}
	if (mode === "rank-backlog") {
		modeRankBacklog(root, String(args.run || ""), Boolean(args.global));
		return;
	}
	console.error(`unknown mode: ${mode}`);
	help();
	process.exit(2);
}

main();
