import type { InfisicalAgentVaultApi } from "@hobo/adapter-infisical";
import { createHoboCli } from "@hobo/cli";
import type { AgentVaultProxyRoute, OwnerStore } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import { createCiCommand } from "../src/ci-command.js";
import { createDoctorCommand } from "../src/doctor-command.js";
import { createOwnerStoreSessions } from "../src/owner-store-session.js";

const CWD = "/synthetic/agent-vault-project";
const OWNER_TOKEN = "synthetic-hostinger-owner-token-0123456789";
const PROJECT_ID = "00000000-0000-4000-8000-0000000000b1";
const PROXY_ID = "00000000-0000-4000-8000-0000000000b2";
const SESSION_ID = "00000000-0000-4000-8000-0000000000b3";
const PROXY_TOKEN = "fixture-agent-vault-proxy-token";
const SESSION_TOKEN = "agv_fixture-agent-vault-session-token";
const PLACEHOLDER = "__HOSTINGER_API_TOKEN__";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n";
const HIDDEN = [PROJECT_ID, PROXY_ID, SESSION_ID, PROXY_TOKEN, SESSION_TOKEN];

type Options = Readonly<{
	entries?: Readonly<Record<string, string>>;
	projects?: readonly string[];
	addedByProxy?: boolean;
}>;

async function setup(options: Options = {}) {
	const log: string[] = [];
	const api: InfisicalAgentVaultApi = {
		listProjects: async () => {
			log.push("listProjects");
			return (options.projects ?? ["Agents"]).map((name, index) => ({
				id: `${PROJECT_ID.slice(0, -1)}${index}`,
				name,
			}));
		},
		listServices: async () => [
			{
				name: "hostinger-api",
				type: "http",
				hosts: ["developers.hostinger.com"],
			},
		],
		listProxies: async () => [],
		createProxy: async (_projectId, name) => ({
			proxy: { id: PROXY_ID, name, healthy: false },
			proxyToken: PROXY_TOKEN,
		}),
		rotateProxyToken: async () => {
			throw new Error("unused");
		},
		proxyCertificateAuthority: async () => ({
			certificate: CA,
			fingerprint: "AA:BB",
		}),
		createSession: async () => ({
			id: SESSION_ID,
			token: SESSION_TOKEN,
			expiresAt: undefined,
		}),
		revokeSession: async () => {
			log.push("revokeSession");
		},
		sessionServices: async () => [
			{
				name: "hostinger-api",
				type: "http",
				hosts: ["developers.hostinger.com"],
				credential: {
					type: "bearer",
					header: "Authorization",
					addedByProxy: options.addedByProxy ?? false,
				},
				placeholders:
					options.addedByProxy === true
						? []
						: [{ placeholder: PLACEHOLDER, surfaces: ["header"] }],
			},
		],
	};
	const port = createMemorySecretsPort({ id: "store:agent-vault" });
	for (const [name, value] of Object.entries(options.entries ?? {}))
		await port.put(name, value);
	const owner: OwnerStore = {
		id: "infisical",
		chosen: true,
		missing: [],
		handOffSignIn: undefined,
		opened: {
			id: "infisical",
			port,
			reference: (name) => `infisical://synthetic/prod/${name}`,
			agentVault: { api, siteUrl: "https://app.infisical.com" },
		},
		infisicalFolder: undefined,
		unopened: undefined,
		stage: async () => {
			throw new Error("the fleet never stages a page");
		},
	};
	const routes: AgentVaultProxyRoute[] = [];
	const sent: { url: string; authorization: string | null }[] = [];
	const sessions = createOwnerStoreSessions({
		signIn: async () => ({ kind: "owner", owner }),
		agentVault: {
			launch: async () => {
				log.push("launch");
				return {
					port: 41_000,
					stop: async () => {
						log.push("stop");
					},
				};
			},
			command: async () => "infisical",
			fetchThrough: (route) => {
				routes.push(route);
				return {
					fetch: async (input, init) => {
						sent.push({
							url: String(input),
							authorization: new Headers(init?.headers).get("authorization"),
						});
						return Response.json([
							{
								id: 3301,
								hostname: "hobo-arc.example.test",
								state: "running",
								plan: "KVM 2",
							},
						]);
					},
					close: async () => undefined,
				};
			},
		},
	});
	await sessions.establish(CWD);
	const hoboCli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {},
				fleetCredentials: sessions.credentials,
				fleetAgentVault: sessions.agentVault,
				hostingerHttp: async () => ({
					status: 200,
					headers: { "content-type": "application/json" },
					body: "[]",
				}),
			}),
			doctor: createDoctorCommand({ env: {}, ownerSession: sessions.status }),
		},
	});
	return { sessions, hoboCli, log, routes, sent };
}

function hidesIds(text: string): void {
	for (const value of HIDDEN) expect(text).not.toContain(value);
	expect(text).not.toContain(OWNER_TOKEN);
}

describe("hobo ci fleet through Infisical Agent Vault", () => {
	it("calls Hostinger through HoBo's proxy with the service's placeholder", async () => {
		const run = await setup();
		const result = await run.hoboCli.run(["ci", "fleet", "status", "--json"], {
			cwd: CWD,
		});
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.message).toContain(
			"through Infisical Agent Vault service hostinger-api: developers.hostinger.com",
		);
		expect(envelope.data.credentialSource).toEqual({
			kind: "agent-vault",
			service: "hostinger-api",
			hosts: ["developers.hostinger.com"],
		});
		expect(envelope.data.fleet.hosts).toHaveLength(1);
		expect(run.sent).toEqual([
			{
				url: "https://developers.hostinger.com/api/vps/v1/virtual-machines",
				authorization: `Bearer ${PLACEHOLDER}`,
			},
		]);
		expect(run.routes).toEqual([
			{ port: 41_000, sessionToken: SESSION_TOKEN, certificateAuthority: CA },
		]);
		hidesIds(result.stdout + result.stderr);
		const doctor = await run.hoboCli.run(["doctor", "--json"], { cwd: CWD });
		const report = JSON.parse(doctor.stdout).data.ownerStoreSession;
		expect(report).toEqual({
			established: true,
			store: "Infisical",
			agentVault: {
				project: "Agents",
				services: [
					{ name: "hostinger-api", hosts: ["developers.hostinger.com"] },
				],
				proxy: { name: "hobo", healthy: true },
			},
		});
		hidesIds(doctor.stdout);
		await run.sessions.close();
		expect(run.log.slice(-2)).toEqual(["revokeSession", "stop"]);
	});

	it("sends no Authorization header when the proxy adds the credential", async () => {
		const run = await setup({ addedByProxy: true });
		const result = await run.hoboCli.run(["ci", "fleet", "status", "--json"], {
			cwd: CWD,
		});
		expect(result.exitCode).toBe(0);
		expect(run.sent[0]?.authorization).toBeNull();
		await run.sessions.close();
	});

	it("keeps using the owner store entry when it exists", async () => {
		const run = await setup({ entries: { HOSTINGER_API_TOKEN: OWNER_TOKEN } });
		const result = await run.hoboCli.run(["ci", "fleet", "status", "--json"], {
			cwd: CWD,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).data.credentialSource).toEqual({
			kind: "owner-store",
		});
		expect(run.log).toEqual([]);
		hidesIds(result.stdout);
	});

	it("refuses several Agent Vault projects by name", async () => {
		const run = await setup({ projects: ["Agents", "Ops"] });
		const result = await run.hoboCli.run(["ci", "fleet", "status", "--json"], {
			cwd: CWD,
		});
		expect(result.exitCode).not.toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.code).toBe("HOBO_AGENT_VAULT_PROJECT_AMBIGUOUS");
		expect(envelope.message).toContain('"Agents", "Ops"');
		expect(run.log).not.toContain("launch");
		hidesIds(result.stdout);
	});

	it("falls back to the credential refusal when no Agent Vault project is reachable", async () => {
		const run = await setup({ projects: [] });
		const result = await run.hoboCli.run(["ci", "fleet", "status", "--json"], {
			cwd: CWD,
		});
		const envelope = JSON.parse(result.stdout);
		expect(envelope.code).toBe("HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE");
		expect(envelope.message).toContain("Agent Vault");
		hidesIds(result.stdout);
	});
});
