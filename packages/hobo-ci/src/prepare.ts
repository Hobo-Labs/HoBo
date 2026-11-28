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
	validGithubOrganizationLogin,
} from "./app-hosts.js";
import { ensureBitwardenSignIn } from "./bitwarden-sign-in.js";
import {
	CI_SETTINGS,
	lookupGithubOwner,
	resolveGithubAppExpectation,
} from "./ceremony-settings.js";
import { lazyEgressFetch } from "./egress.js";
import { createGithubConnectFlow, githubAppConnected } from "./github.js";
import { storeAnswers, takeHandOffSignIn } from "./hand-off-store.js";
import {
	captureAll,
	KEPT_STORE_SIGN_INS,
	ownerCaptureLine,
} from "./owner-channel.js";
import { signInOwnerStore } from "./owner-sign-in.js";
import {
	familySettings,
	InvalidSecretStoreError,
	type OwnerStoreDeps,
	ownerLocator,
	ownerStore,
	storeChoiceGuidance,
	storeIdOf,
	storeSignInGuidance,
} from "./owner-store.js";
import { APP_HANDOFF_PAGE, createAppRemotely } from "./remote-app.js";

/** Where the owner finds each CI setting a remote run asks for. */
const CI_SETTING_GUIDES = new Map([
	["HOBO_CI_PUBLIC_URL", "https://vercel.com/dashboard"],
	["HOBO_CI_GITHUB_OWNER", "https://github.com/settings/profile"],
]);

import {
	adoptStoreSignIn,
	browserEnvironment,
	ignoredSecretEnvNotice,
	scopeRunVault,
	withoutSecretEnv,
	withoutStoreSignIn,
} from "./secret-custody.js";
import type { Env, OpenedSecretStore } from "./secret-stores.js";

// `hobo ci up`'s prepare step (cli-spec.md "Lifecycle families"): make sure
// the GitHub App exists and its credentials are in the owner's secret store
// before the CI project converges.
//
// Secrets never come from, or go to, the environment or a disk. The store is
// found through its non-secret locator in the owner's HoBo settings
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
	/** How a handed-off run waits between store probes (tests make it instant). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** How long a handed-off run waits for the owner's sign-in. */
	readonly handOffTimeoutMs?: number;
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

// public-contract: the prefix of the one progress line naming a page the owner must open, for an agent running with --hand-off to pass on.
export const OWNER_PAGE_LINE_PREFIX = "HOBO_OWNER_PAGE";

/** Whether this run may show the owner a page: a terminal, or an agent's hand-off. */
export function canReachOwner(
	interactive: boolean | undefined,
	handOff: boolean | undefined,
): boolean {
	return interactive ?? (handOff === true || Boolean(process.stdout.isTTY));
}

/**
 * Show the owner the page: in a terminal, open the browser; handed off, name
 * it on one line (the page's loopback address and port) for the agent to pass
 * on, and open nothing on a machine that may have no display.
 */
export function showOwnerPage(options: {
	readonly url: string;
	readonly what: string;
	readonly handOff: boolean | undefined;
	readonly emit: (line: string) => void;
	readonly openBrowser: (url: string) => void;
}): void {
	if (options.handOff === true) {
		const port = new URL(options.url).port;
		options.emit(
			`${OWNER_PAGE_LINE_PREFIX} ${options.url} port=${port} — ${options.what}; give this page to the owner and wait (this run waits for them).`,
		);
		return;
	}
	options.emit(`${options.what} in your browser: ${options.url}`);
	options.openBrowser(options.url);
}

/** Open a URL with only the desktop environment needed by the platform opener. */
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

/**
 * The relay deploys to Vercel. `hobo cd up` connects HoBo's Vercel account and
 * keeps the access token in the owner's store; `hobo ci up` reads it into the
 * run's vault for its deploy (never an environment variable). Absent, the
 * deploy refuses and points at `hobo cd up`.
 */
// public-contract: the store entries hobo cd up keeps the Vercel connection in.
export const VERCEL_DEPLOY_ENTRIES = Object.freeze({
	token: "HOBO_CD_VERCEL_TOKEN",
	team: "HOBO_CD_VERCEL_TEAM_ID",
});

async function loadDeployCredentials(
	store: OpenedSecretStore,
	vault: TrustedVault,
): Promise<void> {
	const read = async (entry: string) => {
		const result = await store.port.access(entry).catch(() => undefined);
		return result?.status === "ok" && result.material
			? result.material
			: undefined;
	};
	const token = await read(VERCEL_DEPLOY_ENTRIES.token);
	if (token !== undefined) vault.put("VERCEL_TOKEN", token);
	const team = await read(VERCEL_DEPLOY_ENTRIES.team);
	if (team !== undefined) vault.put("VERCEL_TEAM_ID", team);
}

/** Connect GitHub for `hobo ci up` (or confirm it is already connected). */
export async function prepareGithubConnection(
	input: PrepareInput,
	deps: PrepareGithubDeps = {},
): Promise<PrepareOutcome> {
	const vault = scopeRunVault(deps.vault ?? createTrustedVault());
	// What the convergence needs, and nothing else: the relay deploy's Vercel
	// connection. The store sign-in stays in `vault` and ends with prepare.
	const handoff = createTrustedVault();
	try {
		return await prepareGithubWithVault(input, {
			...deps,
			cwd: deps.cwd ?? input.projectDir,
			fetch: deps.fetch ?? lazyEgressFetch(deps.env ?? process.env),
			vault,
			handoff,
		});
	} finally {
		// What signs this run in to the store stays for the next run, in the
		// owner channel's memory only.
		for (const name of KEPT_STORE_SIGN_INS) {
			const value = vault.reveal(name);
			if (value !== undefined) deps.ownerChannel?.vault?.put(name, value);
		}
		// GitHub's credentials are deposited in the store during prepare; the
		// subsequent convergence does not need the store sign-in.
		vault.clear();
	}
}

async function prepareGithubWithVault(
	input: PrepareInput,
	deps: PrepareGithubDeps & {
		readonly vault: TrustedVault;
		readonly handoff: TrustedVault;
	},
): Promise<PrepareOutcome> {
	const handoff = deps.handoff;
	const env = deps.env ?? process.env;
	if (
		env.HOBO_CI_GITHUB_OWNER_TYPE === "Organization" &&
		env.HOBO_CI_GITHUB_OWNER !== undefined &&
		!validGithubOrganizationLogin(env.HOBO_CI_GITHUB_OWNER)
	)
		return refused(
			"HOBO_CI_GITHUB_OWNER_INVALID",
			"The GitHub organization login is invalid.",
			["Set HOBO_CI_GITHUB_OWNER to the organization's GitHub login."],
		);
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
	// The environment's own store sign-in (a Bitwarden Secrets Manager access
	// token) moves into this run's vault and leaves the environment. It says
	// Bitwarden is configured here; it is used only if the owner chose it.
	const storeSignIn = adoptStoreSignIn(
		deps.env === undefined ? process.env : { ...deps.env },
		deps.vault,
	);
	const notice = ignoredSecretEnvNotice(
		storeSignIn ? withoutStoreSignIn(env) : env,
	);
	if (notice !== undefined) input.run.emitProgress(notice);
	const plainEnv = withoutSecretEnv(env);
	if (env.HOBO_SECRET_STORE) {
		try {
			storeIdOf(env.HOBO_SECRET_STORE);
		} catch (error) {
			if (!(error instanceof InvalidSecretStoreError)) throw error;
			return refused("HOBO_CI_SECRET_STORE_INVALID", error.message, [
				"Choose infisical, 1password, or bitwarden in the store locator.",
			]);
		}
		// The validated choice is a non-secret setting despite its name.
		plainEnv.HOBO_SECRET_STORE = env.HOBO_SECRET_STORE;
	}
	const vault = deps.vault;
	const workloadOidc = deps.workloadOidc ?? workloadOidcOf(env);
	const openOwner = (resolved?: Env) =>
		ownerStore("ci", vault, {
			...deps,
			env: { ...plainEnv, ...resolved },
			// The setup page collected Bitwarden's API key: provision from it
			// (one approved login request) before the store opens.
			beforeOpen: async (id, values) => {
				if (id !== "bitwarden") return { ok: true };
				if (values.BW_CLIENTID) vault.put("BW_CLIENTID", values.BW_CLIENTID);
				const refusal = await ensureBitwardenSignIn({
					family: "ci",
					vault,
					env: { ...plainEnv, ...values },
					locator: ownerLocator(deps),
					fetch: deps.fetch ?? fetch,
					emit: (line) => input.run.emitProgress(line),
					silent: false,
					handOff: false,
					...(deps.sleep !== undefined ? { sleep: deps.sleep } : undefined),
				});
				return refusal === undefined ? { ok: true } : { ok: false, ...refusal };
			},
			...(workloadOidc !== undefined ? { workloadOidc } : undefined),
			// An OAuth sign-in approves in this machine's browser: a terminal
			// run only, never a handed-off one.
			noBrowser: input.handOff === true || input.whatIf,
			oauthBrowser: {
				open: deps.openBrowser ?? openInBrowser,
				emit: (line) => input.run.emitProgress(line),
			},
		});
	let owner: Awaited<ReturnType<typeof ownerStore>>;
	try {
		const signedIn = await signInOwnerStore({
			family: "ci",
			vault,
			open: openOwner,
			deps,
			plainEnv,
			workloadOidc,
			whatIf: input.whatIf,
			handOff: input.handOff === true,
			silent: input.run.flags.json || input.run.flags.quiet,
			emit: (line) => input.run.emitProgress(line),
		});
		if (signedIn.kind === "refused")
			return refused(signedIn.code, signedIn.message, signedIn.remediation);
		owner = signedIn.owner;
		if (input.handOff === true && !input.whatIf && !owner.chosen)
			return refused(
				"HOBO_CI_STORE_CHOICE",
				"Choose your secret store first: Infisical, 1Password or Bitwarden.",
				storeChoiceGuidance(
					storeSignIn ? new Set(["bitwarden"] as const) : undefined,
				),
			);
		// The owner is needed only if the store does not answer yet: a silent
		// run cannot ask, so it refuses before waiting.
		const needsOwner =
			input.handOff === true &&
			!input.whatIf &&
			!(await storeAnswers(owner, "ci"));
		if (needsOwner && owner.handOffSignIn !== undefined) {
			const taken = await takeHandOffSignIn({
				family: "ci",
				owner,
				open: openOwner,
				vault,
				channel: deps.ownerChannel,
			});
			if (taken.kind === "refused")
				return refused(taken.code, taken.message, taken.remediation);
			owner = taken.owner;
		}
		// Through the HoBo MCP server (--json, an owner channel) no progress
		// line reaches anyone: say why the store did not open, never wait.
		else if (
			needsOwner &&
			deps.ownerChannel !== undefined &&
			(input.run.flags.json || input.run.flags.quiet)
		)
			return refused(
				"HOBO_CI_STORE_UNAVAILABLE",
				owner.unopened?.message ?? `${owner.id} did not answer this run.`,
				owner.unopened?.remediation ?? [
					"Run again: HoBo signs in to the store afresh.",
				],
			);
		else if (needsOwner) owner = { ...owner, opened: undefined };
	} catch (error) {
		if (!(error instanceof InvalidSecretStoreError)) throw error;
		return refused("HOBO_CI_SECRET_STORE_INVALID", error.message, [
			"Choose infisical, 1password, or bitwarden in the store locator.",
		]);
	}

	// Verify the same saved owner and relay the ceremony uses for this store.
	const expectedFor = (store: OpenedSecretStore) => async () => {
		const basics = resolveSettings(
			CI_SETTINGS,
			plainEnv,
			await familySettings(store, "ci").read(),
		);
		return resolveGithubAppExpectation(basics.values, plainEnv, deps.fetch);
	};

	// Idempotency first: an existing connection means there is nothing to do.
	let connected = false;
	try {
		connected =
			owner.opened !== undefined &&
			(await githubAppConnected(owner.opened, expectedFor(owner.opened)));
	} catch {
		return refused(
			"HOBO_CI_SECRET_STORE_UNAVAILABLE",
			"Cannot verify the existing GitHub connection in the secret store.",
			[
				"Check store access, the saved owner and relay, and reconcile any partial credentials before retrying.",
			],
		);
	}
	if (owner.opened !== undefined && connected) {
		await loadDeployCredentials(owner.opened, handoff);
		return {
			kind: "ready",
			credentials: handoff,
			steps: [
				{
					id: "github-app",
					outcome: "unchanged",
					detail: `already in ${owner.opened.id} (${owner.opened.reference("HOBO_CI_GITHUB_APP_ID")})`,
				},
			],
		};
	}
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
	// Through the HoBo MCP server the owner channel carries every owner step;
	// only a plain --json run cannot reach the owner.
	if (
		input.handOff === true &&
		deps.ownerChannel === undefined &&
		(input.run.flags.json || input.run.flags.quiet)
	)
		return refused(
			"HOBO_CI_HANDOFF_SILENT",
			"The owner hand-off needs progress output. Omit --json and -q, then retry.",
			["Run hobo ci up --hand-off without --json or -q."],
		);
	// Handed off, the owner may be anywhere, so nothing is served here. The
	// store must open without a page, and the App must already be in it:
	// creating one needs GitHub's own page, whose one-time code must come back
	// to the owner's own run. Only their terminal receives it: no HoBo service
	// may broker it, since the App's keys are theirs.
	if (input.handOff === true) {
		if (owner.opened === undefined)
			return refused(
				"HOBO_CI_STORE_NEEDS_SIGN_IN",
				`A handed-off run shows no sign-in page: ${owner.id} must open without one.`,
				[
					"Choose the store and give its non-secret ids when the run asks; they are kept in your own HoBo settings.",
					...storeSignInGuidance(owner.id, "ci"),
				],
			);
		// No page here: the App is created from the owner's own browser, on
		// any device, and its one-time code comes back through the owner
		// channel (see remote-app.ts).
		if (deps.ownerChannel === undefined)
			return refused(
				"HOBO_CI_APP_NEEDS_OWNER",
				`${owner.opened.id} holds no GitHub App for HoBo CI, and creating one needs you once, on GitHub's own page.`,
				[
					"Run hobo ci up through the HoBo MCP server (its ci tool): it gives you GitHub's page as a link you open on any device, and takes GitHub's one-time code back in its secret form.",
				],
			);
		const ciSettings = familySettings(owner.opened, "ci");
		let basics = resolveSettings(
			CI_SETTINGS,
			plainEnv,
			await ciSettings.read(),
		);
		if (basics.missing.length > 0) {
			// Non-secret, but asked the same way as everything else a remote
			// owner gives: the HoBo MCP App's form, straight to this run.
			const missing = CI_SETTINGS.filter((setting) =>
				basics.missing.some((field) => field.name === setting.field.name),
			);
			const given = await captureAll(
				deps.ownerChannel,
				missing.map((setting) => ({
					name: setting.field.name,
					title: setting.field.label,
					instructions: setting.field.description ?? setting.field.label,
				})),
			);
			const invalid =
				given === undefined
					? []
					: missing.flatMap((setting, at) => {
							const problem = setting.validate?.(given[at] ?? "");
							return problem === undefined
								? []
								: [`${setting.field.label}: ${problem}`];
						});
			if (given === undefined || invalid.length > 0)
				return refused(
					"HOBO_CI_SETTINGS_NEEDED",
					invalid.length > 0
						? `Those settings were not accepted. ${invalid.join(" ")}`
						: `Creating HoBo CI's GitHub App needs ${missing.map((setting) => setting.field.label).join(" and ")}.`,
					[
						...missing.map((setting) =>
							ownerCaptureLine(
								setting.field.name,
								CI_SETTING_GUIDES.get(setting.field.name) ?? APP_HANDOFF_PAGE,
							),
						),
						`Give ${missing.map((setting) => `${setting.field.label} (${setting.field.description ?? ""})`).join(" and ")} in the HoBo MCP App's form; they are kept in your secret store with HoBo CI's other settings.`,
						"Then run again.",
					],
				);
			await ciSettings.write({
				...(await ciSettings.read()),
				...Object.fromEntries(
					missing.map((setting, at) => [setting.field.name, given[at] ?? ""]),
				),
			});
			basics = resolveSettings(CI_SETTINGS, plainEnv, await ciSettings.read());
		}
		const login = basics.values.HOBO_CI_GITHUB_OWNER ?? "";
		const appOwner = await lookupGithubOwner(login, deps.fetch);
		if (appOwner === undefined)
			return refused(
				"HOBO_CI_GITHUB_OWNER_UNKNOWN",
				`GitHub has no user or organization named ${login}.`,
				["Correct HOBO_CI_GITHUB_OWNER when the agent asks, then run again."],
			);
		const created = await createAppRemotely({
			store: owner.opened,
			relayUrl: basics.values.HOBO_CI_PUBLIC_URL ?? "",
			appOwner,
			owner: deps.ownerChannel,
			locator: ownerLocator(deps),
			...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
		});
		if (created.kind === "refused")
			return refused(created.code, created.message, created.remediation);
		await loadDeployCredentials(owner.opened, handoff);
		return {
			kind: "ready",
			credentials: handoff,
			steps: [
				{
					id: "github-app",
					outcome: created.kind,
					detail: `credentials in ${owner.opened.id} (${owner.opened.reference("HOBO_CI_GITHUB_APP_ID")})`,
				},
			],
		};
	}
	if (!canReachOwner(deps.interactive, input.handOff))
		return refused(
			"HOBO_CI_CONNECTION_NEEDS_OWNER",
			"Connecting GitHub needs the owner at a browser once; this run cannot show the setup page.",
			[
				"Run hobo ci up --hand-off through the HoBo MCP server (its ci tool): it brings each step to you as a link or a form, wherever you are, and keeps what you give it in your secret store.",
				"An agent can run hobo ci up --hand-off with a preconnected store and GitHub App; otherwise the run reports the available owner actions.",
				"For CI, run with the owner's store session (HoBo MCP's choose_secret_store): the store's coordinates stay in the owner's secret store and are never set as environment variables.",
			],
		);

	let page: ConnectPage | undefined;
	let signedInStore: OpenedSecretStore | undefined;
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
			signedInStore = store;
			// Signed in: a store that holds the App needs nothing more.
			try {
				if (await githubAppConnected(store, expectedFor(store)))
					return connectedStep(store);
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
		() =>
			showOwnerPage({
				url: activePage.url,
				what: "Set up GitHub for HoBo CI",
				handOff: input.handOff,
				emit: (line) => input.run.emitProgress(line),
				openBrowser: deps.openBrowser ?? openInBrowser,
			}),
	);
	if (step.kind !== "connected")
		return refused(
			"HOBO_CI_GITHUB_NOT_CONNECTED",
			step.kind === "failed" ? step.message : "GitHub was not connected.",
			step.kind === "failed" ? step.remediation : [],
		);
	if (signedInStore !== undefined)
		await loadDeployCredentials(signedInStore, handoff);
	return {
		kind: "ready",
		credentials: handoff,
		steps: [
			{
				id: "github-app",
				outcome: github?.outcome() ?? "unchanged",
				detail: `credentials in ${step.store}: ${step.references.join(", ")}`,
			},
		],
	};
}
