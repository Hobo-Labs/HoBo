import { setTimeout as delay } from "node:timers/promises";
import { create, fromJsonString } from "@bufbuild/protobuf";
import type { ParsedPipeline } from "@hobo/ci/execution";
import { parse } from "yaml";
import {
	AdoLiveResultSchema,
	type AdoLiveTarget,
	AdoLiveTargetSchema,
	AdoRemoteArtifactsSchema,
	AdoRemoteBuildSchema,
	AdoRemoteDefinitionSchema,
	AdoRemotePoolsSchema,
	AdoRemoteRunSchema,
	AdoRemoteTimelineSchema,
	AdoYamlSchema,
	type AdoYamlStep,
} from "./_generated/project_pb.js";
import { type ParsedAdoProject, parseEnvironmentName } from "./project.js";

declare const parsedLiveTarget: unique symbol;
export type ParsedAdoLiveTarget = AdoLiveTarget & {
	readonly [parsedLiveTarget]: true;
};
export function parseAdoLiveTarget(json: string): ParsedAdoLiveTarget {
	const target = fromJsonString(AdoLiveTargetSchema, json);
	if (
		!/^https:\/\/dev\.azure\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,99}\/?$/.test(
			target.organizationUrl,
		) ||
		!/^[A-Za-z0-9][A-Za-z0-9_. -]{0,199}$/.test(target.project) ||
		target.project !== target.project.trim() ||
		!target.pipelineId ||
		!/^refs\/heads\/[A-Za-z0-9_./-]+$/.test(target.refName) ||
		target.refName.includes("..") ||
		target.refName.endsWith(".") ||
		target.refName
			.split("/")
			.some(
				(part) => !part || part.startsWith(".") || part.endsWith(".lock"),
			) ||
		!/^[a-f0-9]{40}$/.test(target.sourceVersion) ||
		!["pat", "bearer"].includes(target.authentication) ||
		target.timeoutSeconds < 1 ||
		target.timeoutSeconds > 3600
	)
		throw new Error("invalid live Azure pipeline verification target");
	parseEnvironmentName(target.tokenEnv);
	target.organizationUrl = target.organizationUrl.replace(/\/$/, "");
	// SAFETY: strict protobuf parsing and all endpoint, identity and deadline constraints establish this immutable target.
	return Object.freeze(target) as ParsedAdoLiveTarget;
}
function parseRemote<T extends Parameters<typeof fromJsonString>[0]>(
	schema: T,
	json: string,
) {
	try {
		return fromJsonString(schema, json, { ignoreUnknownFields: true });
	} catch {
		throw new Error("invalid Azure REST response");
	}
}
function previewJson(yaml: string): string {
	try {
		return JSON.stringify(parse(yaml));
	} catch {
		throw new Error("Azure returned invalid preview YAML");
	}
}
function bashScript(step: AdoYamlStep): string {
	if (step.bash) return step.bash;
	return step.task === "Bash@3" && step.inputs.targetType === "inline"
		? (step.inputs.script ?? "")
		: "";
}
function hasPlanGuard(script: string, digest: string): boolean {
	return new RegExp(`(?:^|\\s)--expected-plan[ \\t]+${digest}(?=\\s|$)`).test(
		script,
	);
}
async function boundedText(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	if (!response.body) throw new Error("Azure returned an empty response");
	const reader = response.body.getReader();
	const buffers: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await new Promise<
				Awaited<ReturnType<typeof reader.read>>
			>((resolve, reject) => {
				const aborted = () => {
					signal.removeEventListener("abort", aborted);
					reject(new Error("Azure response stopped"));
				};
				signal.addEventListener("abort", aborted, { once: true });
				if (signal.aborted) {
					aborted();
					return;
				}
				reader.read().then(
					(value) => {
						signal.removeEventListener("abort", aborted);
						resolve(value);
					},
					() => {
						signal.removeEventListener("abort", aborted);
						reject(new Error("Azure response stream failed"));
					},
				);
			});
			if (done) break;
			size += value.byteLength;
			if (size > 1024 * 1024) {
				throw new Error("Azure response exceeds one MiB");
			}
			buffers.push(value);
		}
	} finally {
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return Buffer.concat(buffers).toString("utf8");
}

/** Queues exactly one pinned run, checks self-hosted provenance and native upload/download verification. */
export async function verifyLiveAdoPipeline(
	target: ParsedAdoLiveTarget,
	project: ParsedAdoProject,
	pipeline: ParsedPipeline,
	options: {
		hostEnvironment?: NodeJS.ProcessEnv;
		fetch?: typeof fetch;
		signal?: AbortSignal;
		pollMilliseconds?: number;
	} = {},
) {
	if (!project.verifyArtifacts)
		throw new Error("live acceptance requires verifyArtifacts=true");
	const host = options.hostEnvironment ?? process.env;
	const token = Object.hasOwn(host, target.tokenEnv)
		? host[target.tokenEnv]
		: undefined;
	if (
		!token ||
		token === `$(${target.tokenEnv})` ||
		/[\r\n\0]/.test(token) ||
		token.length > 16384
	)
		throw new Error(
			`live Azure authentication is not configured: ${target.tokenEnv}`,
		);
	const requestFetch = options.fetch ?? fetch;
	const authorization =
		target.authentication === "pat"
			? `Basic ${Buffer.from(`:${token}`).toString("base64")}`
			: `Bearer ${token}`;
	const base = target.organizationUrl;
	const projectBase = `${base}/${encodeURIComponent(target.project)}`;
	const requestedPolling = options.pollMilliseconds ?? 1000;
	if (!Number.isFinite(requestedPolling))
		throw new Error("invalid Azure polling interval");
	const signal = options.signal
		? AbortSignal.any([
				options.signal,
				AbortSignal.timeout(target.timeoutSeconds * 1000),
			])
		: AbortSignal.timeout(target.timeoutSeconds * 1000);
	const polling = Math.max(1, Math.min(requestedPolling, 10000));
	async function request(
		url: string,
		method = "GET",
		body?: string,
		requestSignal = signal,
	): Promise<string> {
		requestSignal.throwIfAborted();
		const responseSignal = AbortSignal.any([
			requestSignal,
			AbortSignal.timeout(10000),
		]);
		const init: RequestInit = {
			method,
			headers: {
				Authorization: authorization,
				"Content-Type": "application/json",
			},
			redirect: "error",
			signal: responseSignal,
		};
		if (body !== undefined) init.body = body;
		let response: Response;
		try {
			const fetching = requestFetch(url, init);
			response = await new Promise<Response>((resolve, reject) => {
				const aborted = () => {
					responseSignal.removeEventListener("abort", aborted);
					reject(new Error("Azure request stopped"));
				};
				responseSignal.addEventListener("abort", aborted, { once: true });
				if (responseSignal.aborted) aborted();
				fetching.then(
					(value) => {
						responseSignal.removeEventListener("abort", aborted);
						if (responseSignal.aborted) {
							// A custom transport can settle late after ignoring abort. Release its body.
							void value.body?.cancel().catch(() => undefined);
						} else resolve(value);
					},
					(error: Error) => {
						responseSignal.removeEventListener("abort", aborted);
						reject(error);
					},
				);
			});
		} catch {
			throw new Error(`Azure ${method} transport failed`);
		}
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined);
			throw new Error(`Azure ${method} failed with HTTP ${response.status}`);
		}
		return boundedText(response, responseSignal);
	}
	const api = (path: string) =>
		`${projectBase}/_apis/${path}${path.includes("?") ? "&" : "?"}api-version=7.1`;
	const pools = parseRemote(
		AdoRemotePoolsSchema,
		await request(
			`${base}/_apis/distributedtask/pools?poolName=${encodeURIComponent(project.pool)}&api-version=7.1`,
		),
	);
	const matchingPools = pools.value.filter(
		(value) => value.name === project.pool,
	);
	const pool = matchingPools[0];
	if (matchingPools.length !== 1 || !pool?.id || pool.isHosted !== false)
		throw new Error(
			"configured pool is missing or is not confirmed self-hosted",
		);
	const definition = parseRemote(
		AdoRemoteDefinitionSchema,
		await request(api(`pipelines/${target.pipelineId}`)),
	);
	if (definition.id !== target.pipelineId || !definition.revision)
		throw new Error("Azure did not return a pinned pipeline revision");
	const runPath = `pipelines/${target.pipelineId}/runs?pipelineVersion=${definition.revision}`;
	const resources = {
		repositories: {
			self: { refName: target.refName, version: target.sourceVersion },
		},
	};
	const preview = parseRemote(
		AdoRemoteRunSchema,
		await request(
			api(runPath),
			"POST",
			JSON.stringify({ previewRun: true, resources }),
		),
	);
	const previewYaml = parseRemote(
		AdoYamlSchema,
		previewJson(preview.finalYaml),
	);
	// Azure can expand implicit stages and bash shortcuts in finalYaml.
	if (
		previewYaml.stages.length > 1 ||
		(previewYaml.stages.length && previewYaml.jobs.length)
	)
		throw new Error("Azure preview contains unexpected stages");
	const jobs = previewYaml.stages[0]?.jobs ?? previewYaml.jobs;
	if (
		jobs.length !== 2 ||
		!["hobo_ci", "hobo_ci_verify_artifacts"].every((name) =>
			jobs.some((job) => job.job === name),
		) ||
		jobs.some(
			(job) =>
				job.pool?.name !== project.pool || job.pool.vmImage !== undefined,
		)
	)
		throw new Error(
			"Azure preview does not exclusively target the configured self-hosted producer and verifier jobs",
		);
	// The compiler must retain the exact plan guard. No YAML override is used for the real run.
	const { adoPlanDigest } = await import("./pipeline.js");
	const planDigest = adoPlanDigest(project, pipeline);
	const producer = jobs.find((job) => job.job === "hobo_ci");
	const consumer = jobs.find((job) => job.job === "hobo_ci_verify_artifacts");
	if (
		!producer?.steps.some(
			(step) =>
				step.displayName === "Run HoBo CI checks" &&
				hasPlanGuard(bashScript(step), planDigest),
		) ||
		!producer.steps.some((step) => step.task === "PublishPipelineArtifact@1") ||
		!consumer?.steps.some(
			(step) => step.task === "DownloadPipelineArtifact@2",
		) ||
		!consumer.steps.some(
			(step) =>
				step.displayName === "Verify downloaded artifact hashes" &&
				hasPlanGuard(bashScript(step), planDigest) &&
				bashScript(step).includes("--expected-bundle "),
		)
	)
		throw new Error(
			"registered Azure YAML is stale or is missing native artifact verification",
		);
	let runId = 0;
	let completed = false;
	try {
		try {
			const queued = await request(
				api(runPath),
				"POST",
				JSON.stringify({ resources }),
			);
			const run = parseRemote(AdoRemoteRunSchema, queued);
			if (!run.id) throw new Error("missing created run identity");
			runId = run.id;
		} catch {
			throw new Error(
				"Azure run creation was not confirmed; no automatic retry was attempted",
			);
		}
		for (;;) {
			const build = parseRemote(
				AdoRemoteBuildSchema,
				await request(api(`build/builds/${runId}`)),
			);
			completed = build.id === runId && build.status === "completed";
			if (
				build.id !== runId ||
				build.sourceVersion !== target.sourceVersion ||
				build.queue?.pool?.id !== pool.id
			)
				throw new Error(
					"Azure run source or pool provenance does not match the requested execution",
				);
			if (build.status === "completed") {
				completed = true;
				if (build.result !== "succeeded")
					throw new Error(`Azure run ${runId} did not succeed`);
				break;
			}
			if (!["notStarted", "inProgress", "postponed"].includes(build.status))
				throw new Error("unexpected Azure run state");
			await delay(polling, undefined, { signal });
		}
		const timeline = parseRemote(
			AdoRemoteTimelineSchema,
			await request(api(`build/builds/${runId}/timeline`)),
		);
		for (const name of [
			"Run HoBo CI checks",
			"Publish verified execution bundle",
			"Download execution bundle",
			"Verify downloaded artifact hashes",
		])
			if (
				!timeline.records.some(
					(record) =>
						record.type === "Task" &&
						record.name === name &&
						record.state === "completed" &&
						record.result === "succeeded",
				)
			)
				throw new Error(
					`native Azure acceptance step did not succeed: ${name}`,
				);
		for (const name of ["hobo_ci", "hobo_ci_verify_artifacts"])
			if (
				!timeline.records.some(
					(record) =>
						record.type === "Job" &&
						(record.identifier === name || record.name === name) &&
						record.state === "completed" &&
						record.result === "succeeded",
				)
			)
				throw new Error(`Azure job did not complete: ${name}`);
		const artifacts = parseRemote(
			AdoRemoteArtifactsSchema,
			await request(api(`build/builds/${runId}/artifacts`)),
		);
		const bundles = artifacts.value.filter(
			(artifact) =>
				artifact.name.startsWith(`${project.artifactPrefix}-`) &&
				artifact.name.length > project.artifactPrefix.length + 1 &&
				artifact.resource?.type === "PipelineArtifact",
		);
		if (!bundles.length)
			throw new Error("Azure did not retain the execution Pipeline Artifact");
		return create(AdoLiveResultSchema, {
			runId,
			sourceVersion: target.sourceVersion,
			pool: project.pool,
			result: "succeeded",
			artifactNames: bundles.map((artifact) => artifact.name),
			url: `${projectBase}/_build/results?buildId=${runId}`,
		});
	} catch (error) {
		if (runId && !completed) {
			const cancellation = AbortSignal.timeout(15000);
			try {
				await request(
					api(`build/builds/${runId}`),
					"PATCH",
					JSON.stringify({ status: "cancelling" }),
					cancellation,
				);
				for (;;) {
					const build = parseRemote(
						AdoRemoteBuildSchema,
						await request(
							api(`build/builds/${runId}`),
							"GET",
							undefined,
							cancellation,
						),
					);
					if (build.id !== runId)
						throw new Error("cancellation run identity mismatch");
					if (build.status === "completed") break;
					await delay(polling, undefined, { signal: cancellation });
				}
			} catch {
				throw new Error(
					`Azure verification failed for run ${runId}; cancellation could not be confirmed`,
					{ cause: error },
				);
			}
		}
		throw error;
	}
}
