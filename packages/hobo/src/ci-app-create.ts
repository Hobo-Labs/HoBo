/**
 * public-contract: `hobo ci app create`: create the hosted relay's GitHub App with GitHub's
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
	verifyStoredGithubApp,
} from "@hobo/ci-gh-actions";
import type { CommandResult } from "@hobo/cli";
import {
	type AppHandOffMode,
	type OpenTunnel,
	type RedirectReceiver,
	RedirectReceiverError,
} from "@hobo/hobo-ci";
import type { SecretsPort } from "@hobo/identity";
import { z } from "zod";
import { openBrowser } from "./ci-github-connect.js";
import {
	loadSecretStoreBinding,
	SECRET_STORE_SESSION_REQUIRED,
	SecretStoreBindingRefusal,
	type SecretStoreBindingStore,
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
	viaWorkflow?: boolean | undefined;
	/**
	 * The owner's outbound-only tunnel (HOBO_REDIRECT_RECEIVER), so GitHub's
	 * redirect reaches this run when the owner's browser cannot reach it.
	 */
	receiver?: RedirectReceiver | undefined;
	/**
	 * An agent runs this for an owner it cannot bring to this machine. With a
	 * receiver, the receiver carries the redirect; without one, the owner's
	 * hand-off does (HOBO_APP_HANDOFF: `paste`, the default, or `store`).
	 */
	handOff?: boolean | undefined;
	/** Reaches a tunnel's public origin (tests stand in the provider's edge). */
	tunnelProbe?: typeof fetch | undefined;
	/** How long to wait for a tunnel to carry its first request. Default 60s. */
	tunnelProbeTimeoutMs?: number | undefined;
	/** The hand-off mode, parsed at the CLI boundary; `paste` when unset. */
	handOffMode?: AppHandOffMode | undefined;
	/** The owner's pasted code (paste hand-off): one line from stdin by default. */
	readCode?: (() => Promise<string>) | undefined;
	/** Tests inject the dispatch; otherwise `gh workflow run` with the inputs on stdin. */
	dispatchWorkflow?:
		| ((inputs: Readonly<Record<string, string>>) => Promise<void>)
		| undefined;
}>;

// public-contract: the workflow whose App-credentials job converts the manifest code.
export const APP_CREDENTIALS_WORKFLOW = "app-credentials.yml";

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
	/** The owner's outbound-only tunnel; without one, loopback only. */
	receiver?: RedirectReceiver | undefined;
	/** Reaches the tunnel's public origin, to prove it carries requests here. */
	probe?: typeof fetch | undefined;
	probeTimeoutMs?: number | undefined;
}): Promise<string> {
	// Everything is served under one unguessable prefix: through a tunnel,
	// nothing else on this listener answers, and it takes one callback.
	const base = `/r/${randomBytes(24).toString("base64url")}/`;
	const probeToken = randomBytes(16).toString("base64url");
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
		if (request.method === "GET" && url.pathname === `${base}probe`) {
			// Proof that the tunnel's edge reaches this listener: a token only
			// this run knows, echoed back.
			response
				.writeHead(204, { "x-hobo-receiver": probeToken, ...headers })
				.end();
			return;
		}
		if (request.method === "GET" && url.pathname === base) {
			response.writeHead(200, headers).end(startPage(input.action, manifest));
			return;
		}
		if (
			request.method === "GET" &&
			url.pathname === `${base}callback` &&
			!used
		) {
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
	let tunnel: OpenTunnel | undefined;
	try {
		tunnel = await input.receiver?.open(port);
		// A printed URL is not a working tunnel: prove the edge carries a
		// request to this listener before giving the owner the link.
		if (tunnel !== undefined)
			await proveTunnel(
				`${tunnel.publicOrigin}${base}probe`,
				probeToken,
				input.probe ?? fetch,
				input.probeTimeoutMs ?? 60_000,
			);
	} catch (error) {
		try {
			await tunnel?.close();
		} finally {
			server.closeAllConnections();
			server.close();
		}
		throw error;
	}
	const origin = tunnel?.publicOrigin ?? `http://127.0.0.1:${port}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		manifest = input.manifestFor(`${origin}${base}callback`);
		timer = setTimeout(
			() => settle.reject(new Error("timed out")),
			input.timeoutMs,
		);
		input.show(`${origin}${base}`);
		return await result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		try {
			await tunnel?.close();
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
}

/** Wait until the tunnel's public URL reaches this run's listener, or fail. */
async function proveTunnel(
	url: string,
	token: string,
	send: typeof fetch,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const answer = await send(url, {
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
		if (
			answer?.status === 204 &&
			answer.headers.get("x-hobo-receiver") === token
		)
			return;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	throw new RedirectReceiverError(
		"HOBO_REDIRECT_RECEIVER_FAILED",
		"The tunnel printed a public address but did not carry a request to this run (its client could not reach the provider's edge).",
	);
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
	send: typeof fetch | undefined,
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
			...(send !== undefined ? { fetch: send } : undefined),
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

// public-contract: the static page that, in the owner's browser, posts the manifest to GitHub and shows GitHub's one-time code; it sends nothing anywhere.
export const APP_HANDOFF_PAGE =
	"https://tyler-r-kendrick.github.io/HoBo/github-app/";
// public-contract: the progress line naming the page the owner opens to create the App and copy its code back.
export const OWNER_APP_LINE_PREFIX = "HOBO_OWNER_APP";
// public-contract: the progress line naming GitHub's prefilled registration form, when the owner stores the App themselves.
export const OWNER_APP_REGISTER_LINE_PREFIX = "HOBO_OWNER_APP_REGISTER";

const ManifestJson = z.object({
	name: z.string(),
	url: z.string(),
	hook_attributes: z.object({ url: z.string(), active: z.boolean() }),
	setup_url: z.string().optional(),
	callback_urls: z.array(z.string()).optional(),
	default_events: z.array(z.string()),
	default_permissions: z.record(z.string(), z.string()),
});

/**
 * GitHub's registration form, prefilled with URL parameters
 * (docs: registering-a-github-app-using-url-parameters). The owner creates
 * the App there with their own account; nothing comes back to this run.
 */
export function appRegistrationUrl(manifestJson: string): string {
	const manifest = ManifestJson.parse(JSON.parse(manifestJson));
	const url = new URL("https://github.com/settings/apps/new");
	const params = url.searchParams;
	params.set("name", manifest.name);
	params.set("url", manifest.url);
	params.set("webhook_active", String(manifest.hook_attributes.active));
	params.set("webhook_url", manifest.hook_attributes.url);
	if (manifest.setup_url) params.set("setup_url", manifest.setup_url);
	for (const callback of manifest.callback_urls ?? [])
		params.append("callback_urls[]", callback);
	params.set("public", "false");
	for (const [permission, access] of Object.entries(
		manifest.default_permissions,
	))
		params.set(permission, access);
	for (const event of manifest.default_events) params.append("events[]", event);
	return url.href;
}

/** One line from stdin: the owner's pasted `code~state`. */
function readLineFromStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let text = "";
		const onData = (chunk: Buffer) => {
			text += chunk.toString("utf8");
			const end = text.indexOf("\n");
			if (end !== -1) {
				process.stdin.off("data", onData);
				process.stdin.pause();
				resolve(text.slice(0, end));
			}
		};
		process.stdin.on("data", onData);
		process.stdin.once("end", () => resolve(text));
		process.stdin.once("error", reject);
	});
}

class PastedCodeError extends Error {}

/**
 * The paste hand-off: the owner opens the static page (the manifest rides in
 * the URL fragment, which no server receives), creates the App on GitHub,
 * and GitHub redirects back to that page, which shows `code~state`. The
 * owner gives it to the agent, which writes it to this run's stdin. Nothing
 * connects to this machine and no service receives the code.
 */
async function pastedCode(input: {
	readonly manifestJson: string;
	readonly action: string;
	readonly state: string;
	readonly emit: (line: string) => void;
	readonly readCode: () => Promise<string>;
}): Promise<string> {
	const fragment = new URLSearchParams({
		manifest: input.manifestJson,
		action: input.action,
	}).toString();
	input.emit(
		`${OWNER_APP_LINE_PREFIX} ${APP_HANDOFF_PAGE}#${fragment} — open it on any device and click Create GitHub App; GitHub then shows a single-use code on that page. Give the code to the agent; this run redeems it at once.`,
	);
	const pasted = (await input.readCode()).trim();
	const [code = "", given = ""] = pasted.split("~");
	const expected = Buffer.from(input.state);
	const received = Buffer.from(given);
	if (
		received.length !== expected.length ||
		!timingSafeEqual(received, expected) ||
		!/^[A-Za-z0-9_-]{1,200}$/u.test(code)
	)
		throw new PastedCodeError("not the code GitHub issued for this run");
	return code;
}

/**
 * The store hand-off: the owner registers the App on GitHub's prefilled form,
 * generates its private key and client secret there, and enters them in
 * their own store under the names given; this run waits for them, then
 * checks the App with GitHub. Nothing reaches this machine but the owner's
 * own store.
 */
async function storeFirst(input: {
	readonly manifestJson: string;
	readonly relay: string;
	readonly ownerId: number;
	readonly service: Readonly<{ client: InfisicalClient; port: SecretsPort }>;
	readonly emit: (line: string) => void;
	readonly sleep: (ms: number) => Promise<void>;
	readonly timeoutMs: number;
	readonly fetch?: typeof fetch | undefined;
}): Promise<CommandResult> {
	input.emit(
		`${OWNER_APP_REGISTER_LINE_PREFIX} ${appRegistrationUrl(input.manifestJson)} — create the App there with your account, then on its page generate a private key and a client secret and set a webhook secret. In your Infisical store's relay folder, add ${APP_CREDENTIAL_KEYS.join(", ")} with those values (the App ID, the .pem contents, the webhook secret, the client ID and secret). This run waits and continues on its own.`,
	);
	const deadline = Date.now() + input.timeoutMs;
	while (Date.now() < deadline) {
		let names = new Set<string>();
		try {
			names = new Set(
				(await input.service.client.listSecretNames()).map((s) => s.secretKey),
			);
		} catch {
			// The store is checked again on the next round.
		}
		if (APP_CREDENTIAL_KEYS.every((key) => names.has(key))) {
			const values = new Map<string, string>();
			for (const key of APP_CREDENTIAL_KEYS) {
				const read = await input.service.port.access(key);
				if (read.status !== "ok" || !read.material)
					return failed(
						"HOBO_CI_APP_INCOMPLETE",
						`${key} is in the store but could not be read.`,
					);
				values.set(key, read.material);
			}
			const appId = Number(values.get("HOBO_CI_GITHUB_APP_ID"));
			try {
				await verifyStoredGithubApp({
					appId,
					pem: values.get("HOBO_CI_GITHUB_APP_PRIVATE_KEY") ?? "",
					expectedOrigin: input.relay,
					expectedOwnerId: input.ownerId,
					...(input.fetch !== undefined ? { fetch: input.fetch } : undefined),
				});
			} catch {
				return failed(
					"HOBO_CI_APP_UNVERIFIED",
					`The App in your store (id ${appId}) does not match the reviewed configuration (owner ${input.ownerId}, relay ${input.relay}). Check its permissions, events and webhook URL against the prefilled form.`,
				);
			}
			return {
				message: `The GitHub App ${appId} you stored checks out with GitHub; its credentials stay in your store.`,
				data: { appId, handoff: "store" },
			};
		}
		await input.sleep(10_000);
	}
	return failed(
		"HOBO_CI_APP_TIMEOUT",
		"The App's credentials did not appear in your store in time. Run the command again when they are there; nothing else was changed.",
	);
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
			: configServiceFromEnv(options.env, options.fetch);
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
	const manifestFor = (redirectUrl: string) => {
		const manifest = createGithubAppManifest({
			name,
			relayUrl: relay,
			manifestCallbackUrl: `${relay}/v1/app-bootstrap/callback`,
			installationCallbackUrl: `${relay}/v1/app-registration/install-callback`,
		});
		// GitHub sends the browser back to this run (or the hand-off page),
		// never to the relay.
		manifest.redirectUrl = redirectUrl;
		return githubAppManifestJson(manifest);
	};
	// Handed off with no receiver, the owner's hand-off carries the result.
	// Handed off with no receiver, the owner's hand-off carries the result,
	// in the mode the CLI parsed (paste by default).
	const handOff: AppHandOffMode | undefined =
		options.handOff === true && options.receiver === undefined
			? (options.handOffMode ?? "paste")
			: undefined;
	if (handOff === "store") {
		if (service === undefined)
			return usage(
				"The store hand-off checks the App in your store: it does not combine with --via-workflow.",
			);
		return storeFirst({
			manifestJson: manifestFor(`${relay}/v1/app-bootstrap/callback`),
			relay,
			ownerId,
			service,
			emit: options.emitProgress,
			sleep:
				options.sleep ??
				((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
			timeoutMs: options.callbackTimeoutMs ?? 30 * 60_000,
			fetch: options.fetch,
		});
	}
	// What becomes of GitHub's code: converted into the owner's store here,
	// or handed to the deploy workflow (--via-workflow).
	const finish = async (code: string): Promise<CommandResult> => {
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
				message: `Handed GitHub's one-time code to ${APP_CREDENTIALS_WORKFLOW} (job "Deposit the GitHub App's credentials"). It converts the code and writes the App's credentials straight into the relay's folder as the store writer identity; no credential touched this machine. Watch it with \`gh run watch\`.`,
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
	};
	let code: string;
	try {
		code =
			handOff === "paste"
				? await pastedCode({
						manifestJson: manifestFor(APP_HANDOFF_PAGE),
						action: action.href,
						state,
						emit: options.emitProgress,
						readCode: options.readCode ?? readLineFromStdin,
					})
				: await manifestCallback({
						action: action.href,
						state,
						timeoutMs: options.callbackTimeoutMs ?? 10 * 60_000,
						receiver: options.receiver,
						probe: options.tunnelProbe,
						probeTimeoutMs: options.tunnelProbeTimeoutMs,
						manifestFor,
						show(url) {
							options.emitProgress(
								options.receiver !== undefined
									? `${OWNER_APP_LINE_PREFIX} ${url} — open it on any device to create the GitHub App; GitHub returns through your ${options.receiver.id} tunnel to this run.`
									: `Open this page to create the GitHub App (it posts the manifest to GitHub):\n${url}`,
							);
							if (options.receiver === undefined) open(url);
						},
					});
	} catch (error) {
		if (error instanceof RedirectReceiverError && options.handOff === true) {
			// A broken tunnel is not a dead end: the owner carries the code.
			options.emitProgress(
				`${error.code}: ${error.message} Falling back to the hand-off: you carry GitHub's code back.`,
			);
			try {
				code = await pastedCode({
					manifestJson: manifestFor(APP_HANDOFF_PAGE),
					action: action.href,
					state,
					emit: options.emitProgress,
					readCode: options.readCode ?? readLineFromStdin,
				});
			} catch {
				return failed(
					"HOBO_CI_APP_CODE_INVALID",
					"That is not the code GitHub issued for this run (its state does not match). Nothing was stored; the App GitHub may have created can be deleted at https://github.com/settings/apps, then run again.",
				);
			}
			return finish(code);
		}
		if (error instanceof RedirectReceiverError)
			return failed(
				error.code,
				`${error.message} Without a receiver, run with --hand-off: you carry GitHub's code back (HOBO_APP_HANDOFF=paste) or store the App yourself (HOBO_APP_HANDOFF=store).`,
			);
		if (error instanceof PastedCodeError)
			return failed(
				"HOBO_CI_APP_CODE_INVALID",
				"That is not the code GitHub issued for this run (its state does not match). Nothing was stored; the App GitHub may have created can be deleted at https://github.com/settings/apps, then run again.",
			);
		return failed(
			"HOBO_CI_APP_TIMEOUT",
			"GitHub did not return to this run in time. No App was created by HoBo; run the command again.",
		);
	}

	return finish(code);
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

export async function runCiAppDeposit(options: {
	readonly cwd: string;
	readonly bindingStore?: SecretStoreBindingStore;
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
		const store = await loadSecretStoreBinding(options.bindingStore);
		if (store === undefined)
			return failed(
				"HOBO_CI_SECRET_STORE_NOT_CONNECTED",
				"Your secret store holds no relay binding: connect the store first (hobo ci secret-store connect through the owner hand-off).",
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
		if (
			error instanceof SecretStoreBindingRefusal &&
			error.code === SECRET_STORE_SESSION_REQUIRED
		)
			return failed(error.code, error.message);
		return failed(
			"HOBO_CI_CONFIG_SERVICE_UNCONFIGURED",
			error instanceof SecretStoreBindingRefusal
				? error.message
				: "The owner store's binding does not name a store this job can sign in to.",
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
