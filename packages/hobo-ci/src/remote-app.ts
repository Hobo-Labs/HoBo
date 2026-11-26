import { randomBytes } from "node:crypto";

import type { SettingsStore } from "@hobo/connect-ui";

import type { GithubAppOwner } from "./app-hosts.js";
import { createGithubConnectFlow } from "./github.js";
import { OWNER_SIGN_IN_LINE_PREFIX } from "./infisical-access.js";
import type { OwnerChannel } from "./owner-channel.js";
import type { OpenedSecretStore } from "./secret-stores.js";

/**
 * Create the GitHub App from a remote dev box, with no inbound connection,
 * no tunnel and no service in between.
 *
 * GitHub creates an App from a manifest only through a form its own page
 * receives, and gives the run its credentials only for the one-time code it
 * redirects with. So, over two runs:
 *
 * 1. The run refuses with a link to HoBo's static hand-off page. The
 *    reviewed manifest and GitHub's form address ride in the link's
 *    fragment, which no server receives; the page posts them to GitHub from
 *    the owner's own browser, on any device.
 * 2. The owner clicks Create GitHub App with their own account. GitHub sends
 *    the browser back to that page with its one-time code, which the page
 *    shows as `code~state` and drops from the address bar.
 * 3. The owner hands `code~state` over in the HoBo MCP App's secret form; it
 *    goes only to the waiting run. The next run checks the state against the
 *    one it saved, redeems the code with GitHub (the code works once, within
 *    the hour), verifies the App against the reviewed configuration and puts
 *    its credentials straight into the owner's store.
 *
 * The state is a nonce, not a credential: it is kept in the owner's own HoBo
 * settings so a restart of the agent or its MCP server does not lose it.
 */

export const APP_HANDOFF_PAGE =
	"https://tyler-r-kendrick.github.io/HoBo/github-app/";
export const GITHUB_APP_CODE_CAPTURE = "GITHUB_APP_CODE";

const STATE = "HOBO_CI_GITHUB_APP_STATE";
const STATE_AT = "HOBO_CI_GITHUB_APP_STATE_AT";
/** GitHub's code lives an hour; a link older than this is replaced. */
const STATE_TTL_MS = 50 * 60_000;
const PASTED = /^([A-Za-z0-9_-]{1,200})~([A-Za-z0-9_-]{1,200})$/u;

export type RemoteAppOutcome =
	| { readonly kind: "created" | "unchanged" }
	| {
			readonly kind: "refused";
			readonly code: string;
			readonly message: string;
			readonly remediation: readonly string[];
	  };

export async function createAppRemotely(options: {
	readonly store: OpenedSecretStore;
	readonly relayUrl: string;
	readonly appOwner: GithubAppOwner;
	readonly owner: OwnerChannel;
	/** The owner's own HoBo settings (the state is kept there). */
	readonly locator: SettingsStore;
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly randomState?: () => string;
}): Promise<RemoteAppOutcome> {
	const now = options.now ?? Date.now;
	const saved = await options.locator.read();
	const savedAt = Number(saved[STATE_AT]);
	const fresh =
		saved[STATE] !== undefined &&
		saved[STATE] !== "" &&
		Number.isFinite(savedAt) &&
		now() - savedAt < STATE_TTL_MS;
	const state = fresh
		? (saved[STATE] ?? "")
		: (options.randomState ?? (() => randomBytes(24).toString("base64url")))();
	if (!fresh)
		await options.locator.write({
			...saved,
			[STATE]: state,
			[STATE_AT]: String(now()),
		});
	const forget = async () => {
		const current = await options.locator.read();
		const { [STATE]: _state, [STATE_AT]: _at, ...rest } = current;
		await options.locator.write(rest);
	};

	const flow = createGithubConnectFlow({
		relayUrl: options.relayUrl,
		owner: options.appOwner,
		// GitHub sends the browser back to the hand-off page, which shows the code.
		callbackUrl: () => APP_HANDOFF_PAGE,
		openStore: async () => ({ ok: true, store: options.store }),
		randomState: () => state,
		...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
	});
	const chosen = await flow.onAction(
		"connect.chooseStore",
		{ store: options.store.id },
		flow.initial,
	);
	if (chosen.step.kind === "connected") {
		await forget();
		return { kind: "unchanged" };
	}
	if (chosen.step.kind === "failed")
		return {
			kind: "refused",
			code: "HOBO_CI_APP_FAILED",
			message: chosen.step.message,
			remediation: [...chosen.step.remediation, "Run again."],
		};
	const started = await flow.onAction("connect.start", {}, chosen.step);
	const directive = started.directive;
	if (directive?.kind !== "post")
		throw new Error("the GitHub flow did not produce GitHub's form");
	const fragment = new URLSearchParams({
		manifest: directive.fields.manifest ?? "",
		action: directive.url,
	}).toString();
	const link = `${APP_HANDOFF_PAGE}#${fragment}`;
	const askAgain = (message: string): RemoteAppOutcome => ({
		kind: "refused",
		code: "HOBO_CI_APP_NEEDS_OWNER",
		message,
		remediation: [
			`${OWNER_SIGN_IN_LINE_PREFIX} url=${link} capture=${GITHUB_APP_CODE_CAPTURE}`,
			"Open the link on any device and click Create GitHub App: GitHub creates HoBo CI's App with your own account (you review its permissions there).",
			`GitHub then returns to that page, which shows a single-use code. Hand it over with the HoBo MCP server's secret capture (name ${GITHUB_APP_CODE_CAPTURE}); it goes only to this run, never into chat.`,
			"Then run again: HoBo redeems the code, checks the App and puts its credentials straight into your store.",
		],
	});

	await options.owner.openUrl(
		link,
		"Create the GitHub App, then copy the code HoBo's page shows.",
		GITHUB_APP_CODE_CAPTURE,
	);
	const pasted = await options.owner.captureSecret({
		name: GITHUB_APP_CODE_CAPTURE,
		title: "GitHub App code",
		instructions:
			"After you create the App, GitHub returns to HoBo's page, which shows a single-use code. Copy it here.",
	});
	if (pasted === undefined)
		return askAgain(
			`${options.store.id} holds no GitHub App for HoBo CI yet: create it once with your GitHub account.`,
		);
	const parts = PASTED.exec(pasted.trim());
	if (parts === null)
		return askAgain(
			"What was handed over is not the code HoBo's page shows after GitHub creates the App.",
		);
	const onCallback = flow.onCallback;
	if (onCallback === undefined)
		throw new Error("the GitHub flow takes no callback");
	const callback = await onCallback(
		new URLSearchParams({ code: parts[1] ?? "", state: parts[2] ?? "" }),
		started.step,
	);
	if (callback.step.kind === "connected") {
		await forget();
		return { kind: "created" };
	}
	if (callback.step.kind === "failed") {
		// The code is spent or was never this run's: the next run starts afresh.
		await forget();
		return {
			kind: "refused",
			code: "HOBO_CI_APP_NOT_CREATED",
			message: callback.step.message,
			remediation: [
				...callback.step.remediation,
				"Run again: HoBo gives you a new link.",
			],
		};
	}
	return askAgain("GitHub's answer did not complete the App.");
}
