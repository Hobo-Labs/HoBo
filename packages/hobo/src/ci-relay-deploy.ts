// `hobo ci deploy` — deploy the hosted CI relay with HoBo itself.
//
// The relay is a HoBo app (`packages/ci-vercel/src/bindle.ts`), built by Vercel
// from the git repository. This verb loads that Bindle from the project
// directory, checks it names no provider, and realizes it as one git-source
// Vercel deployment through `createVercelDeployProvider`'s git-artifact mode:
// the non-secret settings first, then the deployment, each of the Bindle's
// resources applied through the provider (which deploys once).
//
// The target is chosen HERE, where the deploy is run, not in the Bindle; and
// it is PREVIEW unless `--target production` says otherwise.
//
// What it deliberately does not do: set a secret (a `--set` must name a field
// the app's `config()` schema declares non-secret, and pass the name and value
// screen in `vercel-env-policy.ts`), provision a database or a storage
// integration, or create the project unless `--create-project` asks.
//
// `--dry-run` forms the plan (`VercelGitDeploymentPlan`,
// data-models/vercel_git_deployment.proto) with the same functions the client
// sends with, reads no token and opens no connection.
//
// HONEST SCOPE: exercised against a fake transport only. No live deployment has
// been made from this repository through this verb.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { create, toJson } from "@bufbuild/protobuf";
import {
	assertNoBindleProviderSelection,
	type BindleDefinition,
} from "@hobo/bindles";
import {
	BINDLE_SOURCE_CANDIDATES,
	type CommandResult,
	loadBindleDefinition,
} from "@hobo/cli";
import type { IacOutputs, IacProgram } from "@hobo/cloud";

import {
	type VercelGitDeploymentPlan,
	VercelGitDeploymentPlanSchema,
} from "./_generated/vercel_git_deployment_pb.js";
import { validRepository } from "./ci-repository.js";
import { isJsonObject, isJsonString } from "./json.js";
import {
	VercelApiError,
	VercelEnvRefusal,
	type VercelFetch,
	VercelTransportError,
} from "./vercel-client.js";
import {
	createVercelDeployProvider,
	planVercelGitDeployment,
	type VercelDeployProviderOptions,
} from "./vercel-deploy-provider.js";
import {
	refusedEnvKeyReason,
	refusedEnvValueReason,
} from "./vercel-env-policy.js";

// The options of `hobo ci deploy`, as `parseCiArgs` names them.
export const CI_DEPLOY_OPTIONS = [
	"repo",
	"ref",
	"sha",
	"project",
	"target",
	"team",
	"set",
	"root-directory",
	"create-project",
	"dry-run",
] as const;

// The ones no other `hobo ci` command takes.
export const CI_DEPLOY_ONLY_OPTIONS = [
	"ref",
	"sha",
	"project",
	"target",
	"team",
	"set",
	"root-directory",
	"create-project",
] as const;

export interface CiRelayDeployInput {
	// The relay's project directory: the one that holds `src/bindle.ts`.
	readonly cwd: string;
	// The parsed `hobo ci` options.
	readonly values: Readonly<
		Record<string, string | boolean | string[] | undefined>
	>;
	// Read for `VERCEL_TOKEN` (a real run only) and `VERCEL_TEAM_ID`.
	readonly env: NodeJS.ProcessEnv;
	// The Vercel transport; injected in tests, the global `fetch` otherwise.
	readonly fetch?: VercelFetch;
	readonly emitProgress: (message: string) => void;
}

const PLAN_SCHEMA_VERSION = "hobo.vercel-git-deployment-plan/v1";

// A canonical Vercel team id, as `selectIacProvider` requires of
// `VERCEL_TEAM_ID`: a slug or a name would select no team, or another.
const TEAM_ID = /^team_[A-Za-z0-9]+$/u;

// A directory of the repository: relative, and never above it.
const ROOT_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function refused(code: string, message: string): CommandResult {
	return { ok: false, status: "rejected", code, message };
}

// One setting the app's `config()` schema declares, and whether it is a secret.
interface DeclaredSetting {
	readonly name: string;
	readonly sensitive: boolean;
}

// The settings the project's Bindle module declares: the fields of the
// `config()` schema it exports, under any name. A field that does not say it is
// non-secret is taken as a secret. Undefined when the module exports no schema.
async function declaredSettings(
	projectDir: string,
): Promise<readonly DeclaredSetting[] | undefined> {
	for (const candidate of BINDLE_SOURCE_CANDIDATES) {
		const absolute = path.join(projectDir, candidate);
		if (!existsSync(absolute)) continue;
		let module: object;
		try {
			module = await import(pathToFileURL(absolute).href);
		} catch {
			// The loader reported why, if this was the module it needed.
			continue;
		}
		for (const exported of Object.values(module)) {
			if (
				!isJsonObject(exported) ||
				exported.kind !== "config-schema" ||
				!isJsonObject(exported.fields)
			)
				continue;
			return Object.entries(exported.fields).map(([name, field]) => ({
				name,
				sensitive: !isJsonObject(field) || field.sensitive !== false,
			}));
		}
	}
	return undefined;
}

// `--set NAME=value`, split at the first `=`.
function parseSettings(
	raw: readonly string[],
): ReadonlyMap<string, string> | string {
	const settings = new Map<string, string>();
	for (const entry of raw) {
		const at = entry.indexOf("=");
		if (at <= 0) return "--set takes NAME=value.";
		const name = entry.slice(0, at);
		if (settings.has(name)) return "--set names a setting twice.";
		settings.set(name, entry.slice(at + 1));
	}
	return settings;
}

// Why a setting may not be set here, or undefined when it may. The reason
// names a setting only when the app declares it: a name the app never declared
// is whatever was typed, and is not echoed any more than a value is.
function settingRefusal(
	name: string,
	value: string,
	bindle: string,
	declared: readonly DeclaredSetting[] | undefined,
): string | undefined {
	const field = declared?.find((candidate) => candidate.name === name);
	if (field?.sensitive === true)
		return `${name} is declared a secret by ${bindle}; the operator or a storage integration sets it, never this command`;
	const byName = refusedEnvKeyReason(name);
	if (byName !== undefined) return `its name ${byName}`;
	if (field === undefined)
		return `it is not a setting ${bindle} declares (its config() schema lists the settings a deploy may set)`;
	const byValue = refusedEnvValueReason(value);
	if (byValue !== undefined) return `the value given for ${name} ${byValue}`;
	return undefined;
}

// The plan as its dry run prints it: who deploys what where, and each request.
function describePlan(plan: VercelGitDeploymentPlan): string {
	const source = plan.gitSource;
	const commit =
		source === undefined
			? ""
			: `${source.org}/${source.repo}@${source.ref}${source.sha ? ` (${source.sha})` : ""}`;
	const lines = [
		`Deploy ${plan.bindle} (${plan.resources.map((resource) => `${resource.kind} ${resource.name}`).join(", ")})`,
		`  to Vercel project ${plan.project}, scope ${plan.scope}, target ${plan.target}`,
		`  from github ${commit}`,
		plan.createMissingProject
			? "  creating the project if Vercel has none by that name"
			: "  into a project that must already exist (pass --create-project to create it)",
		plan.settings.length > 0
			? `Settings set for ${plan.target} first (non-secret): ${plan.settings.map((setting) => `${setting.key}=${setting.value}`).join(" ")}`
			: "Settings: none set",
		plan.operatorSecrets.length > 0
			? `Not set by this command (the operator or a storage integration holds them): ${plan.operatorSecrets.join(", ")}`
			: "Declared secrets: none",
		"Requests to https://api.vercel.com:",
		...plan.requests.flatMap((request, index) => [
			`  ${index + 1}. ${request.method} ${request.path}`,
			...(request.body !== "" ? [`     ${request.body}`] : []),
			`     ${request.when}`,
		]),
	];
	return lines.join("\n");
}

function programFor(
	definition: BindleDefinition,
	resourceId: string,
	deploymentId: string,
): IacProgram {
	return {
		programId: `${deploymentId}:${resourceId}`,
		deploymentId,
		resourceId,
		provider: "vercel",
		driver: "vercel",
		action: "apply",
		stackName: `${definition.name}-${resourceId}`,
	};
}

export async function runCiRelayDeploy(
	input: CiRelayDeployInput,
): Promise<CommandResult> {
	const { values, env } = input;
	const text = (key: string) => {
		const value = values[key];
		return isJsonString(value) && value !== "" ? value : undefined;
	};

	const repository = text("repo");
	if (repository === undefined || !validRepository(repository))
		return usage(
			"hobo ci deploy needs --repo <owner/name>: the GitHub repository Vercel builds.",
		);
	const [org = "", repo = ""] = repository.split("/");
	const ref = text("ref");
	if (ref === undefined)
		return usage(
			"hobo ci deploy needs --ref <branch|tag|sha>: the git ref to deploy.",
		);
	const project = text("project");
	if (project === undefined)
		return usage("hobo ci deploy needs --project <name>: the Vercel project.");
	const target = text("target") ?? "preview";
	if (target !== "preview" && target !== "production")
		return usage(
			"--target is preview (the default) or production; production is never implied.",
		);
	const teamId = text("team") ?? env.VERCEL_TEAM_ID;
	if (teamId !== undefined && teamId !== "" && !TEAM_ID.test(teamId))
		return usage(
			"The Vercel team must be the canonical team id (team_ and the rest), from --team or VERCEL_TEAM_ID; a slug or a name selects no team.",
		);
	const rawSettings = values.set;
	const settings = parseSettings(Array.isArray(rawSettings) ? rawSettings : []);
	if (isJsonString(settings)) return usage(settings);

	let definition: BindleDefinition | null;
	try {
		definition = await loadBindleDefinition(input.cwd);
	} catch {
		definition = null;
	}
	if (definition === null)
		return usage(
			"No Bindle found here. Run hobo ci deploy in the relay's project directory (the one with src/bindle.ts), or pass --cwd packages/ci-vercel.",
		);
	try {
		assertNoBindleProviderSelection(definition);
	} catch {
		return refused(
			"HOBO_CI_DEPLOY_BINDLE_PROVIDER",
			`${definition.name} names a provider. A Bindle stays provider-neutral; the target is chosen where the deploy is run.`,
		);
	}
	const resources = Object.values(definition.resources)
		.map((resource) => ({ kind: resource.kind, name: resource.name }))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (!resources.some((resource) => resource.kind === "api"))
		return refused(
			"HOBO_CI_DEPLOY_NO_HTTP_ENTRY",
			`${definition.name} declares no api resource, so there is no HTTP entry to deploy.`,
		);

	const declared = await declaredSettings(input.cwd);
	let position = 0;
	for (const [name, value] of settings) {
		position += 1;
		const reason = settingRefusal(name, value, definition.name, declared);
		if (reason !== undefined)
			return refused(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				`Refused --set number ${position}: ${reason}. Nothing was sent.`,
			);
	}

	const sha = text("sha");
	const rootDirectory = text("root-directory");
	if (
		rootDirectory !== undefined &&
		(!ROOT_DIRECTORY.test(rootDirectory) || rootDirectory.includes(".."))
	)
		return usage(
			"--root-directory is a directory of the repository, such as packages/ci-vercel.",
		);
	const options: Omit<VercelDeployProviderOptions, "token" | "fetch"> = {
		projectName: project,
		target,
		createMissingProject: values["create-project"] === true,
		configuration: Object.fromEntries(settings),
		gitArtifact: {
			org,
			repo,
			ref,
			...(sha !== undefined ? { sha } : undefined),
			...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		},
		...(teamId !== undefined && teamId !== "" ? { teamId } : undefined),
	};

	let plan: VercelGitDeploymentPlan;
	try {
		const requests = planVercelGitDeployment(options);
		plan = create(VercelGitDeploymentPlanSchema, {
			schemaVersion: PLAN_SCHEMA_VERSION,
			bindle: definition.name,
			resources,
			project: requests.project,
			scope: requests.scope,
			target: requests.target,
			gitSource: {
				type: "github",
				org,
				repo,
				ref,
				sha: sha ?? "",
				rootDirectory: rootDirectory ?? "",
			},
			createMissingProject: requests.createMissingProject,
			settings: [...settings].map(([key, value]) => ({ key, value })),
			operatorSecrets: (declared ?? [])
				.filter((field) => field.sensitive)
				.map((field) => field.name)
				.sort(),
			requests: requests.requests.map((request) => ({
				method: request.method,
				path: request.path,
				body: request.body !== undefined ? JSON.stringify(request.body) : "",
				when: request.when,
			})),
		});
	} catch (error) {
		// The client's own checks: a ref that is not a ref, a sha that is not a
		// commit sha. Their messages are fixed text and quote no input.
		return usage(
			error instanceof TypeError
				? error.message
				: "hobo ci deploy could not form the deployment request.",
		);
	}
	const planJson = toJson(VercelGitDeploymentPlanSchema, plan);

	if (values["dry-run"] === true)
		return {
			status: "dry-run",
			code: "HOBO_CI_DEPLOY_PLANNED",
			message: `Dry run: nothing was sent to Vercel, and VERCEL_TOKEN was not read.\n${describePlan(plan)}`,
			data: { command: "ci deploy", dryRun: true, plan: planJson },
		};

	const token = env.VERCEL_TOKEN;
	if (token === undefined || token === "")
		return {
			ok: false,
			status: "authentication-required",
			code: "HOBO_CI_DEPLOY_AUTH_REQUIRED",
			message:
				"Set VERCEL_TOKEN to a Vercel access token for the project's scope, or pass --dry-run to see what would be sent. The token is read from the environment only and is never printed.",
		};
	// Whatever a result says, it does not say the token: a Vercel answer is
	// redacted where it is read, and this is the last line before the terminal.
	const withoutToken = (value: string) => value.split(token).join("[redacted]");

	input.emitProgress(
		`deploying ${definition.name} to Vercel project ${project} (${target}) from ${org}/${repo}@${sha ?? ref}`,
	);
	try {
		const provider = createVercelDeployProvider({
			...options,
			token,
			...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
		});
		const deploymentId = `hobo-ci-deploy-${randomUUID()}`;
		// The provider realizes the whole Bindle as one deployment: the first
		// resource's apply deploys, and the rest answer with the same outputs.
		let outputs: IacOutputs = {};
		for (const resource of resources)
			outputs = await provider.apply(
				programFor(definition, resource.name, deploymentId),
			);
		const safe = Object.fromEntries(
			Object.entries(outputs).map(([key, value]) => [key, withoutToken(value)]),
		);
		return {
			code: "HOBO_CI_DEPLOYED",
			message: [
				`Deployed ${definition.name} to Vercel project ${project} (${safe.target}): ${safe.url}`,
				...Object.entries(safe).map(([key, value]) => `  ${key}: ${value}`),
			].join("\n"),
			data: {
				command: "ci deploy",
				dryRun: false,
				plan: planJson,
				outputs: safe,
			},
		};
	} catch (error) {
		if (error instanceof VercelEnvRefusal)
			return refused(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				withoutToken(error.message),
			);
		if (error instanceof VercelApiError)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_VERCEL_REFUSED",
				message: withoutToken(
					`Vercel refused the deploy (HTTP ${error.status}). ${error.message}`,
				),
				data: { status: error.status },
			};
		if (error instanceof VercelTransportError)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_NO_ANSWER",
				message: withoutToken(error.message),
			};
		if (error instanceof TypeError) return usage(withoutToken(error.message));
		return {
			ok: false,
			code: "HOBO_CI_DEPLOY_FAILED",
			message:
				"hobo ci deploy failed before Vercel answered. Run it with --dry-run to check the plan.",
		};
	}
}
