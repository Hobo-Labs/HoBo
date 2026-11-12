/**
 * Turn Turbo run summaries into an OpenTelemetry trace on disk (OTLP/JSON,
 * the same shape the OTel file exporter writes) so every CI job can upload
 * its own trace as an artifact. No collector, no paid backend.
 *
 * Usage: node --experimental-strip-types scripts/ci/ci-trace.mts <out-dir> [job-name]
 *
 * Reads `.turbo/runs/*.json` (written by `turbo run --summarize`), writes
 * `<out-dir>/otel-spans.json` and a redacted copy of each summary. On GitHub
 * the trace id is the workflow run's, shared with the relay's own spans. Only
 * timings, task ids, cache status and exit codes are kept; environment
 * variable lists, hashes, commands and user/SCM identity are dropped, and any
 * value of a secret-named environment variable is scrubbed from the output.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

// Node builtins only: the trace step runs on every job, including ones that
// skipped or failed `pnpm install`, so it cannot import workspace packages.

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

type TaskSummary = {
	readonly taskId: string;
	readonly package?: string | undefined;
	readonly task?: string | undefined;
	readonly cache?: { readonly status?: string | undefined } | undefined;
	readonly execution?:
		| {
				readonly startTime: number;
				readonly endTime: number;
				readonly exitCode?: number | null | undefined;
		  }
		| undefined;
};
type RunSummary = {
	readonly id?: string | undefined;
	readonly turboVersion?: string | undefined;
	readonly execution: {
		readonly command?: string | undefined;
		readonly startTime: number;
		readonly endTime: number;
		readonly exitCode?: number | undefined;
		readonly attempted?: number | undefined;
		readonly cached?: number | undefined;
		readonly failed?: number | undefined;
	};
	readonly tasks: readonly TaskSummary[];
};

const tag = (value: Json | undefined): string =>
	Object.prototype.toString.call(value);
function isObject(value: Json | undefined): value is JsonObject {
	return tag(value) === "[object Object]";
}
function isString(value: Json | undefined): value is string {
	return tag(value) === "[object String]";
}
function isNumber(value: Json | undefined): value is number {
	return Number.isFinite(value);
}
const text = (from: JsonObject, key: string): string | undefined => {
	const value = from[key];
	return isString(value) ? value : undefined;
};
const count = (from: JsonObject, key: string): number | undefined => {
	const value = from[key];
	return isNumber(value) ? value : undefined;
};
const child = (from: JsonObject, key: string): JsonObject | undefined => {
	const value = from[key];
	return isObject(value) ? value : undefined;
};

/** Keep only the fields the trace reads, so env lists, hashes, commands, user and SCM never reach the artifact. */
function parseTask(value: Json): TaskSummary | undefined {
	if (!isObject(value)) return undefined;
	const taskId = text(value, "taskId");
	if (taskId === undefined) return undefined;
	const cache = child(value, "cache");
	const execution = child(value, "execution");
	const startTime = execution && count(execution, "startTime");
	const endTime = execution && count(execution, "endTime");
	return {
		taskId,
		package: text(value, "package"),
		task: text(value, "task"),
		cache: cache && { status: text(cache, "status") },
		execution:
			execution && startTime !== undefined && endTime !== undefined
				? {
						startTime,
						endTime,
						exitCode:
							execution.exitCode === null ? null : count(execution, "exitCode"),
					}
				: undefined,
	};
}

/** A turbo `--summarize` run, or undefined when its required timings are missing. */
export function parseRunSummary(value: Json): RunSummary | undefined {
	if (!isObject(value)) return undefined;
	const execution = child(value, "execution");
	const tasks = value.tasks;
	if (!execution || !Array.isArray(tasks)) return undefined;
	const startTime = count(execution, "startTime");
	const endTime = count(execution, "endTime");
	if (startTime === undefined || endTime === undefined) return undefined;
	return {
		id: text(value, "id"),
		turboVersion: text(value, "turboVersion"),
		execution: {
			command: text(execution, "command"),
			startTime,
			endTime,
			exitCode: count(execution, "exitCode"),
			attempted: count(execution, "attempted"),
			cached: count(execution, "cached"),
			failed: count(execution, "failed"),
		},
		tasks: tasks.flatMap((task: Json) => parseTask(task) ?? []),
	};
}

const SECRET_NAME =
	/(TOKEN|SECRET|PASSWORD|PRIVATE|KEY|DATABASE_URL|CREDENTIAL)/i;

/** Values of secret-named env vars present in this process (min length guards against scrubbing "1"). */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
	return Object.entries(env)
		.filter(
			([name, value]) => SECRET_NAME.test(name) && (value?.length ?? 0) >= 6,
		)
		.map(([, value]) => value ?? "");
}

export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
	return out
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
		.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED]")
		.replace(
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
			"[REDACTED]",
		);
}

const hex = (seed: string, bytes: number): string =>
	createHash("sha256")
		.update(seed)
		.digest("hex")
		.slice(0, bytes * 2);
const nanos = (ms: number): string => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const attr = (key: string, value: string) => ({
	key,
	value: { stringValue: value },
});
const intAttr = (key: string, value: number) => ({
	key,
	value: { intValue: `${Math.trunc(value)}` },
});

/**
 * The trace of one workflow run. The relay and the box worker derive the same
 * id from the run id (`runTraceId` in packages/ci-gh-actions/src/relay-trace.ts),
 * so a job's Turbo spans land in the trace that holds its queue wait, its
 * runner and any cancellation. Run ids are unique across GitHub.
 */
export function runTraceId(githubRunId: string): string {
	return hex(`github-actions-run:${githubRunId}`, 16);
}

/**
 * One root span per turbo run, one child span per task. `traceId` joins them
 * to a workflow run's trace; without it the job gets a trace of its own.
 */
export function toOtlp(
	runs: readonly RunSummary[],
	job: string,
	runId: string,
	traceId: string = hex(`${runId}:${job}`, 16),
) {
	const spans = runs.flatMap((run, index) => {
		const rootId = hex(`${runId}:${job}:${run.id ?? index}`, 8);
		const root = {
			traceId,
			spanId: rootId,
			name: `turbo ${run.execution.command?.replace(/^turbo\s+/, "") ?? "run"}`.slice(
				0,
				200,
			),
			kind: 1,
			startTimeUnixNano: nanos(run.execution.startTime),
			endTimeUnixNano: nanos(run.execution.endTime),
			attributes: [
				intAttr("turbo.attempted", run.execution.attempted ?? 0),
				intAttr("turbo.cached", run.execution.cached ?? 0),
				intAttr("turbo.failed", run.execution.failed ?? 0),
				attr("turbo.version", run.turboVersion ?? "unknown"),
			],
			status: { code: (run.execution.exitCode ?? 0) === 0 ? 1 : 2 },
		};
		const tasks = run.tasks
			.filter((task) => task.execution)
			.map((task) => ({
				traceId,
				spanId: hex(`${rootId}:${task.taskId}`, 8),
				parentSpanId: rootId,
				name: task.taskId,
				kind: 1,
				startTimeUnixNano: nanos(task.execution?.startTime ?? 0),
				endTimeUnixNano: nanos(task.execution?.endTime ?? 0),
				attributes: [
					attr("turbo.task", task.task ?? task.taskId),
					attr("turbo.package", task.package ?? ""),
					attr("turbo.cache.status", task.cache?.status ?? "UNKNOWN"),
					intAttr("turbo.exit_code", task.execution?.exitCode ?? 0),
				],
				status: { code: (task.execution?.exitCode ?? 0) === 0 ? 1 : 2 },
			}));
		return [root, ...tasks];
	});
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						attr("service.name", "hobo-ci"),
						attr("ci.job", job),
						attr("ci.run_id", runId),
					],
				},
				scopeSpans: [{ scope: { name: "hobo-ci-trace", version: "1" }, spans }],
			},
		],
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const outDir = process.argv[2] ?? "ci-traces";
	const job = process.argv[3] ?? process.env.GITHUB_JOB ?? "local";
	const runId = `${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
	const dir = join(".turbo", "runs");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		files = [];
	}
	const runs = files.flatMap(
		(file) =>
			parseRunSummary(JSON.parse(readFileSync(join(dir, file), "utf8"))) ?? [],
	);
	mkdirSync(outDir, { recursive: true });
	const secrets = secretValues(process.env);
	writeFileSync(
		join(outDir, "otel-spans.json"),
		redact(
			JSON.stringify(
				/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "")
					? toOtlp(
							runs,
							job,
							runId,
							runTraceId(process.env.GITHUB_RUN_ID ?? ""),
						)
					: toOtlp(runs, job, runId),
				null,
				1,
			),
			secrets,
		),
	);
	runs.forEach((run, index) => {
		writeFileSync(
			join(outDir, `turbo-summary-${index}.json`),
			redact(JSON.stringify(run, null, 1), secrets),
		);
	});
	// Chrome-trace profile from `turbo run --anon-profile=turbo-profile.json` (identifying data already omitted by turbo).
	if (existsSync("turbo-profile.json"))
		writeFileSync(
			join(outDir, "turbo-profile.json"),
			redact(readFileSync("turbo-profile.json", "utf8"), secrets),
		);
	const taskSpanCount = runs.reduce((n, r) => n + r.tasks.length, 0);
	if (runs.length === 0) {
		writeFileSync(join(outDir, ".skip-upload"), "no-turbo-runs\n");
	}
	console.error(
		`ci-trace: ${runs.length} turbo run(s), ${taskSpanCount} task span(s) -> ${outDir}`,
	);
}
