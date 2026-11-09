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

// Explicit fixture deployment helper. Production composition uses exact planned
// ResourceResolvers; this helper never substitutes hello-bindle for an artifact.

// Default Worker module lives next to this package (fixtures/), not under examples/.
// Both `dist/` and `src/` resolve via `../fixtures/deploy/cloudflare/worker.mjs`.
function defaultWorkerModulePath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "fixtures", "deploy", "cloudflare", "worker.mjs");
}

export interface CloudflareDeployProviderOptions {
	/** Explicit opt-in for the committed demonstration artifact. Never enabled by
	 * environment/provider selection or the budgeted production runtime. */
	readonly fixtureArtifact?: true;
	// The Cloudflare API token (forwarded to `createCloudflareClient` as the Bearer).
	readonly token: string;
	// The Cloudflare account id (Cloudflare `account_id`).
	readonly accountId: string;
	// The transport. Defaults to global `fetch`; injected in tests.
	readonly fetch?: CloudflareFetch;
	// The Worker script name. Defaults to "hobo-hello-bindle".
	readonly scriptName?: string;
	// The ESM Worker module to upload. Defaults to
	// packages/hobo/fixtures/deploy/cloudflare/worker.mjs.
	readonly workerModulePath?: string;
}

// Build the REAL Cloudflare-backed `IacProvider`. Construction is network-free; the
// module is read and the upload happens lazily on apply.
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

	// One Cloudflare Worker realizes the whole bindle. The Executor drives the port
	// once per resource, so memoize by deploymentId: the first resource's apply
	// uploads the Worker; the rest reuse its outputs. Keeps `hobo up` to a single
	// real Worker upload per `deployment.Planned`.
	const byDeployment = new Map<string, IacOutputs>();

	return {
		id: `cloudflare-deploy:${scriptName}`,
		async preview(_program: IacProgram): Promise<IacDiff> {
			// Network-free dry run: confirm the committed module is present + non-empty.
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
			// Existence cannot prove that another actor did not replace the code.
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
