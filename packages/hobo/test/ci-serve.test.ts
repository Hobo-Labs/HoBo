import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { DesiredCiPolicySchema, defineCiPolicy } from "@hobo/ci";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	ciWorkerEnvironment,
	resolveCiServePlan,
	startCiServe,
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
		const handle = await startCiServe({
			cwd,
			options: {
				environment: "local",
				port,
				home,
				engines: ["gh-actions", "vercel"],
				installationId: "1",
			},
			env: {},
			git,
		});
		try {
			const listenPort = handle.plan.port;
			const rootReady = await fetch(
				`http://127.0.0.1:${listenPort}/readyz`,
			).then((r) => r.json());
			expect(rootReady.engines["gh-actions"].ready).toBe(true);
			expect(rootReady.engines.vercel.ready).toBe(true);
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
