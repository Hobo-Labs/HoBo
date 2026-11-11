/**
 * The hosted relay with no database (ADR-0179, phase 4b).
 *
 * - Config and secrets: `RelayRuntimeConfig` from the config service
 *   (`relay-runtime-config.ts`: Infisical, or the environment locally), read
 *   once and refreshed at most once a minute. The relay never writes it: the
 *   control plane's configuration routes answer 410.
 * - Per-job state: `RelayCacheStore` over `EphemeralStatePort`, on the cache
 *   the deployment binds (`cache-backend.ts`), every command metered.
 * - Work: webhook intake and per-lease steps as Vercel Queue messages
 *   (`relay-queue.ts`); the 15-minute repair tick scans what is in flight as
 *   a backstop and restores holds a lost cache forgot.
 *
 * The PostgreSQL composition (`relay-composition.ts`, `composition.ts`) stays
 * in the tree until phase 7 and is off the production path.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type Configuration,
	ConfigurationStateSchema,
	parseConfiguration,
} from "@hobo/ci";
import {
	type ControlAuthenticator,
	createControlAuthenticator,
	createGithubAppTransport,
	createGithubOidcVerifier,
	createHostedControlPlane,
	createHostedRelayRuntime,
	createRelayHandler,
	createRelayMcp,
	type GithubAppTransport,
	HostedRelay,
	type IdentityVerifier,
	reportRelayFailure,
} from "@hobo/ci-gh-actions";
import {
	githubRelayDiscovery,
	parseProxyTokenKey,
	RelayCacheStore,
	type RelayConfigSnapshot,
	rebuildInflight,
	rebuildLease,
} from "@hobo/ci-gh-actions/relay-cache";
import { bootstrap, workflow } from "./_generated-assets/relay-assets.js";
import {
	type CacheCommandReport,
	createCacheCommandMeter,
	monthlyCommandAllowance,
	type OpenedCache,
	openCacheBackend,
	selectCacheBackend,
} from "./cache-backend.js";
import {
	denyDirectSandboxEgress,
	isolatedExecutionWiring,
} from "./execution-wiring.js";
import {
	mcpWaitCeilingMs,
	RELAY_FUNCTION_MAX_DURATION_SECONDS,
} from "./function-limits.js";
import { createQueueHandoffHandler } from "./queue-forwarding.js";
import {
	createLeaseStepScheduler,
	encodeRelayQueueMessage,
	leaseStepKind,
	MAX_DELIVERY_BODY_BYTES,
	parseRelayQueueMessage,
	RELAY_QUEUE_TOPICS,
	type RelayQueuedDelivery,
	type RelayQueuedStep,
	type RelayQueueMessage,
	type RelayQueueSend,
	sendDelivery,
} from "./relay-queue.js";
import type {
	RelayConfigSource,
	RelayRuntimeConfig,
	RelayRuntimeConfigLoader,
} from "./relay-runtime-config.js";
import { runtimeDiagnostic } from "./runtime-diagnostic.js";
import {
	createSandboxComposition,
	type VERCEL_SANDBOX_DRIVERS,
} from "./sandbox-composition.js";
import { createSandboxProxyQuotaHandler } from "./sandbox-proxy-quota.js";
import { createScheduledRepairHandler } from "./scheduled-repair.js";

type Env = Readonly<Record<string, string | undefined>>;

/** What a log line may carry: names, counts and kinds, never a value. */
export type StatelessRelayLogValue =
	| string
	| number
	| boolean
	| readonly string[]
	| Readonly<Record<string, number>>;
/** A structured log line: a fixed event name, then names and counts. */
export type StatelessRelayLogLine = Readonly<
	{ event: string } & Record<string, StatelessRelayLogValue>
>;
export type StatelessRelayLog = (line: StatelessRelayLogLine) => void;

export type StatelessRelayOptions = Readonly<{
	/** The deployment's own environment: bindings and platform settings only. */
	env: Env;
	config: RelayRuntimeConfigLoader;
	configService: RelayConfigSource["kind"];
	/** The config service's last failed refresh, if the last one failed. */
	configStaleSince?: () => number | undefined;
	send: RelayQueueSend;
	/** Tests inject the cache, GitHub, OIDC and Sandbox stand-ins. */
	cache?: OpenedCache;
	github?: GithubAppTransport;
	identity?: IdentityVerifier;
	sandboxDrivers?: typeof VERCEL_SANDBOX_DRIVERS;
	fetch?: typeof fetch;
	now?: () => string;
	log?: StatelessRelayLog;
}>;

export type StatelessRelayReadiness = Readonly<{
	ready: boolean;
	configService: boolean;
	/** The config service's last refresh failed; the last good copy is in use. */
	configStale: boolean;
	cache: boolean;
	/** An execution host (the Sandbox controller) is configured. */
	executionHost: boolean;
}>;

export type StatelessRelay = Readonly<{
	origin: string;
	handle(request: Request): Promise<Response>;
	/** One queue message: a delivery, a lease step, or a repair tick. */
	run(message: RelayQueueMessage): Promise<void>;
	readiness(): Promise<StatelessRelayReadiness>;
	store: RelayCacheStore;
	close(): Promise<void>;
}>;

function defaultLog(line: StatelessRelayLogLine) {
	try {
		console.info(JSON.stringify(line));
	} catch {
		// A failed log line never changes the relay's behavior.
	}
}

/** The public origin, as `createVercelApplication` checks it. */
function publicOrigin(value: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("relay public URL must be an HTTPS origin");
	return url.origin;
}

/** A revision for a config document: stable across instances, nonzero, uint32. */
function documentRevision(json: string): number {
	const digest = createHash("sha256").update(json).digest();
	return (digest.readUInt32BE(0) >>> 1) + 1;
}

/** The cache namespace: production, preview and local runs never share keys. */
function cacheEnvironment(env: Env): string {
	const value = env.VERCEL_ENV;
	return value === "production" ||
		value === "preview" ||
		value === "development"
		? value
		: "local";
}

/**
 * Compose the stateless relay. Fails (and the entry answers 503) only when
 * the config service cannot be read on a cold start or the configuration or
 * cache binding is invalid; a cache that is merely unreachable is reported by
 * `/readyz`, not fatal.
 */
export async function composeStatelessRelay(
	options: StatelessRelayOptions,
): Promise<StatelessRelay> {
	const { env } = options;
	const log = options.log ?? defaultLog;
	const now = options.now ?? (() => new Date().toISOString());
	const initial = await options.config.load();
	const origin = publicOrigin(initial.HOBO_CI_PUBLIC_URL);
	if (
		createPrivateKey(initial.HOBO_CI_GITHUB_APP_PRIVATE_KEY)
			.asymmetricKeyType !== "rsa"
	)
		throw new Error("GitHub App key must be RSA");
	const webhookSecret = initial.HOBO_CI_WEBHOOK_SECRET;
	const cronSecret = initial.CRON_SECRET;
	if (
		initial.HOBO_CI_SANDBOX_ENABLED &&
		!initial.HOBO_CI_SANDBOX_PROXY_TOKEN_KEY
	)
		throw new Error(
			"missing configuration: HOBO_CI_SANDBOX_PROXY_TOKEN_KEY (required with HOBO_CI_SANDBOX_ENABLED)",
		);

	// The config document and the control tokens follow the config service:
	// each is parsed once per loaded copy.
	let parsedFrom: RelayRuntimeConfig | undefined;
	let snapshot: RelayConfigSnapshot | undefined;
	let authenticator: ControlAuthenticator | undefined;
	async function current() {
		const config = await options.config.load();
		if (config !== parsedFrom || !snapshot || !authenticator) {
			const configuration: Configuration = parseConfiguration(
				config.HOBO_CI_CONFIG_JSON,
			);
			snapshot = {
				state: create(ConfigurationStateSchema, {
					revision: documentRevision(config.HOBO_CI_CONFIG_JSON),
					configuration,
					updatedAt: now(),
				}),
				// Desired per-account policies are not in the config service yet.
				policies: [],
			};
			authenticator = createControlAuthenticator(
				config.HOBO_CI_CONTROL_TOKENS_JSON,
			);
			parsedFrom = config;
		}
		return { snapshot, authenticator };
	}
	await current();
	const authenticate: ControlAuthenticator = async (header) =>
		(await current()).authenticator(header);

	const choice = options.cache?.choice ?? selectCacheBackend(env);
	log({
		event: "hobo_ci_cache_backend",
		backend: choice.kind,
		names: [...choice.names],
		candidates: [...choice.candidates],
	});
	const cache =
		options.cache ??
		(await openCacheBackend(
			choice,
			env,
			options.fetch ? { fetch: options.fetch } : {},
		));
	const environment = cacheEnvironment(env);
	const meter = createCacheCommandMeter({
		cache,
		environment,
		allowance: monthlyCommandAllowance(env),
		log: (report: CacheCommandReport) => log(report),
	});

	const scheduler = createLeaseStepScheduler({
		send: options.send,
		now: () => Date.parse(now()),
	});
	const proxyTokenKey = initial.HOBO_CI_SANDBOX_PROXY_TOKEN_KEY
		? parseProxyTokenKey(
				Buffer.from(initial.HOBO_CI_SANDBOX_PROXY_TOKEN_KEY, "base64url"),
			)
		: undefined;
	const store = new RelayCacheStore({
		state: cache.state,
		config: { read: async () => (await current()).snapshot },
		environment,
		intake: {
			enqueue: (delivery) =>
				sendDelivery(options.send, {
					deliveryId: delivery.deliveryId,
					// The HTTP layer accepts only these two events.
					event:
						delivery.event === "workflow_run" ? "workflow_run" : "workflow_job",
					installationId: delivery.installationId,
					repositoryId: delivery.repositoryId,
					rawBody: delivery.rawBody,
					receivedAt: delivery.receivedAt,
				}),
		},
		proxyTokenKey,
		onLeaseChange: (change) => scheduler.changed(change),
		onDiagnostic: (event, detail) => log({ event, ...detail }),
	});

	const github =
		options.github ??
		createGithubAppTransport({
			appId: initial.HOBO_CI_GITHUB_APP_ID,
			privateKey: initial.HOBO_CI_GITHUB_APP_PRIVATE_KEY,
		});
	const identity = options.identity ?? createGithubOidcVerifier(origin);
	const sandbox = createSandboxComposition({
		env: { ...initial },
		publicOrigin: origin,
		store,
		github,
		drivers: options.sandboxDrivers,
		now: options.now,
	});
	const execution = isolatedExecutionWiring(sandbox?.host);
	const discovery = githubRelayDiscovery(github, {
		bridgeWorkflow: (job) =>
			snapshot?.state.configuration?.connections.find(
				(entry) =>
					entry.repositoryId === job.repositoryId &&
					entry.installationId === job.installationId,
			)?.bridgeWorkflow || undefined,
		sandbox: async (name) => sandbox?.findSandbox(name),
	});

	const relay = async () => {
		const state = await store.configuration();
		if (!state?.configuration) throw new Error("configuration unavailable");
		return new HostedRelay({
			config: state.configuration,
			store,
			github,
			identity,
			webhookSecret,
			now,
			...execution.relay,
		});
	};
	const control = async (request: Request) =>
		createHostedControlPlane({
			relay: await relay(),
			store,
			github,
			authenticate,
			publicOrigin: origin,
			assets: { workflow, bootstrap },
			runtimeDiagnostic: () =>
				runtimeDiagnostic({ deploymentId: env.VERCEL_DEPLOYMENT_ID, sandbox }),
			readOnlyConfig: { configService: options.configService },
		})(request);
	const runtime = createHostedRelayRuntime({
		store,
		github,
		identity,
		webhookSecret,
		now,
		...execution.runtime,
		control,
		onLeaseFailure: (leaseId) =>
			log({ event: "hobo_ci_lease_reconcile_failed", leaseId }),
	});

	async function readiness(): Promise<StatelessRelayReadiness> {
		const configService = await options.config.load().then(
			() => true,
			() => false,
		);
		const cacheReady = await store.ready();
		const configStale = options.configStaleSince?.() !== undefined;
		const executionHost = !!sandbox;
		return {
			ready: configService && cacheReady && executionHost,
			configService,
			configStale,
			cache: cacheReady,
			executionHost,
		};
	}

	const mcp = createRelayMcp({
		store: {
			...store.observer(),
			retryQuarantinedWebhook: () => store.retryQuarantinedWebhook(),
		},
		relay,
		authenticate,
		ready: async () => (await readiness()).ready,
		publicOrigin: origin,
		sessions: "none",
		cursorSecret: webhookSecret,
		waitMaxMs: mcpWaitCeilingMs(RELAY_FUNCTION_MAX_DURATION_SECONDS),
	});
	const handler = createRelayHandler({
		application: {
			ingestWebhook: (input) => runtime.ingestWebhook(input),
			claim: (id, token) => runtime.claim(id, token),
			control: runtime.control,
			mcp: mcp.handle,
			ready: async () => (await readiness()).ready,
		},
		webhookSecret,
	});

	async function processDelivery(delivery: RelayQueuedDelivery) {
		try {
			const outcome = await runtime.processDelivery(delivery);
			log({
				event: "hobo_ci_delivery_processed",
				deliveryId: delivery.deliveryId,
				outcome: outcome.split(":")[0] ?? outcome,
			});
		} catch (error) {
			// A body that is not JSON can never be admitted: acknowledge it and
			// say so; GitHub can redeliver it within its three-day window.
			if (error instanceof SyntaxError) {
				log({
					event: "hobo_ci_webhook_quarantined",
					deliveryId: delivery.deliveryId,
				});
				return;
			}
			throw error;
		}
	}

	async function leaseStep(step: RelayQueuedStep) {
		const lease = await store.get(step.leaseId);
		if (!lease) {
			// The cache lost the lease (or it lapsed after it ended): rebuild it
			// by name. A rebuilt lease is uncertain, which starts its own chain.
			const outcome = await rebuildLease(store, discovery, step.job, now());
			log({
				event: "hobo_ci_lease_rebuild",
				leaseId: step.leaseId,
				outcome: outcome.kind,
			});
			return;
		}
		// Another chain owns the lease now, or it has ended.
		if (leaseStepKind(lease.state) !== step.step) return;
		// The next rung first: a step that dies part way is redelivered, and the
		// next rung's send is idempotent.
		await scheduler.next(lease, step.step, step.n);
		await runtime.step(lease, step.step);
	}

	async function repair() {
		try {
			const rebuilt = await rebuildInflight(store, discovery, github, now());
			if (rebuilt.accounts.length > 0)
				log({
					event: "hobo_ci_rebuild_pass",
					accounts: rebuilt.accounts.length,
					marked: rebuilt.marked.length,
					outcomes: rebuilt.outcomes,
				});
		} catch (error) {
			reportRelayFailure(
				"hobo_ci_rebuild_pass_failed",
				{},
				error instanceof Error ? error : undefined,
			);
		}
		await runtime.tick({ maxDeliveries: 0 });
	}

	async function run(message: RelayQueueMessage): Promise<void> {
		try {
			switch (message.kind) {
				case "delivery":
					return await processDelivery(message.delivery);
				case "lease-step":
					return await leaseStep(message.step);
				case "repair":
					// Every deployment declares the schedule; only production repairs
					// on a timer, and a preview acknowledges the run unworked.
					if (message.platformSchedule && env.VERCEL_ENV !== "production")
						return;
					await repair();
					await meter.flush();
					return;
				case "manual":
					await repair();
					return;
				case "wakeup":
					// A pre-4b relay's inbox wakeup: this relay has no inbox.
					log({ event: "hobo_ci_legacy_wakeup_acknowledged" });
					return;
			}
		} finally {
			await meter.maybeFlush().catch(() => undefined);
		}
	}

	const queueWakeup = createQueueHandoffHandler<RelayQueueMessage>({
		origin,
		secret: cronSecret,
		run,
		codec: {
			parse: parseRelayQueueMessage,
			isRepairTick: (message) => message.kind === "repair",
			// A delivery's body, base64, plus its envelope.
			maxBodyBytes: Math.ceil((MAX_DELIVERY_BODY_BYTES * 4) / 3) + 4096,
		},
	});
	const scheduledRepair = createScheduledRepairHandler({
		secret: cronSecret,
		enqueue: () =>
			options.send(
				RELAY_QUEUE_TOPICS.repair,
				encodeRelayQueueMessage({
					kind: "repair",
					source: "static",
					platformSchedule: false,
				}),
				{ retentionSeconds: 3600 },
			),
	});
	const sandboxQuota = sandbox
		? createSandboxProxyQuotaHandler(store)
		: undefined;

	return Object.freeze({
		origin,
		store,
		run,
		readiness,
		close: () => cache.close(),
		async handle(request: Request): Promise<Response> {
			const pathname = new URL(request.url).pathname;
			if (request.method === "GET" && pathname === "/readyz") {
				let report: StatelessRelayReadiness;
				try {
					report = await readiness();
				} catch {
					report = {
						ready: false,
						configService: false,
						configStale: false,
						cache: false,
						executionHost: !!sandbox,
					};
				}
				return Response.json(report, {
					status: report.ready ? 200 : 503,
					headers: { "Cache-Control": "no-store" },
				});
			}
			if (pathname === "/internal/queue-wakeup") return queueWakeup(request);
			if (pathname === "/internal/sandbox/quota")
				return sandboxQuota
					? sandboxQuota(request)
					: new Response(null, { status: 503 });
			const deniedEgress = denyDirectSandboxEgress(request);
			if (deniedEgress) return deniedEgress;
			if (pathname === "/internal/tick") return scheduledRepair(request);
			try {
				return await handler(request);
			} finally {
				await meter.maybeFlush().catch(() => undefined);
			}
		},
	});
}
