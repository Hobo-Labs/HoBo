import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isJsonArray, isJsonString, parseJsonText } from "./json.js";

export interface AcceptanceConfig {
	readonly command: readonly string[];
	readonly project: string;
	readonly env: NodeJS.ProcessEnv;
	readonly runsDir: string;
	readonly reportFile: string;
	readonly timeoutMs: number;
}

export const DEFAULT_AI_BDD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_AI_BDD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function aiBddTimeoutMsOf(env: NodeJS.ProcessEnv): number | undefined {
	const raw = env.HOBO_AI_BDD_TIMEOUT_MS;
	if (raw === undefined) return DEFAULT_AI_BDD_TIMEOUT_MS;
	if (!/^[1-9][0-9]{0,8}$/u.test(raw)) return undefined;
	const ms = Number(raw);
	return ms <= MAX_AI_BDD_TIMEOUT_MS ? ms : undefined;
}

function commandOf(raw: string | undefined): readonly string[] | undefined {
	if (raw === undefined) return ["ai-bdd"];
	const parsed = parseJsonText(raw);
	if (!isJsonArray(parsed) || parsed.length === 0) return undefined;
	const words = parsed.filter((word) => isJsonString(word) && word !== "");
	return words.length === parsed.length ? words.map(String) : undefined;
}

export function acceptanceConfigOf(
	env: NodeJS.ProcessEnv,
	cwd: string,
): AcceptanceConfig | string {
	const command = commandOf(env.HOBO_AI_BDD_CMD);
	if (command === undefined) {
		return 'HOBO_AI_BDD_CMD must be a JSON array of non-empty strings, for example ["ai-bdd"]';
	}
	const projectRaw = env.HOBO_AI_BDD_PROJECT ?? "";
	if (projectRaw === "") {
		return "HOBO_AI_BDD_PROJECT is not set: name the ai-bdd project directory";
	}
	const project = resolve(cwd, projectRaw);
	const isDirectory = statSync(project, {
		throwIfNoEntry: false,
	})?.isDirectory();
	if (isDirectory !== true) {
		return `HOBO_AI_BDD_PROJECT ${project} is not a directory`;
	}
	const runsRaw = env.HOBO_AI_BDD_RUNS_DIR ?? ".ai-bdd/runs";
	if (runsRaw === "") {
		return "HOBO_AI_BDD_RUNS_DIR is empty: name the project's runsDir, or leave it unset for .ai-bdd/runs";
	}
	const runsDir = resolve(project, runsRaw);
	const reportFile = join(dirname(runsDir), "report", "report.json");
	const timeoutMs = aiBddTimeoutMsOf(env);
	if (timeoutMs === undefined) {
		return `HOBO_AI_BDD_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${MAX_AI_BDD_TIMEOUT_MS} (unset: ${DEFAULT_AI_BDD_TIMEOUT_MS}, 30 minutes)`;
	}
	return { command, project, env, runsDir, reportFile, timeoutMs };
}
