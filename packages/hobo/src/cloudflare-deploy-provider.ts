import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	IacDiff,
	IacDriftReport,
	IacOutputs,
	IacProgram,
	IacProvider,
} from "@hobo/cloud";

import {
	type CloudflareFetch,
	createCloudflareClient,
} from "./cloudflare-client.js";

function defaultWorkerModulePath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "fixtures", "deploy", "cloudflare", "worker.mjs");
}

export interface CloudflareDeployProviderOptions {
	readonly fixtureArtifact?: true;
	readonly token: string;
	readonly accountId: string;
	readonly fetch?: CloudflareFetch;
	readonly scriptName?: string;
	readonly workerModulePath?: string;
}

export function createCloudflareDeployProvider(
	options: CloudflareDeployProviderOptions,
): IacProvider {
	const scriptName = options.scriptName ?? "hobo-hello-bindle";
	const workerModulePath =
		options.workerModulePath ?? defaultWorkerModulePath();
	const client = createCloudflareClient({
		token: options.token,
		accountId: options.accountId,
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
	});

	const byDeployment = new Map<string, IacOutputs>();

	return {
		id: `cloudflare-deploy:${scriptName}`,
		async preview(_program: IacProgram): Promise<IacDiff> {
			const bytes = readFileSync(workerModulePath, "utf-8").length;
			return {
				summary: `cloudflare deploy ${scriptName} (worker.mjs ${bytes} bytes) [dry-run; live call cred-gated]`,
				changes: 1,
			};
		},
		async apply(program: IacProgram): Promise<IacOutputs> {
			if (options.fixtureArtifact !== true)
				throw new Error(
					"fixture deploy requires explicit fixtureArtifact:true; production hosting requires the approved resolver artifact",
				);
			const cached = byDeployment.get(program.deploymentId);
			if (cached !== undefined) {
				return cached;
			}
			const moduleContent = readFileSync(workerModulePath, "utf-8");
			const result = await client.uploadWorker({
				scriptName,
				moduleContent,
				enableSubdomain: true,
			});
			const outputs: IacOutputs = {
				url: result.url,
				scriptName: result.scriptName,
				provider: "cloudflare",
				target: "production",
			};
			byDeployment.set(program.deploymentId, outputs);
			return outputs;
		},
		async destroy(program: IacProgram): Promise<void> {
			if (!byDeployment.has(program.deploymentId))
				throw new Error(
					"fixture teardown requires the original deployment receipt; use the durable resolver path after restart",
				);
			await client.deleteWorker(scriptName);
			byDeployment.delete(program.deploymentId);
		},
		async refresh(_program: IacProgram): Promise<IacDriftReport> {
			const exists = await client.scriptExists(scriptName);
			return {
				drift: true,
				observed: {
					scriptName,
					provider: "cloudflare",
					exists: String(exists),
					contentVerified: "false",
				},
			};
		},
	};
}
