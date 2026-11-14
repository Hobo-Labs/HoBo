import { spawn } from "node:child_process";

import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type ConnectFlow,
	type ConnectPage,
	type ConnectStep,
	configureThen,
	familySettingsStore,
	resolveSettings,
	type SettingsStore,
	startConnectPage,
} from "@hobo/connect-ui";

import {
	GITHUB_APP_HOSTS,
	type GithubAppOwner,
	resolveGithubAppHost,
} from "./app-hosts.js";
import { browserEnvironment } from "./browser-environment.js";
import {
	CI_SETTINGS,
	lookupGithubOwner,
	resolveGithubAppExpectation,
	storeLabel,
	storeSettings,
} from "./ceremony-settings.js";
import { createGithubConnectFlow, githubAppConnected } from "./github.js";
import {
	type Env,
	type OpenedSecretStore,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
} from "./secret-stores.js";

// `hobo ci up`'s prepare step (cli-spec.md "Lifecycle families"): make sure
// the GitHub App exists and its credentials are in the owner's secret store
// before the CI project converges.
//
// An interactive ceremony, not a list of environment variables: whatever is
// not configured (the relay URL, the App's owner, the secret store and its
// coordinates and sign-in) is asked for on the connect page, checked, and the
// non-secret answers are saved for the next run under HOBO_HOME. The owner's
// id and kind (user or organization) come from GitHub's public users API, so
// only the login is typed. Environment variables of the same names still
// win, for CI and scripting.
//
// Idempotent: a store that already holds the App reports `unchanged` and
// opens nothing. `--what-if` opens nothing. Without a person at a browser, the
// step refuses and names each missing setting.

const RELAY_FOLDER = "/hobo-ci-relay";

export interface PrepareGithubDeps extends SecretStoreDeps {
	readonly env?: Env;
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
	/** Tests inject a store; otherwise `openSecretStore` with the owner's sign-in. */
	readonly openStore?: (
		id: SecretStoreId,
		env: Env,
	) => Promise<SecretStoreOpening>;
	/** Where answered settings are kept (default HOBO_HOME/ceremonies/ci.json). */
	readonly settings?: SettingsStore;
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

function storeIdOf(value: string | undefined): SecretStoreId {
	return value === "1password" || value === "bitwarden" ? value : "infisical";
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
	const settings = deps.settings ?? familySettingsStore("ci", env);
	const saved = await settings.read();
	const openStore =
		deps.openStore ??
		((id: SecretStoreId, storeEnv: Env) => openSecretStore(id, storeEnv, deps));

	const basics = resolveSettings(CI_SETTINGS, env, saved);
	const configuredStore = basics.values.HOBO_CI_SECRET_STORE;
	if (
		configuredStore &&
		configuredStore !== "infisical" &&
		configuredStore !== "1password" &&
		configuredStore !== "bitwarden"
	)
		return refused(
			"HOBO_CI_SECRET_STORE_INVALID",
			"HOBO_CI_SECRET_STORE must be infisical, 1password, or bitwarden.",
			["Unset it to use Infisical, or choose 1password or bitwarden."],
		);
	const storeId = storeIdOf(basics.values.HOBO_CI_SECRET_STORE);
	const storeSide = resolveSettings(
		storeSettings(storeId, RELAY_FOLDER),
		env,
		saved,
	);

	// Idempotency first: an existing connection means there is nothing to do.
	if (storeSide.missing.length === 0) {
		const opened = await openStore(storeId, { ...env, ...storeSide.values });
		if (opened.ok) {
			let connected: boolean;
			try {
				connected = await githubAppConnected(opened.store, () =>
					resolveGithubAppExpectation(basics.values, env, deps.fetch),
				);
			} catch {
				return refused(
					"HOBO_CI_SECRET_STORE_UNAVAILABLE",
					"Cannot verify the existing GitHub connection in the secret store.",
					[
						"Check store access, the configured App owner and relay, and reconcile any partial credentials before retrying.",
					],
				);
			}
			if (connected)
				return {
					kind: "ready",
					steps: [
						{
							id: "github-app",
							outcome: "unchanged",
							detail: `already in ${opened.store.id} (${opened.store.reference("HOBO_CI_GITHUB_APP_ID")})`,
						},
					],
				};
		}
	}
	const missing = [...basics.missing, ...storeSide.missing];
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "github-app",
					outcome: "would-create",
					detail:
						missing.length === 0
							? `would create the GitHub App and store its credentials in ${storeId}`
							: `would ask for ${missing.map((field) => field.label).join(", ")}, then create the GitHub App`,
				},
			],
		};
	if (!(deps.interactive ?? Boolean(process.stdout.isTTY)))
		return refused(
			"HOBO_CI_CONNECTION_NEEDS_OWNER",
			"Connecting GitHub needs the owner at a browser once; this run cannot show the setup page.",
			[
				"Run hobo ci up once in a terminal; it asks for what is missing and later runs (and CI) find the connection.",
				...(missing.length > 0
					? [
							`Or set ${missing.map((field) => field.name).join(", ")} in the environment.`,
						]
					: []),
			],
		);

	let page: ConnectPage | undefined;
	let github: ReturnType<typeof createGithubConnectFlow> | undefined;

	// The App flow, already in its store: straight to "Create the App".
	const githubFlowIn = async (
		store: OpenedSecretStore,
		owner: GithubAppOwner,
		relayUrl: string,
	): Promise<ConnectFlow> => {
		github = createGithubConnectFlow({
			relayUrl,
			owner,
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

	const flow = await configureThen({
		provider: "github",
		title: "Set up HoBo CI",
		reason:
			"hobo ci up needs to know where the relay runs, who owns the GitHub App, and where to keep its credentials.",
		settings: CI_SETTINGS,
		missing: basics.missing,
		known: basics.values,
		store: settings,
		async proceed(values) {
			const relayUrl = values.HOBO_CI_PUBLIC_URL ?? "";
			const login = values.HOBO_CI_GITHUB_OWNER ?? "";
			const pinnedId = Number(env.HOBO_CI_GITHUB_OWNER_ID);
			const pinnedKind = env.HOBO_CI_GITHUB_OWNER_TYPE;
			const owner: GithubAppOwner | undefined =
				Number.isSafeInteger(pinnedId) &&
				pinnedId > 0 &&
				(pinnedKind === "User" || pinnedKind === "Organization")
					? { kind: pinnedKind, login, id: pinnedId }
					: await lookupGithubOwner(login, deps.fetch);
			if (owner === undefined)
				return {
					ok: false,
					errors: {
						HOBO_CI_GITHUB_OWNER:
							"GitHub has no user or organization by that login.",
					},
				};
			const host = resolveGithubAppHost(owner, {
				configured: env.HOBO_CI_APP_HOST || undefined,
			});
			if (!host.ok)
				return {
					ok: false,
					errors: {
						HOBO_CI_GITHUB_OWNER:
							`${host.message} ${host.suggestions.map((s) => `Use ${s.label}.`).join(" ")}`.trim(),
					},
				};
			const chosen = storeIdOf(values.HOBO_CI_SECRET_STORE);
			const sideSettings = storeSettings(chosen, RELAY_FOLDER);
			const side = resolveSettings(sideSettings, env, await settings.read());
			const stage = await configureThen({
				provider: "github",
				title:
					`Connect ${storeLabel(chosen)}`,
				reason: `HoBo writes the App's credentials straight into ${storeLabel(chosen)}. Coordinates are saved for next time; a sign-in token is used for this run only.`,
				settings: sideSettings,
				missing: side.missing,
				known: side.values,
				store: settings,
				async proceed(storeValues) {
					const opened = await openStore(chosen, { ...env, ...storeValues });
					if (!opened.ok) {
						const first =
							side.missing[0]?.name ?? sideSettings[0]?.field.name ?? "store";
						return {
							ok: false,
							errors: {
								[first]: `${opened.message} ${opened.remediation.join(" ")}`,
							},
						};
					}
					return {
						ok: true,
						flow: await githubFlowIn(opened.store, owner, relayUrl),
					};
				},
			});
			return { ok: true, flow: stage };
		},
	});

	page = await (deps.startPage ?? startConnectPage)({ flow });
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<ConnectStep>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "failed",
					provider: "github",
					message: "The setup page was not finished in time.",
					remediation: ["Run hobo ci up again; what you answered is saved."],
				}),
			deps.timeoutMs ?? 15 * 60_000,
		);
	});
	let step: ConnectStep;
	let browserLaunched = false;
	try {
		input.run.emitProgress(
			`Set up GitHub for HoBo CI in your browser: ${page.url}`,
		);
		(deps.openBrowser ?? openInBrowser)(page.url);
		browserLaunched = true;
		step = await Promise.race([page.done, timedOut]);
	} finally {
		clearTimeout(timer);
		// Give a launched browser time to show the final step; on startup
		// failure there is no browser to wait for, so close immediately.
		await page.close({ graceMs: browserLaunched ? 10_000 : 0 });
	}
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
				outcome: github?.outcome() ?? "created",
				detail: `credentials in ${step.store}: ${step.references.join(", ")}`,
			},
		],
	};
}
