import { createHostedAppBootstrap } from "@hobo/ci-gh-actions";
import pg from "pg";
import { createVercelApplication } from "./composition.js";
import {
	databaseConnection,
	type RelayDatabase,
	resolveDatabaseUrls,
} from "./database-connections.js";
import { StoreUnavailable } from "./store-unavailable.js";
import type { QueueMessage } from "./worker.js";

type App = Awaited<ReturnType<typeof createVercelApplication>>;
type Credentials = {
	appId: number;
	pem: string;
	webhookSecret: string;
	clientId: string;
	clientSecret: string;
};
type Bootstrap = {
	handle(request: Request): Promise<Response | undefined>;
	load(): Promise<Credentials | undefined>;
	isVerifiedOwner?(request: Request): Promise<boolean>;
};
function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`missing configuration: ${name}`);
	return value;
}

export { StoreUnavailable };

/** Serve first-App setup before the relay exists, then load the encrypted App into the runtime. */
export function createBootstrapEntry(options: {
	env: NodeJS.ProcessEnv;
	notify: (deliveryId: string) => Promise<void>;
	continueRepair: () => Promise<void>;
	scheduledRepair: () => Promise<void>;
	expectedGithubOwnerId?: number;
	bootstrap?: Bootstrap;
	createApplication?: typeof createVercelApplication;
	/** The database to run on. Defaults to the one the environment names. */
	database?: RelayDatabase;
	/** Clock for the store back-off; injectable for tests. */
	now?: () => number;
}) {
	const { env } = options;
	const url = new URL(required(env, "HOBO_CI_PUBLIC_URL"));
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("public origin must be HTTPS");
	const encoded = required(env, "HOBO_CI_SESSION_KEY");
	if (!/^[A-Za-z0-9_-]{43}$/.test(encoded))
		throw new Error("invalid session key");
	const key = Buffer.from(encoded, "base64url");
	if (key.length !== 32 || key.toString("base64url") !== encoded)
		throw new Error("invalid session key");
	const invitationExpiry = options.expectedGithubOwnerId
		? required(env, "HOBO_CI_INVITATION_EXPIRES_AT")
		: undefined;
	if (
		invitationExpiry &&
		(!/^\d{13}$/.test(invitationExpiry) ||
			!Number.isSafeInteger(Number(invitationExpiry)))
	)
		throw new Error("invalid owner invitation expiry");
	if (
		env.HOBO_CI_GITHUB_APP_ID ||
		env.HOBO_CI_GITHUB_APP_PRIVATE_KEY ||
		env.HOBO_CI_WEBHOOK_SECRET
	)
		throw new Error(
			"bootstrap and explicit App credentials are mutually exclusive",
		);
	const pool = options.bootstrap
		? undefined
		: new pg.Pool({
				...(options.database?.primary ??
					databaseConnection(
						resolveDatabaseUrls(env).primary,
						env.HOBO_CI_DATABASE_CA_CERT,
					)),
				max: 2,
				connectionTimeoutMillis: 5000,
				idleTimeoutMillis: 10000,
			});
	if (options.database) pool?.on("error", () => {});
	let bootstrap = options.bootstrap;
	if (!bootstrap && pool) {
		const bootstrapOptions: Parameters<typeof createHostedAppBootstrap>[0] = {
			pool,
			key,
			publicOrigin: url.origin,
			accountId: required(env, "HOBO_CI_BOOTSTRAP_ACCOUNT_ID"),
			bootstrapTokenSha256: required(env, "HOBO_CI_BOOTSTRAP_TOKEN_SHA256"),
		};
		if (options.expectedGithubOwnerId) {
			bootstrapOptions.expectedGithubOwnerId = options.expectedGithubOwnerId;
			bootstrapOptions.ownerInvitationSha256 = required(
				env,
				"HOBO_CI_BOOTSTRAP_TOKEN_SHA256",
			);
			bootstrapOptions.ownerInvitationExpiresAt = Number(invitationExpiry);
		}
		bootstrap = createHostedAppBootstrap(bootstrapOptions);
	}
	if (!bootstrap) throw new Error("bootstrap store unavailable");
	const bootstrapStore: Bootstrap = bootstrap;
	const ownerControlToken = options.expectedGithubOwnerId
		? required(env, "HOBO_CI_ONBOARDING_CONTROL_TOKEN")
		: undefined;
	let started: Promise<App | undefined> | undefined,
		closed = false;
	const make = options.createApplication ?? createVercelApplication;
	// After the store fails, leave it alone for a while instead of dialling it
	// again on every request: 5 s, doubling to a minute. A store that is down
	// (or over its quota) answers no faster for being asked more often.
	const clock = options.now ?? Date.now;
	let storeRetryAt = 0;
	let storeFailures = 0;
	async function app(): Promise<App | undefined> {
		if (closed) throw new Error("bootstrap entry closed");
		if (!started && clock() < storeRetryAt)
			throw new StoreUnavailable(storeRetryAt - clock());
		started ??= (async () => {
			const credentials = await bootstrapStore.load();
			if (!credentials) return undefined;
			const next = {
				...env,
				HOBO_CI_GITHUB_APP_ID: String(credentials.appId),
				HOBO_CI_GITHUB_APP_PRIVATE_KEY: credentials.pem,
				HOBO_CI_WEBHOOK_SECRET: credentials.webhookSecret,
				HOBO_CI_GITHUB_APP_CLIENT_ID: credentials.clientId,
				HOBO_CI_GITHUB_APP_CLIENT_SECRET: credentials.clientSecret,
			};
			const applicationOptions: Parameters<typeof createVercelApplication>[0] =
				{
					env: next,
					notify: options.notify,
					continueRepair: options.continueRepair,
					scheduledRepair: options.scheduledRepair,
				};
			if (options.database) applicationOptions.database = options.database;
			if (ownerControlToken && bootstrapStore.isVerifiedOwner)
				applicationOptions.trustedBootstrapControl = async (
					request: Request,
				) =>
					(await bootstrapStore.isVerifiedOwner?.(request))
						? ownerControlToken
						: undefined;
			return make(applicationOptions);
		})();
		const pending = started;
		try {
			const result = await pending;
			if (!result && started === pending) started = undefined;
			storeFailures = 0;
			return result;
		} catch (error) {
			if (started === pending) started = undefined;
			storeFailures += 1;
			storeRetryAt =
				clock() + Math.min(60_000, 5_000 * 2 ** (storeFailures - 1));
			throw error;
		}
	}
	return {
		origin: url.origin,
		async handle(request: Request): Promise<Response> {
			if (closed)
				return Response.json(
					{ error: "service unavailable" },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			const path = new URL(request.url).pathname;
			// Liveness is about this process, not its database: a probe must be
			// able to tell "restart me" from "my store is down".
			if (path === "/healthz" && request.method === "GET")
				return Response.json(
					{ ok: true },
					{ status: 200, headers: { "cache-control": "no-store" } },
				);
			if (path.startsWith("/v1/app-bootstrap/"))
				return (
					(await bootstrapStore.handle(request)) ??
					Response.json(
						{ error: "not found" },
						{ status: 404, headers: { "cache-control": "no-store" } },
					)
				);
			let current: App | undefined;
			try {
				current = await app();
			} catch (error) {
				// Readiness says what is wrong, in a word a probe can act on.
				if (path === "/readyz" && request.method === "GET")
					return Response.json(
						{ ready: false, reason: "store-unavailable" },
						{
							status: 503,
							headers: { "cache-control": "no-store", "retry-after": "5" },
						},
					);
				throw error;
			}
			if (current) return current.handle(request);
			if (path === "/readyz" && request.method === "GET")
				return Response.json(
					{ ready: false, reason: "bootstrap-required" },
					{ status: 503, headers: { "cache-control": "no-store" } },
				);
			return Response.json(
				{ error: "GitHub App bootstrap required" },
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		},
		async tick(message: QueueMessage) {
			const current = await app();
			if (!current) throw new Error("GitHub App bootstrap required");
			return current.tick(message);
		},
		async close() {
			closed = true;
			const current = started
				? await started.catch(() => undefined)
				: undefined;
			await current?.close();
			await pool?.end();
		},
	};
}
