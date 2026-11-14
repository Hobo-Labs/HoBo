import { spawn } from "node:child_process";

import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type ConnectFlow,
	type ConnectPage,
	type ConnectStep,
	configureThen,
	resolveSettings,
	startConnectPage,
} from "@hobo/connect-ui";
import { createTrustedVault, type TrustedVault } from "@hobo/core";

import {
	GITHUB_APP_HOSTS,
	type GithubAppOwner,
	resolveGithubAppHost,
} from "./app-hosts.js";
import { browserEnvironment } from "./browser-environment.js";
import { CI_SETTINGS, lookupGithubOwner, resolveGithubAppExpectation } from "./ceremony-settings.js";
import { createGithubConnectFlow, githubAppConnected } from "./github.js";
import {
	familySettings,
	InvalidSecretStoreError,
	type OwnerStoreDeps,
	ownerStore,
	SECRET_STORE_LOCATOR_FILE,
} from "./owner-store.js";
import { ignoredSecretEnvNotice, withoutSecretEnv } from "./secret-custody.js";
import type { Env, OpenedSecretStore } from "./secret-stores.js";

// `hobo ci up`'s prepare step (cli-spec.md "Lifecycle families"): make sure
// the GitHub App exists and its credentials are in the owner's secret store
// before the CI project converges.
//
// Secrets never come from, or go to, the environment or a disk. The store is
// found through its committed, non-secret locator (`.hobo/secret-store.json`)
// and signed in to on the setup page (or by the 1Password desktop app, or a CI
// workload's own OIDC token); the sign-in lives in the run's trusted vault.
// Everything the ceremony was told (relay URL, the App's owner) is kept in
// the store as `HOBO_CI_SETTINGS`, beside the App's credentials, so a
// destroyed devbox is set up again by signing in: nothing is asked twice.
// The owner's id and kind come from GitHub's public users API, so only the
// login is typed, and an organization may own the App.
//
// Idempotent: a store that already holds the App reports `unchanged`.
// `--what-if` opens nothing. Without a person at a browser, and without a
// workload OIDC sign-in, the step refuses and says what is missing.

export interface PrepareGithubDeps extends OwnerStoreDeps {
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
	/** The run's trusted vault; a fresh one by default. */
	readonly vault?: TrustedVault;
}

function refused(
	code: string,
	message: string,
	remediation: readonly string[],
): PrepareOutcome {
	const result: CommandResult = {
		ok: false,
		status: "needs-connection",
		code,
		message,
		remediation,
		data: { command: "ci", connection: "github" },
	};
	return { kind: "refused", result };
}

/** Open a URL with the platform opener after filtering detected secrets. */
export function openInBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";
	try {
		const child = spawn(command, [url], {
			stdio: "ignore",
			detached: true,
			env: browserEnvironment(process.env),
		});
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// The URL is printed as well; opening it is a convenience.
	}
}

/** The CI runner's own OIDC request variables, and nothing else. */
export function workloadOidcOf(env: Env): Env | undefined {
	return env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
		? {
				ACTIONS_ID_TOKEN_REQUEST_URL: env.ACTIONS_ID_TOKEN_REQUEST_URL,
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
			}
		: undefined;
}

/** Run a page to its end (or the timeout); close it gracefully. */
export async function runPage(
	page: ConnectPage,
	provider: string,
	timeoutMs: number,
	again: string,
	onStart?: () => void,
): Promise<ConnectStep> {
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<ConnectStep>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "failed",
					provider,
					message: "The setup page was not finished in time.",
					remediation: [`Run ${again} again; what you answered is saved.`],
				}),
			timeoutMs,
		);
	});
	let browserLaunched = false;
	try {
		onStart?.();
		browserLaunched = true;
		return await Promise.race([page.done, timedOut]);
	} finally {
		clearTimeout(timer);
		await page.close({ graceMs: browserLaunched ? 10_000 : 0 });
	}
}

/** Connect GitHub for `hobo ci up` (or confirm it is already connected). */
export async function prepareGithubConnection(
	input: PrepareInput,
	deps: PrepareGithubDeps = {},
): Promise<PrepareOutcome> {
	const env = deps.env ?? process.env;
	const configuredHost = env.HOBO_CI_APP_HOST;
	if (
		configuredHost &&
		!GITHUB_APP_HOSTS.some((host) => host.id === configuredHost)
	)
		return refused(
			"HOBO_CI_APP_HOST_UNSUPPORTED_OWNER",
			`App host ${configuredHost} is not configured or implemented.`,
			["Use HOBO_CI_APP_HOST=manifest, or unset HOBO_CI_APP_HOST."],
		);
	const notice = ignoredSecretEnvNotice(env);
	if (notice !== undefined) input.run.emitProgress(notice);
	const plainEnv = withoutSecretEnv(env);
	const vault = deps.vault ?? createTrustedVault();
	const workloadOidc = deps.workloadOidc ?? workloadOidcOf(env);
	let owner: Awaited<ReturnType<typeof ownerStore>>;
	try {
		owner = await ownerStore("ci", vault, {
			...deps,
			env: plainEnv,
			...(workloadOidc !== undefined ? { workloadOidc } : undefined),
		});
	} catch (error) {
		if (!(error instanceof InvalidSecretStoreError)) throw error;
		return refused("HOBO_CI_SECRET_STORE_INVALID", error.message, [
			"Choose infisical, 1password, or bitwarden in the store locator.",
		]);
	}

	// Verify the same saved owner and relay the ceremony uses for this store.
	const expectedFor = (store: OpenedSecretStore) => async () => {
		const basics = resolveSettings(CI_SETTINGS, plainEnv, await familySettings(store, "ci").read());
		return resolveGithubAppExpectation(basics.values, plainEnv, deps.fetch);
	};

	// Idempotency first: an existing connection means there is nothing to do.
	let connected = false;
	try {
		connected =
			owner.opened !== undefined && (await githubAppConnected(owner.opened, expectedFor(owner.opened)));
	} catch {
		return refused(
			"HOBO_CI_SECRET_STORE_UNAVAILABLE",
			"Cannot verify the existing GitHub connection in the secret store.",
			[
				"Check store access, the saved owner and relay, and reconcile any partial credentials before retrying.",
			],
		);
	}
	if (owner.opened !== undefined && connected)
		return {
			kind: "ready",
			steps: [
				{
					id: "github-app",
					outcome: "unchanged",
					detail: `already in ${owner.opened.id} (${owner.opened.reference("HOBO_CI_GITHUB_APP_ID")})`,
				},
			],
		};
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "github-app",
					outcome: "would-create",
					detail:
						owner.opened === undefined
							? `would sign in to ${owner.id}${owner.missing.length > 0 ? ` (asking for ${owner.missing.map((f) => f.label).join(", ")})` : ""}, then create the GitHub App unless the store holds it`
							: `would create the GitHub App and store its credentials in ${owner.id}`,
				},
			],
		};
	if (!(deps.interactive ?? Boolean(process.stdout.isTTY)))
		return refused(
			"HOBO_CI_CONNECTION_NEEDS_OWNER",
			"Connecting GitHub needs the owner at a browser once; this run cannot show the setup page.",
			[
				"Run hobo ci up once in a terminal; it asks for what is missing and keeps it in your secret store.",
				`For CI, preconfigure an Infisical machine identity with OIDC Auth (INFISICAL_IDENTITY_ID in ${SECRET_STORE_LOCATOR_FILE}) so the run signs in with its own OIDC token.`,
			],
		);

	let page: ConnectPage | undefined;
	let github: ReturnType<typeof createGithubConnectFlow> | undefined;

	// The App flow, already in its store: straight to "Create the App".
	const githubFlowIn = async (
		store: OpenedSecretStore,
		appOwner: GithubAppOwner,
		relayUrl: string,
	): Promise<ConnectFlow> => {
		github = createGithubConnectFlow({
			relayUrl,
			owner: appOwner,
			callbackUrl: () => page?.callbackUrl ?? "",
			openStore: async () => ({ ok: true, store }),
			...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
		});
		const first = await github.onAction(
			"connect.chooseStore",
			{ store: store.id },
			github.initial,
		);
		return { ...github, initial: first.step };
	};

	const connectedStep = (store: OpenedSecretStore): ConnectFlow => ({
		initial: {
			kind: "connected",
			provider: "github",
			store: store.id,
			references: [store.reference("HOBO_CI_GITHUB_APP_ID")],
			nextHint: "hobo ci up continues in your terminal.",
			link: undefined,
		},
		onAction: async (_action, _params, current) => ({ step: current }),
	});

	const flow = await owner.stage({
		provider: "github",
		reason:
			"hobo ci up keeps the GitHub App's credentials, and what you tell it here, in your secret store.",
		async proceed(store) {
			// Signed in: a store that holds the App needs nothing more.
			try {
				if (await githubAppConnected(store, expectedFor(store))) return connectedStep(store);
			} catch {
				return {
					initial: {
						kind: "failed",
						provider: "github",
						message: "Cannot verify the existing GitHub connection.",
						remediation: [
							"Check store access, the saved owner and relay, and reconcile partial credentials before retrying.",
						],
					},
					onAction: async (_action, _params, current) => ({ step: current }),
				};
			}
			const settings = familySettings(store, "ci");
			const basics = resolveSettings(
				CI_SETTINGS,
				plainEnv,
				await settings.read(),
			);
			return configureThen({
				provider: "github",
				title: "Set up HoBo CI",
				reason:
					"hobo ci up needs to know where the relay runs and who owns the GitHub App. Answers are kept in your secret store.",
				settings: CI_SETTINGS,
				missing: basics.missing,
				known: basics.values,
				store: settings,
				async proceed(values) {
					const relayUrl = values.HOBO_CI_PUBLIC_URL ?? "";
					const login = values.HOBO_CI_GITHUB_OWNER ?? "";
					const pinnedId = Number(plainEnv.HOBO_CI_GITHUB_OWNER_ID);
					const pinnedKind = plainEnv.HOBO_CI_GITHUB_OWNER_TYPE;
					const appOwner: GithubAppOwner | undefined =
						Number.isSafeInteger(pinnedId) &&
						pinnedId > 0 &&
						(pinnedKind === "User" || pinnedKind === "Organization")
							? { kind: pinnedKind, login, id: pinnedId }
							: await lookupGithubOwner(login, deps.fetch);
					if (appOwner === undefined)
						return {
							ok: false,
							errors: {
								HOBO_CI_GITHUB_OWNER:
									"GitHub has no user or organization by that login.",
							},
						};
					const host = resolveGithubAppHost(appOwner, {
						configured: plainEnv.HOBO_CI_APP_HOST || undefined,
					});
					if (!host.ok)
						return {
							ok: false,
							errors: {
								HOBO_CI_GITHUB_OWNER:
									`${host.message} ${host.suggestions.map((s) => `Use ${s.label}.`).join(" ")}`.trim(),
							},
						};
					return {
						ok: true,
						flow: await githubFlowIn(store, appOwner, relayUrl),
					};
				},
			});
		},
	});

	page = await (deps.startPage ?? startConnectPage)({ flow });
	const activePage = page;
	const step = await runPage(
		activePage,
		"github",
		deps.timeoutMs ?? 15 * 60_000,
		"hobo ci up",
		() => {
			input.run.emitProgress(
				`Set up GitHub for HoBo CI in your browser: ${activePage.url}`,
			);
			(deps.openBrowser ?? openInBrowser)(activePage.url);
		},
	);
	if (step.kind !== "connected")
		return refused(
			"HOBO_CI_GITHUB_NOT_CONNECTED",
			step.kind === "failed" ? step.message : "GitHub was not connected.",
			step.kind === "failed" ? step.remediation : [],
		);
	return {
		kind: "ready",
		steps: [
			{
				id: "github-app",
				outcome: github?.outcome() ?? "unchanged",
				detail: `credentials in ${step.store}: ${step.references.join(", ")}`,
			},
		],
	};
}
