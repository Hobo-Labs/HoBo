import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	IacDiff,
	IacDriftReport,
	IacOutputs,
	IacProgram,
	IacProvider,
} from "@hobo/cloud";
import { isJsonString } from "./json.js";

import {
	createVercelClient,
	type VercelDeploymentFile,
	type VercelFetch,
} from "./vercel-client.js";

// Explicit committed-fixture helper. Production composition deploys the exact
// approved ResourceResolver artifact and uses a durable mutation journal.

// Default Vercel tree lives next to this package (fixtures/), not under examples/.
// Both `dist/` and `src/` resolve via `../fixtures/deploy/vercel`.
function defaultTemplateDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "fixtures", "deploy", "vercel");
}

// Walk the committed artifact tree and produce the Vercel inline-files payload:
// one `{ file, data, encoding:"base64" }` per file, `file` being the POSIX path
// relative to the artifact root. This is the deploy source of truth — the app is
// NOT re-invented here; it is the exact bytes HoBo ships as the known-good target.
function readVercelFileTree(rootDir: string): VercelDeploymentFile[] {
	const files: VercelDeploymentFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			files.push({
				file: relative(rootDir, full).split("\\").join("/"),
				data: readFileSync(full).toString("base64"),
				encoding: "base64",
			});
		}
	};
	walk(rootDir);
	files.sort((a, b) => a.file.localeCompare(b.file));
	return files;
}

export interface VercelDeployProviderOptions {
	readonly fixtureArtifact?: true;
	// The Vercel access token (forwarded to `createVercelClient` as the Bearer).
	readonly token: string;
	// The transport. Defaults to global `fetch`; injected in tests.
	readonly fetch?: VercelFetch;
	// The Vercel project/deployment name. Defaults to "hobo-hello-bindle".
	readonly projectName?: string;
	// The team id, when the token is a team token.
	readonly teamId?: string;
	// The artifact directory to deploy. Defaults to
	// packages/hobo/fixtures/deploy/vercel.
	readonly templateDir?: string;
	// The deploy target. Defaults to "production".
	readonly target?: string;
}

// Build the REAL Vercel-backed `IacProvider`. Construction is network-free; the
// file tree is read and the deployment is created lazily on preview/apply.
export function createVercelDeployProvider(
	options: VercelDeployProviderOptions,
): IacProvider {
	const projectName = options.projectName ?? "hobo-hello-bindle";
	const target = options.target ?? "production";
	const templateDir = options.templateDir ?? defaultTemplateDir();
	const client = createVercelClient({
		token: options.token,
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
		...(options.teamId !== undefined ? { teamId: options.teamId } : undefined),
	});

	// One Vercel deployment realizes the whole bindle. The Executor drives the port
	// once per resource, so memoize by deploymentId: the first resource's apply
	// creates the deployment; the rest reuse its outputs. Keeps `hobo up` to a
	// single real Vercel deployment per `deployment.Planned`.
	const byDeployment = new Map<string, IacOutputs>();

	return {
		id: `vercel-deploy:${projectName}`,
		async preview(_program: IacProgram): Promise<IacDiff> {
			const files = readVercelFileTree(templateDir);
			return {
				summary: `vercel deploy ${projectName} target=${target} (${files.length} files) [dry-run; live call cred-gated]`,
				changes: files.length,
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
			const files = readVercelFileTree(templateDir);
			const result = await client.createDeployment({
				name: projectName,
				files,
				target,
			});
			const outputs: IacOutputs = {
				url: result.url,
				deploymentId: result.id,
				provider: "vercel",
				target,
			};
			byDeployment.set(program.deploymentId, outputs);
			return outputs;
		},
		async destroy(program: IacProgram): Promise<void> {
			const receipt = byDeployment.get(program.deploymentId);
			if (
				!receipt ||
				!isJsonString(receipt.deploymentId) ||
				!receipt.deploymentId
			)
				throw new Error(
					"fixture teardown requires its original provider-minted deployment receipt; use the durable resolver path after restart",
				);
			await client.deleteDeployment(receipt.deploymentId);
			byDeployment.delete(program.deploymentId);
		},
		async refresh(program: IacProgram): Promise<IacDriftReport> {
			const receipt = byDeployment.get(program.deploymentId);
			if (
				!receipt ||
				!isJsonString(receipt.deploymentId) ||
				!receipt.deploymentId
			)
				return { drift: true, observed: { contentVerified: "false" } };
			const observed = await client.getDeployment(receipt.deploymentId);
			return {
				drift: true,
				observed: {
					exists: String(observed !== undefined),
					contentVerified: "false",
					...(observed
						? {
								deploymentId: observed.id,
								readyState: observed.readyState ?? "unknown",
							}
						: undefined),
				},
			};
		},
	};
}
