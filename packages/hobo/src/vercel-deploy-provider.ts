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
	afterConflict,
	createVercelClient,
	isProjectNotFound,
	normalizeVercelTeamId,
	VercelApiError,
	type VercelDeploymentFile,
	type VercelDeploymentResult,
	type VercelFetch,
} from "./vercel-client.js";

// Explicit committed-fixture helper. Production composition deploys the exact
// approved ResourceResolver artifact and uses a durable mutation journal.
//
// On `apply` (with `fixtureArtifact: true`) it reads the committed Vercel file
// tree (packages/hobo/fixtures/deploy/vercel/) and posts it via
// `createVercelClient`. Only when Vercel answers that the project does not
// exist (404 `not_found`, "Project not found": the first deploy from a fresh
// account) does it create the project and deploy once more; any other
// refusal, and a second one, propagates as a `VercelApiError`. A create
// answered 409 `conflict` means someone made the project meanwhile, and a
// refusal of the deployment after it names that 409's reason; any other 409
// propagates. A deploy to an existing project makes no other call, so a
// credential scoped to deployments alone keeps working.
//
// The project is created in the scope `teamId` names, or in the token's own
// scope when there is none. Vercel answers "Project not found" for a project
// that exists only in another scope, so a missing `teamId`, or a wrong one the
// token can still deploy to, makes a second project there rather than failing.
// The outputs say what happened: `projectCreated` is "true" when this
// deployment created the project, and `scope` is the `teamId`, or
// "token-default" when there is none: whatever scope Vercel gives a request
// with no `teamId`, which for a team's token need not be personal
// (`IacOutputs` values are strings).

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
	// The Vercel project/deployment name. Defaults to "hobo-hello-bindle". The
	// project is created when a deploy finds the account has none by that name.
	readonly projectName?: string;
	// The team id, when the project lives in a team. Without it, every request
	// (and a project create) is in the token's own scope. Trimmed, and blank
	// taken as none (`normalizeVercelTeamId`).
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
	const teamId = normalizeVercelTeamId(options.teamId);
	const scope = teamId ?? "token-default";
	const client = createVercelClient({
		token: options.token,
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
		...(teamId !== undefined ? { teamId } : undefined),
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
			const request = { name: projectName, files, target };
			let result: VercelDeploymentResult;
			let projectCreated = false;
			try {
				result = await client.createDeployment(request);
			} catch (error) {
				if (!(error instanceof Error) || !isProjectNotFound(error)) throw error;
				// A 409 `conflict` here means someone made it meanwhile: it exists
				// either way.
				const project = await client.createProject(projectName);
				projectCreated = project.created;
				// Once only: a refusal of this deployment propagates, naming the
				// 409 that answered the create, when one did.
				try {
					result = await client.createDeployment(request);
				} catch (retryError) {
					if (project.created || !(retryError instanceof VercelApiError)) {
						throw retryError;
					}
					throw afterConflict(retryError, project);
				}
			}
			const outputs: IacOutputs = {
				url: result.url,
				deploymentId: result.id,
				provider: "vercel",
				target,
				projectCreated: String(projectCreated),
				scope,
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
