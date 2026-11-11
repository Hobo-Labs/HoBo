import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPactInventory,
	createMockProviderFromPact,
	loadPactDirectory,
	type PactDocument,
	type PactRequest,
} from "@hobo/contract-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createInfisicalClient,
	type InfisicalAuth,
	InfisicalError,
	oidcAuth,
	parseInfisicalBinding,
} from "../../src/index.js";

const contractsDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const JWT = "fixture-header.fixture-payload.fixture-signature";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

let pact: PactDocument;
let url: string;
let close: () => void;
const seen: { request: PactRequest; matched: boolean }[] = [];

beforeAll(async () => {
	const pacts = await loadPactDirectory(path.join(contractsDir, "pacts"));
	const found = pacts.find((p) => p.provider.name === "InfisicalApi");
	if (!found) throw new Error("the Infisical pact is missing");
	pact = found;
	const mock = createMockProviderFromPact(pact);
	const server = createServer((incoming, outgoing) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", async () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const headers: Record<string, string> = {};
			// rawHeaders alternates names and values, all strings.
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
			const matched = !JSON.stringify(response.body ?? "").includes(
				"PACT_NO_INTERACTION",
			);
			seen.push({ request, matched });
			outgoing.writeHead(response.status, response.headers);
			outgoing.end(
				response.body === undefined ? "" : JSON.stringify(response.body),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: a server listening on a TCP port reports an AddressInfo.
	const address = server.address() as AddressInfo;
	url = `http://127.0.0.1:${address.port}`;
	close = () => {
		server.closeAllConnections();
		server.close();
	};
});

afterAll(() => close());

function client(
	secretPath = "/hobo-ci-relay",
	auth: InfisicalAuth = oidcAuth({
		identityId: "relay-identity",
		jwt: async () => JWT,
	}),
) {
	return createInfisicalClient({
		binding: parseInfisicalBinding({
			siteUrl: url,
			projectId: "proj-1",
			environment: "prod",
			secretPath,
		}),
		auth,
		sleep: async () => {},
		retry: { attempts: 2 },
	});
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof InfisicalError) return error.code;
		throw error;
	}
	return "ok";
}

/** Every request the adapter made is one the pact records, with its headers. */
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

describe("the Infisical API (consumer contract)", () => {
	it("names the adapter as consumer and Infisical's API as provider", () => {
		expect(pact.consumer.name).toBe("HoboInfisicalAdapter");
		expect(pact.provider.name).toBe("InfisicalApi");
	});

	it("logs in with OIDC and reads the folder, a secret and the names", async () => {
		const c = client();
		const secrets = await c.listSecrets();
		expect(secrets).toEqual([
			{
				secretKey: "HOBO_CI_PUBLIC_URL",
				value: "https://ci.example.com",
				version: 1,
			},
		]);
		expect(await c.getSecret("HOBO_CI_PUBLIC_URL")).toMatchObject({
			value: "https://ci.example.com",
		});
		expect(await c.listSecretNames()).toEqual([
			{ secretKey: "HOBO_CI_PUBLIC_URL", version: 1 },
		]);
		expect(await codeOf(c.getSecret("MISSING"))).toBe("not-found");
		expectRecorded();
	});

	it("updates, creates after a 404, and maps a 403", async () => {
		const c = client();
		expect(await c.putSecret("HOBO_CI_GITHUB_APP_ID", "123456")).toEqual({
			version: 2,
		});
		expect(
			await c.putSecret("HOBO_CI_WEBHOOK_SECRET", "fixture-webhook-value"),
		).toEqual({ version: 1 });
		expect(await codeOf(c.putSecret("READ_ONLY_DENIED", "fixture-value"))).toBe(
			"forbidden",
		);
		expectRecorded();
	});

	it("maps a refused login, 429 and 503", async () => {
		expect(
			await codeOf(
				client(
					"/hobo-ci-relay",
					oidcAuth({ identityId: "unknown-identity", jwt: async () => JWT }),
				).listSecrets(),
			),
		).toBe("login-denied");
		expect(await codeOf(client("/rate-limited").listSecrets())).toBe(
			"rate-limited",
		);
		expect(await codeOf(client("/unavailable").listSecrets())).toBe(
			"unavailable",
		);
		expectRecorded();
	});

	it("signs in with Universal Auth for an owner's machine", async () => {
		const c = client("/hobo-ci-relay", {
			method: "universal-auth",
			clientId: "owner-client",
			clientSecret: "fixture-client-secret",
		});
		await c.listSecrets();
		expect(seen[0]?.request.path).toBe("/api/v1/auth/universal-auth/login");
		expect(seen[1]?.request.headers?.authorization).toBe(
			"Bearer fixture-owner-token",
		);
		expect(seen.every((entry) => entry.matched)).toBe(true);
		seen.length = 0;
	});

	it("records no token or JWT in a request the pact keeps as a path", () => {
		for (const interaction of pact.interactions)
			expect(interaction.request.path).not.toMatch(/token|jwt|Bearer/iu);
	});

	it("lists the pact in the inventory", async () => {
		expect(await checkPactInventory(contractsDir)).toEqual({
			ok: true,
			problems: [],
		});
	});
});
