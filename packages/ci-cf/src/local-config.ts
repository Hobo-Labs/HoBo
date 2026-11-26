import { fileURLToPath } from "node:url";
import { toJsonString } from "@bufbuild/protobuf";
import type { CiParams, CloudflareArtifacts } from "@cloudflare/ci";
import { type ParsedPipeline, PipelineSchema } from "@hobo/ci/execution";
import type { Unstable_RawConfig } from "wrangler";

export function localWorkerName(preparationId: string): string {
	return `hobo-ci-${Buffer.from(preparationId, "utf8").toString("hex")}`;
}

/** Configuration only; building, executing and deploying remain explicit actions. */
export function localConfig(
	pipeline: ParsedPipeline,
	sha: string,
	preparationId: string,
	port = 8787,
) {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
		throw new Error("local source must be a resolved Git commit");
	return {
		name: localWorkerName(preparationId),
		main: fileURLToPath(new URL("../examples/local/index.ts", import.meta.url)),
		// Wrangler 4.114.0's bundled workerd supports dates through July 29.
		compatibility_date: "2026-07-29",
		compatibility_flags: ["nodejs_compat"],
		workers_dev: false,
		send_metrics: false,
		dev: { ip: "127.0.0.1", port, enable_containers: true },
		containers: [
			{
				class_name: "LocalCiSandbox",
				image: "./Dockerfile",
				image_build_context: ".",
				max_instances: 1,
			},
		],
		durable_objects: {
			bindings: [{ name: "SANDBOX", class_name: "LocalCiSandbox" }],
		},
		migrations: [{ tag: "v1", new_sqlite_classes: ["LocalCiSandbox"] }],
		workflows: [
			{
				name: "hobo-ci-cf-local",
				binding: "CI_WORKFLOW",
				class_name: "HoBoLocalCI",
			},
		],
		r2_buckets: [
			{
				binding: "BACKUP_BUCKET",
				bucket_name: "hobo-ci-cf-local-snapshots",
				remote: false,
			},
		],
		vars: {
			HOBO_SOURCE_SHA: sha,
			HOBO_PREPARATION_ID: preparationId,
			HOBO_PIPELINE_JSON: toJsonString(PipelineSchema, pipeline),
		},
	} satisfies Unstable_RawConfig;
}

/** SDK-native trigger parameters; local provider never contacts Artifacts. */
export function localParams(
	sha: string,
	preparationId: string,
): CiParams<CloudflareArtifacts> {
	return {
		provider: "cloudflare-artifacts",
		providerData: { namespace: preparationId },
		event: { type: "push" },
		owner: "local",
		repo: "workspace",
		sha,
		trigger: "push",
		ref: "refs/heads/local",
	};
}
