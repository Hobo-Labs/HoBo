// `hobo ci deploy` — deploy the hosted CI relay with HoBo itself.
//
// The relay is a HoBo app (`packages/ci-vercel/src/bindle.ts`), built by Vercel
// from the git repository. This verb loads that Bindle from the project
// directory, checks it names no provider, and places it with the relay's Yard
// (`deploy/yard.ts`, `ci-relay-yard.ts`): the Yard names the provider, the
// project and repository, and the binding rows; the Camp the target names
// chooses the rows its environment requires, and those rows project the
// non-secret settings (the config service's coordinates among them). It then
// realizes the Bindle as one git-source deployment through
// `createVercelDeployProvider`'s git-artifact mode: the settings first, then
// the deployment, each of the Bindle's resources applied through the provider
// (which deploys once). Only Vercel Yards are realized here today.
//
// The target is chosen HERE, where the deploy is run, not in the Bindle; and
// it is PREVIEW unless `--target production` says otherwise. The deploy
// workflow on `main` (`.github/workflows/relay-deploy.yml`) asks for
// production; a deploy run by hand lands in preview.
//
// `--provision` first attaches the chosen Marketplace bindings (the cache)
// with the Vercel CLI, idempotently (`ci-relay-provision.ts`). `--wait` waits
// for the deployment to be READY before answering.
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

import { execFile } from "node:child_process";
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
	type ParsedSecretStoreBinding,
	SECRET_STORE_BINDING_FILE,
} from "@hobo/secret-store-claim";

import {
	type VercelGitDeploymentPlan,
	VercelGitDeploymentPlanSchema,
} from "./_generated/vercel_git_deployment_pb.js";
import {
	type AttachmentResult,
	describeAttachments,
	planRelayProvisioning,
	provisionRelayAttachments,
	type VercelCliRunner,
} from "./ci-relay-provision.js";
import {
	loadRelayYard,
	type RelayPlacement,
	RelayPlacementRefusal,
	resolveRelayPlacement,
} from "./ci-relay-yard.js";
import { validRepository } from "./ci-repository.js";
import {
	loadSecretStoreBinding,
	SecretStoreBindingRefusal,
	secretStoreDeployInputs,
} from "./ci-secret-store.js";
import { isJsonNumber, isJsonObject, isJsonString } from "./json.js";
import {
	createVercelClient,
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
	"provision",
	"wait",
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
	"provision",
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
	// The Vercel CLI `--provision` runs; injected in tests. Otherwise the
	// executable `HOBO_VERCEL_CLI` names, or `vercel` on the PATH.
	readonly runVercelCli?: VercelCliRunner;
	// `--wait`'s clock; injected in tests.
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly emitProgress: (message: string) => void;
}

// How long `--wait` waits for READY, and how often it asks.
const WAIT_LIMIT_MS = 15 * 60_000;
const WAIT_INTERVAL_MS = 10_000;

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
	placement: RelayPlacement,
): string | undefined {
	if (placement.settings.has(name))
		return `Camp ${placement.camp}'s bindings set ${name}; change the Yard, not the command`;
	// A binding's input is a non-secret setting the Yard declares.
	const field = placement.inputs.includes(name)
		? { name, sensitive: false }
		: declared?.find((candidate) => candidate.name === name);
	if (field?.sensitive === true)
		return `${name} is declared a secret by ${bindle}; the operator or a storage integration sets it, never this command`;
	const byName = refusedEnvKeyReason(name);
	if (byName !== undefined) return `its name ${byName}`;
	if (field === undefined)
		return `it is not a setting ${bindle} declares (its config() schema lists the settings a deploy may set) nor an input of a binding its Yard chooses`;
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
	const placement = plan.placement;
	const lines = [
		`Deploy ${plan.bindle} (${plan.resources.map((resource) => `${resource.kind} ${resource.name}`).join(", ")})`,
		...(placement !== undefined
			? [
					`  placed by Yard ${placement.yard} (provider ${placement.provider}, ${placement.regions.join(", ")}), Camp ${placement.camp}`,
				]
			: []),
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
		"Bindings the Camp chooses (the Yard's other rows are its catalog):",
		...plan.bindings
			.filter((binding) => binding.selected)
			.map(
				(binding) =>
					`  ${binding.profile} -> ${binding.productId || "-"}${binding.connectivityId ? ` via ${binding.connectivityId}` : ""}${binding.provisioning ? ` (${binding.provisioning})` : ""}`,
			),
		...(plan.provisioning.length > 0
			? [
					"Vercel CLI commands --provision runs first (VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID in its environment):",
					...plan.provisioning.flatMap((command, index) => [
						`  ${index + 1}. vercel ${command.args.join(" ")}`,
						`     ${command.when}`,
					]),
				]
			: []),
		"Requests to https://api.vercel.com:",
		...plan.requests.flatMap((request, index) => [
			`  ${index + 1}. ${request.method} ${request.path}`,
			...(request.body !== "" ? [`     ${request.body}`] : []),
			`     ${request.when}`,
		]),
	];
	return lines.join("\n");
}

// The provider and driver come from the Yard: it is the one place a provider is
// named (ADR-0157).
function programFor(
	definition: BindleDefinition,
	placement: RelayPlacement,
	resourceId: string,
	deploymentId: string,
): IacProgram {
	return {
		programId: `${deploymentId}:${resourceId}`,
		deploymentId,
		resourceId,
		provider: placement.providerId,
		driver: placement.providerId,
		action: "apply",
		stackName: `${definition.name}-${resourceId}`,
	};
}

// The Vercel CLI as `--provision` runs it: no shell, the token and the
// project's coordinates in its environment, its output read, never printed.
function vercelCliFrom(
	env: NodeJS.ProcessEnv,
	coordinates: Readonly<Record<string, string>>,
): VercelCliRunner {
	const executable = env.HOBO_VERCEL_CLI || "vercel";
	return (args) =>
		new Promise((resolve) => {
			execFile(
				executable,
				[...args],
				{
					env: {
						PATH: env.PATH ?? "",
						HOME: env.HOME ?? "",
						NO_COLOR: "1",
						CI: "1",
						...coordinates,
					},
					timeout: 180_000,
					maxBuffer: 4 * 1024 * 1024,
					encoding: "utf8",
				},
				(error, stdout) => {
					const code =
						error === null ? 0 : isJsonNumber(error.code) ? error.code : 1;
					resolve({ code, stdout: String(stdout) });
				},
			);
		});
}

export async function runCiRelayDeploy(
	input: CiRelayDeployInput,
): Promise<CommandResult> {
	const { values, env } = input;
	const text = (key: string) => {
		const value = values[key];
		return isJsonString(value) && value !== "" ? value : undefined;
	};

	const repoFlag = text("repo");
	if (repoFlag !== undefined && !validRepository(repoFlag))
		return usage(
			"hobo ci deploy needs --repo <owner/name>: the GitHub repository Vercel builds.",
		);
	const ref = text("ref");
	if (ref === undefined)
		return usage(
			"hobo ci deploy needs --ref <branch|tag|sha>: the git ref to deploy.",
		);
	const target = text("target") ?? "preview";
	if (target !== "preview" && target !== "production")
		return usage(
			"--target is preview (the default) or production; production is never implied.",
		);
	// The secret store chosen when the relay was first deployed
	// (`hobo ci secret-store provision`): its committed coordinates fill the
	// config-service binding's inputs and name the team, so no repository
	// variable or Vercel secret holds them.
	let storeBinding: ParsedSecretStoreBinding | undefined;
	try {
		storeBinding = loadSecretStoreBinding(input.cwd);
	} catch (error) {
		if (error instanceof SecretStoreBindingRefusal)
			return refused(error.code, error.message);
		throw error;
	}
	const teamId =
		text("team") ??
		(storeBinding?.vercelTeamId || undefined) ??
		env.VERCEL_TEAM_ID;
	if (teamId !== undefined && teamId !== "" && !TEAM_ID.test(teamId))
		return usage(
			"The Vercel team must be the canonical team id (team_ and the rest), from --team, the secret store binding or VERCEL_TEAM_ID; a slug or a name selects no team.",
		);
	const rawSettings = values.set;
	const given = parseSettings(Array.isArray(rawSettings) ? rawSettings : []);
	if (isJsonString(given)) return usage(given);
	const settings = new Map(given);

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
			`${definition.name} names a provider. A Bindle stays provider-neutral; its Yard names the provider.`,
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

	let placement: RelayPlacement;
	try {
		const yard = await loadRelayYard(input.cwd);
		if (yard === undefined)
			return usage(
				`No Yard found here for ${definition.name}. Its placement is declared in deploy/yard.ts (export default yard(...)): the provider, the project and the bindings each environment requires.`,
			);
		if (yard.providerId !== "vercel")
			return refused(
				"HOBO_CI_DEPLOY_YARD_PROVIDER",
				`Yard ${yard.name} places ${definition.name} on ${yard.providerId}; hobo ci deploy realizes Vercel Yards only.`,
			);
		placement = resolveRelayPlacement(yard, target);
	} catch (error) {
		if (error instanceof RelayPlacementRefusal)
			return refused(error.code, error.message);
		throw error;
	}

	const repository = repoFlag ?? placement.repository;
	if (repository === undefined || !validRepository(repository))
		return usage(
			"hobo ci deploy needs --repo <owner/name>: the GitHub repository Vercel builds (or a Yard whose properties name it).",
		);
	const [org = "", repo = ""] = repository.split("/");
	const project = text("project") ?? placement.project;
	if (project === undefined)
		return usage(
			"hobo ci deploy needs --project <name>: the Vercel project (or a Yard whose properties name it).",
		);

	const declared = await declaredSettings(input.cwd);
	let position = 0;
	for (const [name, value] of settings) {
		position += 1;
		const reason = settingRefusal(
			name,
			value,
			definition.name,
			declared,
			placement,
		);
		if (reason !== undefined)
			return refused(
				"HOBO_CI_DEPLOY_SETTING_REFUSED",
				`Refused --set number ${position}: ${reason}. Nothing was sent.`,
			);
	}
	if (storeBinding !== undefined)
		for (const [name, value] of secretStoreDeployInputs(storeBinding))
			if (placement.inputs.includes(name) && !settings.has(name))
				settings.set(name, value);
	const missing = placement.inputs.filter((name) => !settings.has(name));
	if (missing.length > 0)
		return usage(
			`Camp ${placement.camp} needs ${missing.map((name) => `--set ${name}=<value>`).join(" ")}: its bindings ask the deploy for these, and the Yard holds no value for them. The config service's coordinates come from ${SECRET_STORE_BINDING_FILE}, which hobo ci secret-store provision writes when it chooses the store.`,
		);
	// The Yard's settings and the command's, one map, sorted by name.
	const configuration = new Map(
		[...placement.settings, ...settings].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		),
	);

	const sha = text("sha");
	const createProject = values["create-project"] === true;
	// The Yard's root directory is saved on a project this deploy creates; an
	// existing project keeps its own unless the command names one.
	const rootDirectory =
		text("root-directory") ??
		(createProject ? placement.rootDirectory : undefined);
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
		createMissingProject: createProject,
		configuration: Object.fromEntries(configuration),
		gitArtifact: {
			org,
			repo,
			ref,
			...(sha !== undefined ? { sha } : undefined),
			...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		},
		...(teamId !== undefined && teamId !== "" ? { teamId } : undefined),
	};

	const provision = values.provision === true;
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
			settings: [...configuration].map(([key, value]) => ({ key, value })),
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
			placement: {
				yard: placement.yard,
				camp: placement.camp,
				provider: placement.providerId,
				regions: [...placement.regions],
			},
			bindings: placement.bindings.map((binding) => ({
				profile: binding.profile,
				productId: binding.productId,
				connectivityId: binding.connectivityId,
				selected: binding.selected,
				settings: [...binding.settings],
				inputs: [...binding.inputs],
				provisioning: binding.provisioning,
			})),
			provisioning: provision
				? planRelayProvisioning(placement.attachments, project, target).map(
						(command) => ({ args: [...command.args], when: command.when }),
					)
				: [],
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
		`deploying ${definition.name} to Vercel project ${project} (${target}, Camp ${placement.camp}) from ${org}/${repo}@${sha ?? ref}`,
	);
	try {
		// Attach the Marketplace bindings first: their variables reach the
		// build. One that cannot be attached is reported, not fatal: the relay
		// reports a missing cache on /readyz.
		let attached: readonly AttachmentResult[] = [];
		if (provision && placement.attachments.length > 0) {
			const team = teamId !== undefined && teamId !== "" ? teamId : undefined;
			attached =
				team === undefined
					? placement.attachments.map((attachment) => ({
							attachment,
							outcome: "failed" as const,
							reason: "provisioning needs the Vercel team id",
						}))
					: await provisionRelayAttachments({
							attachments: placement.attachments,
							project,
							target,
							run:
								input.runVercelCli ??
								vercelCliFrom(env, {
									VERCEL_TOKEN: token,
									VERCEL_ORG_ID: team,
									VERCEL_PROJECT_ID: project,
								}),
						});
			for (const result of attached)
				input.emitProgress(
					`${result.attachment.integration} ${result.attachment.resource}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`,
				);
		}
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
				programFor(definition, placement, resource.name, deploymentId),
			);
		let readyState: string | undefined;
		const deployed = outputs.deploymentId;
		if (values.wait === true && isJsonString(deployed) && deployed !== "")
			readyState = await waitUntilReady({
				client: createVercelClient({
					token,
					...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
					...(teamId !== undefined && teamId !== "" ? { teamId } : undefined),
				}),
				deploymentId: deployed,
				sleep:
					input.sleep ??
					((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
				now: input.now ?? Date.now,
				emitProgress: input.emitProgress,
			});
		const safe = Object.fromEntries(
			Object.entries({
				...outputs,
				yard: placement.yard,
				camp: placement.camp,
				...(attached.length > 0
					? { provisioned: describeAttachments(attached) }
					: undefined),
				...(readyState !== undefined ? { readyState } : undefined),
			}).map(([key, value]) => [key, withoutToken(value)]),
		);
		if (readyState !== undefined && readyState !== "READY")
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_NOT_READY",
				message: `The deployment of ${definition.name} to Vercel project ${project} (${safe.target}) ended ${readyState}, not READY: ${safe.url}`,
				data: {
					command: "ci deploy",
					dryRun: false,
					plan: planJson,
					outputs: safe,
				},
			};
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

// Ask Vercel for the deployment until it is READY, ERROR or CANCELED, or the
// wait runs out; the state it was last in.
async function waitUntilReady(input: {
	readonly client: ReturnType<typeof createVercelClient>;
	readonly deploymentId: string;
	readonly sleep: (ms: number) => Promise<void>;
	readonly now: () => number;
	readonly emitProgress: (message: string) => void;
}): Promise<string> {
	const until = input.now() + WAIT_LIMIT_MS;
	for (;;) {
		const deployment = await input.client.getDeployment(input.deploymentId);
		const state = deployment?.readyState ?? "UNKNOWN";
		if (state === "READY" || state === "ERROR" || state === "CANCELED")
			return state;
		if (input.now() >= until) return `${state} after 15 minutes`;
		input.emitProgress(`deployment ${input.deploymentId}: ${state}`);
		await input.sleep(WAIT_INTERVAL_MS);
	}
}
