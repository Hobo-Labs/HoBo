/**
 * One job of a workflow file as the fields a local run cares about: its
 * condition, environment, outputs, matrix and ordered steps. Used to keep
 * `scripts/ci/attested-jobs.json` in step with the workflows; never used to
 * run anything.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	asBoolean,
	asList,
	asObject,
	asText,
	type JsonObject,
	type JsonValue,
	parseJson,
} from "../ci/attestation.mts";
import type { PlannedJob, PlannedStep } from "../ci/attested-jobs.mts";

const repoRoot = join(import.meta.dirname, "..", "..");
const yamlPath = createRequire(import.meta.url).resolve("yaml", {
	paths: [join(repoRoot, "packages/ci-gh-actions")],
});
const { parse } = await import(yamlPath);

/** A workflow document as plain JSON; YAML has nothing here JSON cannot hold. */
export function workflowDocument(text: string): JsonObject {
	const document = asObject(parseJson(JSON.stringify(parse(text))));
	if (!document) throw new Error("a workflow must be a YAML mapping");
	return document;
}

function textMap(value: JsonValue | undefined): Record<string, string> {
	const entries = Object.entries(asObject(value) ?? {}).map(
		([key, entry]): [string, string] => [
			key,
			asText(entry) ?? JSON.stringify(entry),
		],
	);
	return Object.fromEntries(entries);
}

/** The workflow's own view of a step; what a local run does with it is not here. */
export type WorkflowStep = Omit<PlannedStep, "local" | "reason">;
export type WorkflowJob = Omit<PlannedJob, "id" | "workflow" | "steps"> &
	Readonly<{ steps: readonly WorkflowStep[] }>;

/** A step or job while its optional fields are being filled in. */
type StepDraft = { -readonly [Key in keyof WorkflowStep]: WorkflowStep[Key] };
type JobDraft = { -readonly [Key in keyof WorkflowJob]: WorkflowJob[Key] };

function workflowStep(value: JsonValue): WorkflowStep {
	const source = asObject(value) ?? {};
	const step: StepDraft = {};
	const env = textMap(source.env);
	const name = asText(source.name);
	const id = asText(source.id);
	const condition = asText(source.if);
	const uses = asText(source.uses);
	const run = asText(source.run);
	const shell = asText(source.shell);
	if (name !== undefined) step.name = name;
	if (id !== undefined) step.id = id;
	if (condition !== undefined) step.if = condition;
	if (uses !== undefined) step.uses = uses;
	if (run !== undefined) step.run = run;
	if (shell !== undefined) step.shell = shell;
	if (Object.keys(env).length > 0) step.env = env;
	if (asBoolean(source["continue-on-error"]) === true)
		step.continueOnError = true;
	return step;
}

export function workflowJob(text: string, jobId: string): WorkflowJob {
	const document = workflowDocument(text);
	const source = asObject(asObject(document.jobs)?.[jobId]);
	if (!source) throw new Error(`the workflow has no job ${jobId}`);
	const job: JobDraft = {
		workflowEnv: textMap(document.env),
		env: textMap(source.env),
		outputs: textMap(source.outputs),
		steps: (asList(source.steps) ?? []).map(workflowStep),
	};
	const condition = asText(source.if);
	const matrix = asText(asObject(asObject(source.strategy)?.matrix)?.shard);
	if (condition !== undefined) job.if = condition;
	if (matrix !== undefined) job.matrix = matrix;
	return job;
}
