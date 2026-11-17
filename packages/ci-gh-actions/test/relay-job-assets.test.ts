/**
 * The relay job's generated asset (ADR-0183): the workflow and the vendored
 * evaluator `hobo ci init --relay` writes into a repository. The asset must be
 * what the sources make, the workflow must keep its narrow shape, and the
 * evaluator must run on its own as a plain Node program.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_JOB_INPUTS, RELAY_JOB_OUTPUTS } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import {
	generateRelayJobAsset,
	relayEvaluatorBodyOf,
	sha256,
} from "../scripts/generate-relay-job.mts";
import {
	RELAY_JOB_EVALUATOR,
	RELAY_JOB_EVALUATOR_SHA256,
	RELAY_JOB_SOURCE_COMMIT,
	RELAY_JOB_WORKFLOW,
	RELAY_JOB_WORKFLOW_SHA256,
} from "../src/_generated-assets/relay-job-assets.js";
import {
	parseRelayJobArguments,
	RELAY_JOB_CONTEXT_ARGUMENTS,
} from "../src/relay-job/main.js";

const TEMPLATE = readFileSync(
	new URL("../templates/hobo-relay.yml", import.meta.url),
	"utf8",
);

const Workflow = z.object({
	on: z.object({
		workflow_call: z.object({
			inputs: z.record(
				z.string(),
				z.object({ type: z.literal("string"), required: z.literal(false) }),
			),
			outputs: z.record(z.string(), z.object({ value: z.string() })),
		}),
	}),
	permissions: z.record(z.string(), z.string()),
	jobs: z.record(
		z.string(),
		z.object({
			"runs-on": z.string(),
			outputs: z.record(z.string(), z.string()),
			steps: z.array(
				z.object({
					uses: z.string().optional(),
					with: z
						.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
						.optional(),
					env: z.record(z.string(), z.string()).optional(),
					run: z.string().optional(),
				}),
			),
		}),
	),
});

describe("the relay job asset", () => {
	it("is what the sources make", { timeout: 60_000 }, async () => {
		const result = await generateRelayJobAsset(true);
		expect(result.message).toBe("the relay job asset is current");
		expect(result.ok).toBe(true);
	});

	it("holds the workflow template and the evaluator's digest", () => {
		expect(RELAY_JOB_WORKFLOW).toBe(TEMPLATE);
		expect(RELAY_JOB_WORKFLOW_SHA256).toBe(sha256(TEMPLATE));
		const body = relayEvaluatorBodyOf(RELAY_JOB_EVALUATOR) ?? "";
		expect(sha256(body)).toBe(RELAY_JOB_EVALUATOR_SHA256);
		expect(RELAY_JOB_EVALUATOR).toContain(
			`// sha256: ${RELAY_JOB_EVALUATOR_SHA256}\n`,
		);
		expect(RELAY_JOB_EVALUATOR).toContain(
			`generated at commit ${RELAY_JOB_SOURCE_COMMIT}.`,
		);
		expect(relayEvaluatorBodyOf("no header")).toBeUndefined();
	});

	it("carries the licenses of the third-party code it bundles", () => {
		const body = relayEvaluatorBodyOf(RELAY_JOB_EVALUATOR) ?? "";
		const notice = body.slice(0, body.indexOf("*/"));
		expect(notice).toMatch(/^\/\*\n \* Third-party code in this file/u);
		expect(notice).toContain("@bufbuild/protobuf@");
		expect(notice).toContain("Apache License");
		expect(notice).toContain("Copyright 2008 Google Inc.");
		expect(notice).toMatch(/\nzod@[0-9.]+\n\nMIT License/u);
	});
});

describe("hobo-relay.yml", () => {
	const workflow = Workflow.parse(parse(TEMPLATE));
	const [jobName, job] = Object.entries(workflow.jobs)[0] ?? [];

	it("takes the twelve relay inputs and gives the four outputs", () => {
		expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual([
			...RELAY_JOB_INPUTS,
		]);
		expect(Object.keys(workflow.on.workflow_call.outputs)).toEqual([
			...RELAY_JOB_OUTPUTS,
		]);
		for (const name of RELAY_JOB_OUTPUTS) {
			expect(workflow.on.workflow_call.outputs[name]?.value).toBe(
				`\${{ jobs.${jobName}.outputs.${name} }}`,
			);
			expect(job?.outputs[name]).toBe(`\${{ steps.answer.outputs.${name} }}`);
		}
	});

	it("is one GitHub-hosted job that can only read actions and contents", () => {
		expect(Object.keys(workflow.jobs)).toHaveLength(1);
		expect(workflow.permissions).toEqual({ actions: "read", contents: "read" });
		expect(job?.["runs-on"]).toBe("ubuntu-24.04");
		for (const step of job?.steps ?? [])
			if (step.uses)
				expect(step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/u);
	});

	it("checks out only the evaluator and the project file, from the base branch for a fork", () => {
		const checkout = job?.steps.find((step) =>
			step.uses?.startsWith("actions/checkout@"),
		);
		expect(
			String(checkout?.with?.["sparse-checkout"]).trim().split("\n"),
		).toEqual([".hobo-ci/relay.mjs", ".hobo/ci.json"]);
		expect(checkout?.with?.["persist-credentials"]).toBe(false);
		expect(checkout?.with?.ref).toBe(
			"${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && github.base_ref || '' }}",
		);
	});

	it("passes every input and the run's context as quoted arguments, never as shell text", () => {
		const answer = job?.steps.find((step) => step.run !== undefined);
		const run = answer?.run ?? "";
		expect(run).not.toContain("${{");
		for (const name of RELAY_JOB_INPUTS) {
			const variable = `RELAY_${name.toUpperCase().replaceAll("-", "_")}`;
			expect(answer?.env?.[variable]).toBe(`\${{ inputs.${name} }}`);
			expect(run).toContain(`--${name} "$${variable}"`);
		}
		for (const name of RELAY_JOB_CONTEXT_ARGUMENTS.filter(
			(argument) => argument !== "job-id",
		))
			expect(run).toMatch(new RegExp(`--${name} "\\$[A-Z_]+"`, "u"));
		expect(run.startsWith("node --no-warnings .hobo-ci/relay.mjs")).toBe(true);
	});
});

describe("the vendored evaluator", () => {
	/** Run the evaluator as a workflow would, in a checkout holding `project`. */
	function evaluate(project: string | undefined, args: readonly string[]) {
		const checkout = mkdtempSync(join(tmpdir(), "hobo-relay-"));
		mkdirSync(join(checkout, ".hobo-ci"));
		writeFileSync(join(checkout, ".hobo-ci/relay.mjs"), RELAY_JOB_EVALUATOR);
		if (project !== undefined) {
			mkdirSync(join(checkout, ".hobo"));
			writeFileSync(join(checkout, ".hobo/ci.json"), project);
		}
		const outputs = join(checkout, "outputs.txt");
		writeFileSync(outputs, "");
		const result = spawnSync(
			process.execPath,
			["--no-warnings", ".hobo-ci/relay.mjs", ...args],
			{
				cwd: checkout,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					PATH: process.env.PATH ?? "",
					GITHUB_OUTPUT: outputs,
					GITHUB_TOKEN: "ghs_test",
					// Nothing listens here, so every GitHub read fails at once.
					GITHUB_API_URL: "http://127.0.0.1:9",
				},
			},
		);
		return {
			status: result.status,
			stdout: result.stdout,
			outputs: readFileSync(outputs, "utf8"),
		};
	}
	const context = [
		"--repository",
		"octo/app",
		"--run-id",
		"5",
		"--job",
		"relay",
		"--event",
		"push",
		"--private",
		"true",
	];

	it("fails on its own with the parser's sentence for a broken order", () => {
		const run = evaluate('{"runnerOrder":{"steps":[]}}', [
			"--github",
			"ubuntu-24.04",
			...context,
		]);
		expect(run.status).toBe(1);
		expect(run.stdout).toContain(
			"::error title=hobo-ci-relay-answer::.hobo/ci.json: invalid runner order: a runner order needs at least one step",
		);
		expect(run.outputs).toMatch(/^outcome<<(\S+)\nnone\n\1$/mu);
	});

	it("routes on its own with nothing measured when GitHub cannot be reached", () => {
		const run = evaluate(undefined, ["--github", "ubuntu-24.04", ...context]);
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("::notice title=hobo-ci-relay::{");
		expect(run.stdout).toContain("::warning title=hobo-ci-relay-facts::");
		expect(run.outputs).toMatch(/^runner<<(\S+)\nubuntu-24\.04\n\1$/mu);
	});
});

describe("the parity probe", () => {
	const probe = readFileSync(
		new URL("../../../.github/workflows/parity-probe.yml", import.meta.url),
		"utf8",
	);
	const Probe = z.object({
		jobs: z.record(
			z.string(),
			z.object({
				steps: z.array(z.object({ run: z.string().optional() })),
			}),
		),
	});

	it("passes the evaluator only arguments it reads", () => {
		const runs = Object.values(Probe.parse(parse(probe)).jobs)
			.flatMap((job) => job.steps)
			.flatMap((step) =>
				step.run?.startsWith("node --no-warnings .hobo-ci/relay.mjs")
					? [step.run]
					: [],
			);
		expect(runs).toHaveLength(2);
		for (const run of runs) {
			const argv = run
				.replace("node --no-warnings .hobo-ci/relay.mjs", "")
				.trim()
				.split(/\s+/u)
				.map((word) => (word.startsWith('"$') ? "1" : word));
			const parsed = parseRelayJobArguments(argv);
			expect(parsed.ok ? "" : parsed.problem).toBe("");
		}
	});
});
