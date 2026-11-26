/**
 * Where the release gate finds ai-bdd and the project it checks (ADR-0172),
 * from the check's environment:
 *
 * - HOBO_AI_BDD_CMD: the ai-bdd argv as JSON, default ["ai-bdd"];
 * - HOBO_AI_BDD_PROJECT: the project directory (the working directory of
 *   every ai-bdd command), relative to the gate's working directory;
 * - HOBO_AI_BDD_RUNS_DIR: the project's `runsDir`, relative to the project,
 *   default `.ai-bdd/runs` (ai-bdd's default). ai-bdd writes the latest report
 *   to join(dirname(runsDir), "report"), so the report path follows from it.
 *   The gate cannot read a .ts/.mjs/.js ai-bdd config without running project
 *   code, so a project that moves `runsDir` must name it here; one that does
 *   not fails the replay on freshness rather than read another directory;
 * - HOBO_AI_BDD_TIMEOUT_MS: how long one ai-bdd command may run, default 30
 *   minutes; one that outlives it is killed with its process group and the
 *   check is not run. A value that is not a whole number of milliseconds from
 *   1 to 24 hours is a usage error.
 */
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { isJsonArray, isJsonString, parseJsonText } from "./json.js";

export interface AcceptanceConfig {
	readonly command: readonly string[];
	readonly project: string;
	/** The environment ai-bdd runs with: the one the check was given. */
	readonly env: NodeJS.ProcessEnv;
	/** Absolute: the project's runs directory, one directory per run id. */
	readonly runsDir: string;
	/** Absolute: join(dirname(runsDir), "report", "report.json"), where ai-bdd writes the latest report. */
	readonly reportFile: string;
	/** How long one ai-bdd command may run. */
	readonly timeoutMs: number;
}

/** 30 minutes. */
export const DEFAULT_AI_BDD_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_AI_BDD_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** HOBO_AI_BDD_TIMEOUT_MS as milliseconds, the default when unset, undefined when it is not usable. */
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

/** HOBO_AI_BDD_CMD (a JSON argv, default ["ai-bdd"]) and HOBO_AI_BDD_PROJECT (a directory, relative to `cwd`). */
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
