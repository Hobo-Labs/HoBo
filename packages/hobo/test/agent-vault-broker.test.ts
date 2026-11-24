import {
	type AgentVaultService,
	type AgentVaultSessionService,
	type InfisicalAgentVaultApi,
	InfisicalError,
} from "@hobo/adapter-infisical";
import {
	type AgentVaultProxyLaunch,
	type AgentVaultProxyRoute,
	AgentVaultProxyStartError,
	type LaunchAgentVaultProxy,
} from "@hobo/hobo-ci";
import { describe, expect, it } from "vitest";

import {
	AGENT_VAULT_PROXY_NAME,
	type AgentVaultResolution,
	type AgentVaultStatus,
	createAgentVaultBroker,
} from "../src/agent-vault-broker.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";
const PROXY_ID = "00000000-0000-4000-8000-0000000000a2";
const SESSION_PREFIX = "00000000-0000-4000-8000-0000000001";
const PROXY_TOKEN = "fixture-proxy-token-value";
const SESSION_TOKEN_PREFIX = "agv_fixture-session-token-";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
const HOST = "developers.hostinger.com";
const SECRETS = [
	PROJECT_ID,
	PROXY_ID,
	SESSION_PREFIX,
	PROXY_TOKEN,
	SESSION_TOKEN_PREFIX,
];

type Fixture = {
	projects: { id: string; name: string }[];
	services: AgentVaultService[];
	proxies: { id: string; name: string; healthy: boolean }[];
	described: (services: readonly string[]) => AgentVaultSessionService[];
	failWith?: InfisicalError;
	launchFails?: boolean;
};

const hostingerService: AgentVaultService = {
	name: "hostinger",
	type: "http",
	hosts: [HOST],
};

function describedWith(
	credential: AgentVaultSessionService["credential"],
	placeholders: AgentVaultSessionService["placeholders"] = [],
) {
	return (services: readonly string[]): AgentVaultSessionService[] =>
		services.map((name) => ({
			name,
			type: "http",
			hosts: [HOST],
			credential,
			placeholders,
		}));
}

function world(overrides: Partial<Fixture> = {}) {
	const fixture: Fixture = {
		projects: [{ id: PROJECT_ID, name: "Agents" }],
		services: [hostingerService],
		proxies: [],
		described: describedWith({
			type: "bearer",
			header: "Authorization",
			addedByProxy: true,
		}),
		...overrides,
	};
	const log: string[] = [];
	let sessions = 0;
	const api: InfisicalAgentVaultApi = {
		async listProjects() {
			log.push("listProjects");
			if (fixture.failWith !== undefined) throw fixture.failWith;
			return fixture.projects;
		},
		async listServices(projectId) {
			log.push(`listServices ${projectId === PROJECT_ID}`);
			return fixture.services;
		},
		async listProxies() {
			log.push("listProxies");
			return fixture.proxies;
		},
		async createProxy(_projectId, name) {
			log.push(`createProxy ${name}`);
			const proxy = { id: PROXY_ID, name, healthy: false };
			fixture.proxies.push(proxy);
			return { proxy, proxyToken: PROXY_TOKEN };
		},
		async rotateProxyToken(proxyId) {
			log.push(`rotateProxyToken ${proxyId === PROXY_ID}`);
			return {
				proxy: { id: PROXY_ID, name: AGENT_VAULT_PROXY_NAME, healthy: true },
				proxyToken: PROXY_TOKEN,
			};
		},
		async proxyCertificateAuthority() {
			log.push("proxyCertificateAuthority");
			return { certificate: CA, fingerprint: "AA:BB" };
		},
		async createSession(input) {
			sessions += 1;
			log.push(`createSession ${input.services.join(",")} ${input.ttl}`);
			return {
				id: `${SESSION_PREFIX}${String(sessions).padStart(2, "0")}`,
				token: `${SESSION_TOKEN_PREFIX}${sessions}`,
				expiresAt: "2026-11-23T01:00:00.000Z",
			};
		},
		async revokeSession(sessionId) {
			log.push(`revokeSession ${sessionId.slice(-2)}`);
		},
		async sessionServices(token) {
			log.push(`sessionServices ${token.startsWith(SESSION_TOKEN_PREFIX)}`);
			return fixture.described(
				fixture.services
					.filter((service) => service.type === "http")
					.map((service) => service.name),
			);
		},
	};
	const launches: AgentVaultProxyLaunch[] = [];
	const stops: number[] = [];
	const launch: LaunchAgentVaultProxy = async (input) => {
		launches.push(input);
		log.push("launch");
		if (fixture.launchFails === true)
			throw new AgentVaultProxyStartError(
				"exited",
				"The Agent Vault proxy exited while starting: Infisical refused its token or settings.",
			);
		const port = 40_000 + launches.length;
		return {
			port,
			stop: async () => {
				stops.push(port);
				log.push(`stop ${port}`);
			},
		};
	};
	const routes: AgentVaultProxyRoute[] = [];
	const requests: { url: string; headers: Record<string, string> }[] = [];
	let clock = Date.parse("2026-11-23T00:00:00.000Z");
	const broker = createAgentVaultBroker({
		vault: { api, siteUrl: "https://app.infisical.com" },
		launch,
		command: async () => "/hobo-tools/infisical",
		now: () => clock,
		fetchThrough: (route) => {
			routes.push(route);
			return {
				fetch: async (input, init) => {
					requests.push({
						url: String(input),
						headers: Object.fromEntries(new Headers(init?.headers)),
					});
					return new Response("[]", { status: 200 });
				},
				close: async () => {
					log.push("closeFetch");
				},
			};
		},
	});
	return {
		broker,
		fixture,
		log,
		launches,
		stops,
		routes,
		requests,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

function expectNoSecrets(
	value: AgentVaultResolution | AgentVaultStatus | string | undefined,
): void {
	const text = JSON.stringify(value);
	for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("the Agent Vault broker", () => {
	it("registers its proxy, starts a session before the proxy, and routes through it", async () => {
		const run = world();
		const resolution = await run.broker.route(HOST);
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) throw new Error("refused");
		expect(resolution.route.service).toBe("hostinger");
		expect(resolution.route.hosts).toEqual([HOST]);
		expect(resolution.route.credential).toBeUndefined();
		expect(run.log).toEqual([
			"listProjects",
			"listServices true",
			"createSession hostinger 1h",
			"sessionServices true",
			"listProxies",
			`createProxy ${AGENT_VAULT_PROXY_NAME}`,
			"proxyCertificateAuthority",
			"launch",
		]);
		expect(run.launches).toEqual([
			{
				command: "/hobo-tools/infisical",
				siteUrl: "https://app.infisical.com",
				proxyToken: PROXY_TOKEN,
			},
		]);
		expect(run.routes).toEqual([
			{
				port: 40_001,
				sessionToken: `${SESSION_TOKEN_PREFIX}1`,
				certificateAuthority: CA,
			},
		]);
		const answer = await resolution.route.transport({
			method: "GET",
			url: `https://${HOST}/api/vps/v1/virtual-machines`,
			headers: { authorization: "Bearer ", accept: "application/json" },
			timeoutMs: 1000,
			maxResponseBytes: 1024,
		});
		expect(answer.status).toBe(200);
		expect(run.requests).toEqual([
			{
				url: `https://${HOST}/api/vps/v1/virtual-machines`,
				headers: { accept: "application/json" },
			},
		]);
		expectNoSecrets(resolution.route.service);
		expectNoSecrets(run.broker.status());
		expect(run.broker.status()).toEqual({
			project: "Agents",
			services: [{ name: "hostinger", hosts: [HOST] }],
			proxy: { name: AGENT_VAULT_PROXY_NAME, healthy: true },
		});
	});

	it("rotates the token of an existing proxy and hands over the header placeholder", async () => {
		const run = world({
			proxies: [{ id: PROXY_ID, name: AGENT_VAULT_PROXY_NAME, healthy: false }],
			described: describedWith(
				{ type: "bearer", header: "Authorization", addedByProxy: false },
				[{ placeholder: "__HOSTINGER__", surfaces: ["header"] }],
			),
		});
		const resolution = await run.broker.route(HOST);
		if (!resolution.ok) throw new Error(resolution.refusal.message);
		expect(resolution.route.credential).toBe("__HOSTINGER__");
		expect(run.log).toContain("rotateProxyToken true");
		expect(run.log).not.toContain(`createProxy ${AGENT_VAULT_PROXY_NAME}`);
		await resolution.route.transport({
			method: "GET",
			url: `https://${HOST}/api/vps/v1/virtual-machines`,
			headers: { authorization: "Bearer __HOSTINGER__" },
			timeoutMs: 1000,
			maxResponseBytes: 1024,
		});
		expect(run.requests[0]?.headers.authorization).toBe("Bearer __HOSTINGER__");
	});

	it("reuses the open route, renews it before the session expires, and tears everything down on close", async () => {
		const run = world();
		await run.broker.route(HOST);
		await run.broker.route(HOST);
		expect(run.launches).toHaveLength(1);
		run.advance(56 * 60 * 1000);
		const renewed = await run.broker.route(HOST);
		expect(renewed.ok).toBe(true);
		expect(run.launches).toHaveLength(2);
		expect(run.log).toContain("revokeSession 01");
		expect(run.stops).toEqual([40_001]);
		await run.broker.close();
		expect(run.log.slice(-3)).toEqual([
			"closeFetch",
			"revokeSession 02",
			"stop 40002",
		]);
		const after = await run.broker.route(HOST);
		expect(after.ok).toBe(false);
		expect(run.launches).toHaveLength(2);
	});

	it("refuses several Agent Vault projects by name", async () => {
		const run = world({
			projects: [
				{ id: PROJECT_ID, name: "Agents" },
				{ id: PROXY_ID, name: "Ops" },
			],
		});
		const resolution = await run.broker.route(HOST);
		expect(resolution).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_PROJECT_AMBIGUOUS" },
		});
		if (resolution.ok) throw new Error("routed");
		expect(resolution.refusal.message).toContain('"Agents", "Ops"');
		expectNoSecrets(resolution);
		expect(run.launches).toHaveLength(0);
	});

	it("says Agent Vault is unavailable with no project, and when Infisical refuses", async () => {
		const none = await world({ projects: [] }).broker.route(HOST);
		expect(none).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_UNAVAILABLE" },
		});
		const denied = world({
			failWith: new InfisicalError("list agent vault projects", "forbidden", {
				status: 403,
			}),
		});
		const refused = await denied.broker.route(HOST);
		expect(refused).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_UNAVAILABLE" },
		});
		expectNoSecrets(refused);
	});

	it("names the services it has when none covers the host", async () => {
		const run = world({
			services: [
				{ name: "github", type: "http", hosts: ["api.github.com"] },
				{ name: "db", type: "postgres", hosts: [] },
			],
		});
		const resolution = await run.broker.route(HOST);
		expect(resolution).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_NO_SERVICE" },
		});
		expect(run.log).not.toContain("launch");
	});

	it("matches a one-label wildcard and refuses a service without a usable credential", async () => {
		const run = world({
			services: [
				{ name: "hostinger", type: "http", hosts: ["*.hostinger.com"] },
			],
			described: describedWith(
				{ type: "bearer", header: "Authorization", addedByProxy: false },
				[{ placeholder: "__HOSTINGER__", surfaces: ["body"] }],
			),
		});
		const resolution = await run.broker.route(HOST);
		expect(resolution).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_NO_CREDENTIAL" },
		});
		expect(run.log).toContain("revokeSession 01");
		expect(run.launches).toHaveLength(0);
		const deeper = world({
			services: [{ name: "hostinger", type: "http", hosts: ["*.com"] }],
		});
		expect(await deeper.broker.route(HOST)).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_NO_SERVICE" },
		});
	});

	it("revokes the session when the proxy does not start", async () => {
		const run = world({ launchFails: true });
		const resolution = await run.broker.route(HOST);
		expect(resolution).toMatchObject({
			ok: false,
			refusal: { code: "HOBO_AGENT_VAULT_PROXY_FAILED" },
		});
		expect(run.log.slice(-2)).toEqual(["launch", "revokeSession 01"]);
		expectNoSecrets(resolution);
	});
});
