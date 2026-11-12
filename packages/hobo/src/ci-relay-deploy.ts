// `hobo ci deploy` — HoBo delivering its own hosted CI relay, a thin front
// over @hobo/cd.
//
// The relay is a HoBo app (`packages/ci-vercel/src/bindle.ts`), built by Vercel
// from the git repository. This verb loads that Bindle from the project
// directory, checks it names no provider, and places it with the relay's Yard
// (`deploy/yard.ts`, `ci-relay-yard.ts`): the Yard names the provider, the
// project and repository, and the binding rows; the Camp the target names
// chooses the rows its environment requires, and those rows project the
// non-secret settings (the config service's coordinates among them). Only
// Vercel Yards are realized here today.
//
// A real run does not deploy by itself: it hands the relay to CD
// (`ci-relay-delivery.ts`). The build is recorded as Freight (the Bindle, its
// declaration and the commit it pins), promoted through the relay's pipeline
// (`deploy/delivery.ts`: preview, then production, which takes only Freight
// preview qualified) and the CD gate, and realized by a conductor reconciler
// whose realizer is `createVercelDeployProvider`'s git-artifact mode: the
// settings first, then one deployment for the whole Bindle. `--wait` drives the
// promotion to its end: READY, then the node's probes (`/healthz` for
// preview, `/healthz` and `/readyz` for production, failing closed on no
// data), then qualification. Without `--wait` the command returns once the
// deployment exists, unverified. The journal is the shared CD journal
// (`<HOBO_HOME>/cd`, or the store HOBO_CD_SQLITE_PATH / HOBO_CD_POSTGRES_URL
// names), the one `hobo deploy` reads.
//
// CONTRACT CHANGE (from the direct-deploy verb; packages/ci-vercel/README.md
// "Contract changes of hobo ci deploy"): `--wait` now verifies and qualifies,
// so it needs the target's probe origin (HOBO_CI_RELAY_PREVIEW_URL or
// HOBO_CI_RELAY_URL) and is refused without it
// (HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET); `--target production` needs `--sha`
// and preview's qualification of that commit in the same journal
// (HOBO_CI_DEPLOY_NOT_QUALIFIED); the wait limit is 20 minutes, not 15; new
// failure codes: HOBO_CI_DEPLOY_INCOMPLETE, HOBO_CI_DEPLOY_VERIFICATION_FAILED,
// HOBO_CI_DEPLOY_NOT_QUALIFIED, HOBO_CI_DEPLOY_SOURCE_UNPINNED,
// HOBO_CI_DEPLOY_DELIVERY_UNAVAILABLE, HOBO_CI_DEPLOY_DELIVERY_INVALID,
// HOBO_CI_DEPLOY_FREIGHT_REFUSED, HOBO_CI_DEPLOY_PROMOTION_REFUSED.
//
// The target is chosen HERE, where the deploy is run, not in the Bindle; and
// it is PREVIEW unless `--target production` says otherwise. Production needs
// `--sha`: it takes exactly the commit preview verified. The deploy workflow
// on `main` (`.github/workflows/relay-deploy.yml`) holds no Vercel token and
// runs `--adopt` instead (`ci-relay-adopt.ts`): the deployment Vercel's Git
// integration made, observed, recorded and promoted preview then production.
//
// `--provision` first attaches the chosen Marketplace bindings (the cache)
// with the Vercel CLI, idempotently (`ci-relay-provision.ts`).
//
// What it deliberately does not do: set a secret (a `--set` must name a field
// the app's `config()` schema declares non-secret, and pass the name and value
// screen in `vercel-env-policy.ts`), provision a database or a storage
// integration, or create the project unless `--create-project` asks.
//
// `--dry-run` forms the plan (`VercelGitDeploymentPlan`,
// data-models/vercel_git_deployment.proto) with the same functions the client
// sends with, names the delivery CD would run, reads no token and opens no
// connection.
//
// HONEST SCOPE: exercised against fake transports and a temporary journal
// only. No live deployment has been made from this repository through this
// verb.

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
import { HOBO_CI_COMPONENTS } from "@hobo/cd/compose";
import {
	BINDLE_SOURCE_CANDIDATES,
	type CommandResult,
	compileProjectManifest,
	loadBindleDefinition,
} from "@hobo/cli";
import type { IacOutputs, IacProgram } from "@hobo/cloud";
import type { HttpTransport } from "@hobo/core";
import {
	type ParsedSecretStoreBinding,
	SECRET_STORE_BINDING_FILE,
} from "@hobo/secret-store-claim";
import type { Yard } from "@hobo/yards";

import {
	type VercelGitDeploymentPlan,
	VercelGitDeploymentPlanSchema,
} from "./_generated/vercel_git_deployment_pb.js";
import {
	deliverRelay,
	type RelayRealization,
	type RelayRealizationFailure,
	relayCampId,
} from "./ci-relay-delivery.js";
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
import { defaultHoboHome } from "./hobo-home.js";
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
	"adopt",
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
	// HOBO_HOME: where the CD journal and artifact store live by default.
	readonly home?: string;
	// The transport the verification probes use; injected in tests.
	readonly probe?: HttpTransport;
	readonly emitProgress: (message: string) => void;
}

// How long a deploy drives its promotion (READY, then verification), and how
// often it looks.
const WAIT_LIMIT_MS = 20 * 60_000;
const WAIT_INTERVAL_MS = 10_000;

const PLAN_SCHEMA_VERSION = "hobo.vercel-git-deployment-plan/v1";

// A canonical Vercel team id, as `selectIacProvider` requires of
// `VERCEL_TEAM_ID`: a slug or a name would select no team, or another.
const TEAM_ID = /^team_[A-Za-z0-9]+$/u;

// Where each target's verification probes reach the relay (deploy/delivery.ts
// reads the same names).
export const RELAY_VERIFY_ORIGIN = Object.freeze({
	preview: "HOBO_CI_RELAY_PREVIEW_URL",
	production: "HOBO_CI_RELAY_URL",
} as const);

// What each target's verification probes (deploy/delivery.ts declares the
// same): the preview Camp has no config-service binding, so its /readyz
// answers 503 and only /healthz is required there.
export const RELAY_VERIFY_PATHS = Object.freeze({
	preview: Object.freeze(["/healthz"]),
	production: Object.freeze(["/healthz", "/readyz"]),
} as const);

const HTTPS_ORIGIN = /^https:\/\/[^/?#\s]+\/?$/u;

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

// How a real run delivers the relay through @hobo/cd, as its dry run prints it.
function describeDelivery(
	yard: Yard,
	target: "preview" | "production",
	commit: string,
): string {
	return [
		"Delivered by @hobo/cd (deploy/delivery.ts):",
		`  records ${commit} as Freight of ${HOBO_CI_COMPONENTS.relay.bindle}`,
		`  promotes it through pipeline ${HOBO_CI_COMPONENTS.relay.pipeline}, node ${target}, to Camp ${relayCampId(yard, target)}, through the CD gate`,
		...(target === "production"
			? ["  only if preview qualified the same Freight (the same commit)"]
			: []),
		"  a conductor reconciler realizes it as the Vercel git deployment above, converged once Vercel reports READY",
		`  --wait verifies it with probes of ${RELAY_VERIFY_PATHS[target].join(" and ")} at ${RELAY_VERIFY_ORIGIN[target]} (fail closed on no data) and qualifies it`,
		"  in the shared CD journal (HOBO_HOME/cd, or HOBO_CD_SQLITE_PATH / HOBO_CD_POSTGRES_URL), the one hobo deploy reads",
	].join("\n");
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
	let relayYard: Yard;
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
		relayYard = yard;
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
			message: `Dry run: nothing was sent to Vercel, and VERCEL_TOKEN was not read.\n${describePlan(plan)}\n${describeDelivery(relayYard, target, `${org}/${repo}@${sha ?? ref}`)}`,
			data: {
				command: "ci deploy",
				dryRun: true,
				plan: planJson,
				delivery: {
					pipeline: HOBO_CI_COMPONENTS.relay.pipeline,
					node: target,
					campId: relayCampId(relayYard, target),
					verifiedBy: RELAY_VERIFY_ORIGIN[target],
				},
			},
		};

	if (target === "production" && sha === undefined)
		return usage(
			"hobo ci deploy --target production needs --sha <commit>: production takes exactly the commit preview verified, and a ref alone names no commit.",
		);
	const wait = values.wait === true;
	const origin = RELAY_VERIFY_ORIGIN[target];
	if (wait && !HTTPS_ORIGIN.test(env[origin] ?? ""))
		return refused(
			"HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET",
			`--wait verifies ${target} with probes of ${RELAY_VERIFY_PATHS[target].join(" and ")} at ${origin}, which is not set to an https origin. Set it (packages/ci-vercel/CONFIG-SERVICE.md), or deploy without --wait (nothing is verified or qualified then).`,
		);

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
		`delivering ${definition.name} to Vercel project ${project} (${target}, Camp ${placement.camp}) from ${org}/${repo}@${sha ?? ref} through @hobo/cd`,
	);
	const client = createVercelClient({
		token,
		...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
		...(teamId !== undefined && teamId !== "" ? { teamId } : undefined),
	});
	// The conductor's Vercel side: the git deployment of the commit the
	// Freight pins, and its readiness. Failures keep the codes and messages
	// this command always returned.
	const realization: RelayRealization = {
		async deploy(pin) {
			try {
				// Attach the Marketplace bindings first: their variables reach the
				// build. One that cannot be attached is reported, not fatal: the
				// relay reports a missing cache on /readyz.
				let attached: readonly AttachmentResult[] = [];
				if (provision && placement.attachments.length > 0) {
					const team =
						teamId !== undefined && teamId !== "" ? teamId : undefined;
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
				const [pinOrg = org, pinRepo = repo] = pin.repository.split("/");
				const provider = createVercelDeployProvider({
					...options,
					gitArtifact: {
						...options.gitArtifact,
						org: pinOrg,
						repo: pinRepo,
						ref: pin.ref,
						...(pin.sha !== undefined ? { sha: pin.sha } : undefined),
					},
					token,
					...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
				});
				const deploymentId = `hobo-ci-deploy-${randomUUID()}`;
				// The provider realizes the whole Bindle as one deployment: the
				// first resource's apply deploys, and the rest answer with the
				// same outputs.
				let outputs: IacOutputs = {};
				for (const resource of resources)
					outputs = await provider.apply(
						programFor(definition, placement, resource.name, deploymentId),
					);
				return {
					ok: true,
					outputs: Object.fromEntries(
						Object.entries({
							...outputs,
							yard: placement.yard,
							camp: placement.camp,
							...(attached.length > 0
								? { provisioned: describeAttachments(attached) }
								: undefined),
						}).map(([key, value]) => [key, withoutToken(value)]),
					),
				};
			} catch (error) {
				return realizationFailure(
					error instanceof Error ? error : new Error("not an Error"),
					withoutToken,
				);
			}
		},
		async readyState(deploymentId) {
			try {
				const deployment = await client.getDeployment(deploymentId);
				return deployment?.readyState ?? "UNKNOWN";
			} catch (error) {
				// No answer is not a state: keep observing until the wait ends.
				if (error instanceof VercelTransportError) return "UNKNOWN";
				throw error;
			}
		},
	};

	const now = input.now ?? Date.now;
	const startedAt = now();
	const declaration = await compileProjectManifest(input.cwd);
	if (declaration === null)
		return usage(
			`${definition.name} did not compile to a declaration, so there is nothing to record as Freight.`,
		);
	const delivered = await deliverRelay({
		cwd: input.cwd,
		env,
		home: input.home ?? defaultHoboHome(env),
		yard: relayYard,
		declaration,
		target,
		source: {
			repository: `${org}/${repo}`,
			ref,
			...(sha !== undefined ? { sha } : undefined),
			...(rootDirectory !== undefined ? { rootDirectory } : undefined),
		},
		realization,
		wait,
		limitMs: WAIT_LIMIT_MS,
		intervalMs: WAIT_INTERVAL_MS,
		...(input.probe !== undefined ? { http: input.probe } : undefined),
		...(input.sleep !== undefined ? { sleep: input.sleep } : undefined),
		...(input.now !== undefined ? { now: input.now } : undefined),
		emitProgress: input.emitProgress,
	});
	const delivery = delivered.ok
		? delivered.report
		: (delivered.report ?? undefined);
	const deliveryData = delivery !== undefined ? { delivery } : undefined;
	if (delivered.ok) {
		const safe = Object.fromEntries(
			Object.entries({
				...delivered.handover,
				yard: placement.yard,
				camp: placement.camp,
			}).map(([key, value]) => [key, withoutToken(value)]),
		);
		const promoted = delivered.report.state === "PROMOTED";
		return {
			code: "HOBO_CI_DEPLOYED",
			message: [
				`Deployed ${definition.name} to Vercel project ${project} (${safe.target}): ${safe.url}`,
				promoted
					? `  Freight ${delivered.report.alias} promoted through ${delivered.report.pipeline}/${delivered.report.node} to ${delivered.report.campId}: verified and qualified`
					: `  Freight ${delivered.report.alias} is ${delivered.report.state ?? "in flight"} at ${delivered.report.campId}, not yet verified; run with --wait to verify and qualify it`,
				...Object.entries(safe).map(([key, value]) => `  ${key}: ${value}`),
			].join("\n"),
			data: {
				command: "ci deploy",
				dryRun: false,
				plan: planJson,
				outputs: safe,
				...deliveryData,
			},
		};
	}
	if (delivered.realization !== undefined) {
		const failure = delivered.realization;
		return {
			ok: false,
			...(failure.status !== undefined
				? { status: failure.status }
				: undefined),
			code: failure.code,
			message: withoutToken(failure.message),
			data: { ...failure.data, ...deliveryData },
		};
	}
	const handover = delivered.handover ?? {};
	const readyState = handover.readyState;
	// The deployment never became READY: the promotion ran out of time, or
	// its rollout's deadline failed it. Said as this command always said it.
	if (
		delivered.code === "HOBO_CI_DEPLOY_NOT_READY" ||
		(readyState !== undefined && readyState !== "READY")
	) {
		const state =
			delivered.code === "HOBO_CI_DEPLOY_NOT_READY"
				? (readyState ?? "UNKNOWN")
				: `${readyState} after ${Math.round((now() - startedAt) / 60_000)} minutes`;
		const safe = Object.fromEntries(
			Object.entries({
				...handover,
				yard: placement.yard,
				camp: placement.camp,
				readyState: state,
			}).map(([key, value]) => [key, withoutToken(value)]),
		);
		return {
			ok: false,
			code: "HOBO_CI_DEPLOY_NOT_READY",
			message: `The deployment of ${definition.name} to Vercel project ${project} (${safe.target ?? target}) ended ${state}, not READY: ${safe.url ?? ""}`,
			data: {
				command: "ci deploy",
				dryRun: false,
				plan: planJson,
				outputs: safe,
				...deliveryData,
			},
		};
	}
	return {
		ok: false,
		code: delivered.code,
		message: withoutToken(delivered.message),
		data: {
			command: "ci deploy",
			dryRun: false,
			plan: planJson,
			...deliveryData,
		},
	};
}

// A failed realization, with the code and message this command has always
// returned for it, and never the token.
function realizationFailure(
	error: Error,
	withoutToken: (value: string) => string,
): RelayRealizationFailure {
	if (error instanceof VercelEnvRefusal)
		return {
			ok: false,
			status: "rejected",
			code: "HOBO_CI_DEPLOY_SETTING_REFUSED",
			message: withoutToken(error.message),
		};
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
	if (error instanceof TypeError)
		return {
			ok: false,
			status: "usage",
			code: "HOBO_CLI_USAGE",
			message: withoutToken(error.message),
		};
	return {
		ok: false,
		code: "HOBO_CI_DEPLOY_FAILED",
		message:
			"hobo ci deploy failed before Vercel answered. Run it with --dry-run to check the plan.",
	};
}
