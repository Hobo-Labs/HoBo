import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { parseInfisicalBinding } from "@hobo/adapter-infisical";
import {
	createRelaySetupMcp,
	RELAY_SETUP_PROVIDE_TOOL,
	RELAY_SETUP_STATUS_TOOL,
	RelaySetupWriteError,
} from "@hobo/ci-gh-actions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createHttpEntry,
	RELAY_START_STATES,
	type RelaySetupHost,
	relaySetupGaps,
	relaySetupOrigin,
} from "../src/entry.js";
import { RelayRuntimeConfigError } from "../src/relay-runtime-config.js";
import {
	acceptRelaySetupValue,
	createInfisicalRelaySetupWriter,
	RELAY_SETUP_ENTRIES,
	restorePem,
} from "../src/relay-setup.js";

const ORIGIN = "https://relay.example";
const MISSING = ["HOBO_CI_CONFIG_JSON", "HOBO_CI_GITHUB_APP_PRIVATE_KEY"];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (closers.length) await closers.pop()?.();
	vi.restoreAllMocks();
});

function incomplete(): Promise<never> {
	return Promise.reject(
		new RelayRuntimeConfigError("invalid relay configuration", MISSING, {
			missing: MISSING,
			invalid: [],
		}),
	);
}

async function serve(entry: ReturnType<typeof createHttpEntry>) {
	const server = createServer(entry);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(
		() =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	);
	const { port } = z.object({ port: z.number() }).parse(server.address());
	return `http://127.0.0.1:${port}`;
}

const Events = z.object({ jsonrpc: z.literal("2.0"), result: z.json() });

async function rpc(
	base: string,
	method: string,
	params: Record<string, z.infer<ReturnType<typeof z.json>>>,
	session?: string,
) {
	const response = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2025-11-25",
			...(session === undefined ? undefined : { "Mcp-Session-Id": session }),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	const text = await response.text();
	const data = text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => line.slice("data: ".length));
	return {
		status: response.status,
		session: response.headers.get("mcp-session-id") ?? undefined,
		result: Events.parse(JSON.parse(data[0] ?? text)).result,
	};
}

function setupHost(): RelaySetupHost {
	const mcp = createRelaySetupMcp({
		publicOrigin: ORIGIN,
		gaps: () => relaySetupGaps(incomplete),
		entries: RELAY_SETUP_ENTRIES,
		accept: acceptRelaySetupValue,
		write: undefined,
	});
	closers.push(() => mcp.close());
	return { origin: ORIGIN, handle: mcp.handle };
}

describe("the relay's setup mode on the Vercel entry", () => {
	it("serves initialize, tools/list and the status while the folder is incomplete", async () => {
		const host = setupHost();
		const base = await serve(
			createHttpEntry(incomplete, { setup: () => host }),
		);
		const opened = await rpc(base, "initialize", {
			protocolVersion: "2025-11-25",
			capabilities: { elicitation: {} },
			clientInfo: { name: "claude-ai", version: "1" },
		});
		expect(opened.status).toBe(200);
		expect(opened.session).toBeDefined();
		const tools = await rpc(base, "tools/list", {}, opened.session);
		expect(JSON.stringify(tools.result)).toContain(RELAY_SETUP_PROVIDE_TOOL);
		const status = await rpc(
			base,
			"tools/call",
			{ name: RELAY_SETUP_STATUS_TOOL, arguments: {} },
			opened.session,
		);
		expect(
			z
				.object({ structuredContent: z.record(z.string(), z.json()) })
				.parse(status.result).structuredContent,
		).toEqual({
			state: RELAY_START_STATES.notConfigured,
			missing: MISSING,
			invalid: [],
			providable: MISSING,
			writable: false,
		});
	});

	it("keeps /readyz and CI routes fail-closed and answers OAuth discovery with 404", async () => {
		const host = setupHost();
		const base = await serve(
			createHttpEntry(incomplete, { setup: () => host }),
		);
		const ready = await fetch(`${base}/readyz`);
		expect(ready.status).toBe(503);
		expect(await ready.json()).toMatchObject({
			ready: false,
			state: RELAY_START_STATES.notConfigured,
		});
		expect(
			(await fetch(`${base}/github/webhooks`, { method: "POST" })).status,
		).toBe(503);
		expect((await fetch(`${base}/v1/accounts/self/leases`)).status).toBe(503);
		expect(
			(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status,
		).toBe(404);
	});

	it("answers 503 at /mcp when there is no setup host, and leaves a configured relay untouched", async () => {
		const closed = await serve(
			createHttpEntry(incomplete, { setup: () => undefined }),
		);
		expect((await fetch(`${closed}/mcp`, { method: "POST" })).status).toBe(503);
		const setup = vi.fn((): RelaySetupHost | undefined => undefined);
		const configured = await serve(
			createHttpEntry(
				async () => ({
					origin: ORIGIN,
					handle: async (request: Request) =>
						new Response(`relay ${new URL(request.url).pathname}`),
				}),
				{ setup },
			),
		);
		expect(
			await (await fetch(`${configured}/mcp`, { method: "POST" })).text(),
		).toBe("relay /mcp");
		expect(setup).not.toHaveBeenCalled();
	});

	it("reports a configured relay and reads its origin from the production URL", async () => {
		expect(await relaySetupGaps(async () => "ready")).toEqual({
			state: "configured",
			missing: [],
			invalid: [],
		});
		expect(
			relaySetupOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "hobo-ci.vercel.app" }),
		).toBe("https://hobo-ci.vercel.app");
		expect(
			relaySetupOrigin({ VERCEL_PROJECT_PRODUCTION_URL: "a/b" }),
		).toBeUndefined();
		expect(relaySetupOrigin({})).toBeUndefined();
	});
});

describe("what setup mode accepts", () => {
	it("offers every non-derived relay entry, the derived keys never", () => {
		const names = RELAY_SETUP_ENTRIES.map((entry) => entry.name);
		expect(names).toContain("HOBO_CI_CONFIG_JSON");
		expect(names).toContain("HOBO_CI_GITHUB_APP_PRIVATE_KEY");
		for (const derived of [
			"HOBO_CI_SESSION_KEY",
			"CRON_SECRET",
			"HOBO_CI_SANDBOX_PROXY_TOKEN_KEY",
		])
			expect(names).not.toContain(derived);
		expect(
			acceptRelaySetupValue("CRON_SECRET", "x".repeat(40)),
		).toBeUndefined();
	});

	it("restores a private key whose line breaks were lost, and refuses what the loader refuses", () => {
		const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
			.privateKey.export({ type: "pkcs8", format: "pem" })
			.toString();
		const pasted = pem.replace(/\n/gu, " ");
		expect(restorePem(pasted)).toBe(pem);
		expect(
			acceptRelaySetupValue("HOBO_CI_GITHUB_APP_PRIVATE_KEY", pasted),
		).toBe(pem);
		expect(
			acceptRelaySetupValue("HOBO_CI_GITHUB_APP_PRIVATE_KEY", "not a key"),
		).toBeUndefined();
		expect(
			acceptRelaySetupValue("HOBO_CI_PUBLIC_URL", " https://relay.example "),
		).toBe("https://relay.example");
		expect(
			acceptRelaySetupValue("HOBO_CI_PUBLIC_URL", "http://relay.example/x"),
		).toBeUndefined();
		expect(acceptRelaySetupValue("NOT_A_RELAY_KEY", "x")).toBeUndefined();
	});
});

describe("the setup writer", () => {
	const binding = parseInfisicalBinding({
		siteUrl: "https://store.example",
		projectId: "fixture-project",
		environment: "prod",
		secretPath: "/hobo-ci-relay",
	});
	const CLIENT_SECRET = "one-use-writer-secret-sentinel-3c9d";
	const VALUE = "config-value-sentinel-81aa";

	function fakeStore(loginStatus: number) {
		const calls: Array<{ method: string; path: string; body: string }> = [];
		const send = vi.fn<typeof fetch>(async (url, init) => {
			const path = new URL(String(url)).pathname;
			calls.push({
				method: init?.method ?? "GET",
				path,
				body: String(init?.body ?? ""),
			});
			if (path === "/api/v1/auth/universal-auth/login")
				return loginStatus === 200
					? Response.json({
							accessToken: "fixture-access-token-0123456789",
							expiresIn: 600,
							accessTokenMaxTTL: 600,
							tokenType: "Bearer",
						})
					: Response.json(
							{ message: "Invalid credentials" },
							{ status: loginStatus },
						);
			if (path === "/api/v1/auth/token/revoke") return Response.json({});
			const key = decodeURIComponent(path.slice("/api/v4/secrets/".length));
			return Response.json({ secret: { secretKey: key, version: 1 } });
		});
		return { calls, send };
	}

	it("signs in once as the writer, writes each entry to the relay's folder and revokes the token", async () => {
		const { calls, send } = fakeStore(200);
		await createInfisicalRelaySetupWriter(binding, { fetch: send })(
			{ clientId: "writer-client", clientSecret: CLIENT_SECRET },
			new Map([["HOBO_CI_CONFIG_JSON", VALUE]]),
		);
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"POST /api/v1/auth/universal-auth/login",
			"PATCH /api/v4/secrets/HOBO_CI_CONFIG_JSON",
			"POST /api/v1/auth/token/revoke",
		]);
		expect(calls[1]?.body).toContain("/hobo-ci-relay");
	});

	it("reports a refused writer by code, never by value, and writes nothing", async () => {
		const { calls, send } = fakeStore(401);
		const error = await createInfisicalRelaySetupWriter(binding, {
			fetch: send,
		})(
			{ clientId: "writer-client", clientSecret: CLIENT_SECRET },
			new Map([["HOBO_CI_CONFIG_JSON", VALUE]]),
		).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(RelaySetupWriteError);
		expect(error).toMatchObject({ code: "writer-refused" });
		const rendered = `${error?.message} ${error?.stack} ${JSON.stringify(error)}`;
		expect(rendered).not.toContain(CLIENT_SECRET);
		expect(rendered).not.toContain(VALUE);
		expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
	});
});
