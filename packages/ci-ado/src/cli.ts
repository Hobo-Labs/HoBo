#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toJsonString } from "@bufbuild/protobuf";
import { AdoLiveResultSchema } from "./_generated/project_pb.js";
import {
	artifactReportDigest,
	reserveArtifactDirectory,
	verifyArtifactBundle,
	writeArtifactBundle,
} from "./artifacts.js";
import { parseAdoLiveTarget, verifyLiveAdoPipeline } from "./live.js";
import {
	adoPlanDigest,
	loadAdoProject,
	renderAzurePipeline,
	runAdoPipeline,
} from "./pipeline.js";

function logText(value: string): string {
	return value.replace(/##vso\[/gi, "##vso%5B").replaceAll("##[", "##%5B");
}
function options(
	args: string[],
	allowed: readonly string[],
): Map<string, string> {
	const parsed = new Map<string, string>();
	while (args.length) {
		const name = args.shift();
		const value = args.shift();
		if (
			!name ||
			!allowed.includes(name) ||
			parsed.has(name) ||
			!value ||
			value.startsWith("--")
		)
			throw new Error("invalid or duplicate CLI option");
		parsed.set(name, value);
	}
	return parsed;
}
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	const input = args.shift();
	if (!input || !["run", "yaml", "verify", "live"].includes(command ?? ""))
		throw new Error(
			"usage: hobo-ci-ado run|yaml <config-path> [workspace] [options]; verify <bundle> --config <config-path> --expected-plan <digest> [options]; live <config-path> <target-json> [workspace]",
		);
	if (command === "live") {
		const targetPath = args.shift();
		const workspace = args.shift() ?? ".";
		if (!targetPath || args.length)
			throw new Error(
				"usage: hobo-ci-ado live <config-path> <target-json> [workspace]",
			);
		const root = resolve(workspace);
		const { project, pipeline } = await loadAdoProject(root, input);
		const target = parseAdoLiveTarget(
			await readFile(resolve(root, targetPath), "utf8"),
		);
		const stop = new AbortController();
		const cancel = () => stop.abort(new Error("live verification interrupted"));
		process.on("SIGINT", cancel);
		process.on("SIGTERM", cancel);
		try {
			const result = await verifyLiveAdoPipeline(target, project, pipeline, {
				signal: stop.signal,
			});
			process.stdout.write(`${toJsonString(AdoLiveResultSchema, result)}\n`);
		} finally {
			process.removeListener("SIGINT", cancel);
			process.removeListener("SIGTERM", cancel);
		}
		return;
	}
	if (command === "verify") {
		const flags = options(args, [
			"--expected-plan",
			"--expected-bundle",
			"--config",
			"--workspace",
		]);
		const expected = flags.get("--expected-plan");
		if (!expected) throw new Error("verify requires --expected-plan");
		const config = flags.get("--config");
		if (!config)
			throw new Error(
				"verify requires --config to check the exact artifact manifest",
			);
		const { project, pipeline } = await loadAdoProject(
			resolve(flags.get("--workspace") ?? "."),
			config,
		);
		if (adoPlanDigest(project, pipeline) !== expected)
			throw new Error("verification config/plan changed");
		const report = await verifyArtifactBundle(
			input,
			expected,
			pipeline.artifactPaths,
			flags.get("--expected-bundle"),
		);
		process.stdout.write(
			`Verified ${report.artifacts.length} artifacts from execution ${report.executionId}\n`,
		);
		return;
	}
	const root = resolve(
		args[0] && !args[0].startsWith("--") ? (args.shift() ?? ".") : ".",
	);
	const flags = options(
		args,
		command === "yaml" ? ["--check"] : ["--expected-plan", "--artifacts"],
	);
	const { project, pipeline } = await loadAdoProject(root, input);
	if (command === "yaml") {
		const yaml = renderAzurePipeline(project, pipeline, input);
		const check = flags.get("--check");
		if (check) {
			if ((await readFile(resolve(root, check), "utf8")) !== yaml)
				throw new Error(
					"generated Azure YAML is stale; regenerate it from the current config and command plan",
				);
			process.stdout.write("Azure pipeline configuration is current\n");
		} else process.stdout.write(yaml);
		return;
	}
	const planDigest = adoPlanDigest(project, pipeline);
	const expected = flags.get("--expected-plan");
	if (expected && expected !== planDigest)
		throw new Error(
			"Azure pipeline config/command plan changed; regenerate YAML before executing",
		);
	const artifacts = flags.get("--artifacts");
	const directory = artifacts
		? await reserveArtifactDirectory(resolve(root, artifacts))
		: undefined;
	const stop = new AbortController();
	const cancel = () => stop.abort(new Error("process interrupted"));
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		const result = await runAdoPipeline(root, pipeline, {
			signal: stop.signal,
			project,
		});
		for (const step of result.steps) {
			process.stdout.write(`${step.id}: exit ${step.exitCode}\n`);
			for (const line of step.stdout.split("\n"))
				if (line) process.stdout.write(`  ${logText(line)}\n`);
			for (const line of step.stderr.split("\n"))
				if (line) process.stderr.write(`  ${logText(line)}\n`);
		}
		if (directory) {
			const report = await writeArtifactBundle(directory, result, planDigest);
			const bundleDigest = artifactReportDigest(report);
			process.stdout.write(`Artifact manifest SHA-256: ${bundleDigest}\n`);
			if (process.env.TF_BUILD?.toLowerCase() === "true")
				process.stdout.write(
					`##vso[task.setvariable variable=bundleDigest;isOutput=true;isReadOnly=true]${bundleDigest}\n`,
				);
			if (process.env.TF_BUILD?.toLowerCase() === "true")
				process.stdout.write(
					"##vso[task.setvariable variable=HOBO_CI_BUNDLE_READY]true\n",
				);
		}
		process.stdout.write(`HoBo CI: ${result.status} (${result.id})\n`);
		process.exitCode = result.status === "succeeded" ? 0 : 1;
	} finally {
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	void main().catch((error: Error) => {
		process.stderr.write(
			`HoBo CI ADO: ${logText(error.message.slice(0, 2048)).replaceAll("\n", "\n  ")}\n`,
		);
		process.exitCode = 1;
	});
}
