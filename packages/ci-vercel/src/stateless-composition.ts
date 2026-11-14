/**
 * The hosted relay with no database (ADR-0179, phase 4b).
 *
 * - Config and secrets: `RelayRuntimeConfig` from the config service
 *   (`relay-runtime-config.ts`: Infisical, or the environment locally), read
 *   once and refreshed at most once a minute. The relay never writes it: the
 *   control plane's configuration routes answer 410.
 * - Per-job state: `RelayCacheStore` over `EphemeralStatePort`, on the cache
 *   fleet (`cache-fleet.ts`): every cache the deployment binds is a member,
 *   the active one is read from the fleet's assignment register and chosen
 *   by budget on the repair tick (phase 4c), and every member is metered in
 *   the units it bills.
 * - Work: webhook intake and per-lease steps as Vercel Queue messages
 *   (`relay-queue.ts`); the 15-minute repair tick scans what is in flight as
 *   a backstop, restores holds a lost cache forgot, and runs the repair
 *   scanners (missed deliveries, queued jobs) on the cache (phase 5).
 * - Onboarding: OAuth sessions, App-installation state and the owner's
 *   invitation on the cache (`createStatelessAppOnboarding`); worker-health
 *   evidence on the cache (`worker-health-cache.ts`).
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
	createQueuedJobRepair,
	createRelayHandler,
	createRelayMcp,
	createStatelessAppOnboarding,
	createWebhookRepair,
	type GithubAppTransport,
	HostedRelay,
	type IdentityVerifier,
	reportRelayFailure,
} from "@hobo/ci-gh-actions";
import {
	CacheQueuedJobRepairClaims,
	CacheWebhookRepairClaims,
	githubRelayDiscovery,
	parseProxyTokenKey,
	parseRelaySessionKey,
	RelayCacheStore,
	type RelayConfigSnapshot,
	rebuildInflight,
	rebuildLease,
} from "@hobo/ci-gh-actions/relay-cache";
import type { OneActiveTick } from "@hobo/fleet";
import { bootstrap, workflow } from "./_generated-assets/relay-assets.js";
import {
	cacheBindingEnv,
	discoverCacheBackends,
	monthlyCommandAllowance,
	type OpenedCacheBackend,
	openCacheBackends,
} from "./cache-backend.js";
import { type CacheFleetOptions, createCacheFleet } from "./cache-fleet.js";
import { cacheOfferRateCards, parseCacheOffers } from "./cache-offers.js";
import {
	denyDirectSandboxEgress,
	isolatedExecutionWiring,
} from "./execution-wiring.js";
import {
	mcpWaitCeilingMs,
	RELAY_FUNCTION_MAX_DURATION_SECONDS,
} from "./function-limits.js";
import {
	chooseLifecycleDriver,
	type LeaseLifecycleDriver,
} from "./lifecycle-driver.js";
import { createOwnerControlDelegation } from "./owner-control.js";
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
import { runRepairs } from "./worker.js";
import {
	CacheWorkerHealth,
	type RelayWorkerStatus,
} from "./worker-health-cache.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Extra steps the queued-job scan may take in one repair tick: with the
 * first, ten, the App's REST budget for the scan per minute.
 */
const QUEUED_SCAN_PASSES = 9;

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
	/** Tests inject the cache backends, GitHub, OIDC and Sandbox stand-ins. */
	cacheBackends?: readonly OpenedCacheBackend[];
	/** Tests shorten the fleet's clocks and waits. */
	cacheFleet?: Pick<
		CacheFleetOptions,
		"assignmentTtlMs" | "sealWaitMs" | "sleep" | "flushIntervalMs"
	>;
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
	/**
	 * Repair evidence in the cache: `starting` while there is none yet (a new
	 * deployment, or after a cache loss), `failing` when a scanner or the
	 * repair tick last failed or has not succeeded for 45 minutes.
	 */
	workers: RelayWorkerStatus;
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
	const configured: ControlAuthenticator = async (header) =>
		(await current()).authenticator(header);

	// Cache bindings: the deployment's environment, then what the config
	// service holds for names the environment does not set. Names only leave.
	const bindingEnv = cacheBindingEnv(env, initial);
	const bindings = discoverCacheBackends(bindingEnv.env);
	const backends =
		options.cacheBackends ??
		(await openCacheBackends(
			bindings,
			bindingEnv.env,
			options.fetch ? { fetch: options.fetch } : {},
		));
	log({
		event: "hobo_ci_cache_fleet",
		members: backends.map((backend) => backend.binding.id),
		kinds: backends.map((backend) => backend.binding.kind),
		names: backends.flatMap((backend) => [...backend.binding.names]),
		candidates: [...bindings.candidates],
		fromConfigService: [...bindingEnv.fromConfig],
	});
	const environment = cacheEnvironment(env);
	// Offers are priced in the relay's catalog (`offers/`); which of them the
	// relay uses is a logged policy decision. Only the Queue driver is built.
	const lifecycle = chooseLifecycleDriver(now());
	log({
		event: "hobo_ci_offer_selection",
		lifecycleDriver: lifecycle.driver,
		lifecycleConsidered: [...lifecycle.considered],
		cacheRateCards: [...cacheOfferRateCards()],
	});
	const scheduler: LeaseLifecycleDriver = createLeaseStepScheduler({
		send: options.send,
		now: () => Date.parse(now()),
	});
	const fleet = createCacheFleet({
		backends,
		environment,
		offers: parseCacheOffers(
			initial.HOBO_CI_CACHE_OFFERS_JSON ?? env.HOBO_CI_CACHE_OFFERS_JSON,
			monthlyCommandAllowance(env),
		),
		now: () => Date.parse(now()),
		log: (line) => log(line),
		decidedBy: `relay:${env.VERCEL_DEPLOYMENT_ID ?? environment}`.replace(
			/[^A-Za-z0-9:._-]/gu,
			"-",
		),
		// A sealed move activates on a delayed repair tick, keyed by its epoch.
		scheduleActivation: (delaySeconds, epoch) =>
			options.send(
				RELAY_QUEUE_TOPICS.repair,
				encodeRelayQueueMessage({
					kind: "repair",
					source: "static",
					platformSchedule: false,
				}),
				{
					delaySeconds,
					idempotencyKey: `cache-fleet-activate-${epoch}`,
					retentionSeconds: 3600,
				},
			),
		...options.cacheFleet,
	});

	const proxyTokenKey = initial.HOBO_CI_SANDBOX_PROXY_TOKEN_KEY
		? parseProxyTokenKey(
				Buffer.from(initial.HOBO_CI_SANDBOX_PROXY_TOKEN_KEY, "base64url"),
			)
		: undefined;
	const store = new RelayCacheStore({
		state: fleet.state,
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
	const nowMs = () => Date.parse(now());

	// GitHub onboarding on the cache: sealed sessions, single-use state, the
	// owner's invitation. Nothing it records is configuration.
	const invitationExpiry = initial.HOBO_CI_INVITATION_EXPIRES_AT
		? Number(initial.HOBO_CI_INVITATION_EXPIRES_AT)
		: undefined;
	const onboarding = createStatelessAppOnboarding({
		state: fleet.state,
		environment,
		sessionKey: parseRelaySessionKey(
			Buffer.from(initial.HOBO_CI_SESSION_KEY, "base64url"),
		),
		publicOrigin: origin,
		appId: Number(initial.HOBO_CI_GITHUB_APP_ID),
		clientId: initial.HOBO_CI_GITHUB_APP_CLIENT_ID,
		clientSecret: initial.HOBO_CI_GITHUB_APP_CLIENT_SECRET,
		github,
		authenticate: configured,
		owner: {
			accountId: initial.HOBO_CI_BOOTSTRAP_ACCOUNT_ID,
			tokenSha256: initial.HOBO_CI_BOOTSTRAP_TOKEN_SHA256,
			expiresAt: invitationExpiry,
			controlToken: initial.HOBO_CI_ONBOARDING_CONTROL_TOKEN,
		},
		// Ids only: the operator writes the installation into the config
		// service with `hobo ci`; until then it is usable for a day.
		onVerified: (accountId, installationId) =>
			log({
				event: "hobo_ci_installation_verified",
				accountId,
				installationId,
			}),
		fetch: options.fetch ?? fetch,
		now: nowMs,
	});
	const authenticate: ControlAuthenticator = (header) =>
		onboarding.authenticate(header);
	const delegateOwnerControl = createOwnerControlDelegation({
		publicOrigin: origin,
		resolve: onboarding.trustedBootstrapControl,
	});
	const health = new CacheWorkerHealth({
		state: fleet.state,
		environment,
		deploymentId: env.VERCEL_DEPLOYMENT_ID,
		now: nowMs,
	});
	const webhookRepair = createWebhookRepair({
		appId: initial.HOBO_CI_GITHUB_APP_ID,
		privateKey: initial.HOBO_CI_GITHUB_APP_PRIVATE_KEY,
		claims: new CacheWebhookRepairClaims({
			state: fleet.state,
			environment,
			now: nowMs,
		}),
		// A delivery the relay already took in is not redelivered.
		isAccepted: (deliveryId) => store.hasWebhook(deliveryId),
		fetch: options.fetch ?? fetch,
		now: nowMs,
	});
	const queuedClaims = new CacheQueuedJobRepairClaims({
		state: fleet.state,
		environment,
		appId: initial.HOBO_CI_GITHUB_APP_ID,
		now: nowMs,
	});
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
	const control = async (request: Request) => {
		const onboarded = await onboarding.handle(request);
		if (onboarded) return onboarded;
		return createHostedControlPlane({
			relay: await relay(),
			store,
			github,
			authenticate,
			publicOrigin: origin,
			assets: { workflow, bootstrap },
			runtimeDiagnostic: () =>
				runtimeDiagnostic({ deploymentId: env.VERCEL_DEPLOYMENT_ID, sandbox }),
			readOnlyConfig: { configService: options.configService },
		})(await delegateOwnerControl(request));
	};
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
		const workers: RelayWorkerStatus = cacheReady
			? await health.summary().catch(() => "starting" as const)
			: "starting";
		return {
			ready:
				configService && cacheReady && executionHost && workers !== "failing",
			configService,
			configStale,
			cache: cacheReady,
			executionHost,
			workers,
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

	async function fleetTick(): Promise<OneActiveTick | undefined> {
		try {
			return await fleet.tick();
		} catch (error) {
			reportRelayFailure(
				"hobo_ci_cache_fleet_tick_failed",
				{},
				error instanceof Error ? error : undefined,
			);
			return undefined;
		}
	}

	/**
	 * The repair scanners on the cache: GitHub deliveries that never reached
	 * the relay are redelivered, and queued jobs whose delivery was lost are
	 * admitted (by job key, so a job admitted already is a no-op). Each
	 * scanner's outcome is worker-health evidence. No continuation messages:
	 * the queued scan takes up to `QUEUED_SCAN_PASSES` more steps within the
	 * tick and resumes from its cursors on the next one, so a tick's cache
	 * commands stay bounded (ADR-0179: work is driven by messages, not polling).
	 */
	async function scanners() {
		const queuedRepair = createQueuedJobRepair({
			store,
			github,
			claims: queuedClaims,
			idleComplete: () => health.repairComplete(1),
			relay,
		});
		const evidence = {
			start: () => health.startRepair(),
			finish: (index: number, ok: boolean, startedAt: string) =>
				health.finishRepair(index, ok, startedAt),
		};
		const first = await runRepairs([webhookRepair, queuedRepair], evidence);
		let { failed, more } = first;
		for (let pass = 0; more && !failed && pass < QUEUED_SCAN_PASSES; pass++) {
			const next = await runRepairs([queuedRepair], {
				start: evidence.start,
				finish: (_index, ok, startedAt) => evidence.finish(1, ok, startedAt),
			});
			failed ||= next.failed;
			more = next.more;
		}
		await health.mark("repair", !failed).catch(() => undefined);
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
		// The scanners first: a job the queued scan finds is admitted by the
		// runtime's pass in the same tick.
		await scanners();
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
					// The fleet first: a sealed move activates before the rebuild
					// pass runs on the new backend.
					await fleetTick();
					await repair();
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
			await fleet.flushUsage().catch(() => undefined);
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
		close: () => fleet.close(),
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
						workers: "starting",
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
			// The owner's invitation; the relay's handler routes no such path.
			if (pathname.startsWith("/v1/app-bootstrap/"))
				try {
					return (
						(await onboarding.handle(request)) ??
						Response.json({ error: "not found" }, { status: 404 })
					);
				} finally {
					await fleet.flushUsage().catch(() => undefined);
				}
			try {
				return await handler(request);
			} finally {
				await fleet.flushUsage().catch(() => undefined);
			}
		},
	});
}
