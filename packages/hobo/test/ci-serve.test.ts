import { defineCiPolicy, DesiredCiPolicySchema } from "@hobo/ci";
import { toJsonString } from "@bufbuild/protobuf";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveCiServePlan, startCiServe } from "../src/ci-serve.js";

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

async function projectRoot() {
	const root = await mkdtemp(join(tmpdir(), "hobo-ci-serve-"));
	directories.push(root);
	await mkdir(join(root, ".hobo"), { recursive: true });
	await mkdir(join(root, "packages", "ci-vercel"), { recursive: true });
	await mkdir(join(root, "packages", "ci-gh-actions"), { recursive: true });
	await writeFile(join(root, ".hobo", "ci.json"), JSON.stringify(minimalProject));
	return root;
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
			const rootReady = await fetch(`http://127.0.0.1:${listenPort}/readyz`).then((r) => r.json());
			expect(rootReady.engines["gh-actions"].ready).toBe(true);
			expect(rootReady.engines.vercel.ready).toBe(true);
			expect(
				(await fetch(`http://127.0.0.1:${listenPort}/engines/vercel/healthz`)).status,
			).toBe(200);
			expect(
				(await fetch(`http://127.0.0.1:${listenPort}/engines/gh-actions/github/webhooks`, {
					method: "POST",
				})).status,
			).toBe(401);
		} finally {
			await handle.stop();
		}
	});
});
