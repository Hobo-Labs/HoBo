import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseCiRunnerIntegrations } from "@hobo/ci-gh-actions/project-config";
import {
	buildRunnerIntegration,
	RUNNER_INTEGRATION_AUTH_METHODS,
	RUNNER_INTEGRATION_PROVIDERS,
	RUNNER_PROVIDER_PROFILES,
	type RunnerIntegration,
	type RunnerIntegrationAuthMethod,
	type RunnerIntegrationProvider,
	type RunnerProviderProfile,
	redactSecrets,
} from "@hobo/ci-gh-actions/runner-integrations";
import type { CommandResult } from "@hobo/cli";
import {
	cloneAsJson,
	isJsonString,
	type JsonObject,
	parseJsonObject,
} from "./json.js";

const execute = promisify(execFile);

function invalidConfig(): CommandResult {
	return {
		ok: false,
		status: "error",
		code: "HOBO_CI_CONFIG_INVALID",
		message:
			"The CI config has invalid integrations or JSON. Fix it (references only) before connecting.",
	};
}

export type CiConnectRunner = (
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

export interface CiConnectOptions {
	readonly cwd: string;
	readonly provider: string;
	readonly values: Readonly<{
		auth?: ConnectValue;
		id?: ConnectValue;
		"secret-ref"?: ConnectValue;
		"project-id"?: ConnectValue;
		org?: ConnectValue;
		config?: ConnectValue;
		"runs-on"?: ConnectValue;
		"dry-run"?: ConnectValue;
		launch?: ConnectValue;
	}>;
	readonly env: NodeJS.ProcessEnv;
	readonly run?: CiConnectRunner;
	readonly emitProgress?: (message: string) => void;
}

/** `usejog` is the product's domain name; the provider id is `jog`. */
function canonicalProvider(name: string): string {
	const lowered = name.toLowerCase();
	return lowered === "usejog" ? "jog" : lowered;
}

function isProvider(name: string): name is RunnerIntegrationProvider {
	return RUNNER_INTEGRATION_PROVIDERS.some((provider) => provider === name);
}

function isAuthMethod(name: string): name is RunnerIntegrationAuthMethod {
	return RUNNER_INTEGRATION_AUTH_METHODS.some((method) => method === name);
}

type ConnectValue = string | boolean | readonly string[] | undefined;

/** CLI flag values arrive from parseArgs; only plain strings are meaningful here. */
function flagText(value: ConnectValue): string | undefined {
	return isJsonString(value) ? value : undefined;
}

function isMissingFile(error: Error | null | undefined): boolean {
	return (
		error !== null &&
		error !== undefined &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

/** Environment variables a provider ceremony must never inherit. */
const STRIPPED_ENV =
	/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function nextSteps(entry: RunnerIntegration): string[] {
	const profile: RunnerProviderProfile =
		RUNNER_PROVIDER_PROFILES[entry.provider];
	const org = entry.organization ? ` for ${entry.organization}` : "";
	switch (entry.auth.method) {
		case "github-app":
			return [
				`Sign in to ${profile.displayName} with GitHub and install its GitHub App${org}: ${profile.ceremonyUrl} (organization owner).`,
				`Then use runs-on: ${entry.runsOn[0]} in workflows. Docs: ${profile.docsUrl}`,
			];
		case "oidc":
			return [
				`Add a GitHub Actions trust relationship for this repository in ${profile.displayName} project ${entry.auth.projectId} (Project Settings → Trust Relationships).`,
				"Grant the workflow job `permissions: { id-token: write, contents: read }`; no stored token is needed.",
				`Docs: ${profile.docsUrl}`,
			];
		case "device":
			return [
				`Run \`${[...(profile.ceremonyCommand ?? []), ...(entry.organization ? ["--org", entry.organization] : [])].join(" ")}\` (or rerun with --launch) to complete the browser sign-in.`,
				`Docs: ${profile.docsUrl}`,
			];
		case "secret-ref": {
			const ref = entry.auth.secretRef ?? "";
			const [kind, name] = ref.split(":");
			return [
				kind === "github-secret"
					? `Store the credential yourself with \`gh secret set ${name}\` (it prompts; never pass the value on the command line).`
					: `Export ${name} in the runner environment yourself; HoBo only stores the name.`,
				"Prefer the provider's GitHub App or OIDC when available.",
			];
		}
	}
}

async function writeAtomic(path: string, text: string): Promise<void> {
	const temp = join(dirname(path), `.ci.json.${randomUUID()}.tmp`);
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(temp, text, { mode: 0o644, flag: "wx" });
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * `hobo ci connect <provider>`: record a references-only runner integration in
 * `.hobo/ci.json` and walk the owner through the provider's own sign-in
 * ceremony. It never asks for, reads, prints or stores a credential value.
 */
export async function runCiConnect(
	options: CiConnectOptions,
): Promise<CommandResult> {
	const provider = canonicalProvider(options.provider);
	if (!isProvider(provider))
		return usage(
			`Unknown runner provider. Choose one of: ${RUNNER_INTEGRATION_PROVIDERS.join(", ")}.`,
		);
	const auth = flagText(options.values.auth);
	if (auth !== undefined && !isAuthMethod(auth))
		return usage(
			`--auth must be one of: ${RUNNER_INTEGRATION_AUTH_METHODS.join(", ")}.`,
		);
	const runsOn = options.values["runs-on"];
	let entry: RunnerIntegration;
	try {
		entry = buildRunnerIntegration(provider, {
			id: flagText(options.values.id),
			auth,
			secretRef: flagText(options.values["secret-ref"]),
			projectId: flagText(options.values["project-id"]),
			organization: flagText(options.values.org),
			runsOn:
				runsOn === undefined ||
				runsOn === true ||
				runsOn === false ||
				isJsonString(runsOn)
					? undefined
					: runsOn,
		});
	} catch (error) {
		return usage(
			redactSecrets(
				`Invalid ${provider} integration: ${error instanceof Error ? error.message : "rejected"}`,
			),
		);
	}
	const path = resolve(
		options.cwd,
		flagText(options.values.config) ?? ".hobo/ci.json",
	);
	let document: JsonObject = {};
	let existing: readonly RunnerIntegration[] = [];
	let source: string | undefined;
	try {
		source = await readFile(path, "utf8");
	} catch (error) {
		if (!(error instanceof Error) || !isMissingFile(error))
			return invalidConfig();
	}
	if (source !== undefined) {
		try {
			existing = parseCiRunnerIntegrations(source);
		} catch {
			return invalidConfig();
		}
		document = parseJsonObject(source);
	}
	const integrations = [
		...existing.filter((item) => item.id !== entry.id),
		entry,
	];
	const next = { ...document, integrations: cloneAsJson(integrations) };
	const text = `${JSON.stringify(next, null, 2)}\n`;
	parseCiRunnerIntegrations(text);
	const steps = nextSteps(entry);
	const dryRun = options.values["dry-run"] === true;
	if (!dryRun) await writeAtomic(path, text);
	let ceremony: string | undefined;
	const profile: RunnerProviderProfile = RUNNER_PROVIDER_PROFILES[provider];
	if (
		options.values.launch === true &&
		!dryRun &&
		entry.auth.method === "device" &&
		profile.ceremonyCommand
	) {
		const [command, ...args] = profile.ceremonyCommand;
		const env = Object.fromEntries(
			Object.entries(options.env).filter(([key]) => !STRIPPED_ENV.test(key)),
		);
		options.emitProgress?.(`Starting ${profile.displayName} sign-in…`);
		try {
			const run =
				options.run ??
				(async (
					cmd: string,
					cmdArgs: readonly string[],
					cmdEnv: NodeJS.ProcessEnv,
				) =>
					execute(cmd, [...cmdArgs], {
						env: cmdEnv,
						timeout: 15 * 60_000,
						maxBuffer: 1 << 20,
					}));
			const result = await run(
				command ?? "",
				[...args, ...(entry.organization ? ["--org", entry.organization] : [])],
				env,
			);
			ceremony = redactSecrets(`${result.stdout}\n${result.stderr}`.trim());
		} catch {
			return {
				ok: false,
				status: "error",
				code: "HOBO_CI_CONNECT_CEREMONY",
				message: `${profile.displayName} sign-in did not complete. The integration reference was saved; rerun \`${profile.ceremonyCommand.join(" ")}\` yourself.`,
			};
		}
	}
	const message = redactSecrets(
		[
			`${dryRun ? "Would save" : "Saved"} ${profile.displayName} integration "${entry.id}" (${entry.auth.method}) to ${path}. No credentials were stored.`,
			...(ceremony ? [ceremony] : []),
			...steps.map((step) => `- ${step}`),
		].join("\n"),
	);
	return {
		message,
		data: {
			integration: entry,
			path,
			dryRun,
		},
	};
}
