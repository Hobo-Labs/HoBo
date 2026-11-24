import { describe, expect, it } from "vitest";
import {
	createInfisicalClient,
	InfisicalError,
	parseInfisicalBinding,
} from "../src/index.js";

const SITE = "https://infisical.example.test";
const OWNER_TOKEN = "owner-access-token-value";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const PROXY = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const PROXY_TOKEN = "proxy-token-value";
const SESSION_TOKEN = "agv_session-token-value";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

type Seen = Readonly<{
	method: string;
	url: URL;
	authorization: string | null;
	body: string | undefined;
}>;

function fakeInfisical(
	answer: (seen: Seen) => Readonly<{ status: number; json?: object }>,
) {
	const seen: Seen[] = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = {
			method: init?.method ?? "GET",
			url: new URL(String(input)),
			authorization: new Headers(init?.headers).get("authorization"),
			body: init?.body === undefined ? undefined : String(init.body),
		};
		seen.push(request);
		const reply = answer(request);
		return new Response(
			reply.json === undefined ? null : JSON.stringify(reply.json),
			{ status: reply.status },
		);
	};
	const client = createInfisicalClient({
		binding: parseInfisicalBinding({
			siteUrl: SITE,
			projectId: "proj-1",
			environment: "prod",
			secretPath: "/hobo",
		}),
		auth: { method: "access-token", accessToken: OWNER_TOKEN },
		fetch,
		sleep: async () => undefined,
	});
	return { seen, api: client.agentVault() };
}

const proxyRecord = {
	id: PROXY,
	name: "hobo",
	description: null,
	heartbeat: null,
	isHealthy: false,
	rootCaFingerprint: null,
	rootCaExpiresAt: null,
	trafficPolicy: "service-hosts",
	allowedHosts: null,
	pollInterval: 10,
	createdAt: "2026-11-01T00:00:00.000Z",
};

describe("Infisical Agent Vault API", () => {
	it("lists Agent Vault projects with the owner's access token", async () => {
		const { seen, api } = fakeInfisical(() => ({
			status: 200,
			json: {
				projects: [
					{ id: PROJECT, name: "Agents", type: "agent-vault", slug: "agents" },
					{ id: "other", name: "Secrets", type: "secret-manager" },
				],
			},
		}));
		expect(await api.listProjects()).toEqual([{ id: PROJECT, name: "Agents" }]);
		expect(seen[0]?.url.pathname).toBe("/api/v1/projects");
		expect(seen[0]?.url.searchParams.get("type")).toBe("agent-vault");
		expect(seen[0]?.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
	});

	it("reads services as names, types and hosts, paging by 100", async () => {
		const page = (offset: number) =>
			Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) => ({
				id: `00000000-0000-4000-8000-${String(offset + index).padStart(12, "0")}`,
				name: `svc-${offset + index}`,
				description: null,
				type: index === 0 ? "http" : "ssh",
				hostPattern:
					index === 0 ? "Developers.Hostinger.com, *.example.com:8443" : null,
				accessBundles: [{ id: PROXY, name: "ops" }],
			}));
		const { seen, api } = fakeInfisical((request) => ({
			status: 200,
			json: {
				services: page(Number(request.url.searchParams.get("offset"))),
			},
		}));
		const services = await api.listServices(PROJECT);
		expect(services).toHaveLength(101);
		expect(services[0]).toEqual({
			name: "svc-0",
			type: "http",
			hosts: ["developers.hostinger.com", "*.example.com:8443"],
		});
		expect(services[100]).toEqual({
			name: "svc-100",
			type: "http",
			hosts: ["developers.hostinger.com", "*.example.com:8443"],
		});
		expect(seen.map((entry) => entry.url.searchParams.get("offset"))).toEqual([
			"0",
			"100",
		]);
		expect(seen[0]?.url.searchParams.get("projectId")).toBe(PROJECT);
	});

	it("creates a service-hosts proxy and returns its first token", async () => {
		const { seen, api } = fakeInfisical(() => ({
			status: 200,
			json: { proxy: proxyRecord, proxyToken: PROXY_TOKEN },
		}));
		const started = await api.createProxy(PROJECT, "hobo");
		expect(started).toEqual({
			proxy: { id: PROXY, name: "hobo", healthy: false },
			proxyToken: PROXY_TOKEN,
		});
		expect(seen[0]?.method).toBe("POST");
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
			projectId: PROJECT,
			name: "hobo",
			description: "HoBo runs this proxy for its verbs.",
			trafficPolicy: "service-hosts",
			pollInterval: 10,
		});
	});

	it("rotates a proxy token, reads its CA, and lists proxies", async () => {
		const { seen, api } = fakeInfisical((request) => {
			if (request.url.pathname.endsWith("/proxy-token"))
				return {
					status: 200,
					json: { proxy: proxyRecord, proxyToken: PROXY_TOKEN },
				};
			if (request.url.pathname.endsWith("/ca"))
				return {
					status: 200,
					json: {
						ca: {
							certificate: PEM,
							fingerprint: "AB:CD",
							expiresAt: "2027-01-01T00:00:00.000Z",
						},
					},
				};
			return {
				status: 200,
				json: { proxies: [{ ...proxyRecord, isHealthy: true }] },
			};
		});
		expect((await api.rotateProxyToken(PROXY)).proxyToken).toBe(PROXY_TOKEN);
		expect(await api.proxyCertificateAuthority(PROXY)).toEqual({
			certificate: PEM,
			fingerprint: "AB:CD",
		});
		expect(await api.listProxies(PROJECT)).toEqual([
			{ id: PROXY, name: "hobo", healthy: true },
		]);
		expect(
			seen.map((entry) => `${entry.method} ${entry.url.pathname}`),
		).toEqual([
			`POST /api/v1/agent-vault/proxies/${PROXY}/token-auth/proxy-token`,
			`GET /api/v1/agent-vault/proxies/${PROXY}/ca`,
			"GET /api/v1/agent-vault/proxies",
		]);
	});

	it("creates, inspects and revokes a session", async () => {
		const { seen, api } = fakeInfisical((request) => {
			if (request.url.pathname === "/api/v1/agent-vault/sessions")
				return {
					status: 200,
					json: {
						session: {
							id: SESSION,
							projectId: PROJECT,
							token: SESSION_TOKEN,
							expiresAt: "2026-11-23T01:00:00.000Z",
							metadata: {},
						},
					},
				};
			if (request.url.pathname === "/api/v1/agent-vault/session/services")
				return {
					status: 200,
					json: {
						agentVault: { proxy: null, version: null, trafficPolicy: null },
						session: { expiresAt: null, accessBundle: null },
						services: [
							{
								name: "hostinger",
								description: null,
								type: "http",
								hosts: ["developers.hostinger.com"],
								url: "https://developers.hostinger.com",
								status: "ready",
								credential: {
									type: "bearer",
									header: "Authorization",
									addedByProxy: false,
									memberProvided: false,
								},
								customHeaders: [],
								placeholders: [
									{ placeholder: "__hostinger_token__", surfaces: ["header"] },
								],
								allowedMethods: null,
								allowedPathPrefixes: null,
								allowedTools: null,
								howToUse: "Send the placeholder.",
							},
						],
						notes: [],
					},
				};
			return { status: 200, json: { session: { id: SESSION } } };
		});
		const session = await api.createSession({
			projectId: PROJECT,
			services: ["hostinger"],
			ttl: "1h",
			label: "hobo",
		});
		expect(session).toEqual({
			id: SESSION,
			token: SESSION_TOKEN,
			expiresAt: "2026-11-23T01:00:00.000Z",
		});
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
			projectId: PROJECT,
			services: ["hostinger"],
			ttl: "1h",
			label: "hobo",
		});
		const services = await api.sessionServices(session.token);
		expect(seen[1]?.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
		expect(services).toEqual([
			{
				name: "hostinger",
				type: "http",
				hosts: ["developers.hostinger.com"],
				credential: {
					type: "bearer",
					header: "Authorization",
					addedByProxy: false,
				},
				placeholders: [
					{ placeholder: "__hostinger_token__", surfaces: ["header"] },
				],
			},
		]);
		await api.revokeSession(SESSION);
		expect(`${seen[2]?.method} ${seen[2]?.url.pathname}`).toBe(
			`POST /api/v1/agent-vault/sessions/${SESSION}/revoke`,
		);
	});

	it("refuses malformed answers and denials without quoting ids or tokens", async () => {
		const denied = fakeInfisical(() => ({
			status: 403,
			json: { message: PROJECT },
		}));
		const forbidden = await denied.api
			.listServices(PROJECT)
			.catch((error) => error);
		expect(forbidden).toBeInstanceOf(InfisicalError);
		expect(forbidden).toMatchObject({ code: "forbidden", status: 403 });
		const malformed = fakeInfisical(() => ({
			status: 200,
			json: { proxy: proxyRecord, proxyToken: "" },
		}));
		const refused = await malformed.api
			.rotateProxyToken(PROXY)
			.catch((error) => error);
		expect(refused).toMatchObject({ code: "invalid-response" });
		for (const error of [forbidden, refused])
			for (const secret of [PROJECT, PROXY, OWNER_TOKEN, PROXY_TOKEN])
				expect(String(error.message)).not.toContain(secret);
		await expect(
			malformed.api.createSession({
				projectId: PROJECT,
				services: [],
				ttl: "1h",
				label: "hobo",
			}),
		).rejects.toMatchObject({ code: "invalid-input" });
		expect(malformed.seen).toHaveLength(1);
	});

	it("does not retry a session creation that failed in transit", async () => {
		const { seen, api } = fakeInfisical(() => ({ status: 503 }));
		await expect(
			api.createSession({
				projectId: PROJECT,
				services: ["hostinger"],
				ttl: "1h",
				label: "hobo",
			}),
		).rejects.toMatchObject({ code: "write-uncertain" });
		expect(seen).toHaveLength(1);
	});
});
