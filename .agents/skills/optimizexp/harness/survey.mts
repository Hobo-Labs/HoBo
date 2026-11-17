#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";
import {
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
  survey.mts --mode validate --path <survey.json>

Validate existing survey evidence.
`);
}

function isInt0to5(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 5;
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

function main() {
	const args = parseArgs(process.argv.slice(2));
	const mode = String(args.mode || "help");
	if (mode === "help") {
		help();
		return;
	}
	if (mode === "validate") {
		modeValidate(String(args.path || ""));
		return;
	}
	console.error(`unknown mode: ${mode}`);
	help();
	process.exit(2);
}

main();
