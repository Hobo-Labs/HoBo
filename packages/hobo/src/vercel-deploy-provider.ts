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
	type CreateDeploymentInput,
	type CreateGitDeploymentInput,
	createVercelClient,
	isProjectNotFound,
	normalizeVercelTeamId,
	VercelApiError,
	type VercelClient,
	type VercelDeploymentFile,
	type VercelDeploymentResult,
	type VercelFetch,
	type VercelPlannedRequest,
	type VercelProjectEnvResult,
	type VercelProjectResult,
	vercelEnvCreateRequest,
	vercelEnvListRequest,
	vercelGitDeploymentRequest,
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

//
// GIT ARTIFACT (`gitArtifact`, the explicit alternative to `fixtureArtifact`).
// A workspace package Vercel must build from the repository (HoBo's own CI
// relay, `packages/ci-vercel`) is not a file tree to upload: it is a commit.
// In this mode `apply` first sets the non-secret `configuration` on the
// project for the target's environment (`setProjectEnv`: read, then create or
// edit only what differs), then posts one Create Deployment with a
// `gitSource`. The target is PREVIEW unless `target: "production"` says
// otherwise: nothing reaches production by default. The project is created on
// "Project not found" exactly as above, unless `createMissingProject: false`
// turns that off, which is what a deploy to a project that must already exist
// (a live service in a team) wants: with it, a wrong or missing `teamId` is a
// refusal, not a second project. The outputs add `artifact` ("git"),
// `gitRepository`, `gitRef` and `gitSha`, and `configCreated`,
// `configUpdated` and `configUnchanged`: the variable names, comma-joined,
// never a value. Secrets and storage are not this mode's: it refuses a
// secret-looking name before any request, and provisions nothing.

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

// A commit Vercel builds the deployment from, in place of a file tree.
export interface VercelGitArtifact {
	// The GitHub owner and repository name.
	readonly org: string;
	readonly repo: string;
	// A branch, a tag or a commit sha.
	readonly ref: string;
	// The full commit sha, to pin what `ref` names.
	readonly sha?: string;
	// The directory of the repository the project builds (Vercel
	// `projectSettings.rootDirectory`). Vercel saves it on the project, so it is
	// sent only when given: an existing project keeps its own.
	readonly rootDirectory?: string;
}

// What `planVercelGitDeployment` says a git-artifact `apply` would send.
export interface VercelGitDeploymentPlan {
	readonly project: string;
	readonly scope: string;
	readonly target: "preview" | "production";
	readonly createMissingProject: boolean;
	// The variable names `configuration` holds, sorted.
	readonly configuration: readonly string[];
	// Each request and when it is sent.
	readonly requests: readonly (VercelPlannedRequest & {
		readonly when: string;
	})[];
}

export interface VercelDeployProviderOptions {
	readonly fixtureArtifact?: true;
	// Deploy this commit instead of a file tree. Not with `fixtureArtifact`.
	readonly gitArtifact?: VercelGitArtifact;
	// Non-secret project configuration to set, for the target's environment,
	// before a git deployment (`setProjectEnv`). Git artifact only.
	readonly configuration?: Readonly<Record<string, string>>;
	// Whether a git deployment creates the project when Vercel answers that it
	// does not exist. Defaults to true, as the fixture path always does.
	readonly createMissingProject?: boolean;
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
	// The deploy target. The fixture path defaults to "production". A git
	// artifact defaults to "preview" and takes "preview" or "production" only.
	readonly target?: string;
}

// The parts of a git deployment the provider and its plan both work from.
interface GitDeployment {
	readonly project: string;
	readonly target: "preview" | "production";
	readonly createMissingProject: boolean;
	readonly configuration: Readonly<Record<string, string>>;
	readonly request: CreateGitDeploymentInput;
}

function gitDeploymentOf(
	options: Omit<VercelDeployProviderOptions, "token" | "fetch">,
	artifact: VercelGitArtifact,
): GitDeployment {
	if (options.fixtureArtifact === true)
		throw new TypeError(
			"createVercelDeployProvider: choose fixtureArtifact or gitArtifact, not both",
		);
	if (options.templateDir !== undefined)
		throw new TypeError(
			"createVercelDeployProvider: templateDir is the fixture path's; a git artifact deploys a commit",
		);
	const project = options.projectName;
	if (project === undefined || project === "")
		throw new TypeError(
			"createVercelDeployProvider: a git artifact needs an explicit projectName",
		);
	const asked = options.target ?? "preview";
	if (asked !== "preview" && asked !== "production")
		throw new TypeError(
			'createVercelDeployProvider: a git artifact deploys to "preview" (the default) or "production"',
		);
	return {
		project,
		target: asked,
		createMissingProject: options.createMissingProject ?? true,
		configuration: options.configuration ?? {},
		request: {
			name: project,
			project,
			gitSource: {
				type: "github",
				org: artifact.org,
				repo: artifact.repo,
				ref: artifact.ref,
				...(artifact.sha !== undefined ? { sha: artifact.sha } : undefined),
			},
			// Vercel reads a request with no `target` as preview.
			...(asked === "production" ? { target: asked } : undefined),
			...(artifact.rootDirectory !== undefined
				? { projectSettings: { rootDirectory: artifact.rootDirectory } }
				: undefined),
		},
	};
}

// What a git-artifact `apply` would send, formed by the functions the client
// sends with and with no client, no token and no network: the requests of a
// dry run. The configuration requests depend on what the project already
// holds, so each possible create is listed and says when it is sent.
export function planVercelGitDeployment(
	options: Omit<VercelDeployProviderOptions, "token" | "fetch">,
): VercelGitDeploymentPlan {
	if (options.gitArtifact === undefined)
		throw new TypeError("planVercelGitDeployment: gitArtifact is required");
	const git = gitDeploymentOf(options, options.gitArtifact);
	const teamId = normalizeVercelTeamId(options.teamId);
	const names = Object.keys(git.configuration).sort();
	return {
		project: git.project,
		scope: teamId ?? "token-default",
		target: git.target,
		createMissingProject: git.createMissingProject,
		configuration: names,
		requests: [
			...(names.length > 0
				? [
						{
							...vercelEnvListRequest(git.project, teamId),
							when: "always: read what the project holds, before any write",
						},
					]
				: []),
			...names.map((key) => ({
				...vercelEnvCreateRequest(
					{
						project: git.project,
						target: git.target,
						key,
						value: git.configuration[key] ?? "",
					},
					teamId,
				),
				when: `only if ${key} is not set for ${git.target}; a plain ${git.target}-only value that differs is edited instead, and one already as asked is left alone`,
			})),
			{
				...vercelGitDeploymentRequest(git.request, teamId),
				when: "always: one deployment, built by Vercel from the commit",
			},
		],
	};
}

// Deploy `request`; when Vercel answers that its project does not exist and
// `createMissing` allows, create the project and deploy once more. A create
// answered 409 `conflict` means someone made it meanwhile, and a refusal of
// the deployment after it names that 409's reason.
async function deployCreatingProject(
	client: VercelClient,
	request: CreateDeploymentInput | CreateGitDeploymentInput,
	projectName: string,
	createMissing: boolean,
): Promise<{
	readonly result: VercelDeploymentResult;
	readonly projectCreated: boolean;
}> {
	try {
		return {
			result: await client.createDeployment(request),
			projectCreated: false,
		};
	} catch (error) {
		if (
			!createMissing ||
			!(error instanceof Error) ||
			!isProjectNotFound(error)
		)
			throw error;
		// A 409 `conflict` here means someone made it meanwhile: it exists
		// either way.
		const project = await client.createProject(projectName);
		// Once only: a refusal of this deployment propagates, naming the
		// 409 that answered the create, when one did.
		try {
			return {
				result: await client.createDeployment(request),
				projectCreated: project.created,
			};
		} catch (retryError) {
			if (project.created || !(retryError instanceof VercelApiError)) {
				throw retryError;
			}
			throw afterConflict(retryError, project);
		}
	}
}

// Set a git deployment's configuration; when Vercel answers that the project
// does not exist and `createMissingProject` allows, create it and set once
// more. `project` is the create's answer when one was made.
async function configureCreatingProject(
	client: VercelClient,
	git: GitDeployment,
): Promise<{
	readonly env: VercelProjectEnvResult;
	readonly project: VercelProjectResult | undefined;
}> {
	const input = {
		project: git.project,
		target: git.target,
		variables: git.configuration,
	};
	try {
		return { env: await client.setProjectEnv(input), project: undefined };
	} catch (error) {
		if (
			!git.createMissingProject ||
			!(error instanceof Error) ||
			!isProjectNotFound(error)
		)
			throw error;
		const project = await client.createProject(git.project);
		try {
			return { env: await client.setProjectEnv(input), project };
		} catch (retryError) {
			if (project.created || !(retryError instanceof VercelApiError)) {
				throw retryError;
			}
			throw afterConflict(retryError, project);
		}
	}
}

// Build the REAL Vercel-backed `IacProvider`. Construction is network-free; the
// file tree is read and the deployment is created lazily on preview/apply.
export function createVercelDeployProvider(
	options: VercelDeployProviderOptions,
): IacProvider {
	// A git artifact is checked here, at construction: a wrong target or a
	// missing project name never reaches `apply`.
	const git =
		options.gitArtifact !== undefined
			? gitDeploymentOf(options, options.gitArtifact)
			: undefined;
	if (git === undefined && options.configuration !== undefined)
		throw new TypeError(
			"createVercelDeployProvider: configuration is set before a git deployment; the fixture path sets none",
		);
	const projectName =
		git?.project ?? options.projectName ?? "hobo-hello-bindle";
	const target = git?.target ?? options.target ?? "production";
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
			if (git !== undefined) {
				const { gitSource } = git.request;
				const names = Object.keys(git.configuration);
				return {
					summary: `vercel deploy ${projectName} target=${target} git=${gitSource.org}/${gitSource.repo}@${gitSource.sha ?? gitSource.ref} (${names.length} settings) [dry-run; live call cred-gated]`,
					changes: names.length + 1,
				};
			}
			const files = readVercelFileTree(templateDir);
			return {
				summary: `vercel deploy ${projectName} target=${target} (${files.length} files) [dry-run; live call cred-gated]`,
				changes: files.length,
			};
		},
		async apply(program: IacProgram): Promise<IacOutputs> {
			if (git !== undefined) {
				const cached = byDeployment.get(program.deploymentId);
				if (cached !== undefined) return cached;
				// Configuration first: the build reads it. With none to set there
				// is no project call, and the deployment is the first request.
				const configured = await configureCreatingProject(client, git);
				const deployed = await deployCreatingProject(
					client,
					git.request,
					projectName,
					git.createMissingProject,
				);
				const { gitSource } = git.request;
				const outputs: IacOutputs = {
					url: deployed.result.url,
					deploymentId: deployed.result.id,
					provider: "vercel",
					target,
					projectCreated: String(
						deployed.projectCreated || configured.project?.created === true,
					),
					scope,
					artifact: "git",
					gitRepository: `${gitSource.org}/${gitSource.repo}`,
					gitRef: gitSource.ref,
					gitSha: gitSource.sha ?? "",
					configCreated: configured.env.created.join(","),
					configUpdated: configured.env.updated.join(","),
					configUnchanged: configured.env.unchanged.join(","),
				};
				byDeployment.set(program.deploymentId, outputs);
				return outputs;
			}
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
			const { result, projectCreated } = await deployCreatingProject(
				client,
				request,
				projectName,
				true,
			);
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
