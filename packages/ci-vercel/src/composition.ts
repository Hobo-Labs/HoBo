import { createPrivateKey } from "node:crypto";
import { parseConfiguration } from "@hobo/ci";
import { PostgresCiStore } from "@hobo/ci/postgres";
import {
	createControlAuthenticator,
	createGithubAppTransport,
	createGithubOidcVerifier,
	createHostedAppOnboarding,
	createHostedControlPlane,
	createHostedRelayRuntime,
	createQueuedJobRepair,
	createWebhookRepair,
	HostedRelay,
	PostgresQueuedJobRepairClaims,
	PostgresWebhookRepairClaims,
} from "@hobo/ci-gh-actions";
import pg from "pg";
import { bootstrap, workflow } from "./_generated-assets/relay-assets.js";
import {
	type RelayDatabase,
	relayDatabase,
	verifyRepairDatabase,
	withRepairPool,
} from "./database-connections.js";
import {
	denyDirectSandboxEgress,
	isolatedExecutionWiring,
} from "./execution-wiring.js";
import {
	createVercelRelayHandler,
	type HostedRelayApplication,
} from "./handler.js";
import { createOwnerControlDelegation } from "./owner-control.js";
import { createQueueWakeupHandler } from "./queue-forwarding.js";
import { runtimeDiagnostic } from "./runtime-diagnostic.js";
import { createSandboxComposition } from "./sandbox-composition.js";
import { createSandboxProxyQuotaHandler } from "./sandbox-proxy-quota.js";
import { createScheduledRepairHandler } from "./scheduled-repair.js";
import {
	createHostedWorker,
	type QueueMessage,
	runRepairs,
	withRepairStage,
} from "./worker.js";
import { PostgresWorkerHealth } from "./worker-health.js";

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`missing configuration: ${name}`);
	return value;
}

/** A queue notification is a wakeup hint, never the source of truth. */
export function withWakeup(
	application: HostedRelayApplication,
	notify: (deliveryId: string) => Promise<void>,
): HostedRelayApplication {
	return {
		...application,
		async ingestWebhook(input) {
			const result = await application.ingestWebhook(input);
			if (result !== "ignored") {
				// The separately scheduled repair scan covers enqueue failures and the
				// commit-to-send gap. Keep GitHub's delivery acknowledgement bounded.
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						notify(input.deliveryId),
						new Promise<void>((resolve) => {
							timeout = setTimeout(resolve, 1000);
						}),
					]);
				} catch {
					// Durable inbox still owns the delivery; the repair scan will find it.
				} finally {
					if (timeout) clearTimeout(timeout);
				}
			}
			return result;
		},
	};
}

/** Compose only with real, explicitly provisioned account and GitHub App bindings. */
export async function createVercelApplication(options: {
	env: NodeJS.ProcessEnv;
	notify: (deliveryId: string) => Promise<void>;
	continueRepair: () => Promise<void>;
	scheduledRepair: () => Promise<void>;
	trustedBootstrapControl?: (request: Request) => Promise<string | undefined>;
	/** The database to run on. Defaults to the one the environment names. */
	database?: RelayDatabase;
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
		throw new Error("relay public URL must be an HTTPS origin");
	const key = required(env, "HOBO_CI_GITHUB_APP_PRIVATE_KEY");
	if (createPrivateKey(key).asymmetricKeyType !== "rsa")
		throw new Error("GitHub App key must be RSA");
	const appId = required(env, "HOBO_CI_GITHUB_APP_ID");
	if (!/^[1-9]\d*$/.test(appId)) throw new Error("invalid GitHub App ID");
	const secret = required(env, "HOBO_CI_WEBHOOK_SECRET");
	if (Buffer.byteLength(secret) < 32)
		throw new Error("webhook secret too short");
	const scheduledRepair = createScheduledRepairHandler({
		secret: required(env, "CRON_SECRET"),
		enqueue: options.scheduledRepair,
	});
	const baseAuthenticate = createControlAuthenticator(
		required(env, "HOBO_CI_CONTROL_TOKENS_JSON"),
	);
	const seed = parseConfiguration(required(env, "HOBO_CI_CONFIG_JSON"));
	const database = options.database ?? relayDatabase(env);
	const pool = new pg.Pool({
		...database.primary,
		max: 2,
		connectionTimeoutMillis: 5000,
		idleTimeoutMillis: 10000,
	});
	// On a fleet a backend going away is an expected event: an idle connection
	// that breaks must not take the process down with it.
	if (options.database) pool.on("error", () => {});
	try {
		const store = new PostgresCiStore(pool);
		if (!(await store.configuration())) {
			try {
				await store.configure(seed, 0, new Date().toISOString());
			} catch (error) {
				if (!(await store.configuration())) throw error;
			}
		}
		const github = createGithubAppTransport({ appId, privateKey: key });
		const identity = createGithubOidcVerifier(url.origin);
		const onboardingSettings = [
			env.HOBO_CI_GITHUB_APP_CLIENT_ID,
			env.HOBO_CI_GITHUB_APP_CLIENT_SECRET,
			env.HOBO_CI_SESSION_KEY,
		];
		if (onboardingSettings.some(Boolean) && !onboardingSettings.every(Boolean))
			throw new Error("incomplete GitHub onboarding configuration");
		const onboarding = onboardingSettings.every(Boolean)
			? (() => {
					const sessionKey = required(env, "HOBO_CI_SESSION_KEY");
					if (!/^[A-Za-z0-9_-]{43}$/.test(sessionKey))
						throw new Error("invalid session key");
					const decoded = Buffer.from(sessionKey, "base64url");
					if (
						decoded.length !== 32 ||
						decoded.toString("base64url") !== sessionKey
					)
						throw new Error("invalid session key");
					const numericAppId = Number(appId);
					if (!Number.isSafeInteger(numericAppId))
						throw new Error("invalid App ID");
					const onboardingOptions: Parameters<
						typeof createHostedAppOnboarding
					>[0] = {
						pool,
						key: decoded,
						publicOrigin: url.origin,
						appId: numericAppId,
						clientId: required(env, "HOBO_CI_GITHUB_APP_CLIENT_ID"),
						clientSecret: required(env, "HOBO_CI_GITHUB_APP_CLIENT_SECRET"),
						github,
						authenticate: baseAuthenticate,
					};
					if (options.trustedBootstrapControl)
						onboardingOptions.trustedBootstrapControl =
							options.trustedBootstrapControl;
					return createHostedAppOnboarding(onboardingOptions);
				})()
			: undefined;
		const authenticate = onboarding?.authenticate ?? baseAuthenticate;
		const delegateOwnerControl = options.trustedBootstrapControl
			? createOwnerControlDelegation({
					publicOrigin: url.origin,
					resolve: options.trustedBootstrapControl,
				})
			: undefined;
		const assets = { workflow, bootstrap };
		const sandbox = createSandboxComposition({
			env,
			publicOrigin: url.origin,
			store,
			github,
		});
		const execution = isolatedExecutionWiring(sandbox?.host);
		const sandboxQuota = sandbox
			? createSandboxProxyQuotaHandler(store)
			: undefined;
		const control = async (request: Request) => {
			const registration = await onboarding?.handle(request);
			if (registration) return registration;
			const state = await store.configuration();
			if (!state?.configuration) throw new Error("configuration unavailable");
			const relayOptions: ConstructorParameters<typeof HostedRelay>[0] = {
				config: state.configuration,
				store,
				github,
				identity,
				webhookSecret: secret,
				...execution.relay,
			};
			const relay = new HostedRelay(relayOptions);
			return createHostedControlPlane({
				relay,
				store,
				github,
				authenticate,
				publicOrigin: url.origin,
				assets,
				runtimeDiagnostic: () =>
					runtimeDiagnostic({
						deploymentId: env.VERCEL_DEPLOYMENT_ID,
						sandbox,
					}),
			})(delegateOwnerControl ? await delegateOwnerControl(request) : request);
		};
		const runtimeOptions: Parameters<typeof createHostedRelayRuntime>[0] = {
			store,
			github,
			identity,
			webhookSecret: secret,
			...execution.runtime,
			control,
		};
		const runtime = createHostedRelayRuntime(runtimeOptions);
		// Queue messages are pinned to the deployment that sent them. Older
		// callbacks can outlive a release and must not alter its health evidence.
		const health = new PostgresWorkerHealth(
			pool,
			env.VERCEL_ENV === "production"
				? required(env, "VERCEL_DEPLOYMENT_ID")
				: env.VERCEL_DEPLOYMENT_ID,
		);
		await health.initialize();
		const repair = async () => {
			// Direct sessions exist only while a repair invocation is active. The
			// primary pool remains pooled for HTTP traffic and ordinary queries.
			const repairPool = new pg.Pool({
				...database.direct,
				max: 1,
				connectionTimeoutMillis: 5000,
				idleTimeoutMillis: 10000,
			});
			if (options.database) repairPool.on("error", () => {});
			try {
				return await withRepairPool(repairPool, async (direct) => {
					await withRepairStage("repair-database", () =>
						verifyRepairDatabase(pool, direct),
					);
					const claims = new PostgresWebhookRepairClaims(pool, direct);
					const queuedClaims = new PostgresQueuedJobRepairClaims(
						pool,
						appId,
						direct,
					);
					await withRepairStage("repair-claims", () =>
						Promise.all([claims.initialize(), queuedClaims.initialize()]),
					);
					const repairDeliveries = createWebhookRepair({
						appId,
						privateKey: key,
						claims,
						isAccepted: (deliveryId) => store.hasWebhook(deliveryId),
					});
					return runRepairs(
						[
							repairDeliveries,
							createQueuedJobRepair({
								store,
								github,
								claims: queuedClaims,
								idleComplete: () => health.repairComplete(1),
								relay: async () => {
									const state = await store.configuration();
									if (!state?.configuration)
										throw new Error("configuration unavailable");
									const relayOptions: ConstructorParameters<
										typeof HostedRelay
									>[0] = {
										config: state.configuration,
										store,
										github,
										identity,
										webhookSecret: secret,
										...execution.relay,
									};
									return new HostedRelay(relayOptions);
								},
							}),
						],
						{
							start: () => health.startRepair(),
							finish: (index, ok, startedAt) =>
								health.finishRepair(index, ok, startedAt),
						},
					);
				});
			} finally {
				await onboarding?.cleanup();
			}
		};
		const worker = createHostedWorker({
			tick: () => runtime.tick({ maxDeliveries: 50 }),
			repair,
			health,
			continueRepair: options.continueRepair,
		});
		const queueWakeup = createQueueWakeupHandler({
			origin: url.origin,
			secret: required(env, "CRON_SECRET"),
			run: (message) => worker.run(message),
		});
		const handler = createVercelRelayHandler({
			application: withWakeup(
				{
					...runtime,
					// A configured host and fresh worker health are required in addition
					// to the database and configuration checks in the runtime.
					ready: () => execution.ready(runtime.ready, () => health.ready()),
				},
				options.notify,
			),
			webhookSecret: secret,
		});
		return {
			origin: url.origin,
			tick: (message: QueueMessage) => worker.run(message),
			close: () => pool.end(),
			async handle(request: Request): Promise<Response> {
				const pathname = new URL(request.url).pathname;
				if (pathname === "/internal/queue-wakeup") return queueWakeup(request);
				if (pathname === "/internal/sandbox/quota")
					return sandboxQuota
						? sandboxQuota(request)
						: new Response(null, { status: 503 });
				const deniedEgress = denyDirectSandboxEgress(request);
				if (deniedEgress) return deniedEgress;
				if (pathname === "/internal/tick") {
					return scheduledRepair(request);
				}
				return handler(request);
			},
		};
	} catch (error) {
		await pool.end();
		throw error;
	}
}
