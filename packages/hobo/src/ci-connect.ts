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
	redactSecrets,
} from "@hobo/ci-gh-actions/runner-integrations";
import type { CommandResult } from "@hobo/cli";

const execute = promisify(execFile);

export type CiConnectRunner = (
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string; stderr: string }>;

export interface CiConnectOptions {
	readonly cwd: string;
	readonly provider: string;
	readonly values: Record<string, string | boolean | string[] | undefined>;
	readonly env: NodeJS.ProcessEnv;
	readonly run?: CiConnectRunner;
	readonly emitProgress?: (message: string) => void;
}

const PROVIDER_ALIASES: Readonly<Record<string, RunnerIntegrationProvider>> = {
	usejog: "jog",
};

/** Environment variables a provider ceremony must never inherit. */
const STRIPPED_ENV =
	/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nextSteps(entry: RunnerIntegration): string[] {
	const profile = RUNNER_PROVIDER_PROFILES[entry.provider];
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
	const requested = options.provider.toLowerCase();
	const provider = (PROVIDER_ALIASES[requested] ??
		requested) as RunnerIntegrationProvider;
	if (!RUNNER_INTEGRATION_PROVIDERS.includes(provider))
		return usage(
			`Unknown runner provider. Choose one of: ${RUNNER_INTEGRATION_PROVIDERS.join(", ")}.`,
		);
	const auth = string(options.values.auth);
	if (
		auth &&
		!RUNNER_INTEGRATION_AUTH_METHODS.includes(
			auth as RunnerIntegrationAuthMethod,
		)
	)
		return usage(
			`--auth must be one of: ${RUNNER_INTEGRATION_AUTH_METHODS.join(", ")}.`,
		);
	const runsOn = options.values["runs-on"];
	let entry: RunnerIntegration;
	try {
		entry = buildRunnerIntegration(provider, {
			id: string(options.values.id),
			auth: auth as RunnerIntegrationAuthMethod | undefined,
			secretRef: string(options.values["secret-ref"]),
			projectId: string(options.values["project-id"]),
			organization: string(options.values.org),
			runsOn: Array.isArray(runsOn) ? runsOn : undefined,
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
		string(options.values.config) ?? ".hobo/ci.json",
	);
	let document: Record<string, unknown> = {};
	try {
		document = JSON.parse(await readFile(path, "utf8")) as Record<
			string,
			unknown
		>;
		parseCiRunnerIntegrations(JSON.stringify(document));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			return {
				ok: false,
				status: "error",
				code: "HOBO_CI_CONFIG_INVALID",
				message:
					"The CI config has invalid integrations or JSON. Fix it (references only) before connecting.",
			};
	}
	const existing = Array.isArray(document.integrations)
		? (document.integrations as RunnerIntegration[])
		: [];
	const integrations = [
		...existing.filter((item) => item.id !== entry.id),
		entry,
	];
	const next = { ...document, integrations };
	const text = `${JSON.stringify(next, null, 2)}\n`;
	parseCiRunnerIntegrations(text);
	const steps = nextSteps(entry);
	const dryRun = options.values["dry-run"] === true;
	if (!dryRun) await writeAtomic(path, text);
	let ceremony: string | undefined;
	const profile = RUNNER_PROVIDER_PROFILES[provider];
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
			integration: entry as unknown as Record<string, unknown>,
			path,
			dryRun,
		} as never,
	};
}
