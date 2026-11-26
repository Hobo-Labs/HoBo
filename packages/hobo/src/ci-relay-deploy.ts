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
import type { CredentialResolver } from "@hobo/cd";
import { HOBO_CI_COMPONENTS } from "@hobo/cd/compose";
import {
	BINDLE_SOURCE_CANDIDATES,
	type CommandResult,
	compileProjectManifest,
	loadBindleDefinition,
} from "@hobo/cli";
import type { IacOutputs, IacProgram } from "@hobo/cloud";
import {
	capability,
	createBoundedFetchTransport,
	type HttpTransport,
	type TrustedVault,
} from "@hobo/core";
import {
	BUNDLED_SECRET_STORE_BINDING_FILE,
	type ParsedSecretStoreBinding,
	type RepairSecretStoreBinding,
	readSecretStoreBindingForRepair,
} from "@hobo/secret-store-claim";
import type { Yard } from "@hobo/yards";
import {
	type VercelGitDeploymentPlan,
	VercelGitDeploymentPlanSchema,
} from "./_generated/vercel_git_deployment_pb.js";
import { loadDeliveryFile } from "./cd-delivery-module.js";
import {
	deliverRelay,
	RELAY_DELIVERY_FILE,
	type RelayRealization,
	type RelayRealizationFailure,
	relayCampId,
} from "./ci-relay-delivery.js";
import { readRelayDeployToken } from "./ci-relay-deploy-credential.js";
import {
	type AttachmentResult,
	describeAttachments,
	planRelayProvisioning,
	provisionRelayAttachments,
	type VercelCliRunner,
} from "./ci-relay-provision.js";
import {
	commitCheckingProbe,
	deployedPreviewSuites,
	RelayDeploymentReadRefusal,
	recordVerifiedPreviewRecords,
	relayOrigin,
	relayVerifyFailure,
} from "./ci-relay-verify.js";
import {
	loadRelayJoinedYards,
	loadRelayYard,
	type RelayPlacement,
	RelayPlacementRefusal,
	resolveRelayPlacement,
} from "./ci-relay-yard.js";
import { validRepository } from "./ci-repository.js";
import {
	parseOwnerStoreBinding,
	readSecretStoreBindingText,
	SECRET_STORE_SESSION_REQUIRED,
	SecretStoreBindingRefusal,
	type SecretStoreBindingStore,
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
import {
	checkoutHeadOf,
	promoteStagedBuild,
	repositoryRoot,
	servesProduction,
	stageVercelBuild,
	type VercelBuildRunner,
	vercelBuildEnvironment,
	vercelBuildRunnerFrom,
} from "./vercel-prebuilt.js";

export function relayStoreCoordinates(
	binding: Pick<
		RepairSecretStoreBinding,
		| "kind"
		| "endpoint"
		| "projectId"
		| "environment"
		| "secretPath"
		| "relayIdentityId"
	>,
): string {
	return `${JSON.stringify(
		{
			kind: binding.kind,
			endpoint: binding.endpoint,
			projectId: binding.projectId,
			environment: binding.environment,
			secretPath: binding.secretPath,
			relayIdentityId: binding.relayIdentityId,
		},
		null,
		"\t",
	)}\n`;
}

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
	"deadline",
	"build",
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
	"build",
] as const;

export interface CiRelayDeployInput {
	// The relay's project directory: the one that holds `src/bindle.ts`.
	readonly cwd: string;
	// The parsed `hobo ci` options.
	readonly values: Readonly<
		Record<string, string | boolean | string[] | undefined>
	>;
	readonly env: NodeJS.ProcessEnv;
	readonly credentials?: TrustedVault;
	readonly ownerCredentials?: CredentialResolver;
	readonly bindingStore?: SecretStoreBindingStore;
	// The Vercel transport; injected in tests, the global `fetch` otherwise.
	readonly fetch?: VercelFetch;
	// The Vercel CLI `--provision` runs; injected in tests. Otherwise the
	// executable `HOBO_VERCEL_CLI` names, or `vercel` on the PATH.
	readonly runVercelCli?: VercelCliRunner;
	readonly runVercelBuild?: VercelBuildRunner;
	readonly checkoutHead?: (repoRoot: string) => Promise<string>;
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

const ISO_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

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

interface PrebuiltState {
	projectId?: string;
	promoted?: string;
	promotedFrom?: string;
}

function prebuiltRequests(
	git: ReturnType<typeof planVercelGitDeployment>["requests"],
	project: string,
	target: "preview" | "production",
	teamId: string | undefined,
): readonly Readonly<{
	method: string;
	path: string;
	body?: unknown;
	when: string;
}>[] {
	const team =
		teamId !== undefined && teamId !== ""
			? `teamId=${encodeURIComponent(teamId)}`
			: "";
	const projectRead = {
		method: "GET",
		path: `/v9/projects/${encodeURIComponent(project)}${team ? `?${team}` : ""}`,
		when: "always: the project's canonical id, and the deployment production serves",
	};
	const staged = {
		method: "GET",
		path: `/v6/deployments?projectId=${encodeURIComponent(project)}&limit=100&target=production${team ? `&${team}` : ""}`,
		when: "always: the production build staged for this Freight (meta hoboFreight)",
	};
	if (target === "preview")
		return [
			projectRead,
			...git.filter((request) => !request.path.startsWith("/v13/deployments")),
			staged,
		];
	return [
		staged,
		projectRead,
		{
			method: "POST",
			path: `/v10/projects/<project id>/promote/<staged deployment id>${team ? `?${team}` : ""}`,
			when: "unless production already serves the staged build: point production at it, no rebuild",
		},
		{
			method: "POST",
			path: `/v1/projects/<project id>/rollback/<previous production deployment id>${team ? `?${team}` : ""}`,
			when: "only if production verification of the promoted build fails",
		},
	];
}

export const RELAY_PRODUCTION_NEEDS_PREBUILT =
	"HOBO_CI_DEPLOY_PRODUCTION_NEEDS_PREBUILT";

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
	const deadlineFlag = text("deadline");
	const deadlineAt =
		deadlineFlag === undefined
			? undefined
			: ISO_TIME.test(deadlineFlag)
				? Date.parse(deadlineFlag)
				: Number.NaN;
	if (deadlineAt !== undefined && !Number.isFinite(deadlineAt))
		return usage(
			`--deadline takes an ISO-8601 time with a zone (e.g. 2026-11-20T16:09:00Z), not ${JSON.stringify(deadlineFlag)}.`,
		);
	const target = text("target") ?? "preview";
	if (target !== "preview" && target !== "production")
		return usage(
			"--target is preview (the default) or production; production is never implied.",
		);
	const build = text("build") ?? "git";
	if (build !== "git" && build !== "prebuilt")
		return usage(
			"--build is git (the default: Vercel builds from its Git integration) or prebuilt (HoBo builds once, stages, then promotes the same build).",
		);
	const prebuilt = build === "prebuilt";
	if (prebuilt && text("sha") === undefined)
		return usage(
			"hobo ci deploy --build prebuilt needs --sha <commit>: HoBo builds only the checkout of the commit the Freight pins.",
		);
	if (target === "production" && !prebuilt)
		return refused(
			RELAY_PRODUCTION_NEEDS_PREBUILT,
			"hobo ci deploy --target production --build git is refused: a git build carries none of the relay's store coordinates, so production could never read its configuration and never qualifies. Deploy production with --build prebuilt --sha <commit> and the owner's store session (HoBo MCP's choose_secret_store): HoBo bundles the coordinates into the build it makes and removes them afterwards.",
		);
	const buildTarget: "preview" | "production" = prebuilt
		? "production"
		: target;
	let storeBindingText: string | undefined;
	try {
		storeBindingText = await readSecretStoreBindingText(input.bindingStore);
	} catch (error) {
		if (!(error instanceof SecretStoreBindingRefusal)) throw error;
		if (
			values["dry-run"] !== true ||
			error.code !== SECRET_STORE_SESSION_REQUIRED
		)
			return refused(error.code, error.message);
		storeBindingText = undefined;
	}
	let storeBinding:
		| ParsedSecretStoreBinding
		| RepairSecretStoreBinding
		| undefined;
	try {
		storeBinding =
			storeBindingText === undefined
				? undefined
				: parseOwnerStoreBinding(storeBindingText);
	} catch (error) {
		if (!(error instanceof SecretStoreBindingRefusal)) throw error;
		if (
			values["dry-run"] !== true ||
			error.code !== "HOBO_CI_SECRET_STORE_BINDING_INVALID" ||
			storeBindingText === undefined
		)
			return refused(error.code, error.message);
		try {
			storeBinding = readSecretStoreBindingForRepair(storeBindingText);
		} catch {
			return refused(error.code, error.message);
		}
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
		placement = resolveRelayPlacement(
			yard,
			buildTarget,
			await loadRelayJoinedYards(input.cwd, yard),
		);
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
	const missing = placement.inputs.filter((name) => !settings.has(name));
	if (missing.length > 0)
		return usage(
			`Camp ${placement.camp} needs ${missing.map((name) => `--set ${name}=<value>`).join(" ")}: its bindings ask the deploy for these, and the Yard holds no value for them.`,
		);
	const bundlesStoreBinding = placement.bindings.some(
		(binding) =>
			binding.selected &&
			binding.profile === capability.secretRef.runtimeProjection,
	);
	if (
		bundlesStoreBinding &&
		storeBinding === undefined &&
		values["dry-run"] !== true
	)
		return refused(
			"HOBO_CI_SECRET_STORE_NOT_CONNECTED",
			`Camp ${placement.camp} reads the relay's configuration from the owner's secret store, and that store holds no relay binding yet: connect it first (hobo ci secret-store connect through the owner hand-off).`,
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
			requests: (prebuilt
				? prebuiltRequests(requests.requests, project, target, teamId)
				: requests.requests
			).map((request) => ({
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
				? planRelayProvisioning(
						placement.attachments,
						project,
						buildTarget,
					).map((command) => ({ args: [...command.args], when: command.when }))
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
			message: `Dry run: nothing was sent to Vercel, and no deploy token was read.\n${describePlan(plan)}\n${describeDelivery(relayYard, target, `${org}/${repo}@${sha ?? ref}`)}`,
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
	const originGiven = env[origin]?.trim() ?? "";
	if (wait && !HTTPS_ORIGIN.test(originGiven)) {
		if (target === "production" || originGiven !== "")
			return refused(
				"HOBO_CI_DEPLOY_VERIFY_ORIGIN_UNSET",
				`--wait verifies ${target} with probes of ${RELAY_VERIFY_PATHS[target].join(" and ")} at ${origin}, which is not set to an https origin. Set it (packages/ci-vercel/CONFIG-SERVICE.md), or deploy without --wait (nothing is verified or qualified then).`,
			);
	}
	if (target === "preview" && wait && originGiven === "" && sha === undefined)
		return usage(
			"hobo ci deploy --target preview --wait needs --sha <commit> when no HOBO_CI_RELAY_PREVIEW_URL is set: the deployment record must be verified against the Freight's commit.",
		);
	const recordVerifiedPreview =
		target === "preview" &&
		wait &&
		(prebuilt || !HTTPS_ORIGIN.test(originGiven));

	const deployToken = await readRelayDeployToken({
		...(input.ownerCredentials !== undefined
			? { ownerCredentials: input.ownerCredentials }
			: undefined),
		...(input.credentials !== undefined
			? { runVault: input.credentials }
			: undefined),
	});
	if (!deployToken.ok)
		return {
			ok: false,
			status: "authentication-required",
			code: deployToken.code,
			message: deployToken.message,
		};
	const token = deployToken.token;
	input.emitProgress(
		deployToken.source === "owner-store"
			? "deploy token read from the owner's store session"
			: "deploy token taken from this run's vault (read from the owner's store by hobo ci up)",
	);
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
	interface CreatedDeployment {
		deploymentId?: string;
		commit?: string;
	}
	const created: CreatedDeployment = {};
	const retryableRead = (status: number) => status === 429 || status >= 500;
	const readDeployment = async (deploymentId: string) => {
		try {
			const deployment = await client.getDeployment(deploymentId);
			if (deployment !== undefined) return deployment;
			throw new RelayDeploymentReadRefusal(
				404,
				`Vercel answers 404 for deployment ${deploymentId}: it does not exist under this deploy token's scope`,
			);
		} catch (error) {
			if (error instanceof RelayDeploymentReadRefusal) throw error;
			if (error instanceof VercelApiError) {
				if (retryableRead(error.status)) return undefined;
				throw new RelayDeploymentReadRefusal(
					error.status,
					withoutToken(error.message),
				);
			}
			if (error instanceof VercelTransportError) return undefined;
			throw error;
		}
	};
	const prebuiltState: PrebuiltState = {};
	const realizePrebuilt = async (
		pin: Parameters<RelayRealization["deploy"]>[0],
		freightId: string,
	): Promise<
		| Readonly<{ ok: true; outputs: Readonly<Record<string, string>> }>
		| Readonly<{ ok: false; code: string; message: string }>
	> => {
		const pinned = pin.sha;
		if (pinned === undefined)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_SOURCE_UNPINNED",
				message: `Freight ${freightId} pins no commit: a prebuilt delivery builds only a pinned commit.`,
			};
		if (target === "production") {
			const promoted = await promoteStagedBuild({
				client,
				project,
				freightId,
				sha: pinned,
				emit: input.emitProgress,
			});
			if (!promoted.ok) return promoted;
			prebuiltState.projectId = promoted.projectId;
			prebuiltState.promoted = promoted.deployment.id;
			if (promoted.previousDeploymentId !== undefined)
				prebuiltState.promotedFrom = promoted.previousDeploymentId;
			created.deploymentId = promoted.deployment.id;
			created.commit = pinned;
			return {
				ok: true,
				outputs: {
					deploymentId: promoted.deployment.id,
					url: promoted.deployment.url,
					target: "production",
					build: "prebuilt",
					...(promoted.previousDeploymentId !== undefined
						? { promotedFrom: promoted.previousDeploymentId }
						: undefined),
				},
			};
		}
		const repoRoot = repositoryRoot(input.cwd);
		if (repoRoot === undefined)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_CHECKOUT_MISMATCH",
				message: `${input.cwd} is not inside a git checkout: --build prebuilt builds the checkout of the Freight's commit.`,
			};
		const read = await client.readProject(project);
		prebuiltState.projectId = read.id;
		if (configuration.size > 0) {
			const set = await client.setProjectEnv({
				project: read.id,
				target: "production",
				variables: Object.fromEntries(configuration),
			});
			input.emitProgress(
				`production settings: ${set.created.length} created, ${set.updated.length} updated, ${set.unchanged.length} unchanged`,
			);
		}
		const run =
			input.runVercelBuild ??
			vercelBuildRunnerFrom(
				env.HOBO_VERCEL_CLI || "vercel",
				vercelBuildEnvironment(env, {
					VERCEL_TOKEN: token,
					VERCEL_PROJECT_ID: read.id,
					...(teamId !== undefined && teamId !== ""
						? { VERCEL_ORG_ID: teamId }
						: undefined),
				}),
			);
		const staged = await stageVercelBuild({
			run,
			client,
			project: read.id,
			cwd: repoRoot,
			head: await (input.checkoutHead ?? checkoutHeadOf)(repoRoot),
			freightId,
			sha: pinned,
			emit: input.emitProgress,
			...(bundlesStoreBinding && storeBinding !== undefined
				? {
						bundle: {
							file: path.join(input.cwd, BUNDLED_SECRET_STORE_BINDING_FILE),
							text: relayStoreCoordinates(storeBinding),
						},
					}
				: undefined),
		});
		if (!staged.ok) return staged;
		created.deploymentId = staged.deployment.id;
		created.commit = pinned;
		return {
			ok: true,
			outputs: {
				deploymentId: staged.deployment.id,
				url: staged.deployment.url,
				target: "production",
				build: "prebuilt",
				staged: "true",
				...(staged.deployment.readyState !== undefined
					? { readyState: staged.deployment.readyState }
					: undefined),
			},
		};
	};
	const realization: RelayRealization = {
		async deploy(pin, context) {
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
									target: buildTarget,
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
				if (prebuilt) {
					const realized = await realizePrebuilt(pin, context.freightId);
					if (!realized.ok)
						return {
							ok: false,
							code: realized.code,
							message: withoutToken(realized.message),
						};
					return {
						ok: true,
						outputs: Object.fromEntries(
							Object.entries({
								...realized.outputs,
								yard: placement.yard,
								camp: placement.camp,
								...(attached.length > 0
									? { provisioned: describeAttachments(attached) }
									: undefined),
							}).map(([key, value]) => [key, withoutToken(value)]),
						),
					};
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
				if (isJsonString(outputs.deploymentId) && outputs.deploymentId) {
					created.deploymentId = outputs.deploymentId;
					if (pin.sha !== undefined) created.commit = pin.sha;
				}
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
			if (prebuilt && target === "production") {
				let serving = false;
				try {
					serving = await servesProduction(
						client,
						prebuiltState.projectId ?? project,
						deploymentId,
					);
				} catch (error) {
					if (!(error instanceof VercelApiError)) throw error;
					if (!retryableRead(error.status))
						throw new RelayDeploymentReadRefusal(
							error.status,
							withoutToken(error.message),
						);
				}
				if (!serving) return "PROMOTING";
			}
			return (await readDeployment(deploymentId))?.readyState ?? "UNKNOWN";
		},
	};

	const now = input.now ?? Date.now;
	const startedAt = now();
	const declaration = await compileProjectManifest(input.cwd);
	if (declaration === null)
		return usage(
			`${definition.name} did not compile to a declaration, so there is nothing to record as Freight.`,
		);
	// Production is verified at HOBO_CI_RELAY_URL, the production domain: its
	// /healthz must name the commit just deployed, so an origin still serving
	// an older deployment fails verification instead of qualifying this one.
	const productionOrigin =
		target === "production" && wait && sha !== undefined
			? relayOrigin(env.HOBO_CI_RELAY_URL)
			: undefined;
	const verify =
		productionOrigin !== undefined && sha !== undefined
			? {
					origin: productionOrigin,
					probe: commitCheckingProbe(
						input.probe ??
							createBoundedFetchTransport({ fetchImpl: globalThis.fetch }),
						{ origin: productionOrigin, commit: sha.toLowerCase() },
					),
				}
			: undefined;
	let records: ReturnType<typeof recordVerifiedPreviewRecords> | undefined;
	if (recordVerifiedPreview) {
		const loaded = await loadDeliveryFile(RELAY_DELIVERY_FILE, {
			cwd: input.cwd,
		});
		if (!loaded.ok)
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_DELIVERY_INVALID",
				message: `${RELAY_DELIVERY_FILE}: ${loaded.code}: ${loaded.message}. ${loaded.remediation}`,
			};
		records = recordVerifiedPreviewRecords(loaded.value);
		input.emitProgress(
			`verifying preview by the deployment record (no ${RELAY_VERIFY_ORIGIN.preview} set)`,
		);
	}
	const waitLimitMs =
		deadlineAt === undefined
			? WAIT_LIMIT_MS
			: Math.max(0, Math.min(WAIT_LIMIT_MS, deadlineAt - now()));
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
		limitMs: waitLimitMs,
		intervalMs: WAIT_INTERVAL_MS,
		...(records !== undefined ? { records } : undefined),
		...(records !== undefined
			? {
					suites: deployedPreviewSuites({
						intended: () =>
							created.deploymentId !== undefined && created.commit !== undefined
								? {
										deploymentId: created.deploymentId,
										commit: created.commit,
										project: prebuilt
											? (prebuiltState.projectId ?? project)
											: project,
										target: prebuilt ? "production" : "preview",
									}
								: undefined,
						deployment: readDeployment,
					}),
				}
			: undefined),
		...(verify !== undefined
			? { http: verify.probe.transport }
			: input.probe !== undefined
				? { http: input.probe }
				: undefined),
		...(input.sleep !== undefined ? { sleep: input.sleep } : undefined),
		...(input.now !== undefined ? { now: input.now } : undefined),
		emitProgress: input.emitProgress,
	});
	const delivery = delivered.ok
		? delivered.report
		: (delivered.report ?? undefined);
	const deliveryData = delivery !== undefined ? { delivery } : undefined;
	if (
		prebuilt &&
		target === "production" &&
		!delivered.ok &&
		prebuiltState.promoted !== undefined &&
		prebuiltState.promotedFrom === undefined
	)
		return {
			ok: false,
			code: delivered.realization?.code ?? delivered.code,
			message: withoutToken(
				`${delivered.realization?.message ?? delivered.message} Production serves ${prebuiltState.promoted}, and this run recorded no earlier deployment to roll back to (it was already live, or production served none): roll back by hand with vercel rollback.`,
			),
			data: {
				command: "ci deploy",
				failedDeployment: prebuiltState.promoted,
				...deliveryData,
			},
		};
	if (
		prebuilt &&
		target === "production" &&
		!delivered.ok &&
		prebuiltState.promotedFrom !== undefined &&
		prebuiltState.promoted !== undefined
	) {
		const failedWith = delivered.realization?.code ?? delivered.code;
		const restore = prebuiltState.promotedFrom;
		try {
			await client.rollbackProduction(
				prebuiltState.projectId ?? project,
				restore,
				`hobo ci deploy: ${prebuiltState.promoted} failed production verification (${failedWith})`,
			);
		} catch (error) {
			return {
				ok: false,
				code: "HOBO_CI_DEPLOY_ROLLBACK_FAILED",
				message: withoutToken(
					`Production verification of ${prebuiltState.promoted} failed (${failedWith}), and rolling production back to ${restore} failed too: ${error instanceof Error ? error.message : "unknown error"}. Roll back by hand: vercel rollback ${restore}.`,
				),
				data: {
					command: "ci deploy",
					failedDeployment: prebuiltState.promoted,
					rollbackTarget: restore,
					...deliveryData,
				},
			};
		}
		return {
			ok: false,
			code: "HOBO_CI_DEPLOY_ROLLED_BACK",
			message: withoutToken(
				`Production verification of ${prebuiltState.promoted} failed (${failedWith}: ${delivered.realization?.message ?? delivered.message}); production was rolled back to ${restore}, the deployment it served before.`,
			),
			data: {
				command: "ci deploy",
				failedDeployment: prebuiltState.promoted,
				rolledBackTo: restore,
				...deliveryData,
			},
		};
	}
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
				deployTokenSource: deployToken.source,
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
	const why =
		verify !== undefined && sha !== undefined
			? relayVerifyFailure(
					verify.origin,
					sha.toLowerCase(),
					verify.probe.findings(),
				)
			: undefined;
	return {
		ok: false,
		code: why?.code ?? delivered.code,
		message: withoutToken(
			why !== undefined
				? `${delivered.message}\n  ${why.reason}\n  ${why.remediation}`
				: delivered.message,
		),
		data: {
			command: "ci deploy",
			dryRun: false,
			plan: planJson,
			...deliveryData,
			...(why !== undefined ? { verification: { ...why } } : undefined),
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
