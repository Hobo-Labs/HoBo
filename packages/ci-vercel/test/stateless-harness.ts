/**
 * The stateless relay composed for tests: the in-memory cache engine (which a
 * test can wipe), the configuration from an `env` source, an in-memory queue
 * with the platform's idempotency and delays, a GitHub stand-in that keeps
 * one workflow run and its jobs, and Sandbox drivers that keep VMs in a map.
 * Nothing is contacted.
 */
import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomBytes,
} from "node:crypto";
import { create, type JsonValue, toJsonString } from "@bufbuild/protobuf";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	OfferSchema,
	SandboxPricingSchema,
} from "@hobo/ci";
import type { GithubAppTransport } from "@hobo/ci-gh-actions";
import {
	createMemoryRedisExecutor,
	createRedisEphemeralState,
	meterExecutor,
} from "@hobo/kv-redis-compatible";
import { APIError } from "@vercel/sandbox";
import { z } from "zod";
import type { OpenedCacheBackend } from "../src/cache-backend.js";
import {
	parseRelayQueueMessage,
	type RelayQueueSendOptions,
	type RelayQueueTopic,
} from "../src/relay-queue.js";
import {
	createRelayRuntimeConfigLoader,
	envRelayConfigSource,
} from "../src/relay-runtime-config.js";
import type {
	IsolatedSandboxDriver,
	SandboxProxyDriver,
	SandboxUsage,
} from "../src/sandbox-controller.js";
import {
	composeStatelessRelay,
	type StatelessRelay,
	type StatelessRelayLogLine,
} from "../src/stateless-composition.js";

export const ORIGIN = "https://ci.example.test";
export const REPOSITORY = "Org/Repo";
export const RUN_ID = 900;
export const TEAM = "team_real";

const pricing = () =>
	create(SandboxPricingSchema, {
		vcpus: 1,
		memoryMb: 2048,
		cpuMicrosPerVcpuHour: 128000,
		memoryMicrosPerGbHour: 21200,
		creationMicros: 1,
		egressMicrosPerGb: 150000,
		maxEgressBytes: 1000000,
		proxyMicrosPerGb: 150000,
		proxyFixedMicros: 1,
		bootstrapFixedMicros: 1,
		networkHeadroomBytes: 1000,
		proxyVmRequired: true,
		proxyVmVcpus: 1,
		proxyVmMemoryMb: 2048,
		proxyVmExtraMs: 120000,
		proxyVmNetworkBytes: 10000000,
		proxyVmNetworkHeadroomBytes: 1000,
		proxyControlMaxCalls: 100,
		proxyControlCallMicros: 1,
		region: "iad1",
		plan: "hobby",
	});

function configuration(nowMs: number): string {
	return toJsonString(
		ConfigurationSchema,
		create(ConfigurationSchema, {
			accounts: [
				create(AccountSchema, {
					id: "hobo-labs",
					budgetMicros: 10_000_000,
					maxRuntimeMinutes: 5,
					startupMinutes: 1,
					offers: [
						create(OfferSchema, {
							id: "vercel",
							provider: "vercel",
							backend: "sandbox",
							providerAccountId: TEAM,
							enabled: true,
							runsOn: "sandbox",
							bridgeAcknowledged: true,
							budgetMicros: 10_000_000,
							concurrency: 2,
							sandboxPricing: pricing(),
							observedAt: new Date(nowMs - 60_000).toISOString(),
							validUntil: new Date(nowMs + 7 * 24 * 3_600_000).toISOString(),
							sourceUrl: "https://example.test/sandbox-pricing",
						}),
					],
				}),
			],
			connections: [
				create(ConnectionSchema, {
					accountId: "hobo-labs",
					repository: REPOSITORY,
					repositoryId: 101,
					installationId: 10,
					runnerGroupId: 1,
					isolatedOnly: true,
					acceptAllMatchingRepositoryJobs: true,
					trustedRepositoryAcknowledged: true,
					publicRepositoryAcknowledged: true,
				}),
			],
		}),
	);
}

/** The relay's configuration, as the `env` config source reads it. */
export function relayEntries(nowMs: number, token: string) {
	const key = (bytes: number) => randomBytes(bytes).toString("base64url");
	return {
		HOBO_CI_PUBLIC_URL: ORIGIN,
		HOBO_CI_SESSION_KEY: key(32),
		HOBO_CI_BOOTSTRAP_ACCOUNT_ID: "hobo-labs",
		HOBO_CI_BOOTSTRAP_TOKEN_SHA256: createHash("sha256")
			.update("bootstrap")
			.digest("hex"),
		HOBO_CI_CONTROL_TOKENS_JSON: JSON.stringify({
			tokens: [
				{
					accountId: "hobo-labs",
					installationIds: [10],
					tokenSha256: createHash("sha256").update(token).digest("hex"),
					scopes: [
						"policy:read",
						"policy:write",
						"repositories:write",
						"observations:write",
						"operations:write",
					],
				},
			],
		}),
		HOBO_CI_CONFIG_JSON: configuration(nowMs),
		CRON_SECRET: key(32),
		HOBO_CI_GITHUB_APP_ID: "12345",
		HOBO_CI_GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", {
			modulusLength: 2048,
		})
			.privateKey.export({ type: "pkcs8", format: "pem" })
			.toString(),
		HOBO_CI_WEBHOOK_SECRET: key(32),
		HOBO_CI_GITHUB_APP_CLIENT_ID: "Iv1.relaytest",
		HOBO_CI_GITHUB_APP_CLIENT_SECRET: key(30),
		HOBO_CI_SANDBOX_ENABLED: "1",
		HOBO_CI_SANDBOX_TEAM_ID: TEAM,
		HOBO_CI_SANDBOX_PROJECT_ID: "prj_real",
		HOBO_CI_SANDBOX_ISSUER: "https://oidc.vercel.com/team",
		HOBO_CI_SANDBOX_DOMAINS_JSON: '["github.com"]',
		HOBO_CI_SANDBOX_PLAN: "hobby",
		HOBO_CI_SANDBOX_PROXY_TOKEN_KEY: key(32),
	};
}

type QueuedMessage = {
	topic: RelayQueueTopic;
	payload: JsonValue;
	key: string | undefined;
	dueMs: number;
	seq: number;
};

/** One GitHub job as the stand-in holds it. */
type GithubJob = {
	id: number;
	status: "queued" | "in_progress" | "completed";
	runnerName: string | null;
	runnerId: number | null;
};

export type StatelessHarness = Awaited<ReturnType<typeof openStatelessRelay>>;

/** Compose the relay over stand-ins; the clock starts now and moves only when told. */
export async function openStatelessRelay(
	options: { failCache?: () => boolean } = {},
) {
	let nowMs = Math.floor(Date.now() / 1000) * 1000;
	const clock = {
		now: () => new Date(nowMs).toISOString(),
		nowMs: () => nowMs,
		advance(ms: number) {
			nowMs += ms;
		},
	};
	// The cache: an engine the test can replace, as a flushed store would be.
	let engine = createMemoryRedisExecutor({ now: () => nowMs });
	const meter = meterExecutor({
		execute: (command) => {
			if (options.failCache?.()) throw new Error("cache unreachable");
			return engine.execute(command);
		},
	});
	const backend: OpenedCacheBackend = {
		binding: { id: "memory", kind: "memory", names: [] },
		state: createRedisEphemeralState({ executor: meter }),
		units: ["commands"],
		usage: () => ({ commands: meter.usage().total }),
		close: async () => {},
	};
	const cache = { backend, meter };

	// The queue: idempotency keys are kept for the dedupe window, delays held.
	const queued: QueuedMessage[] = [];
	const seen = new Set<string>();
	const sent: { topic: RelayQueueTopic; options: RelayQueueSendOptions }[] = [];
	let seq = 0;
	const send = async (
		topic: RelayQueueTopic,
		payload: JsonValue,
		sendOptions: RelayQueueSendOptions,
	) => {
		sent.push({ topic, options: sendOptions });
		const key = sendOptions.idempotencyKey;
		if (key !== undefined) {
			if (seen.has(`${topic}:${key}`)) return;
			seen.add(`${topic}:${key}`);
		}
		queued.push({
			topic,
			payload: structuredClone(payload),
			key,
			dueMs: nowMs + (sendOptions.delaySeconds ?? 0) * 1000,
			seq: seq++,
		});
	};

	// GitHub: one run, its jobs, and the runners the relay registered.
	const jobs = new Map<number, GithubJob>();
	const runners = new Map<number, string>();
	const requests: string[] = [];
	const github = {
		requests,
		jitRegistrations: 0,
		job(id: number): GithubJob {
			const found = jobs.get(id);
			if (!found) throw new Error(`no job ${id}`);
			return found;
		},
	};
	const jobJson = (job: GithubJob) => ({
		id: job.id,
		run_id: RUN_ID,
		run_attempt: 1,
		status: job.status,
		labels: ["hobo"],
		name: `job-${job.id}`,
		runner_name: job.runnerName,
		runner_id: job.runnerId,
		created_at: new Date(nowMs - 60_000).toISOString(),
	});
	const transport: GithubAppTransport = {
		async request(_installationId, path, method = "GET", body) {
			github.requests.push(`${method} ${path}`);
			const base = `/repos/${REPOSITORY}/actions`;
			if (method === "GET" && path === `${base}/runs/${RUN_ID}`)
				return Response.json({
					id: RUN_ID,
					run_attempt: 1,
					event: "push",
					head_sha: "a".repeat(40),
					head_branch: "main",
					path: ".github/workflows/ci.yml",
					display_title: "CI",
					status: "in_progress",
					conclusion: null,
					created_at: new Date(nowMs - 120_000).toISOString(),
					run_started_at: new Date(nowMs - 120_000).toISOString(),
					updated_at: new Date(nowMs).toISOString(),
					actor: { id: 1 },
					repository: { id: 101, private: false },
					head_repository: { id: 101 },
				});
			const job = /^\/repos\/Org\/Repo\/actions\/jobs\/(\d+)$/u.exec(path);
			if (method === "GET" && job?.[1]) {
				const found = jobs.get(Number(job[1]));
				return found
					? Response.json(jobJson(found))
					: new Response(null, { status: 404 });
			}
			if (method === "POST" && path === `${base}/runners/generate-jitconfig`) {
				github.jitRegistrations += 1;
				const { name } = z
					.object({ name: z.string() })
					.parse(JSON.parse(body ?? "{}"));
				const id = 30 + github.jitRegistrations;
				runners.set(id, name);
				return Response.json(
					{ runner: { id, name }, encoded_jit_config: "b25lLXRpbWU=" },
					{ status: 201 },
				);
			}
			const runner = /^\/repos\/Org\/Repo\/actions\/runners\/(\d+)$/u.exec(
				path,
			);
			if (method === "DELETE" && runner?.[1]) {
				runners.delete(Number(runner[1]));
				return new Response(null, { status: 204 });
			}
			if (method === "GET" && path.startsWith(`${base}/runners?`)) {
				const name = new URL(path, "https://api.test").searchParams.get("name");
				return Response.json({
					runners: [...runners]
						.filter(([, entry]) => !name || entry === name)
						.map(([id, entry]) => ({ id, name: entry })),
				});
			}
			if (method === "GET" && path.startsWith(`${base}/runs?status=`)) {
				const status = new URL(path, "https://api.test").searchParams.get(
					"status",
				);
				const live = [...jobs.values()].some(
					(entry) => entry.status === status,
				);
				return Response.json({
					workflow_runs: live ? [{ id: RUN_ID }] : [],
				});
			}
			if (method === "GET" && path.startsWith(`${base}/runs/${RUN_ID}/jobs`))
				return Response.json({ jobs: [...jobs.values()].map(jobJson) });
			return new Response(null, { status: 404 });
		},
		appRequest: async () => new Response(null, { status: 404 }),
	};

	// Vercel Sandbox: VMs by name.
	const vms = new Map<
		string,
		{ sessionId: string; exitCode: number | null; stopped: boolean }
	>();
	const quotaTokens: string[] = [];
	const sandbox = { creates: 0, stops: 0, quotaTokens };
	const usage = (vcpus: number): SandboxUsage => ({
		cpuMs: 500,
		durationMs: 60_000,
		memoryMb: 2048,
		vcpus,
		egressBytes: 100,
		ingressBytes: 50,
		creations: 1,
		stoppedAt: nowMs,
	});
	const notFound = () => new APIError(new Response(null, { status: 404 }));
	const driver: IsolatedSandboxDriver = {
		async create(config) {
			sandbox.creates += 1;
			const sessionId = `sbx_guest${sandbox.creates}`;
			vms.set(config.name, { sessionId, exitCode: null, stopped: false });
			return {
				name: config.name,
				sessionId,
				expiresAt: nowMs + config.timeoutMs,
			};
		},
		async discover(name: string) {
			const vm = vms.get(name);
			if (!vm) throw notFound();
			return { sessionId: vm.sessionId };
		},
		async prepare() {},
		async start() {
			return { cmdId: "cmd_runner" };
		},
		async inspect(name: string) {
			return {
				commandId: "cmd_runner",
				exitCode: vms.get(name)?.exitCode ?? null,
			};
		},
		async stop(name: string) {
			sandbox.stops += 1;
			const vm = vms.get(name);
			if (vm) vm.stopped = true;
			return usage(1);
		},
	};
	const proxyDriver: SandboxProxyDriver = {
		async create(config) {
			vms.set(config.name, {
				sessionId: "sbx_proxy",
				exitCode: null,
				stopped: false,
			});
			return {
				name: config.name,
				sessionId: "sbx_proxy",
				origin: "https://proxy.example.test",
				expiresAt: nowMs + config.timeoutMs,
			};
		},
		async start(_name, _sessionId, config) {
			sandbox.quotaTokens.push(config.quotaToken);
			return { commandId: "cmd_proxy" };
		},
		async bind() {},
		async discover(name: string) {
			const vm = vms.get(name);
			if (!vm) throw notFound();
			return { sessionId: vm.sessionId };
		},
		async stop(name: string) {
			const vm = vms.get(name);
			if (vm) vm.stopped = true;
			return usage(1);
		},
	};

	const token = randomBytes(24).toString("base64url");
	const entries = relayEntries(nowMs, token);
	const lines: StatelessRelayLogLine[] = [];
	const loader = createRelayRuntimeConfigLoader({
		source: envRelayConfigSource(entries),
		now: () => nowMs,
	});
	const relay: StatelessRelay = await composeStatelessRelay({
		env: { VERCEL_ENV: "development" },
		config: loader,
		configService: "env",
		send,
		cacheBackends: [backend],
		github: transport,
		identity: {
			verify: async () => {
				throw new Error("no OIDC in these tests");
			},
		},
		sandboxDrivers: { driver, proxyDriver },
		now: clock.now,
		log: (line) => lines.push({ ...line }),
	});

	let delivery = 0;
	/** POST a signed `workflow_job` webhook, as GitHub would. */
	async function webhook(
		action: "queued" | "in_progress" | "completed",
		jobId: number,
		deliveryId = `delivery-${++delivery}`,
	) {
		const job = jobs.get(jobId);
		const body = JSON.stringify({
			action,
			installation: { id: 10 },
			repository: { id: 101, full_name: REPOSITORY },
			workflow_job: {
				id: jobId,
				run_id: RUN_ID,
				run_attempt: 1,
				labels: ["hobo"],
				name: `job-${jobId}`,
				created_at: new Date(nowMs - 60_000).toISOString(),
				runner_name: job?.runnerName ?? null,
			},
		});
		const signature = createHmac("sha256", entries.HOBO_CI_WEBHOOK_SECRET)
			.update(body)
			.digest("hex");
		const response = await relay.handle(
			new Request(`${ORIGIN}/github/webhooks`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": "workflow_job",
					"x-github-delivery": deliveryId,
					"x-hub-signature-256": `sha256=${signature}`,
				},
				body,
			}),
		);
		return { response, deliveryId };
	}

	const failures: {
		topic: string;
		key: string | undefined;
		message: string;
	}[] = [];
	/** Deliver every message due by now (and any they send that is due), oldest first. */
	async function drain(topic?: RelayQueueTopic) {
		let delivered = 0;
		for (;;) {
			const due = queued
				.filter(
					(entry) =>
						entry.dueMs <= nowMs &&
						(topic === undefined || entry.topic === topic),
				)
				.sort((a, b) => a.dueMs - b.dueMs || a.seq - b.seq)[0];
			if (!due) return delivered;
			queued.splice(queued.indexOf(due), 1);
			try {
				await relay.run(parseRelayQueueMessage(due.payload));
			} catch (error) {
				// The platform would redeliver it with back-off; the test sees it.
				failures.push({
					topic: due.topic,
					key: due.key,
					message: error instanceof Error ? error.message : String(error),
				});
			}
			delivered += 1;
		}
	}

	return {
		relay,
		clock,
		cache,
		entries,
		token,
		lines,
		failures,
		queued,
		sent,
		github,
		jobs,
		sandbox,
		vms,
		webhook,
		drain,
		/** Deliver a message again, as an at-least-once queue may. */
		async redeliver(payload: JsonValue) {
			await relay.run(parseRelayQueueMessage(payload));
		},
		/** Empty the cache, as a lost Upstash database or a flushed Valkey would. */
		wipeCache() {
			engine = createMemoryRedisExecutor({ now: () => nowMs });
		},
		/** Advance the clock and deliver what fell due. */
		async after(ms: number) {
			nowMs += ms;
			return drain();
		},
	};
}
