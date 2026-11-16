/**
 * `hobo ci app create`: create the hosted relay's GitHub App with GitHub's
 * manifest flow and deposit its credentials straight into the config service
 * (Infisical, ADR-0179). The private key, webhook secret and client secret are
 * held in this process's memory between GitHub's answer and Infisical's, and
 * are never written to disk, printed, or put in an error.
 *
 * Manifest flow: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 * The conversion is one-time: GitHub returns the credentials once, so a failed
 * deposit is retried from memory, and if it cannot succeed the App has to be
 * deleted and created again.
 *
 * Secretless first (ADR-0179 amendment): with `--via-workflow` this machine
 * never holds the credentials or any Infisical credential. It gets GitHub's
 * one-time manifest code from the browser's redirect and hands it, on stdin
 * to `gh workflow run`, to the relay deploy workflow's App-credentials job,
 * which converts it and writes the credentials straight into the relay's
 * folder as `hobo-ci-writer` over GitHub OIDC (`hobo ci app deposit`). The
 * one browser click on GitHub's "Create GitHub App" page stays.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	createInfisicalClient,
	createInfisicalSecretsPort,
	githubActionsJwtSource,
	type InfisicalClient,
	InfisicalError,
	infisicalBindingFromEnv,
	infisicalSecretRef,
	oidcAuth,
	ownerAuthFromEnv,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import {
	createGithubAppManifest,
	githubAppManifestJson,
	verifyConvertedGithubApp,
} from "@hobo/ci-gh-actions";
import type { CommandResult } from "@hobo/cli";
import type { SecretsPort } from "@hobo/identity";
import { z } from "zod";
import { openBrowser } from "./ci-github-connect.js";
import {
	loadSecretStoreBinding,
	SecretStoreBindingRefusal,
} from "./ci-secret-store.js";

/** Entries in deposit order: the App id last, so its presence means complete. */
export const APP_CREDENTIAL_KEYS = [
	"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
	"HOBO_CI_WEBHOOK_SECRET",
	"HOBO_CI_GITHUB_APP_CLIENT_SECRET",
	"HOBO_CI_GITHUB_APP_CLIENT_ID",
	"HOBO_CI_GITHUB_APP_ID",
] as const;
type AppCredentialKey = (typeof APP_CREDENTIAL_KEYS)[number];

const Id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Conversion = z.object({
	id: Id,
	slug: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
	pem: z.string().min(1).max(32_768),
	webhook_secret: z.string().min(1).max(1024),
	client_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
	client_secret: z.string().min(1).max(256),
});

export type AppCreateOptions = Readonly<{
	relay: string | undefined;
	ownerId: string | undefined;
	name?: string | undefined;
	replace: boolean;
	interactive: boolean;
	env: Readonly<Record<string, string | undefined>>;
	emitProgress: (message: string) => void;
	fetch?: typeof fetch | undefined;
	openBrowser?: ((url: string) => void) | undefined;
	prompt?: ((question: string) => Promise<string>) | undefined;
	sleep?: ((ms: number) => Promise<void>) | undefined;
	/** How long to wait for GitHub's redirect. Default 10 minutes. */
	callbackTimeoutMs?: number | undefined;
	/** Automatic deposit attempts without a terminal. Default 5. */
	depositAttempts?: number | undefined;
	/** Tests inject the config service; otherwise it is built from `env`. */
	configService?:
		| Readonly<{ client: InfisicalClient; port: SecretsPort }>
		| undefined;
	/**
	 * Hand GitHub's one-time code to the relay deploy workflow instead of
	 * converting here (secretless: no credential on this machine).
	 */
	viaWorkflow?: boolean | undefined;
	/** Tests inject the dispatch; otherwise `gh workflow run` with the inputs on stdin. */
	dispatchWorkflow?:
		| ((inputs: Readonly<Record<string, string>>) => Promise<void>)
		| undefined;
}>;

// public-contract: the workflow whose App-credentials job converts the manifest code.
export const APP_CREDENTIALS_WORKFLOW = "relay-deploy.yml";

/** `gh workflow run <workflow> --ref main --json`, the inputs on stdin, never in argv. */
function ghWorkflowRun(
	inputs: Readonly<Record<string, string>>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			"gh",
			["workflow", "run", APP_CREDENTIALS_WORKFLOW, "--ref", "main", "--json"],
			{ stdio: ["pipe", "ignore", "ignore"] },
		);
		child.on("error", () => reject(new Error("gh could not start")));
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error("gh workflow run failed")),
		);
		child.stdin.end(JSON.stringify(inputs));
	});
}

function failed(code: string, message: string): CommandResult {
	return { ok: false, code, message };
}

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function relayOrigin(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/gu,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				character
			] ?? character,
	);
}

/** The page that posts the manifest to GitHub (the flow requires a form POST). */
function startPage(action: string, manifest: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Create the HoBo CI GitHub App</title></head><body><form id="m" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(manifest)}"><p>Review the App on GitHub, then create it.</p><button type="submit">Continue to GitHub</button></form><script>document.getElementById("m").submit()</script></body></html>`;
}

const DONE_PAGE =
	'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>HoBo CI</title></head><body><p>GitHub App created. Return to the terminal.</p></body></html>';

/** How the loopback server hands GitHub's one-time code to the waiting command. */
type CallbackSettlement = {
	resolve: (code: string) => void;
	reject: (error: Error) => void;
};

/**
 * Serve the manifest form and wait for GitHub's one redirect to
 * `/callback?code&state` on the loopback interface.
 */
async function manifestCallback(input: {
	manifestFor: (redirectUrl: string) => string;
	action: string;
	state: string;
	timeoutMs: number;
	show: (url: string) => void;
}): Promise<string> {
	const settle: CallbackSettlement = { resolve: () => {}, reject: () => {} };
	const result = new Promise<string>((resolve, reject) => {
		settle.resolve = resolve;
		settle.reject = reject;
	});
	let manifest = "";
	let used = false;
	const expected = Buffer.from(input.state);
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const headers = {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
		};
		if (request.method === "GET" && url.pathname === "/") {
			response.writeHead(200, headers).end(startPage(input.action, manifest));
			return;
		}
		if (request.method === "GET" && url.pathname === "/callback" && !used) {
			const state = url.searchParams.get("state") ?? "";
			const code = url.searchParams.get("code") ?? "";
			const given = Buffer.from(state);
			if (
				given.length !== expected.length ||
				!timingSafeEqual(given, expected) ||
				!/^[A-Za-z0-9_-]{1,200}$/u.test(code)
			) {
				response.writeHead(400, headers).end("Invalid callback.");
				return;
			}
			used = true;
			response.writeHead(200, headers).end(DONE_PAGE);
			settle.resolve(code);
			return;
		}
		response.writeHead(404, headers).end("Not found.");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const { port } = server.address() as AddressInfo;
	const origin = `http://127.0.0.1:${port}`;
	manifest = input.manifestFor(`${origin}/callback`);
	const timer = setTimeout(
		() => settle.reject(new Error("timed out")),
		input.timeoutMs,
	);
	input.show(`${origin}/`);
	try {
		return await result;
	} finally {
		clearTimeout(timer);
		server.closeAllConnections();
		server.close();
	}
}

/** A signed-in store client and the SecretsPort over it. */
type ConfigServiceHandle = Readonly<{
	client: InfisicalClient;
	port: SecretsPort;
}>;

/** The config service the command writes to, or why there is none. */
type ConfigServiceResolution =
	| Readonly<{
			ok: true;
			service: Readonly<{ client: InfisicalClient; port: SecretsPort }>;
	  }>
	| Readonly<{ ok: false; message: string }>;

/** Build the config service from the owner's environment, or explain what is missing. */
function configServiceFromEnv(
	env: AppCreateOptions["env"],
): ConfigServiceResolution {
	let auth: ReturnType<typeof ownerAuthFromEnv>;
	try {
		auth = ownerAuthFromEnv(env);
	} catch {
		return {
			ok: false,
			message:
				"INFISICAL_TOKEN, or INFISICAL_UNIVERSAL_AUTH_CLIENT_ID with INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET, is malformed.",
		};
	}
	if (!auth)
		return {
			ok: false,
			message:
				"Sign in to Infisical first: set INFISICAL_UNIVERSAL_AUTH_CLIENT_ID and INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET for an identity that may write the relay's folder, or INFISICAL_TOKEN from `infisical login --method=universal-auth --silent --plain`. See packages/ci-vercel/CONFIG-SERVICE.md.",
		};
	try {
		const client = createInfisicalClient({
			binding: infisicalBindingFromEnv(env),
			auth,
		});
		return {
			ok: true,
			service: { client, port: createInfisicalSecretsPort({ client }) },
		};
	} catch {
		return {
			ok: false,
			message:
				"Set INFISICAL_PROJECT_ID, INFISICAL_ENVIRONMENT and INFISICAL_SECRET_PATH (and INFISICAL_SITE_URL off Infisical Cloud) to the relay's folder.",
		};
	}
}

export async function runCiAppCreate(
	options: AppCreateOptions,
): Promise<CommandResult> {
	const relay = relayOrigin(options.relay);
	if (!relay)
		return usage(
			"hobo ci app create requires --relay <https-origin>, the relay's public URL.",
		);
	if (!options.ownerId || !/^[1-9]\d{0,15}$/u.test(options.ownerId))
		return usage(
			"hobo ci app create requires --owner-id <id>, your numeric GitHub user id (gh api user --jq .id).",
		);
	const ownerId = Number(options.ownerId);
	const name = options.name ?? "HoBo CI";
	if (!name.trim() || name.length > 100)
		return usage("--name must be 1 to 100 characters.");
	const viaWorkflow = options.viaWorkflow === true;
	const resolution: ConfigServiceResolution | undefined = viaWorkflow
		? undefined
		: options.configService
			? { ok: true, service: options.configService }
			: configServiceFromEnv(options.env);
	if (resolution !== undefined && !resolution.ok)
		return failed("HOBO_CI_CONFIG_SERVICE_UNCONFIGURED", resolution.message);
	const service = resolution?.ok === true ? resolution.service : undefined;

	// Before GitHub: the owner can write, and no App is being replaced by
	// accident. (Through the workflow, the writer cannot read the folder;
	// the deposit there replaces what is present.)
	if (service !== undefined)
		try {
			const { client } = service;
			const existing = new Set(
				(await client.listSecretNames()).map((secret) => secret.secretKey),
			);
			const present = APP_CREDENTIAL_KEYS.filter((key) => existing.has(key));
			if (present.length && !options.replace)
				return failed(
					"HOBO_CI_APP_EXISTS",
					`The config service already holds ${present.join(", ")}. Pass --yes to replace them with a new App's credentials.`,
				);
		} catch (error) {
			const code = error instanceof InfisicalError ? error.code : "unavailable";
			return failed(
				"HOBO_CI_CONFIG_SERVICE_ERROR",
				`Could not read the relay's folder in Infisical (${code}). Nothing was created on GitHub.`,
			);
		}

	const state = randomBytes(32).toString("base64url");
	const action = new URL("https://github.com/settings/apps/new");
	action.searchParams.set("state", state);
	const open = options.openBrowser ?? openBrowser;
	let code: string;
	try {
		code = await manifestCallback({
			action: action.href,
			state,
			timeoutMs: options.callbackTimeoutMs ?? 10 * 60_000,
			manifestFor(redirectUrl) {
				const manifest = createGithubAppManifest({
					name,
					relayUrl: relay,
					manifestCallbackUrl: `${relay}/v1/app-bootstrap/callback`,
					installationCallbackUrl: `${relay}/v1/app-registration/install-callback`,
				});
				// GitHub sends the browser back to this machine, not to the relay.
				manifest.redirectUrl = redirectUrl;
				return githubAppManifestJson(manifest);
			},
			show(url) {
				options.emitProgress(
					`Open this page to create the GitHub App (it posts the manifest to GitHub):\n${url}`,
				);
				open(url);
			},
		});
	} catch {
		return failed(
			"HOBO_CI_APP_TIMEOUT",
			"GitHub did not return to this machine in time. No App was created by HoBo; run the command again.",
		);
	}

	if (service === undefined) {
		try {
			await (options.dispatchWorkflow ?? ghWorkflowRun)({
				manifest_code: code,
				relay,
				owner_id: String(ownerId),
			});
		} catch {
			return failed(
				"HOBO_CI_APP_HANDOFF_FAILED",
				`GitHub created the App's one-time code, but \`gh workflow run ${APP_CREDENTIALS_WORKFLOW}\` did not start. The code expires within an hour; check \`gh auth status\`, then delete the App GitHub may have created (https://github.com/settings/apps) and run the command again.`,
			);
		}
		return {
			message: `Handed GitHub's one-time code to ${APP_CREDENTIALS_WORKFLOW} (job "Deposit the GitHub App's credentials"). It converts the code and writes the App's credentials straight into the relay's folder as hobo-ci-writer; no credential touched this machine. Watch it with \`gh run watch\`.`,
			data: { handoff: APP_CREDENTIALS_WORKFLOW },
		};
	}
	return convertAndDeposit({
		code,
		relay,
		ownerId,
		service,
		replace: options.replace,
		interactive: options.interactive,
		prompt: options.prompt,
		emitProgress: options.emitProgress,
		fetch: options.fetch,
		sleep: options.sleep,
		depositAttempts: options.depositAttempts,
	});
}

/**
 * GitHub's one-time conversion and the deposit, wherever they run: on the
 * owner's machine (`hobo ci app create`) or in the deploy workflow over GitHub
 * OIDC (`hobo ci app deposit`). From the conversion on, the credentials exist
 * only in this process's memory until the store holds them.
 */
async function convertAndDeposit(options: {
	readonly code: string;
	readonly relay: string;
	readonly ownerId: number;
	readonly service: Readonly<{ client: InfisicalClient; port: SecretsPort }>;
	readonly replace: boolean;
	readonly interactive: boolean;
	readonly prompt?: ((question: string) => Promise<string>) | undefined;
	readonly emitProgress: (message: string) => void;
	readonly fetch?: typeof fetch | undefined;
	readonly sleep?: ((ms: number) => Promise<void>) | undefined;
	readonly depositAttempts?: number | undefined;
}): Promise<CommandResult> {
	const { code, relay, ownerId } = options;
	const { client, port } = options.service;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	// The one-time conversion. From here the credentials exist only in memory.
	const send = options.fetch ?? fetch;
	let conversion: z.infer<typeof Conversion>;
	let metadata: unknown;
	try {
		const response = await send(
			`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
			{
				method: "POST",
				headers: {
					accept: "application/vnd.github+json",
					"x-github-api-version": "2026-03-10",
				},
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			},
		);
		if (response.status !== 201 && response.status !== 200)
			throw new Error("conversion refused");
		metadata = await response.json();
		conversion = Conversion.parse(metadata);
	} catch {
		return failed(
			"HOBO_CI_APP_CONVERSION_UNCERTAIN",
			"GitHub's manifest conversion failed or its answer could not be read. The App may exist: check https://github.com/settings/apps, delete an App HoBo did not finish, and run the command again.",
		);
	}
	const { id: appId, slug } = conversion;
	const deleteUrl = `https://github.com/settings/apps/${slug}/advanced`;
	try {
		await verifyConvertedGithubApp({
			appId,
			pem: conversion.pem,
			metadata,
			expectedOrigin: relay,
			expectedOwnerId: ownerId,
			fetch: send,
		});
	} catch {
		return failed(
			"HOBO_CI_APP_UNVERIFIED",
			`GitHub App ${slug} (id ${appId}) was created but does not match the reviewed configuration (owner ${ownerId}, relay ${relay}); its credentials were not stored and are now discarded. Delete it at ${deleteUrl}.`,
		);
	}

	const values = {
		HOBO_CI_GITHUB_APP_PRIVATE_KEY: conversion.pem,
		HOBO_CI_WEBHOOK_SECRET: conversion.webhook_secret,
		HOBO_CI_GITHUB_APP_CLIENT_SECRET: conversion.client_secret,
		HOBO_CI_GITHUB_APP_CLIENT_ID: conversion.client_id,
		HOBO_CI_GITHUB_APP_ID: String(appId),
	} satisfies Record<AppCredentialKey, string>;
	const stored = new Set<AppCredentialKey>();
	const attempts = Math.max(1, options.depositAttempts ?? 5);
	let lastCode = "unavailable";
	for (let attempt = 1; ; attempt++) {
		for (const key of APP_CREDENTIAL_KEYS) {
			if (stored.has(key)) continue;
			try {
				await port.put(key, values[key]);
				stored.add(key);
			} catch (error) {
				lastCode = error instanceof InfisicalError ? error.code : "unavailable";
				break;
			}
		}
		if (stored.size === APP_CREDENTIAL_KEYS.length) break;
		const pending = APP_CREDENTIAL_KEYS.filter((key) => !stored.has(key));
		const why = `Storing ${pending.join(", ")} in Infisical failed (${lastCode}). The credentials are held only in this process's memory; GitHub will not show them again.`;
		if (options.interactive && options.prompt) {
			const answer = (
				await options.prompt(
					`${why}\nFix Infisical access, then press Enter to retry, or type "discard" to give up: `,
				)
			)
				.trim()
				.toLowerCase();
			if (answer === "discard") break;
			client.signOut();
			continue;
		}
		if (attempt >= attempts) break;
		options.emitProgress(`${why} Retrying (${attempt}/${attempts - 1}).`);
		client.signOut();
		await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
	}
	// Drop the only references to the credentials.
	for (const key of APP_CREDENTIAL_KEYS) values[key] = "";

	const refs = Object.fromEntries(
		[...stored].map((key) => [key, infisicalSecretRef(client.binding, key)]),
	);
	if (stored.size !== APP_CREDENTIAL_KEYS.length)
		return {
			ok: false,
			code: "HOBO_CI_APP_DEPOSIT_FAILED",
			message: `GitHub App ${slug} (id ${appId}) was created, but its credentials could not all be stored in Infisical (${lastCode}). Stored: ${
				stored.size ? [...stored].join(", ") : "none"
			}. The rest were held only in memory and are now discarded; GitHub's manifest conversion cannot be repeated. Delete the App at ${deleteUrl}, fix Infisical access, and run hobo ci app create again.`,
			data: { appId, slug, stored: [...stored] },
		};
	return {
		message: `GitHub App ${slug} (id ${appId}) created. Its private key, webhook secret, client id and client secret are in Infisical at ${infisicalSecretRef(
			client.binding,
			"HOBO_CI_GITHUB_APP_ID",
		).replace(
			/\/HOBO_CI_GITHUB_APP_ID$/u,
			"/",
		)}; nothing was written to disk. Install it: https://github.com/apps/${slug}/installations/new`,
		data: { appId, slug, refs },
	};
}

/**
 * `hobo ci app deposit`: the App-credentials job of the relay deploy workflow.
 * Reads GitHub's one-time manifest code from `HOBO_APP_MANIFEST_CODE`,
 * converts it, checks the App against the reviewed configuration, and writes
 * the credentials into the relay's folder named by the committed binding,
 * signed in as the binding's CI identity (`hobo-ci-writer`, stored in its
 * `deployIdentityId` field) with this job's GitHub OIDC token. No credential
 * is configured anywhere for it.
 */
export async function runCiAppDeposit(options: {
	readonly cwd: string;
	readonly relay: string | undefined;
	readonly ownerId: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly emitProgress: (message: string) => void;
	readonly fetch?: typeof fetch | undefined;
	readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<CommandResult> {
	const relay = relayOrigin(options.relay);
	if (!relay)
		return usage("hobo ci app deposit requires --relay <https-origin>.");
	if (!options.ownerId || !/^[1-9]\d{0,15}$/u.test(options.ownerId))
		return usage("hobo ci app deposit requires --owner-id <id>.");
	const code = options.env.HOBO_APP_MANIFEST_CODE ?? "";
	if (!/^[A-Za-z0-9_-]{1,200}$/u.test(code))
		return usage(
			"hobo ci app deposit reads GitHub's one-time code from HOBO_APP_MANIFEST_CODE.",
		);
	let service: ConfigServiceHandle;
	try {
		const store = loadSecretStoreBinding(options.cwd);
		if (store === undefined)
			return failed(
				"HOBO_CI_SECRET_STORE_NOT_CONNECTED",
				"No deploy/secret-store.binding.json: connect the store first (hobo ci secret-store connect).",
			);
		const client = createInfisicalClient({
			binding: parseInfisicalBinding({
				siteUrl: store.endpoint,
				projectId: store.projectId,
				environment: store.environment,
				secretPath: store.secretPath,
			}),
			auth: oidcAuth({
				identityId: store.deployIdentityId,
				jwt: githubActionsJwtSource({
					env: options.env,
					...(options.fetch !== undefined
						? { fetch: options.fetch }
						: undefined),
				}),
			}),
			...(options.fetch !== undefined ? { fetch: options.fetch } : undefined),
		});
		service = { client, port: createInfisicalSecretsPort({ client }) };
	} catch (error) {
		return failed(
			"HOBO_CI_CONFIG_SERVICE_UNCONFIGURED",
			error instanceof SecretStoreBindingRefusal
				? error.message
				: "The committed binding does not name a store this job can sign in to.",
		);
	}
	return convertAndDeposit({
		code,
		relay,
		ownerId: Number(options.ownerId),
		service,
		replace: true,
		interactive: false,
		emitProgress: options.emitProgress,
		fetch: options.fetch,
		sleep: options.sleep,
		depositAttempts: 3,
	});
}
