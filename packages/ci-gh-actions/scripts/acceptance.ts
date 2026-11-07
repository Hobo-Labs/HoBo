import { execFile } from "node:child_process";
import {
	createHash,
	createHmac,
	generateKeyPairSync,
	randomUUID,
	sign,
} from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { create } from "@bufbuild/protobuf";
import { OfferSchema } from "@hobo/ci";
import { z } from "zod";
import { runHostProcess, runnerEnvironment } from "../src/bootstrap.js";
import type { GithubTransport } from "../src/github.js";
import { createGithubOidcVerifier } from "../src/oidc.js";
import { Relay } from "../src/relay.js";
import { createRelayService } from "../src/service.js";
import { LeaseStore } from "../src/store.js";
import {
	config,
	NOW,
	type queued,
	run,
	SECRET,
	SHA,
} from "../test/fixtures.js";

const providers = [
	"warpbuild",
	"depot",
	"kubernetes",
	"blacksmith",
	"github",
] as const;
const labels = [
	"warp-ubuntu-latest-x64-2x",
	"depot-ubuntu-24.04",
	"hobo-ci-isolated-k8s-host",
	"blacksmith-2vcpu-ubuntu-2404",
	"ubuntu-24.04",
];
const here = dirname(fileURLToPath(import.meta.url));
const Jit = z.object({
	leaseId: z.string().uuid(),
	provider: z.string(),
	executionId: z.string().uuid(),
	jobId: z.number().int().positive(),
	workflowSha256: z.string().length(64),
	runnerName: z.string(),
});
export type LaunchIdentity = z.infer<typeof Jit>;
export interface AcceptanceReport {
	mode: "local-shipped-relay-and-host";
	evidenceDirectory: string;
	workflowSha256: string;
	executions: LaunchIdentity[];
	freeMinutesConsumed: number;
	paidMicros: number;
	deniedLaunches: number;
	replayPreserved: boolean;
	liveProviderProof: false;
	service: {
		starts: number;
		drains: number;
		workerTicks: number;
		replayedCompletions: number;
	};
}
function invariant(ok: boolean, message: string): asserts ok {
	if (!ok) throw new Error(message);
}
export function authorizeLaunch(
	encoded: string,
	expected: LaunchIdentity,
): LaunchIdentity {
	const actual = Jit.parse(
		JSON.parse(Buffer.from(encoded, "base64").toString()),
	);
	invariant(
		actual.leaseId === expected.leaseId &&
			actual.provider === expected.provider &&
			actual.executionId === expected.executionId &&
			actual.jobId === expected.jobId &&
			actual.workflowSha256 === expected.workflowSha256 &&
			actual.runnerName === expected.runnerName,
		"JIT identity does not bind dispatched physical execution",
	);
	invariant(
		actual.runnerName === `hobo-${actual.leaseId}`,
		"runner name does not bind lease",
	);
	return actual;
}
export function assertAcceptanceMarker(
	marker: string,
	identity: LaunchIdentity,
): void {
	invariant(
		marker.trim() ===
			[
				identity.leaseId,
				identity.provider,
				identity.executionId,
				identity.jobId,
				identity.workflowSha256,
				identity.runnerName,
			].join("|"),
		"original job was skipped or execution identity changed",
	);
}
async function listen(server: Server): Promise<string> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = z.object({ port: z.number() }).parse(server.address()).port;
	return `http://127.0.0.1:${port}`;
}
async function close(server: Server): Promise<void> {
	await new Promise<void>((resolveClose, reject) =>
		server.close((error) => (error ? reject(error) : resolveClose())),
	);
}
async function command(
	file: string,
	args: string[],
	cwd: string,
): Promise<string> {
	const env = runnerEnvironment(process.env);
	if (file === "gh") {
		if (process.env.GH_TOKEN) env.GH_TOKEN = process.env.GH_TOKEN;
		if (process.env.GITHUB_TOKEN) env.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
	}
	return new Promise((resolveCommand, reject) =>
		execFile(
			file,
			args,
			{ cwd, timeout: 30000, maxBuffer: 1024 * 1024, env },
			(error, stdout, stderr) =>
				error
					? reject(
							new Error(
								file === "gh"
									? `GitHub permission probe failed for ${args.at(-1)} (${/HTTP (\d{3})/.exec(stderr)?.[1] ?? "authentication or executable unavailable"})`
									: `${file} command failed; executable unavailable`,
							),
						)
					: resolveCommand(stdout),
		),
	);
}

interface Host {
	identity: LaunchIdentity;
	runId: number;
	label: string;
	status: "in_progress" | "completed";
	startedAt: string;
	completedAt: string | null;
	registered: boolean;
	deleted: boolean;
}
/** All provider/GitHub boundaries are local. The production Relay, identity verifier,
 * HTTP server, durable ledger and host process launcher are used without replacement. */
export async function runAcceptance(options: {
	actBinary: string;
	evidenceDirectory?: string | undefined;
	fault?: "missing-jit" | "wrong-provider" | "skip-job" | undefined;
	local?: boolean | undefined;
}): Promise<AcceptanceReport> {
	const base = options.evidenceDirectory
		? resolve(options.evidenceDirectory)
		: tmpdir();
	await mkdir(base, { recursive: true });
	const root = await mkdtemp(join(base, "hobo-ci-acceptance-"));
	const source = join(here, "../acceptance/workflow.yml");
	const bytes = await readFile(source);
	const workflowSha256 = createHash("sha256").update(bytes).digest("hex");
	const binary = options.actBinary.includes("/")
		? resolve(options.actBinary)
		: options.actBinary;
	const configuration = config();
	const account = configuration.accounts[0];
	invariant(account !== undefined, "account missing");
	account.maxRuntimeMinutes = 1;
	account.startupMinutes = 1;
	account.budgetMicros = 6000;
	account.offers = providers.map((provider, index) =>
		create(OfferSchema, {
			id: provider,
			provider,
			providerAccountId: `local-${provider}`,
			enabled: true,
			runsOn: labels[index] ?? "",
			freeMinutes: 2,
			priceMicrosPerMinute: (index + 1) * 1000,
			budgetMicros: provider === "warpbuild" ? 2000 : 1000000,
			concurrency: 1,
			observedAt: "2026-10-26T00:00:00Z",
			validUntil: "2026-10-27T00:00:00Z",
			sourceUrl: "https://example.test/local-meter-contract",
			bridgeAcknowledged: true,
		}),
	);
	const hostProviders = options.local ? ["local"] : [...providers];
	const hostLabels = options.local ? ["hobo-local-host"] : labels;
	if (options.local) {
		account.budgetMicros = 0;
		account.offers = [
			create(OfferSchema, {
				...account.offers[0],
				id: "local",
				provider: "local",
				providerAccountId: "owned-dev-machine",
				backend: "gh-actions",
				runsOn: "hobo-local-host",
				freeMinutes: 0,
				priceMicrosPerMinute: 0,
				budgetMicros: 0,
			}),
		];
	}
	let now = NOW;
	let currentJob = 1;
	let originalStatus = "queued";
	const hosts = new Map<string, Host>();
	let unmatched = 0;
	let jwksRequests = 0;
	let launches = 0;
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const jwks = {
		keys: [
			{
				...publicKey.export({ format: "jwk" }),
				kid: "local-acceptance",
				alg: "RS256",
				use: "sig",
			},
		],
	};
	const dispatchSchema = z.object({
		ref: z.literal("hobo-ci-v1"),
		inputs: z.object({
			lease_id: z.string().uuid(),
			runs_on: z.string(),
			timeout_minutes: z.literal("2"),
		}),
	});
	const fixture = createServer(async (request, response) => {
		response.setHeader("Content-Type", "application/json");
		try {
			if (request.method === "GET" && request.url === "/jwks") {
				jwksRequests++;
				response.end(JSON.stringify(jwks));
				return;
			}
			invariant(
				request.headers["x-installation"] === "10",
				"unexpected installation",
			);
			const path = request.url ?? "";
			const method = request.method;
			if (
				method === "GET" &&
				path ===
					"/repos/org/repo/actions/workflows/host.yml/runs?event=workflow_dispatch&per_page=100"
			) {
				response.end(
					JSON.stringify({
						workflow_runs: [...hosts.values()].map((entry) => ({
							id: entry.runId,
							display_title: `HoBo lease ${entry.identity.leaseId}`,
						})),
					}),
				);
				return;
			}
			const originalRun = /^\/repos\/org\/repo\/actions\/runs\/(\d+)$/.exec(
				path,
			);
			const originalJob = /^\/repos\/org\/repo\/actions\/jobs\/(\d+)$/.exec(
				path,
			);
			const jobId = originalRun
				? Number(originalRun[1]) - 10
				: originalJob
					? Number(originalJob[1])
					: 0;
			const knownJob =
				jobId === currentJob ||
				[...hosts.values()].some((entry) => entry.identity.jobId === jobId);
			if (method === "GET" && knownJob && (originalRun || originalJob)) {
				const status = jobId === currentJob ? originalStatus : "completed";
				response.end(
					JSON.stringify(
						originalRun
							? { ...run(), id: 10 + jobId, status }
							: { id: jobId, run_id: 10 + jobId, status, labels: ["hobo"] },
					),
				);
				return;
			}

			const host = [...hosts.values()].find(
				(entry) =>
					path === `/repos/org/repo/actions/runs/${entry.runId}` ||
					path === `/repos/org/repo/actions/runs/${entry.runId}/jobs`,
			);
			if (method === "GET" && host) {
				response.end(
					JSON.stringify(
						path.endsWith("/jobs")
							? {
									jobs: [
										{
											name: "host",
											labels: [
												options.fault === "wrong-provider"
													? "wrong-provider"
													: host.label,
											],
											status: host.status,
											started_at: host.startedAt,
											completed_at: host.completedAt,
										},
									],
								}
							: {
									...run(),
									id: host.runId,
									event: "workflow_dispatch",
									path: ".github/workflows/host.yml",
									display_title: `HoBo lease ${host.identity.leaseId}`,
									status: host.status,
									conclusion: host.status === "completed" ? "success" : null,
									run_started_at: host.startedAt,
									updated_at: host.completedAt ?? host.startedAt,
								},
					),
				);
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body: unknown = chunks.length
				? JSON.parse(Buffer.concat(chunks).toString())
				: null;
			if (
				method === "POST" &&
				path === "/repos/org/repo/actions/workflows/host.yml/dispatches"
			) {
				const dispatch = dispatchSchema.parse(body);
				const index = hostLabels.indexOf(dispatch.inputs.runs_on);
				invariant(index >= 0, "unknown physical host label");
				invariant(!hosts.has(dispatch.inputs.lease_id), "duplicate dispatch");
				const identity: LaunchIdentity = {
					leaseId: dispatch.inputs.lease_id,
					provider: hostProviders[index] ?? "",
					executionId: randomUUID(),
					jobId: currentJob,
					workflowSha256,
					runnerName: `hobo-${dispatch.inputs.lease_id}`,
				};
				hosts.set(identity.leaseId, {
					identity,
					runId: 100 + currentJob,
					label: dispatch.inputs.runs_on,
					status: "in_progress",
					startedAt: now,
					completedAt: null,
					registered: false,
					deleted: false,
				});
				response.writeHead(204).end();
				return;
			}
			if (
				method === "POST" &&
				path === "/repos/org/repo/actions/runners/generate-jitconfig"
			) {
				const registration = z
					.object({
						name: z.string(),
						runner_group_id: z.literal(1),
						labels: z.tuple([z.literal("hobo")]),
						work_folder: z.literal("_hobo_work"),
					})
					.parse(body);
				const selected = [...hosts.values()].find(
					(entry) => entry.identity.runnerName === registration.name,
				);
				invariant(
					selected !== undefined && !selected.registered,
					"unbound or duplicate JIT registration",
				);
				selected.registered = true;
				response.writeHead(201).end(
					JSON.stringify(
						options.fault === "missing-jit"
							? { runner: { id: currentJob, name: registration.name } }
							: {
									runner: { id: currentJob, name: registration.name },
									encoded_jit_config: Buffer.from(
										JSON.stringify(selected.identity),
									).toString("base64"),
								},
					),
				);
				return;
			}
			const runner = /^\/repos\/org\/repo\/actions\/runners\/(\d+)$/.exec(path);
			if (method === "DELETE" && runner) {
				const selected = [...hosts.values()].find(
					(entry) => entry.identity.jobId === Number(runner[1]),
				);
				invariant(
					selected?.registered === true && selected.status === "completed",
					"cleanup before host shutdown",
				);
				selected.deleted = true;
				response.writeHead(204).end();
				return;
			}

			unmatched++;
			throw new Error("unmatched GitHub contract");
		} catch {
			response
				.writeHead(500)
				.end('{"error":"strict local fixture rejected request"}');
		}
	});
	const fixtureOrigin = await listen(fixture);
	const github: GithubTransport = {
		request(installation, path, method = "GET", body) {
			const init: RequestInit = {
				method,
				headers: { "x-installation": String(installation) },
				redirect: "error",
			};
			if (body !== undefined) init.body = body;
			return fetch(`${fixtureOrigin}${path}`, init);
		},
	};
	const jwksFetch: typeof fetch = (input, init) => {
		invariant(
			String(input) ===
				"https://token.actions.githubusercontent.com/.well-known/jwks",
			"unpinned JWKS request",
		);
		return fetch(`${fixtureOrigin}/jwks`, init);
	};
	const identity = createGithubOidcVerifier(
		"https://relay.example",
		jwksFetch,
		() => Date.parse(now),
	);
	const database = join(root, "relay.sqlite");
	let store = new LeaseStore(database);
	let relay = new Relay({
		config: configuration,
		store,
		github,
		identity,
		webhookSecret: SECRET,
		now: () => now,
	});
	let ticks = 0;
	let drains = 0;
	const serviceLogs: string[] = [];
	const makeService = () =>
		createRelayService({
			relay,
			store,
			port: 0,
			host: "127.0.0.1",
			tickIntervalMs: 25,
			readinessProbe: async () => true,
			beforeDispatch: async () => {
				ticks++;
			},
			logger: (entry) => {
				serviceLogs.push(entry.event);
			},
		});
	let service = makeService();
	await service.start();
	invariant(await service.checkReadiness(), "relay service not ready");
	let origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(service.server.address()).port}`;
	invariant(
		(await fetch(`${origin}/readyz`)).status === 200,
		"relay service readiness HTTP failed",
	);
	const waitFor = async (ready: () => boolean, message: string) => {
		const deadline = Date.now() + 5000;
		while (!ready()) {
			invariant(Date.now() < deadline, message);
			await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		}
	};
	const executions: LaunchIdentity[] = [];
	type CompletionWebhook = {
		action: "completed";
		installation: { id: number };
		repository: { id: number; full_name: string };
		workflow_run: { id: number; display_title: string };
	};
	const webhook = async (
		payload: ReturnType<typeof queued> | CompletionWebhook,
		event = "workflow_job",
	) => {
		const body = JSON.stringify(payload);
		const response = await fetch(`${origin}/github/webhooks`, {
			method: "POST",
			headers: {
				"x-github-event": event,
				"x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
			},
			body,
		});
		invariant(response.status === 202, "signed webhook rejected");
		return z.object({ status: z.string() }).parse(await response.json()).status;
	};
	try {
		invariant(
			(await command(binary, ["--version"], root)).includes(
				"act version 0.2.89",
			),
			"act v0.2.89 required",
		);
		await mkdir(join(root, ".github/workflows"), { recursive: true });
		await cp(source, join(root, ".github/workflows/original.yml"));
		await command("git", ["init", "--initial-branch=main"], root);
		await command(
			"git",
			[
				"-c",
				"user.name=HoBo CI fixture",
				"-c",
				"user.email=fixture@example.test",
				"commit",
				"--allow-empty",
				"-m",
				"fixture",
			],
			root,
		);
		const expectedProviders = options.local
			? ["local", "local"]
			: [...providers, "warpbuild", "depot"];
		for (const expectedProvider of expectedProviders) {
			originalStatus = "queued";
			const payload = {
				action: "queued",
				installation: { id: 10 },
				repository: { id: 101, full_name: "org/repo" },
				workflow_job: {
					id: currentJob,
					run_id: 10 + currentJob,
					run_attempt: 1,
					labels: ["hobo"],
					runner_name: null,
				},
			};
			invariant(
				(await webhook(payload)).startsWith("reserved:"),
				"eligible job was blocked",
			);
			const lease = store.all().find((entry) => entry.jobId === currentJob);
			invariant(
				lease !== undefined && lease.provider === expectedProvider,
				"free-first/cheapest/budget routing violated",
			);
			await waitFor(
				() => hosts.has(lease.id),
				"background outbox did not dispatch reserved lease",
			);
			const selected = hosts.get(lease.id);
			invariant(
				selected !== undefined && selected.identity.provider === lease.provider,
				"dispatch did not bind selected physical host",
			);
			const seconds = Date.parse(now) / 1000;
			const header = Buffer.from(
				JSON.stringify({ alg: "RS256", kid: "local-acceptance" }),
			).toString("base64url");
			const claims = Buffer.from(
				JSON.stringify({
					iss: "https://token.actions.githubusercontent.com",
					aud: "https://relay.example",
					exp: seconds + 300,
					nbf: seconds - 1,
					iat: seconds,
					repository_id: "101",
					repository: "org/repo",
					run_id: String(selected.runId),
					run_attempt: "1",
					workflow_sha: SHA,
					workflow_ref: `org/repo/.github/workflows/host.yml@${SHA}`,
					event_name: "workflow_dispatch",
				}),
			).toString("base64url");
			const input = `${header}.${claims}`;
			const token = `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
			const claim = await fetch(`${origin}/v1/leases/${lease.id}/jit`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			});
			invariant(
				claim.status === 200,
				"no valid JIT claim; host execution refused",
			);
			const jit = z
				.object({ encodedJitConfig: z.string().min(1) })
				.parse(await claim.json());
			const launch = authorizeLaunch(jit.encodedJitConfig, selected.identity);
			invariant(
				selected.registered && store.get(lease.id)?.state === "running",
				"JIT registration not committed",
			);
			const marker = join(root, `job-${currentJob}.marker`);
			const envFile = join(root, `job-${currentJob}.env`);
			await writeFile(
				envFile,
				Object.entries({
					HOBO_CI_ACCEPTANCE_MARKER: marker,
					HOBO_CI_LEASE_ID: launch.leaseId,
					HOBO_CI_PROVIDER: launch.provider,
					HOBO_CI_EXECUTION_ID: launch.executionId,
					HOBO_CI_ORIGINAL_JOB_ID: String(launch.jobId),
					HOBO_CI_WORKFLOW_SHA256: workflowSha256,
					HOBO_CI_RUNNER_NAME: launch.runnerName,
				})
					.map(([key, value]) => `${key}=${value}`)
					.join("\n"),
				{ mode: 0o600 },
			);
			invariant(
				createHash("sha256")
					.update(await readFile(join(root, ".github/workflows/original.yml")))
					.digest("hex") === workflowSha256,
				"original job graph changed",
			);
			launches++;
			await runHostProcess(
				binary,
				[
					"workflow_dispatch",
					"--workflows",
					".github/workflows/original.yml",
					"--job",
					options.fault === "skip-job" ? "missing" : "acceptance",
					"--platform",
					"hobo=-self-hosted",
					"--env-file",
					envFile,
					"--action-offline-mode",
					"--no-cache-server",
					"--secret-file",
					"/dev/null",
					"--input-file",
					"/dev/null",
					"--pull=false",
				],
				root,
				{
					...runnerEnvironment(process.env),
					XDG_CACHE_HOME: join(root, "cache"),
					XDG_CONFIG_HOME: join(root, "config"),
				},
				60000,
			);
			assertAcceptanceMarker(await readFile(marker, "utf8"), launch);
			executions.push(launch);
			originalStatus = "completed";
			selected.status = "completed";
			now = new Date(Date.parse(now) + 120000).toISOString();
			selected.completedAt = now;
			invariant(
				(await webhook(
					{
						action: "completed",
						installation: { id: 10 },
						repository: { id: 101, full_name: "org/repo" },
						workflow_run: {
							id: selected.runId,
							display_title: `HoBo lease ${lease.id}`,
						},
					},
					"workflow_run",
				)) === "settled",
				"completion not settled",
			);
			const settled = store.get(lease.id);
			invariant(
				settled?.state === "completed" && selected.deleted,
				"runner cleanup or durable settlement missing",
			);
			invariant(
				settled.billedFreeMinutes ===
					(!options.local && currentJob <= 5 ? 2 : 0),
				"free allocation settlement incorrect",
			);
			currentJob++;
		}
		const before = launches;
		// A free local machine is not exhausted by spending. Simulate it going away.
		if (options.local)
			for (const offer of account.offers) offer.enabled = false;
		originalStatus = "queued";
		invariant(
			(await webhook({
				action: "queued",
				installation: { id: 10 },
				repository: { id: 101, full_name: "org/repo" },
				workflow_job: {
					id: currentJob,
					run_id: 10 + currentJob,
					run_attempt: 1,
					labels: ["hobo"],
					runner_name: null,
				},
			})) === "waiting-for-budget-or-capacity",
			"unavailable capacity or exhausted account admitted work",
		);
		const deniedAtTick = ticks;
		await waitFor(
			() => ticks >= deniedAtTick + 3,
			"budget refusal not revisited by worker",
		);
		invariant(
			hosts.size === before && launches === before,
			"budget refusal launched host",
		);
		const settledBefore = JSON.stringify(store.all());
		invariant(
			(await service.stop()).drained,
			"service did not drain before reopen",
		);
		drains++;
		store = new LeaseStore(database);
		relay = new Relay({
			config: configuration,
			store,
			github,
			identity,
			webhookSecret: SECRET,
			now: () => now,
		});
		invariant(
			store.pendingJobs().length === 1,
			"durable reopen lost denied demand",
		);
		invariant(
			JSON.stringify(store.all()) === settledBefore,
			"durable reopen changed settlement",
		);
		service = makeService();
		await service.start();
		invariant(
			await service.checkReadiness(),
			"reopened relay service not ready",
		);
		origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(service.server.address()).port}`;
		const replayAtTick = ticks;
		for (const selected of hosts.values()) {
			invariant(
				(await webhook(
					{
						action: "completed",
						installation: { id: 10 },
						repository: { id: 101, full_name: "org/repo" },
						workflow_run: {
							id: selected.runId,
							display_title: `HoBo lease ${selected.identity.leaseId}`,
						},
					},
					"workflow_run",
				)) === "settled",
				"replayed completion not accepted",
			);
		}
		await waitFor(
			() => ticks >= replayAtTick + 3,
			"reopened automatic worker did not run",
		);
		invariant(
			hosts.size === before && JSON.stringify(store.all()) === settledBefore,
			"replay duplicated dispatch or settlement",
		);
		invariant(
			unmatched === 0 &&
				jwksRequests === expectedProviders.length &&
				launches === expectedProviders.length,
			"acceptance silently skipped boundaries",
		);
		const freeMinutesConsumed = store
			.all()
			.reduce((sum, lease) => sum + lease.billedFreeMinutes, 0);
		const paidMicros = store
			.all()
			.reduce((sum, lease) => sum + lease.paidMicros, 0);
		invariant(
			freeMinutesConsumed === (options.local ? 0 : 10) &&
				paidMicros === (options.local ? 0 : 6000),
			"final budget accounting incorrect",
		);
		invariant((await service.stop()).drained, "reopened service did not drain");
		drains++;
		invariant(
			drains === 2 &&
				serviceLogs.filter((event) => event === "service.started").length ===
					2 &&
				serviceLogs.filter((event) => event === "service.drained").length === 2,
			"service restart/drain was skipped",
		);
		await writeFile(
			join(root, "service-events.json"),
			`${JSON.stringify({ ticks, drains, events: serviceLogs }, null, 2)}\n`,
		);
		const report: AcceptanceReport = {
			mode: "local-shipped-relay-and-host",
			evidenceDirectory: root,
			workflowSha256,
			executions,
			freeMinutesConsumed,
			paidMicros,
			deniedLaunches: 0,
			replayPreserved: true,
			liveProviderProof: false,
			service: {
				starts: 2,
				drains,
				workerTicks: ticks,
				replayedCompletions: executions.length,
			},
		};
		await writeFile(
			join(root, "report.json"),
			`${JSON.stringify(report, null, 2)}\n`,
		);
		return report;
	} finally {
		await service.stop();
		await close(fixture);
		if (!options.evidenceDirectory)
			await rm(root, { recursive: true, force: true });
	}
}
/** Read-only readiness, never proof of execution. The injected boundary permits
 * permission rejection to be tested without contacting GitHub. */
export async function verifyLivePermissions(
	repository: string,
	probe: (path: string) => Promise<Response> = async (path) =>
		Response.json(
			JSON.parse(await command("gh", ["api", path], process.cwd())),
		),
): Promise<void> {
	invariant(
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
		"invalid repository",
	);
	const repo = await probe(`repos/${repository}`);
	invariant(
		repo.status === 200,
		`GitHub repository readiness failed (${repo.status}); live workflow execution unproven`,
	);
	const identity = z
		.object({ id: z.number().int().positive(), full_name: z.string() })
		.parse(await repo.json());
	invariant(
		identity.full_name.toLowerCase() === repository.toLowerCase(),
		"GitHub repository identity mismatch",
	);
	const runners = await probe(`repos/${repository}/actions/runners`);
	invariant(
		runners.status === 200,
		`GitHub runner readiness failed (${runners.status}); live workflow execution unproven`,
	);
	z.object({
		total_count: z.number().int().nonnegative(),
		runners: z.array(
			z.object({ id: z.number().int().positive(), name: z.string() }),
		),
	}).parse(await runners.json());
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	const args = parseArgs({
		options: {
			act: { type: "string" },
			evidence: { type: "string" },
			fault: { type: "string" },
			local: { type: "boolean" },
			"live-verify": { type: "boolean" },
			repository: { type: "string", default: "Hobo-Labs/HoBo" },
		},
	});
	const task = args.values["live-verify"]
		? verifyLivePermissions(args.values.repository).then(() => ({
				permissionProbe: "passed",
				liveWorkflowExecutionProven: false,
			}))
		: runAcceptance({
				actBinary: args.values.act ?? "act",
				local: args.values.local,
				evidenceDirectory: args.values.evidence,
				fault:
					args.values.fault === undefined
						? undefined
						: z
								.enum(["missing-jit", "wrong-provider", "skip-job"])
								.parse(args.values.fault),
			});
	task
		.then((result) =>
			process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
		)
		.catch((error) => {
			process.stderr.write(
				`${error instanceof Error ? error.message : "acceptance failed"}\n`,
			);
			process.exitCode = 1;
		});
}
