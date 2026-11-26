import type {
	WorkflowEvent,
	WorkflowStep,
	WorkflowStepConfig,
	WorkflowStepContext,
} from "cloudflare:workers";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	CIWorkflow,
	type CiContext,
	type CiParams,
	type CiWorkflowPayload,
	type CloudflareArtifacts,
} from "@cloudflare/ci";
import { type CiBindings, CiSandbox } from "@cloudflare/ci/worker";
import {
	executePipeline,
	PipelineResultSchema,
	parsePipeline,
} from "@hobo/ci/execution";
import {
	LocalHealthSchema,
	LocalNativeStatusSchema,
} from "../../src/_generated/readiness_pb.js";
import { createCloudflareBackend } from "../../src/backend.js";
import {
	assertLocalPreparation,
	localBackupOptions,
	localSourceAdapter,
} from "../../src/local-source.js";

type Bindings = CiBindings & {
	HOBO_PIPELINE_JSON: string;
	HOBO_SOURCE_SHA: string;
	HOBO_PREPARATION_ID: string;
	HOBO_PIPELINE_SHA256: string;
	HOBO_CI_ACCESS_TOKEN: string;
};

export class LocalCiSandbox extends CiSandbox {
	override createBackup(
		options: Parameters<CiSandbox["createBackup"]>[0],
	): ReturnType<CiSandbox["createBackup"]> {
		return super.createBackup(localBackupOptions(options));
	}
}

/** Local Workflows and Docker execute the same native CI context as the cloud. */
export class HoBoLocalCI extends CIWorkflow<CloudflareArtifacts, Bindings> {
	static override getProvider() {
		return localSourceAdapter();
	}

	override async run(
		event: WorkflowEvent<CiWorkflowPayload<CloudflareArtifacts>>,
		step: WorkflowStep,
	) {
		const bucket = this.env.BACKUP_BUCKET;
		// SDK 0.2.0 calls do(name, config, callback). The guard runs *inside*
		// that durable callback, so committed steps replay from the native journal.
		// An interrupted callback's admission remains: it may have caused external
		// effects and must never be repeated automatically after a process crash.
		const guarded = new Proxy(step, {
			get(target, property) {
				if (property === "sleep") return target.sleep.bind(target);
				if (property === "sleepUntil") return target.sleepUntil.bind(target);
				if (property === "waitForEvent")
					return target.waitForEvent.bind(target);
				if (property !== "do")
					throw new Error("unsupported Workflow step member");
				return (
					name: string,
					config: WorkflowStepConfig,
					callback: (
						ctx: WorkflowStepContext,
					) => Promise<Rpc.Serializable<unknown>>,
				) =>
					target.do(name, config, async (ctx) => {
						if (await bucket.head(`hobo/cancel/${event.instanceId}`))
							throw new Error("local run was cancelled");
						const admission = await bucket.put(
							`hobo/admitted/${event.instanceId}/${encodeURIComponent(name)}`,
							"admitted",
							{ onlyIf: { etagDoesNotMatch: "*" } },
						);
						if (!admission)
							throw new Error(
								"uncertain native admission: refusing to repeat an interrupted command",
							);
						return callback(ctx);
					});
			},
		});
		return super.run(event, guarded);
	}

	protected async pipeline(
		event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
		_step: WorkflowStep,
		ci: CiContext,
	): Promise<void> {
		assertLocalPreparation(
			event.payload,
			this.env.HOBO_SOURCE_SHA,
			this.env.HOBO_PREPARATION_ID,
		);
		const backend = createCloudflareBackend({
			context: ci,
			terminate: async () => {
				const instance = await this.env.CI_WORKFLOW.get(event.instanceId);
				await instance.terminate();
			},
		});
		const result = await executePipeline(
			backend,
			parsePipeline(this.env.HOBO_PIPELINE_JSON),
		);
		await this.env.BACKUP_BUCKET.put(
			`hobo/results/${event.instanceId}.json`,
			toJsonString(PipelineResultSchema, result),
		);
		if (result.status !== "succeeded")
			throw new Error(`HoBo local CI finished with ${result.status}`);
	}
}

// Trigger/status/termination use Wrangler's existing local Workflow API.
export default {
	async fetch(request, env): Promise<Response> {
		if (
			!env.HOBO_CI_ACCESS_TOKEN ||
			!/^[a-f0-9]{64}$/.test(env.HOBO_CI_ACCESS_TOKEN) ||
			request.headers.has("Origin") ||
			request.headers.get("Authorization") !==
				`Bearer ${env.HOBO_CI_ACCESS_TOKEN}`
		)
			return new Response("unauthorized", { status: 403 });
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/__hobo/health")
			return new Response(
				toJsonString(
					LocalHealthSchema,
					create(LocalHealthSchema, {
						preparationId: env.HOBO_PREPARATION_ID,
						sourceSha: env.HOBO_SOURCE_SHA,
						pipelineSha256: env.HOBO_PIPELINE_SHA256,
					}),
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		const match = /^\/__hobo\/(results|status|cancel)\/([a-f0-9-]{36})$/.exec(
			url.pathname,
		);
		if (!match) return new Response("not found", { status: 404 });
		if (match[1] === "cancel" && request.method === "POST") {
			await env.BACKUP_BUCKET.put(`hobo/cancel/${match[2]}`, "cancelled");
			const instance = await env.CI_WORKFLOW.get(match[2]);
			await instance.terminate();
			return new Response("cancelled");
		}
		if (request.method !== "GET" || match[1] === "cancel")
			return new Response("method not allowed", { status: 405 });
		if (match[1] === "status") {
			const instance = await env.CI_WORKFLOW.get(match[2]);
			const status = await instance.status();
			return new Response(
				toJsonString(
					LocalNativeStatusSchema,
					create(LocalNativeStatusSchema, {
						status: status.status,
						error: status.error?.message ?? "",
					}),
				),
				{ headers: { "Content-Type": "application/json" } },
			);
		}
		const record = await env.BACKUP_BUCKET.get(`hobo/results/${match[2]}.json`);
		return record
			? new Response(record.body, {
					headers: { "Content-Type": "application/json" },
				})
			: new Response("pending", { status: 404 });
	},
} satisfies ExportedHandler<Bindings>;
