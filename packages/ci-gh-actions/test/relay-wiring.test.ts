import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { VerifiedWebhook } from "../src/http-handler.js";
import { RELAY_CONFIG_PATH } from "../src/relay-answer/index.js";
import {
	createRelayWiring,
	RELAY_WIRING_OFF,
	type RelayWiring,
	type RelayWiringFlags,
	relayWiringFlags,
	relayWiringOn,
} from "../src/relay-wiring.js";
import { testJitConfig } from "../src/runner-protocol/port.js";
import {
	GithubSimulator,
	SimulatedRunnerService,
	simulatorTransport,
} from "./support/github-simulator/index.js";

const REPO = "octo/app";
const ACCOUNT = "acct-1";
const CONNECTIONS = [{ installationId: 1, repository: REPO }];
const MINUTE = 60_000;
const TOKEN = "Bearer reader-token";
const READER = {
	accountId: ACCOUNT,
	installationIds: [1],
	scopes: ["policy:read"],
};

const wirings: RelayWiring[] = [];
const directories: string[] = [];
afterEach(() => {
	for (const wiring of wirings.splice(0)) wiring.close();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function flags(
	init: Partial<{ answer: boolean; autoRetry: boolean; dashboard: boolean }>,
): RelayWiringFlags {
	return {
		relayJobs: { answer: init.answer ?? false, label: "hobo-relay" },
		autoRetry: init.autoRetry ?? false,
		dashboard: init.dashboard ?? false,
	};
}

function recordingTransport() {
	const paths: string[] = [];
	const transport = {
		request: async (_installationId: number, path: string) => {
			paths.push(path);
			return new Response(null, { status: 500 });
		},
	} satisfies GithubTransport;
	return { paths, transport };
}

function simulatorWithRerun(sim: GithubSimulator) {
	const base = simulatorTransport(sim);
	const reruns: string[] = [];
	const transport: GithubTransport = {
		request: async (installationId, path, method = "GET", body) => {
			if (method === "POST" && /\/actions\/jobs\/\d+\/rerun$/u.test(path)) {
				reruns.push(path);
				return new Response(null, { status: 201 });
			}
			return base.request(installationId, path, method, body);
		},
	};
	return { reruns, transport };
}

function wire(
	sim: GithubSimulator | undefined,
	on: RelayWiringFlags,
	transport: GithubTransport,
	extra: Partial<Parameters<typeof createRelayWiring>[0]> = {},
): RelayWiring {
	const options: Parameters<typeof createRelayWiring>[0] = {
		flags: on,
		github: transport,
		connections: async () =>
			CONNECTIONS.map((connection) => ({
				...connection,
				accountId: ACCOUNT,
				public: false,
			})),
		database: ":memory:",
		node: "node-a",
		...extra,
	};
	const wiring = createRelayWiring(
		sim === undefined
			? options
			: {
					...options,
					runnerService: new SimulatedRunnerService(sim),
					readJitConfig: (_encoded: string, runnerName: string) =>
						testJitConfig(runnerName),
					nowMs: () => sim.nowMs(),
				},
	);
	wirings.push(wiring);
	return wiring;
}

function turnOn(sim: GithubSimulator): void {
	sim.putFile(
		REPO,
		RELAY_CONFIG_PATH,
		JSON.stringify({
			relayJobs: { answer: true },
			runnerOrder: {
				steps: [{ key: "github" }, { key: "blacksmith" }],
				retry: { enabled: true, runner: "other", max: 2 },
			},
		}),
	);
}

function queueRelay(sim: GithubSimulator): number {
	const relay = sim.queueJob({
		repository: REPO,
		name: "title",
		labels: ["hobo-relay"],
		steps: [{ uses: "hobo-labs/hobo/checks/pr-title@v1", with: new Map() }],
	});
	return relay.runId;
}

function intake(wiring: RelayWiring) {
	return async (request: Request): Promise<Response> => {
		const event = request.headers.get("x-github-event");
		const webhook: VerifiedWebhook = {
			deliveryId: request.headers.get("x-github-delivery") ?? "",
			event: event === "workflow_run" ? "workflow_run" : "workflow_job",
			rawBody: new Uint8Array(await request.arrayBuffer()),
			receivedAt: new Date().toISOString(),
		};
		await wiring.onWebhook(webhook);
		return new Response(null, { status: 202 });
	};
}

describe("relay wiring flags", () => {
	it("are all off unless set to 1", () => {
		expect(relayWiringFlags({})).toEqual(RELAY_WIRING_OFF);
		expect(relayWiringOn(relayWiringFlags({}))).toBe(false);
		expect(
			relayWiringFlags({
				HOBO_CI_RELAY_JOBS_ANSWER: "true",
				HOBO_CI_AUTO_RETRY: "yes",
				HOBO_CI_DASHBOARD: "on",
			}),
		).toEqual(RELAY_WIRING_OFF);
		expect(
			relayWiringFlags({
				HOBO_CI_RELAY_JOBS_ANSWER: "1",
				HOBO_CI_RELAY_JOBS_LABEL: "my-relay",
				HOBO_CI_AUTO_RETRY: "1",
				HOBO_CI_DASHBOARD: "1",
			}),
		).toEqual({
			relayJobs: { answer: true, label: "my-relay" },
			autoRetry: true,
			dashboard: true,
		});
	});
});

describe("with every flag off", () => {
	it("opens no file, asks GitHub nothing and serves no page", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-relay-wiring-"));
		directories.push(directory);
		const database = join(directory, "relay-wiring.sqlite");
		const { transport, paths } = recordingTransport();
		const wiring = wire(undefined, RELAY_WIRING_OFF, transport, {
			database,
			dashboard: async () => new Response("page"),
		});
		expect(await wiring.afterPoll(CONNECTIONS)).toBeUndefined();
		expect(
			await wiring.onWebhook({
				deliveryId: "d-1",
				event: "workflow_run",
				rawBody: new TextEncoder().encode(
					JSON.stringify({
						action: "completed",
						installation: { id: 1 },
						repository: { full_name: REPO },
					}),
				),
				receivedAt: new Date().toISOString(),
			}),
		).toBeUndefined();
		expect(
			await wiring.page(new Request("https://relay.example/dashboard")),
		).toBeUndefined();
		expect(paths).toEqual([]);
		expect(existsSync(database)).toBe(false);
		expect(wiring.journal).toBeUndefined();
	});
});

describe("relay mode after a poll", () => {
	it("answers a check job whose webhook never arrived, then sweeps", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const wiring = wire(sim, flags({ answer: true }), simulatorTransport(sim));
		const runId = queueRelay(sim);
		const pass = await wiring.afterPoll(CONNECTIONS);
		expect(pass?.rescue.queued).toBe(1);
		expect(pass?.rescue.outcomes[0]?.kind).toBe("answered");
		expect(pass?.sweep.deleted).toEqual([]);
		const title = sim
			.jobs()
			.find((one) => one.name === "title" && one.runId === runId);
		expect(title).toMatchObject({ status: "completed", conclusion: "failure" });
		expect(title?.annotations).toEqual([
			"No relay check handler answered this job; its checks did not run.",
		]);
		expect(title?.outputs.size).toBe(0);
		expect(
			await wiring.journal?.decisions({
				accountId: ACCOUNT,
				repository: REPO,
				sinceMs: 0,
				limit: 10,
			}),
		).toEqual([]);
	});

	it("skips a poll's pass while the last one is still running", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const wiring = wire(sim, flags({ answer: true }), simulatorTransport(sim));
		queueRelay(sim);
		const first = wiring.afterPoll(CONNECTIONS);
		expect(await wiring.afterPoll(CONNECTIONS)).toBeUndefined();
		expect((await first)?.rescue.queued).toBe(1);
		expect((await wiring.afterPoll(CONNECTIONS))?.rescue.queued).toBe(0);
	});

	it("does not answer with relay mode off, even when the repository turns it on", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const wiring = wire(sim, flags({}), simulatorTransport(sim));
		const runId = queueRelay(sim);
		const before = sim.requests().length;
		expect(await wiring.afterPoll(CONNECTIONS)).toBeUndefined();
		expect(sim.requests()).toHaveLength(before);
		expect(
			sim.jobs().find((one) => one.name === "title" && one.runId === runId)
				?.status,
		).toBe("queued");
	});
});

async function failedBeforeSteps(
	sim: GithubSimulator,
	wiring: RelayWiring,
): Promise<number> {
	sim.registerRunner({ name: "gh-1", labels: ["ubuntu-24.04"] });
	const { runId } = sim.queueJob({
		repository: REPO,
		name: "build",
		labels: ["ubuntu-24.04"],
	});
	await wiring.afterPoll(CONNECTIONS);
	const build = sim.claim("gh-1");
	expect(build?.name).toBe("build");
	sim.advance(MINUTE);
	sim.complete(build?.id ?? 0, {
		conclusion: "failure",
		steps: [{ name: "Set up job", conclusion: "failure" }],
	});
	return runId;
}

describe("automatic retry on a failed workflow_run", () => {
	it("re-runs nothing for a run no route decision was journaled for", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const { transport, reruns } = simulatorWithRerun(sim);
		const wiring = wire(
			sim,
			flags({ answer: true, autoRetry: true }),
			transport,
		);
		await failedBeforeSteps(sim, wiring);
		await sim.deliver(intake(wiring));
		expect(reruns).toEqual([]);
	});

	it("re-runs nothing with retry off", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const { transport, reruns } = simulatorWithRerun(sim);
		const wiring = wire(sim, flags({ answer: true }), transport);
		await failedBeforeSteps(sim, wiring);
		const before = sim.requests().length;
		await sim.deliver(intake(wiring));
		expect(reruns).toEqual([]);
		expect(sim.requests()).toHaveLength(before);
	});

	it("ignores a delivery for a repository the relay is not connected to", async () => {
		const { transport, paths } = recordingTransport();
		const wiring = wire(undefined, flags({ autoRetry: true }), transport);
		expect(
			await wiring.onWebhook({
				deliveryId: "d-1",
				event: "workflow_run",
				rawBody: new TextEncoder().encode(
					JSON.stringify({
						action: "completed",
						installation: { id: 9 },
						repository: { full_name: "someone/else" },
					}),
				),
				receivedAt: new Date().toISOString(),
			}),
		).toBeUndefined();
		expect(paths).toEqual([]);
	});
});

describe("the dashboard", () => {
	const dashboard = async (request: Request) =>
		new URL(request.url).pathname === "/dashboard"
			? new Response("<!doctype html>", { status: 200 })
			: undefined;

	it("is served with its flag on", async () => {
		const { transport } = recordingTransport();
		const wiring = wire(undefined, flags({ dashboard: true }), transport, {
			dashboard,
		});
		const page = await wiring.page(
			new Request("https://relay.example/dashboard"),
		);
		expect(page?.status).toBe(200);
		expect(
			await wiring.page(new Request("https://relay.example/elsewhere")),
		).toBeUndefined();
	});

	it("is not served with its flag off, and neither is the read API", async () => {
		const { transport } = recordingTransport();
		const wiring = wire(undefined, flags({}), transport, {
			dashboard,
			authenticate: () => READER,
		});
		expect(
			await wiring.page(new Request("https://relay.example/dashboard")),
		).toBeUndefined();
		expect(
			await wiring.control(
				new Request(`https://relay.example/v1/accounts/self/runs`, {
					headers: { authorization: TOKEN },
				}),
			),
		).toBeUndefined();
	});

	it("reads the relay's run history through the read API, behind its token", async () => {
		const sim = new GithubSimulator();
		turnOn(sim);
		const wiring = wire(
			sim,
			flags({ answer: true, dashboard: true }),
			simulatorTransport(sim),
			{
				dashboard,
				authenticate: (presented) => (presented === TOKEN ? READER : undefined),
			},
		);
		sim.registerRunner({ name: "gh-1", labels: ["ubuntu-24.04"] });
		const { runId } = sim.queueJob({
			repository: REPO,
			name: "build",
			labels: ["ubuntu-24.04"],
		});
		await wiring.afterPoll(CONNECTIONS);
		const build = sim.claim("gh-1");
		sim.complete(build?.id ?? 0, { conclusion: "success" });
		await sim.deliver(intake(wiring));

		const read = async (path: string, authorization = TOKEN) => {
			const response = await wiring.control(
				new Request(`https://relay.example/v1/accounts/self${path}`, {
					headers: { authorization },
				}),
			);
			return response;
		};
		const runs = await read(`/runs?repository=${REPO}`);
		expect(runs?.status).toBe(200);
		expect(await runs?.json()).toMatchObject({ runs: [{ id: runId }] });
		const routes = await read(`/routes?repository=${REPO}`);
		expect(routes?.status).toBe(200);
		expect(await routes?.json()).toMatchObject({ routes: [] });
		expect((await read("/runs", "Bearer wrong"))?.status).toBe(401);
		expect(await read("/policy")).toBeUndefined();
	});
});
