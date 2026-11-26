import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import {
	executePipeline,
	type ParsedPipeline,
	type PipelineResult,
	PipelineSchema,
	parsePipeline,
	shellQuote,
} from "@hobo/ci/execution";
import { stringify } from "yaml";
import { AdoProjectSchema } from "./_generated/project_pb.js";
import { readBoundedFile } from "./artifacts.js";
import { createAdoBackend } from "./backend.js";
import { redactResult, resolveEnvironment } from "./environment.js";
import {
	type ParsedAdoProject,
	parseAdoProject,
	parseProjectPath,
} from "./project.js";

async function readWithin(workspace: string, path: string): Promise<string> {
	parseProjectPath(path);
	const root = await realpath(workspace);
	const target = await realpath(resolve(root, path));
	const inside = relative(root, target);
	if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
		throw new Error("configuration path escapes workspace");
	return (await readBoundedFile(root, path, 8 * 1024 * 1024)).toString("utf8");
}
export async function loadAdoProject(workspace: string, configPath: string) {
	const project = parseAdoProject(await readWithin(workspace, configPath));
	const pipeline = parsePipeline(
		await readWithin(workspace, project.pipelinePath),
	);
	pipeline.artifactPaths.forEach(parseProjectPath);
	return Object.freeze({ project, pipeline });
}
const sorted = (map: Readonly<Record<string, string>>) =>
	Object.fromEntries(
		Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
/** Hashes author intent before resolving secret values or assigning a fresh execution ID. */
export function adoPlanDigest(
	project: ParsedAdoProject,
	pipeline: ParsedPipeline,
): string {
	return createHash("sha256")
		.update(
			toJsonString(AdoProjectSchema, {
				...project,
				environmentRefs: sorted(project.environmentRefs),
			}),
		)
		.update("\0")
		.update(
			toJsonString(PipelineSchema, {
				...pipeline,
				steps: pipeline.steps.map((step) => ({
					...step,
					env: sorted(step.env),
				})),
			}),
		)
		.digest("hex");
}
/** Every invocation is a new logical run, including a new ADO job attempt. */
export async function runAdoPipeline(
	workspace: string,
	pipeline: ParsedPipeline,
	options: {
		signal?: AbortSignal;
		project?: ParsedAdoProject;
		hostEnvironment?: NodeJS.ProcessEnv;
	} = {},
): Promise<PipelineResult> {
	const environment = resolveEnvironment(
		options.project?.environmentRefs ?? {},
		pipeline,
		options.hostEnvironment ?? process.env,
	);
	const execution = parsePipeline(
		toJsonString(PipelineSchema, {
			...pipeline,
			id: randomUUID(),
			steps: pipeline.steps.map((step) => ({
				...step,
				env: { ...step.env, ...environment },
			})),
		}),
	);
	const result = await executePipeline(
		createAdoBackend({ workspace }),
		execution,
		options,
	);
	return redactResult(result, Object.values(environment));
}
/** Named self-hosted pool, immutable bundle, attempt-scoped artifact, and optional native round trip. */
export function renderAzurePipeline(
	project: ParsedAdoProject,
	pipeline: ParsedPipeline,
	configPath: string,
): string {
	parseProjectPath(configPath);
	pipeline.artifactPaths.forEach(parseProjectPath);
	const digest = adoPlanDigest(project, pipeline);
	const runner = project.runnerArgv.map(shellQuote).join(" ");
	const bootstrap = project.bootstrapArgv.map(shellQuote).join(" ");
	const pool = {
		name: project.pool,
		demands: [
			"Agent.OS -equals Linux",
			...project.demands.filter((value) => value !== "Agent.OS -equals Linux"),
		],
	};
	const checkout = { checkout: "self", clean: true, persistCredentials: false };
	const bootstrapStep = {
		bash: `set -euo pipefail\n${bootstrap}`,
		displayName: "Prepare HoBo CI runner",
		workingDirectory: "$(Build.SourcesDirectory)",
	};
	const producer = {
		job: "hobo_ci",
		pool,
		timeoutInMinutes: Math.ceil(pipeline.timeoutSeconds / 60) + 10,
		cancelTimeoutInMinutes: 1,
		workspace: { clean: "all" },
		variables: { HOBO_CI_BUNDLE_READY: "false" },
		steps: [
			checkout,
			{
				bash: "printf '##vso[task.setvariable variable=artifactName;isOutput=true]%s\\n' \"$HOBO_CI_ARTIFACT_NAME\"",
				name: "artifact_identity",
				displayName: "Name execution artifact",
				env: {
					HOBO_CI_ARTIFACT_NAME: `${project.artifactPrefix}-$(System.JobId)-$(System.JobAttempt)`,
				},
			},
			bootstrapStep,
			{
				bash: `set -euo pipefail\n${runner} run ${shellQuote(configPath)} . --expected-plan ${digest} --artifacts "$HOBO_CI_ARTIFACT_DIRECTORY"`,
				name: "run_checks",
				displayName: "Run HoBo CI checks",
				workingDirectory: "$(Build.SourcesDirectory)",
				env: {
					HOBO_CI_ARTIFACT_DIRECTORY:
						"$(Agent.TempDirectory)/hobo-ci-$(System.JobId)-$(System.JobAttempt)",
					...Object.fromEntries(
						[...new Set(Object.values(project.environmentRefs))]
							.sort()
							.map((name) => [name, `$(${name})`]),
					),
				},
			},
			{
				task: "PublishPipelineArtifact@1",
				displayName: "Publish verified execution bundle",
				condition:
					"and(succeededOrFailed(), eq(variables['HOBO_CI_BUNDLE_READY'], 'true'))",
				inputs: {
					targetPath:
						"$(Agent.TempDirectory)/hobo-ci-$(System.JobId)-$(System.JobAttempt)",
					artifact: `${project.artifactPrefix}-$(System.JobId)-$(System.JobAttempt)`,
					publishLocation: "pipeline",
				},
			},
		],
	};
	const consumer = {
		job: "hobo_ci_verify_artifacts",
		dependsOn: "hobo_ci",
		condition: "succeeded()",
		pool,
		timeoutInMinutes: 10,
		workspace: { clean: "all" },
		variables: {
			hoboArtifactName:
				"$[ dependencies.hobo_ci.outputs['artifact_identity.artifactName'] ]",
			hoboBundleDigest:
				"$[ dependencies.hobo_ci.outputs['run_checks.bundleDigest'] ]",
		},
		steps: [
			checkout,
			bootstrapStep,
			{
				task: "DownloadPipelineArtifact@2",
				displayName: "Download execution bundle",
				inputs: {
					buildType: "current",
					artifactName: "$(hoboArtifactName)",
					targetPath:
						"$(Agent.TempDirectory)/hobo-ci-download-$(System.JobId)-$(System.JobAttempt)",
				},
			},
			{
				bash: `set -euo pipefail\n${runner} verify "$HOBO_CI_DOWNLOAD_DIRECTORY" --config ${shellQuote(configPath)} --expected-plan ${digest} --expected-bundle "$HOBO_CI_EXPECTED_BUNDLE_DIGEST"`,
				displayName: "Verify downloaded artifact hashes",
				workingDirectory: "$(Build.SourcesDirectory)",
				env: {
					HOBO_CI_EXPECTED_BUNDLE_DIGEST: "$(hoboBundleDigest)",
					HOBO_CI_DOWNLOAD_DIRECTORY:
						"$(Agent.TempDirectory)/hobo-ci-download-$(System.JobId)-$(System.JobAttempt)",
				},
			},
		],
	};
	return (
		"# Generated by @hobo/ci-ado. Regenerate after changing the config or command plan.\n" +
		stringify(
			{
				trigger: "none",
				pr: "none",
				jobs: project.verifyArtifacts ? [producer, consumer] : [producer],
			},
			{ lineWidth: 0, aliasDuplicateObjects: false },
		)
	);
}
