/**
 * Turn Turbo run summaries into an OpenTelemetry trace on disk (OTLP/JSON,
 * the same shape the OTel file exporter writes) so every CI job can upload
 * its own trace as an artifact. No collector, no paid backend.
 *
 * Usage: node --experimental-strip-types scripts/ci/ci-trace.mts <out-dir> [job-name]
 *
 * Reads `.turbo/runs/*.json` (written by `turbo run --summarize`), writes
 * `<out-dir>/otel-spans.json` and a redacted copy of each summary. Only
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
import { z } from "zod";

const TaskSummary = z.object({
	taskId: z.string(),
	package: z.string().optional(),
	task: z.string().optional(),
	cache: z.object({ status: z.string().optional() }).partial().optional(),
	execution: z
		.object({
			startTime: z.number(),
			endTime: z.number(),
			exitCode: z.number().nullable().optional(),
		})
		.optional(),
});
const RunSummary = z.object({
	id: z.string().optional(),
	turboVersion: z.string().optional(),
	execution: z.object({
		command: z.string().optional(),
		startTime: z.number(),
		endTime: z.number(),
		exitCode: z.number().optional(),
		attempted: z.number().optional(),
		cached: z.number().optional(),
		failed: z.number().optional(),
	}),
	tasks: z.array(TaskSummary),
});
type RunSummary = z.infer<typeof RunSummary>;

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

/** One root span per turbo run, one child span per task. */
export function toOtlp(
	runs: readonly RunSummary[],
	job: string,
	runId: string,
) {
	const traceId = hex(`${runId}:${job}`, 16);
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

/** Keep only what the trace needs; drops env lists, hashes, commands, user and SCM. */
export function slimSummary(run: RunSummary): RunSummary {
	return RunSummary.parse({
		id: run.id,
		turboVersion: run.turboVersion,
		execution: run.execution,
		tasks: run.tasks.map((task) => TaskSummary.parse(task)),
	});
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
	const runs = files.flatMap((file) => {
		const parsed = RunSummary.safeParse(
			JSON.parse(readFileSync(join(dir, file), "utf8")),
		);
		return parsed.success ? [slimSummary(parsed.data)] : [];
	});
	mkdirSync(outDir, { recursive: true });
	const secrets = secretValues(process.env);
	writeFileSync(
		join(outDir, "otel-spans.json"),
		redact(JSON.stringify(toOtlp(runs, job, runId), null, 1), secrets),
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
	console.error(
		`ci-trace: ${runs.length} turbo run(s), ${runs.reduce((n, r) => n + r.tasks.length, 0)} task span(s) -> ${outDir}`,
	);
}
