import { spawn } from "node:child_process";

import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type ConnectPage,
	type ConnectStep,
	evaluatorFromEnv,
	startConnectPage,
} from "@hobo/connect-ui";

import { createGithubConnectFlow, githubAppConnected } from "./github.js";
import {
	type Env,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
} from "./secret-stores.js";

// `hobo ci up`'s prepare step (cli-spec.md "Lifecycle families"): make sure
// the GitHub App exists and its credentials are in the owner's secret store
// before the CI project converges. Idempotent: when the chosen store already
// holds the App, it reports `unchanged` and opens nothing. `--what-if` opens
// nothing either. A refused or cancelled connection stops `up` before
// anything is deployed.
//
// Configuration (the owner's environment; nothing secret):
//   HOBO_CI_PUBLIC_URL          the relay's public HTTPS origin
//   HOBO_CI_GITHUB_OWNER_ID     numeric id of the GitHub user who owns the App
//   HOBO_CI_GITHUB_OWNER        that user's login (shown on the page)
// The App is user-owned: the reviewed verifier accepts no other owner type.
//   HOBO_CI_SECRET_STORE        infisical (default) | 1password

export interface PrepareGithubDeps extends SecretStoreDeps {
	readonly env?: Env;
	/** Whether a person can answer a browser page. Default: stdout is a TTY. */
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	/** How long the page waits for the owner. Default 15 minutes. */
	readonly timeoutMs?: number;
	/** Tests inject a store; otherwise `openSecretStore` with the owner's sign-in. */
	readonly openStore?: (id: SecretStoreId) => Promise<SecretStoreOpening>;
}

function refused(
	code: string,
	message: string,
	remediation: readonly string[],
	data: Readonly<Record<string, string>> = {},
): PrepareOutcome {
	const result: CommandResult = {
		ok: false,
		status: "needs-connection",
		code,
		message,
		remediation,
		data: { command: "ci", connection: "github", ...data },
	};
	return { kind: "refused", result };
}

function openInBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";
	try {
		const child = spawn(command, [url], { stdio: "ignore", detached: true });
		child.on("error", () => undefined);
		child.unref();
	} catch {
		// The URL is printed as well; opening it is a convenience.
	}
}

function parseStore(value: string | undefined): SecretStoreId | undefined {
	if (value === undefined || value === "") return "infisical";
	return value === "infisical" || value === "1password" ? value : undefined;
}

/** Connect GitHub for `hobo ci up` (or confirm it is already connected). */
export async function prepareGithubConnection(
	input: PrepareInput,
	deps: PrepareGithubDeps = {},
): Promise<PrepareOutcome> {
	const env = deps.env ?? process.env;
	const preferred = parseStore(env.HOBO_CI_SECRET_STORE);
	if (preferred === undefined)
		return refused(
			"HOBO_CI_SECRET_STORE_INVALID",
			"HOBO_CI_SECRET_STORE must be infisical or 1password.",
			["Unset it to use Infisical, or set it to 1password."],
		);
	const openStore =
		deps.openStore ?? ((id: SecretStoreId) => openSecretStore(id, env, deps));

	// Idempotency first: an existing connection means there is nothing to do.
	const opened = await openStore(preferred);
	if (opened.ok) {
		let connected: boolean;
		try {
			connected = await githubAppConnected(opened.store);
		} catch {
			return refused(
				"HOBO_CI_SECRET_STORE_UNAVAILABLE",
				"Cannot verify the existing GitHub connection in the secret store.",
				[
					"Check store access and reconcile any partial credentials before retrying.",
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
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "github-app",
					outcome: "would-create",
					detail: opened.ok
						? `would create the GitHub App and store its credentials in ${opened.store.id}`
						: `would create the GitHub App; ${opened.message}`,
				},
			],
		};

	const relayUrl = env.HOBO_CI_PUBLIC_URL;
	const ownerId = Number(env.HOBO_CI_GITHUB_OWNER_ID);
	const owner = env.HOBO_CI_GITHUB_OWNER;
	if (
		!relayUrl?.startsWith("https://") ||
		!Number.isSafeInteger(ownerId) ||
		ownerId <= 0 ||
		!owner
	)
		return refused(
			"HOBO_CI_CONNECTION_UNCONFIGURED",
			"hobo ci up needs to know where the relay runs and who owns the GitHub App.",
			[
				"Export HOBO_CI_PUBLIC_URL (the relay's https origin), HOBO_CI_GITHUB_OWNER (your login) and HOBO_CI_GITHUB_OWNER_ID (gh api user --jq .id).",
			],
		);
	const interactive = deps.interactive ?? Boolean(process.stdout.isTTY);
	if (!interactive)
		return refused(
			"HOBO_CI_CONNECTION_NEEDS_OWNER",
			"Connecting GitHub needs the owner at a browser once; this run cannot show a page.",
			[
				"Run hobo ci up once in a terminal; later runs (and CI) find the connection and skip this step.",
			],
		);

	let page: ConnectPage | undefined;
	const flow = createGithubConnectFlow({
		relayUrl,
		ownerId,
		owner,
		callbackUrl: () => page?.callbackUrl ?? "",
		openStore,
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
	});
	page = await (deps.startPage ?? startConnectPage)({
		flow,
		evaluate: evaluatorFromEnv(env, deps.fetch),
	});
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<ConnectStep>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "failed",
					provider: "github",
					message: "The connect page was not finished in time.",
					remediation: ["Run hobo ci up again."],
				}),
			deps.timeoutMs ?? 15 * 60_000,
		);
	});
	let step: ConnectStep;
	let browserLaunched = false;
	try {
		input.run.emitProgress(`Connect GitHub in your browser: ${page.url}`);
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
				outcome: flow.outcome() ?? "created",
				detail: `credentials in ${step.store}: ${step.references.join(", ")}`,
			},
		],
	};
}
