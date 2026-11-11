import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
	DesiredCiPolicySchema,
	defineCiPolicy,
} from "@hobo/ci";
import { createAdmissionOrder } from "@hobo/ci-gh-actions";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { importGithubKey } from "../src/ci-github-keys.js";
import {
	ciWorkerEnvironment,
	resolveCiServePlan,
	startCiServe,
	startPullAdmission,
} from "../src/ci-serve.js";

const ListenAddress = z.object({
	address: z.string(),
	family: z.string(),
	port: z.number().int().positive(),
});

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

const policyJson = () =>
	JSON.parse(
		toJsonString(
			DesiredCiPolicySchema,
			defineCiPolicy({
				accountId: "local-dev",
				tenantId: "local-dev",
				pool: { label: "hobo", os: "linux", architecture: "x64" },
				providers: [
					{
						id: "gh",
						kind: "github",
						connectionRef: "gh",
						runsOn: "ubuntu-24.04",
					},
				],
				budget: {
					scope: "ci-account",
					currency: "USD",
					period: "manual",
					timeZone: "UTC",
					limitMicros: 1,
				},
				routing: {
					strategy: "lowest-total-incremental-cost",
					noEligibleProvider: "queue",
					unknownAllocation: "zero",
				},
				thresholds: [],
			}),
		),
	);

const minimalProject = {
	defaultEnvironment: "local",
	environments: {
		local: {
			relayOrigin: "http://127.0.0.1:8787",
			allowInsecureLoopback: true,
			jobAdmission: "pull",
			engines: ["gh-actions", "vercel"],
			policy: policyJson(),
		},
	},
};

async function projectRoot(projectJson = JSON.stringify(minimalProject)) {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-serve-"));
	directories.push(root);
	await mkdir(join(root, ".hobo"), { recursive: true });
	await mkdir(join(root, "packages", "ci-vercel"), { recursive: true });
	await mkdir(join(root, "packages", "ci-gh-actions"), { recursive: true });
	await writeFile(join(root, ".hobo", "ci.json"), projectJson);
	return root;
}

/** Store entries stay string-valued; the parser decides which shapes are legal. */
function withStore(store: Readonly<Record<string, string>>): string {
	return JSON.stringify({
		...minimalProject,
		environments: {
			local: { ...minimalProject.environments.local, store },
		},
	});
}

const git = async () => "git@github.com:example/project.git";

describe("hobo ci serve multi-engine", () => {
	it.each([
		{ HOBO_CI_GITHUB_APP_ID: "123" },
		{ HOBO_CI_GITHUB_APP_ID_FILE: "app-id" },
		{ HOBO_CI_GITHUB_APP_KEY_FILE: "missing-key.pem" },
		{ HOBO_CI_GITHUB_APP_PRIVATE_KEY: "unused" },
	])("refuses incomplete App configuration instead of starting with fixture credentials", async (env) => {
		const cwd = await projectRoot();
		const home = await mkdtemp(join(tmpdir(), "hobo-ci-incomplete-app-"));
		directories.push(home);
		await expect(
			startCiServe({
				cwd,
				options: {
					environment: "local",
					port: "31234",
					home,
					installationId: "1",
				},
				env,
				git,
			}),
		).rejects.toThrow(
			"GitHub App configuration requires a readable HOBO_CI_GITHUB_APP_KEY_FILE",
		);
	});

	it("print-config lists resolved engines", async () => {
		const cwd = await projectRoot();
		const plan = await resolveCiServePlan({
			cwd,
			options: { environment: "local", engines: ["gh-actions"] },
			env: {},
			git,
		});
		expect(plan.engines).toEqual(["gh-actions"]);
	});

	it("defaults the worker store to local SQLite, even with DATABASE_URL set", async () => {
		const cwd = await projectRoot();
		const plan = await resolveCiServePlan({
			cwd,
			options: { environment: "local" },
			env: { DATABASE_URL: "postgres://unused.invalid/db" },
			git,
		});
		expect(plan.workerStore).toEqual({ kind: "sqlite" });
		const env = ciWorkerEnvironment({
			relayEnv: {
				HOBO_CI_DB: "/state/relay.sqlite",
				HOBO_CI_STORE_URL_ENV: "X",
			},
			store: plan.workerStore,
			stateDir: "/state",
		});
		expect(env.HOBO_CI_STORE).toBe("sqlite");
		expect(env.HOBO_CI_WORKER_DB).toBe(join("/state", "worker.sqlite"));
		expect(env.HOBO_CI_DB).toBeUndefined();
		expect(env.HOBO_CI_STORE_URL_ENV).toBeUndefined();
	});

	it("takes a Postgres worker store from the config by env var name", async () => {
		const cwd = await projectRoot(
			withStore({ kind: "postgres", urlEnv: "HOBO_CI_SHARED_DB" }),
		);
		const plan = await resolveCiServePlan({
			cwd,
			options: { environment: "local" },
			env: {},
			git,
		});
		expect(plan.workerStore).toEqual({
			kind: "postgres",
			urlEnv: "HOBO_CI_SHARED_DB",
		});
		expect(() =>
			ciWorkerEnvironment({
				relayEnv: {},
				store: plan.workerStore,
				stateDir: "/s",
			}),
		).toThrow("--with-worker postgres store requires HOBO_CI_SHARED_DB");
		const env = ciWorkerEnvironment({
			relayEnv: { HOBO_CI_SHARED_DB: "postgres://synthetic.invalid/db" },
			store: plan.workerStore,
			stateDir: "/s",
		});
		expect(env.HOBO_CI_STORE).toBe("postgres");
		expect(env.HOBO_CI_STORE_URL_ENV).toBe("HOBO_CI_SHARED_DB");
	});

	it("refuses a connection string written into the config", async () => {
		const cwd = await projectRoot(
			withStore({ kind: "postgres", url: "postgres://user:pw@db.invalid/db" }),
		);
		await expect(
			resolveCiServePlan({
				cwd,
				options: { environment: "local" },
				env: {},
				git,
			}),
		).rejects.toThrow();
	});

	it("readyz reports per-engine readiness on mounted paths", async () => {
		const cwd = await projectRoot();
		const home = await mkdtemp(join(tmpdir(), "hobo-ci-serve-home-"));
		directories.push(home);
		const key = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		}).privateKey;
		const secret = "test-webhook-secret-for-imported-app";
		await writeFile(join(home, "source.pem"), key);
		await writeFile(join(home, "source-secret"), secret);
		await importGithubKey({
			home,
			appId: "123",
			keyFile: join(home, "source.pem"),
			webhookSecretFile: join(home, "source-secret"),
			fetch: async () => Response.json({ id: 123 }),
		});
		const port = String(
			await new Promise<number>((resolve, reject) => {
				import("node:net").then(({ createServer }) => {
					const server = createServer();
					server.listen(0, "127.0.0.1", () => {
						const picked = ListenAddress.parse(server.address()).port;
						server.close((error) => (error ? reject(error) : resolve(picked)));
					});
				});
			}),
		);
		const serveInput = {
			cwd,
			options: {
				environment: "local",
				port,
				home,
				engines: ["gh-actions", "vercel"],
				installationId: "1",
			},
			git,
		};
		await expect(startCiServe({ ...serveInput, env: {} })).rejects.toThrow(
			"real App credentials require a CI account token",
		);
		const accountToken = "test-account-token-0123456789abcdef";
		const handle = await startCiServe({
			...serveInput,
			env: { HOBO_CI_ACCOUNT_TOKEN: accountToken },
		});
		try {
			const control = await readFile(
				join(home, "ci", "serve", "control-tokens.json"),
				"utf8",
			);
			expect(control).not.toContain(accountToken);
			expect(JSON.parse(control).tokens[0].installationIds).toEqual([1]);
			const listenPort = handle.plan.port;
			const rootReady = await fetch(
				`http://127.0.0.1:${listenPort}/readyz`,
			).then((r) => r.json());
			expect(rootReady.engines["gh-actions"].ready).toBe(true);
			expect(rootReady.engines.vercel.ready).toBe(true);
			const body = "{}";
			const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
			const webhook = await fetch(
				`http://127.0.0.1:${listenPort}/engines/gh-actions/github/webhooks`,
				{
					method: "POST",
					headers: {
						"x-github-event": "ping",
						"x-hub-signature-256": signature,
					},
					body,
				},
			);
			expect(webhook.status).toBe(202);
			expect(
				(await fetch(`http://127.0.0.1:${listenPort}/engines/vercel/healthz`))
					.status,
			).toBe(200);
			expect(
				(
					await fetch(
						`http://127.0.0.1:${listenPort}/engines/gh-actions/github/webhooks`,
						{
							method: "POST",
						},
					)
				).status,
			).toBe(401);
		} finally {
			await handle.stop();
		}
	});
});

describe("hobo ci serve with a CI agent", () => {
	const agent = {
		mode: "observe",
		engines: [
			{
				id: "primary",
				kind: "gateway",
				model: "openai/gpt-5.1",
				credential: "env:TEST_MODEL_KEY",
			},
		],
	};
	const accountToken = "test-account-token-0123456789abcdef";
	/** A project (optionally with an agent block), an imported App key and a free port. */
	async function serveInput(project: z.infer<ReturnType<typeof z.json>>) {
		const cwd = await projectRoot(JSON.stringify(project));
		const home = await mkdtemp(join(tmpdir(), "hobo-ci-serve-home-"));
		directories.push(home);
		await writeFile(
			join(home, "source.pem"),
			generateKeyPairSync("rsa", {
				modulusLength: 2048,
				privateKeyEncoding: { type: "pkcs8", format: "pem" },
				publicKeyEncoding: { type: "spki", format: "pem" },
			}).privateKey,
		);
		await writeFile(
			join(home, "source-secret"),
			"test-webhook-secret-for-imported-app",
		);
		await importGithubKey({
			home,
			appId: "123",
			keyFile: join(home, "source.pem"),
			webhookSecretFile: join(home, "source-secret"),
			fetch: async () => Response.json({ id: 123 }),
		});
		const { createServer } = await import("node:net");
		const port = await new Promise<number>((resolve, reject) => {
			const server = createServer();
			server.listen(0, "127.0.0.1", () => {
				const picked = ListenAddress.parse(server.address()).port;
				server.close((error) => (error ? reject(error) : resolve(picked)));
			});
		});
		return {
			home,
			agentState: join(home, "ci", "serve", "agent"),
			input: {
				cwd,
				options: {
					environment: "local",
					port: String(port),
					home,
					installationId: "1",
				},
				git,
			},
		};
	}
	const exists = (path: string) =>
		readFile(path).then(
			() => true,
			() => false,
		);

	it("starts the agent beside the relay when the project has an agent block", async () => {
		const { input, agentState } = await serveInput({
			...minimalProject,
			agent,
		});
		const events: string[] = [];
		const handle = await startCiServe({
			...input,
			env: { HOBO_CI_ACCOUNT_TOKEN: accountToken, TEST_MODEL_KEY: "not-real" },
			emitProgress: (message) => events.push(message),
		});
		try {
			const ready = await fetch(`http://127.0.0.1:${handle.plan.port}/readyz`);
			expect(ready.status).toBe(200);
			// The agent opened its journal under this serve's state directory.
			expect(await exists(join(agentState, "agent.sqlite"))).toBe(true);
			expect(
				events.some((message) =>
					/"event":"serve\.starting".*"agent":true/.test(message),
				),
			).toBe(true);
		} finally {
			await handle.stop();
		}
	});

	it("serves without the agent when there is no block, or with --no-agent", async () => {
		for (const { project, options } of [
			{ project: minimalProject, options: {} },
			{ project: { ...minimalProject, agent }, options: { noAgent: true } },
		]) {
			const { input, agentState } = await serveInput(project);
			const handle = await startCiServe({
				...input,
				options: { ...input.options, ...options },
				// No model key: without the agent, none is needed.
				env: { HOBO_CI_ACCOUNT_TOKEN: accountToken },
			});
			try {
				expect(
					(await fetch(`http://127.0.0.1:${handle.plan.port}/readyz`)).status,
				).toBe(200);
				expect(await exists(join(agentState, "agent.sqlite"))).toBe(false);
			} finally {
				await handle.stop();
			}
		}
	});

	it("refuses to serve when the agent's model credential is not in the environment", async () => {
		const { input } = await serveInput({ ...minimalProject, agent });
		await expect(
			startCiServe({ ...input, env: { HOBO_CI_ACCOUNT_TOKEN: accountToken } }),
		).rejects.toThrow("CI agent credential is not set: env:TEST_MODEL_KEY");
	});
});

describe("hobo ci serve pull admission", () => {
	const connection = (repository: string, installationId: number) =>
		create(ConnectionSchema, {
			accountId: "local-dev",
			repository,
			repositoryId: installationId * 100,
			installationId,
		});
	function setup(connections: ReturnType<typeof connection>[]) {
		const reads: string[] = [];
		const github = {
			async request(installationId: number, path: string) {
				reads.push(`${installationId} ${path}`);
				if (path.includes("/jobs?"))
					return Response.json({
						jobs: [
							{
								id: 70,
								run_id: 7,
								run_attempt: 1,
								status: "queued",
								labels: ["hobo-trunk"],
								name: "build",
							},
							{
								id: 71,
								run_id: 7,
								run_attempt: 1,
								status: "queued",
								labels: ["ubuntu-latest"],
								name: "lint",
							},
						],
					});
				return Response.json({
					workflow_runs: path.includes("status=queued")
						? [{ id: 7, run_attempt: 1, status: "queued", event: "push" }]
						: [],
				});
			},
		};
		const deliveries: { deliveryId: string; body: string }[] = [];
		const progress: string[] = [];
		const admission = startPullAdmission({
			github,
			relay: {
				runtime: {
					admissionOrder: createAdmissionOrder(github),
					async ingestWebhook(delivery) {
						deliveries.push({
							deliveryId: delivery.deliveryId,
							body: Buffer.from(delivery.rawBody).toString("utf8"),
						});
						return "accepted";
					},
				},
				store: {
					configuration: async () =>
						create(ConfigurationStateSchema, {
							revision: 1,
							configuration: create(ConfigurationSchema, { connections }),
						}),
				},
			},
			repository: "Example/Project",
			installationId: 1,
			// The test drives each poll itself.
			intervalMs: 3_600_000,
			emitProgress: (line) => progress.push(line),
		});
		return { admission, reads, deliveries, progress };
	}

	it("hands the served repository's queued hobo and hobo-trunk jobs to the relay inbox", async () => {
		const h = setup([
			connection("example/project", 1),
			connection("example/other", 1),
			connection("example/project", 2),
		]);
		try {
			await h.admission.poll();
			// Only the repository and installation this serve was started for are read.
			expect(h.reads.length).toBeGreaterThan(0);
			expect(
				h.reads.every((read) =>
					read.startsWith("1 /repos/example/project/actions/runs"),
				),
			).toBe(true);
			expect(h.deliveries).toHaveLength(1);
			expect(h.deliveries[0]?.deliveryId).toBe("poll-70-1-q");
			expect(JSON.parse(h.deliveries[0]?.body ?? "null")).toMatchObject({
				action: "queued",
				installation: { id: 1 },
				repository: { id: 100, full_name: "example/project" },
				workflow_job: { id: 70, run_id: 7, labels: ["hobo-trunk"] },
			});
			expect(h.progress).toEqual([
				"poll-admission: 1 accepted, 0 refused, 0 GitHub read errors",
			]);
		} finally {
			h.admission.stop();
		}
	});

	it("reads nothing from GitHub until the relay holds a connection for the repository", async () => {
		const h = setup([connection("example/other", 1)]);
		try {
			await h.admission.poll();
			expect(h.reads).toEqual([]);
			expect(h.deliveries).toEqual([]);
			expect(h.progress).toEqual([]);
		} finally {
			h.admission.stop();
		}
	});
});
