import { spawn } from "node:child_process";

import type { CommandResult, PrepareInput, PrepareOutcome } from "@hobo/cli";
import {
	type ConnectPage,
	type ConnectStep,
	evaluatorFromEnv,
	startConnectPage,
} from "@hobo/connect-ui";
import {
	type Env,
	type OpenedSecretStore,
	openSecretStore,
	type SecretStoreDeps,
	type SecretStoreId,
	type SecretStoreOpening,
} from "@hobo/hobo-ci";

import { resolveVercelJunction } from "./junction.js";
import { createVercelConnectFlow, vercelConnected } from "./vercel.js";

// `hobo cd up`'s prepare step: make sure the Vercel connection exists in the
// owner's secret store, then resolve the Vercel junction's credential for
// this convergence. Idempotent (`unchanged` opens nothing); `--what-if` opens
// nothing; a refused connection stops `up` before anything is deployed.
//
// Configuration (the owner's environment; nothing secret):
//   HOBO_CD_VERCEL_INTEGRATION    HoBo CD's Integration slug
//   HOBO_CD_VERCEL_CLIENT_ID      its client id
//   HOBO_CD_VERCEL_REDIRECT_URI   its registered Redirect URL
//                                 (default http://127.0.0.1:8792/vercel/callback)
//   HOBO_CD_SECRET_STORE          infisical (default) | 1password

// public-contract: the Redirect URL HoBo CD's Integration registers by default.
export const DEFAULT_VERCEL_REDIRECT_URI =
	"http://127.0.0.1:8792/vercel/callback";

export interface PrepareVercelDeps extends SecretStoreDeps {
	readonly env?: Env;
	readonly interactive?: boolean;
	readonly openBrowser?: (url: string) => void;
	readonly startPage?: typeof startConnectPage;
	readonly timeoutMs?: number;
	readonly openStore?: (id: SecretStoreId) => Promise<SecretStoreOpening>;
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
		data: { command: "cd", connection: "vercel" },
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
		spawn(command, [url], { stdio: "ignore", detached: true }).unref();
	} catch {
		// The URL is printed as well.
	}
}

async function ready(
	store: OpenedSecretStore,
	outcome: "created" | "unchanged",
): Promise<PrepareOutcome> {
	const resolved = await resolveVercelJunction(store);
	if (!resolved.ok)
		return refused("HOBO_CD_VERCEL_JUNCTION_UNRESOLVED", resolved.message, [
			"Run hobo cd up again; if it persists, check access to the secret store.",
		]);
	return {
		kind: "ready",
		steps: [
			{
				id: "vercel",
				outcome,
				detail: `junction ${resolved.junction.name} (${resolved.junction.yards.map((y) => y.name).join(" <-> ")}); credential in ${store.id}`,
			},
		],
		runtimeEnv: resolved.runtimeEnv,
	};
}

/** Connect Vercel for `hobo cd up` (or confirm it), then resolve the junction. */
export async function prepareVercelConnection(
	input: PrepareInput,
	deps: PrepareVercelDeps = {},
): Promise<PrepareOutcome> {
	const env = deps.env ?? process.env;
	const preferredRaw = env.HOBO_CD_SECRET_STORE || "infisical";
	if (preferredRaw !== "infisical" && preferredRaw !== "1password")
		return refused(
			"HOBO_CD_SECRET_STORE_INVALID",
			"HOBO_CD_SECRET_STORE must be infisical or 1password.",
			[],
		);
	const openStore =
		deps.openStore ?? ((id: SecretStoreId) => openSecretStore(id, env, deps));

	const opened = await openStore(preferredRaw);
	if (opened.ok && (await vercelConnected(opened.store))) {
		if (input.whatIf)
			return {
				kind: "ready",
				steps: [
					{
						id: "vercel",
						outcome: "unchanged",
						detail: `already in ${opened.store.id}`,
					},
				],
			};
		return ready(opened.store, "unchanged");
	}
	if (input.whatIf)
		return {
			kind: "ready",
			steps: [
				{
					id: "vercel",
					outcome: "would-create",
					detail: opened.ok
						? `would install HoBo CD on Vercel and store its token in ${opened.store.id}`
						: `would install HoBo CD on Vercel; ${opened.message}`,
				},
			],
		};

	const slug = env.HOBO_CD_VERCEL_INTEGRATION;
	const clientId = env.HOBO_CD_VERCEL_CLIENT_ID;
	if (!slug || !clientId)
		return refused(
			"HOBO_CD_CONNECTION_UNCONFIGURED",
			"hobo cd up needs HoBo CD's Vercel Integration to connect Vercel.",
			[
				"Export HOBO_CD_VERCEL_INTEGRATION (its slug) and HOBO_CD_VERCEL_CLIENT_ID; its Redirect URL must be HOBO_CD_VERCEL_REDIRECT_URI (default http://127.0.0.1:8792/vercel/callback).",
			],
		);
	const redirect = new URL(
		env.HOBO_CD_VERCEL_REDIRECT_URI || DEFAULT_VERCEL_REDIRECT_URI,
	);
	if (
		redirect.protocol !== "http:" ||
		redirect.hostname !== "127.0.0.1" ||
		redirect.port === ""
	)
		return refused(
			"HOBO_CD_REDIRECT_INVALID",
			"The Integration's Redirect URL must be a loopback URL with a port (http://127.0.0.1:<port>/<path>).",
			[],
		);
	if (!(deps.interactive ?? Boolean(process.stdout.isTTY)))
		return refused(
			"HOBO_CD_CONNECTION_NEEDS_OWNER",
			"Connecting Vercel needs the owner at a browser once; this run cannot show a page.",
			[
				"Run hobo cd up once in a terminal; later runs (and CI) find the connection.",
			],
		);

	let chosen: OpenedSecretStore | undefined;
	const flow = createVercelConnectFlow({
		integrationSlug: slug,
		clientId,
		redirectUri: redirect.href,
		openStore: async (id) => {
			const result = await openStore(id);
			if (result.ok) chosen = result.store;
			return result;
		},
		...(deps.fetch !== undefined ? { fetch: deps.fetch } : undefined),
	});
	const page: ConnectPage = await (deps.startPage ?? startConnectPage)({
		flow,
		evaluate: evaluatorFromEnv(env, deps.fetch),
		port: Number(redirect.port),
		callbackPath: redirect.pathname,
	});
	input.run.emitProgress(`Connect Vercel in your browser: ${page.url}`);
	(deps.openBrowser ?? openInBrowser)(page.url);

	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<ConnectStep>((resolve) => {
		timer = setTimeout(
			() =>
				resolve({
					kind: "failed",
					provider: "vercel",
					message: "The connect page was not finished in time.",
					remediation: ["Run hobo cd up again."],
				}),
			deps.timeoutMs ?? 15 * 60_000,
		);
	});
	let step: ConnectStep;
	try {
		step = await Promise.race([page.done, timedOut]);
	} finally {
		clearTimeout(timer);
		await page.close({ graceMs: 10_000 });
	}
	if (step.kind !== "connected" || chosen === undefined)
		return refused(
			"HOBO_CD_VERCEL_NOT_CONNECTED",
			step.kind === "failed" ? step.message : "Vercel was not connected.",
			step.kind === "failed" ? step.remediation : [],
		);
	return ready(chosen, flow.outcome() ?? "created");
}
