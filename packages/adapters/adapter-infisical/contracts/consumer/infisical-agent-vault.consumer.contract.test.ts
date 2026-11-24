import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createInfisicalClient,
	type InfisicalAgentVaultApi,
	InfisicalError,
	parseInfisicalBinding,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const METHODS = ["GET", "POST"] as const;
const PROJECT = "00000000-0000-4000-8000-000000000001";
const PROXY = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const SESSION_TOKEN = "agv_fixture-session-token";

function isAddressInfo(
	value: string | AddressInfo | null,
): value is AddressInfo {
	return (
		value !== null &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}

let pact: PactDocument;
let api: InfisicalAgentVaultApi;
let close: () => void;
const seen: { request: PactRequest; matched: boolean }[] = [];

beforeAll(async () => {
	const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
	const found = pacts.find(
		(candidate) => candidate.provider.name === "InfisicalAgentVaultApi",
	);
	if (!found) throw new Error("the Infisical Agent Vault pact is missing");
	pact = found;
	const mock = createMockProviderFromPact(pact);
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", async () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const headers: Record<string, string> = {};
			for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2)
				headers[(incoming.rawHeaders[i] ?? "").toLowerCase()] =
					incoming.rawHeaders[i + 1] ?? "";
			const method = METHODS.find((candidate) => candidate === incoming.method);
			if (method === undefined) {
				outgoing.writeHead(405).end();
				return;
			}
			const request: PactRequest = raw
				? { method, path: incoming.url ?? "/", headers, body: JSON.parse(raw) }
				: { method, path: incoming.url ?? "/", headers };
			const response = await mock.handle(request);
			seen.push({
				request,
				matched: !JSON.stringify(response.body ?? "").includes(
					"PACT_NO_INTERACTION",
				),
			});
			outgoing.writeHead(response.status, response.headers);
			outgoing.end(
				response.body === undefined ? "" : JSON.stringify(response.body),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!isAddressInfo(address)) throw new Error("the pact mock has no port");
	const port = address.port;
	api = createInfisicalClient({
		binding: parseInfisicalBinding({
			siteUrl: `http://127.0.0.1:${port}`,
			projectId: "proj-1",
			environment: "prod",
			secretPath: "/hobo",
		}),
		auth: { method: "access-token", accessToken: "fixture-owner-access-token" },
		sleep: async () => undefined,
	}).agentVault();
	close = () => {
		server.closeAllConnections();
		server.close();
	};
});

afterAll(() => close());

function expectRecorded() {
	for (const { request, matched } of seen) {
		expect(matched, `${request.method} ${request.path}`).toBe(true);
		const interaction = pact.interactions.find(
			(candidate) =>
				candidate.request.method === request.method &&
				candidate.request.path === request.path,
		);
		for (const [name, value] of Object.entries(
			interaction?.request.headers ?? {},
		))
			expect(request.headers?.[name], `${request.path} ${name}`).toBe(value);
	}
	seen.length = 0;
}

describe("Infisical's Agent Vault API (consumer contract)", () => {
	it("names the broker as consumer", () => {
		expect(pact.consumer.name).toBe("HoboAgentVaultBroker");
	});

	it("finds the project, its services and proxies by name", async () => {
		expect(await api.listProjects()).toEqual([{ id: PROJECT, name: "Agents" }]);
		expect(await api.listServices(PROJECT)).toEqual([
			{ name: "hostinger", type: "http", hosts: ["developers.hostinger.com"] },
			{ name: "db", type: "postgres", hosts: [] },
		]);
		expect(await api.listProxies(PROJECT)).toEqual([]);
		expectRecorded();
	});

	it("registers and rotates the proxy, then reads its certificate authority", async () => {
		const created = await api.createProxy(PROJECT, "hobo");
		expect(created.proxy).toEqual({ id: PROXY, name: "hobo", healthy: false });
		expect(created.proxyToken).toBe("fixture-proxy-token");
		const rotated = await api.rotateProxyToken(PROXY);
		expect(rotated.proxyToken).toBe("fixture-rotated-proxy-token");
		const ca = await api.proxyCertificateAuthority(PROXY);
		expect(ca.fingerprint).toBe("AA:BB");
		expectRecorded();
	});

	it("starts, inspects and revokes a session", async () => {
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
		expect(await api.sessionServices(session.token)).toEqual([
			{
				name: "hostinger",
				type: "http",
				hosts: ["developers.hostinger.com"],
				credential: {
					type: "bearer",
					header: "Authorization",
					addedByProxy: true,
				},
				placeholders: [],
			},
		]);
		await api.revokeSession(session.id);
		expectRecorded();
	});

	it("reports a refusal by code alone", async () => {
		const other = "00000000-0000-4000-8000-000000000008";
		const error = await api.listProxies(other).catch((caught) => caught);
		expect(error).toBeInstanceOf(InfisicalError);
		expect(error).toMatchObject({ code: "forbidden", status: 403 });
		expect(String(error.message)).not.toContain(other);
		expectRecorded();
	});
});
