import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type CapturePublicKey,
	createHoboMcpServer,
	createSecretCaptureApp,
	SECRET_CAPTURE_SEAL_SOURCE,
} from "@hobo/mcp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComposedHoboCli } from "../src/cli.js";
import type { JsonObject } from "../src/json.js";
import {
	createInfisicalCaptureConnector,
	RELAY_SECRET_CAPTURE_SPECS,
	secretCaptureProjectDir,
	WRITER_SECRET_NAME,
} from "../src/mcp-secret-capture.js";
import {
	createMcpStdioSession,
	handleMcpMessage,
	type JsonRpcResponse,
	localOperatorAuth,
} from "../src/mcp-stdio.js";

// The relay's secret capture end to end over the hobo-mcp JSON-RPC surface:
// a host that negotiated MCP Apps, the capture form's own sealing source, the
// connector against a fake Infisical (fetch-level), and the committed binding
// in a temporary relay project. Nothing here contacts Infisical.

const WRITER_CLIENT = "writer-client";
const WRITER_SECRET = `writer-one-use-${randomBytes(12).toString("hex")}`;
const ACCESS_TOKEN = `fake-at-${randomBytes(12).toString("hex")}`;

type Seal = (
	subtle: SubtleCrypto,
	key: CapturePublicKey,
	value: string,
	ticketId: string,
	aad: string,
) => Promise<{ epk: CapturePublicKey; iv: string; ciphertext: string }>;
// SAFETY: the shipped page source defines exactly this function signature.
const hoboSeal = new Function(
	`return (${SECRET_CAPTURE_SEAL_SOURCE})`,
)() as Seal;

/** Infisical, as far as the writer session uses it. */
function fakeInfisical() {
	let usesLeft = 1;
	const live = new Set<string>();
	const stored = new Map<string, string>();
	const requests: { method: string; path: string; authorized: boolean }[] = [];
	const json = (status: number, body: JsonObject) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
		requests.push({
			method,
			path: url.pathname,
			authorized: headers.has("authorization"),
		});
		if (url.pathname === "/api/v1/auth/universal-auth/login") {
			if (
				usesLeft <= 0 ||
				body.clientId !== WRITER_CLIENT ||
				body.clientSecret !== WRITER_SECRET
			)
				return json(401, { statusCode: 401, reqId: "req-1" });
			usesLeft--;
			live.add(ACCESS_TOKEN);
			return json(200, {
				accessToken: ACCESS_TOKEN,
				expiresIn: 600,
				accessTokenMaxTTL: 600,
				tokenType: "Bearer",
			});
		}
		if (url.pathname === "/api/v1/auth/token/revoke") {
			live.delete(body.accessToken);
			return json(200, { message: "Successfully revoked access token" });
		}
		const token = headers.get("authorization")?.replace(/^Bearer /u, "");
		if (token === undefined || !live.has(token))
			return json(401, { statusCode: 401 });
		if (!url.pathname.startsWith("/api/v4/secrets/") || method === "GET")
			return json(403, { statusCode: 403 });
		const name = decodeURIComponent(
			url.pathname.slice("/api/v4/secrets/".length),
		);
		const key = `${body.projectId}|${body.secretPath}|${name}`;
		if (method === "PATCH" && !stored.has(key))
			return json(404, { statusCode: 404 });
		stored.set(key, body.secretValue);
		return json(200, {
			secret: {
				secretKey: name,
				secretValue: "<hidden>",
				version: 1,
				type: "shared",
			},
		});
	};
	return { fetcher, stored, requests, live };
}

let projectDir: string;
let emptyDir: string;

beforeAll(() => {
	projectDir = mkdtempSync(path.join(tmpdir(), "hobo-capture-"));
	emptyDir = mkdtempSync(path.join(tmpdir(), "hobo-capture-empty-"));
	mkdirSync(path.join(projectDir, "deploy"));
	writeFileSync(
		path.join(projectDir, "deploy", "secret-store.binding.json"),
		`${JSON.stringify(
			{
				kind: "infisical-cloud-attach",
				endpoint: "https://infisical.test",
				projectId: "proj-1",
				environment: "prod",
				secretPath: "/hobo-ci-relay",
				relayIdentityId: "relay-identity",
				deployIdentityId: "deploy-identity",
				claimBundleId: "secret-store:hobo-ci-relay:1",
				deployProjectId: "proj-deploy",
				claimState: "claimed",
			},
			null,
			"\t",
		)}\n`,
	);
});

afterAll(() => {
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(emptyDir, { recursive: true, force: true });
});

const APPS_CLIENT = {
	extensions: {
		"io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
	},
};

function harness(dir: string) {
	const infisical = fakeInfisical();
	const capture = createSecretCaptureApp({
		specs: RELAY_SECRET_CAPTURE_SPECS,
		connector: createInfisicalCaptureConnector({
			projectDir: dir,
			fetch: infisical.fetcher,
		}),
	});
	const session = createMcpStdioSession(capture);
	const server = createHoboMcpServer({ cli: createComposedHoboCli() });
	const auth = localOperatorAuth({});
	const transcript: string[] = [];
	let id = 0;
	async function rpc(
		method: string,
		params?: JsonObject,
	): Promise<JsonRpcResponse> {
		id += 1;
		const response = await handleMcpMessage(
			server,
			auth,
			JSON.stringify({ jsonrpc: "2.0", id, method, params }),
			session,
		);
		if (response === null) throw new Error("expected a response");
		transcript.push(JSON.stringify(response));
		return response;
	}
	async function call(name: string, args: JsonObject) {
		const response = await rpc("tools/call", { name, arguments: args });
		// The result is JSON: a round trip reads it as a CallToolResult.
		const result: {
			structuredContent: {
				ticketId: string;
				name: string;
				key: CapturePublicKey;
				code?: string;
				nextStep?: string;
			};
			isError: boolean;
		} = JSON.parse(JSON.stringify(response.result ?? null));
		return result;
	}
	async function seal(
		ticket: { ticketId: string; name: string; key: CapturePublicKey },
		value: string,
	) {
		const sealed = await hoboSeal(
			globalThis.crypto.subtle,
			ticket.key,
			value,
			ticket.ticketId,
			`${ticket.ticketId}:${ticket.name}`,
		);
		return { ticketId: ticket.ticketId, ...sealed };
	}
	return { infisical, capture, rpc, call, seal, transcript };
}

describe("hobo-mcp secret capture into Infisical (MCP App channel)", () => {
	it("authorizes a one-use writer, stores the optional cache credentials, revokes, and never echoes a value", async () => {
		const h = harness(projectDir);
		const init = await h.rpc("initialize", {
			protocolVersion: "2025-11-25",
			capabilities: APPS_CLIENT,
		});
		expect(init.result).toMatchObject({
			capabilities: { tools: {}, resources: {} },
		});
		// SAFETY: test-side read of the tools/list result.
		const tools = (await h.rpc("tools/list")).result as {
			tools: { name: string; _meta?: unknown }[];
		};
		expect(
			tools.tools.find((tool) => tool.name === "capture_secret")?._meta,
		).toMatchObject({
			ui: { resourceUri: "ui://hobo/secret-capture" },
		});
		expect(
			tools.tools.find((tool) => tool.name === "submit_secret_value")?._meta,
		).toEqual({
			ui: { resourceUri: "ui://hobo/secret-capture", visibility: ["app"] },
		});
		expect(
			(await h.rpc("resources/read", { uri: "ui://hobo/secret-capture" }))
				.result,
		).toMatchObject({ contents: [{ mimeType: "text/html;profile=mcp-app" }] });

		// No writer session yet: the deploy token cannot be captured.
		expect(
			(await h.call("capture_secret", { name: "TURSO_AUTH_TOKEN" }))
				.structuredContent,
		).toMatchObject({ code: "SECRET_STORE_WRITER_REQUIRED" });

		const writer = (
			await h.call("capture_secret", {
				name: WRITER_SECRET_NAME,
				writerClientId: WRITER_CLIENT,
			})
		).structuredContent;
		const authorized = await h.call("submit_secret_value", {
			ticketId: writer.ticketId,
			sealed: await h.seal(writer, WRITER_SECRET),
		});
		expect(authorized.structuredContent).toEqual({
			ticketId: writer.ticketId,
			name: WRITER_SECRET_NAME,
			stored: false,
			ref: `hobo-writer-session://${WRITER_CLIENT}`,
			status: "authorized",
		});

		const valkey = `rediss://default:${randomBytes(24).toString("hex")}@valkey.example.com:6380`;
		const turso = `turso-${randomBytes(16).toString("hex")}`;
		for (const [name, value] of [
			["VALKEY_URL", valkey],
			["TURSO_AUTH_TOKEN", turso],
		] as const) {
			const ticket = (await h.call("capture_secret", { name }))
				.structuredContent;
			const receipt = await h.call("submit_secret_value", {
				ticketId: ticket.ticketId,
				sealed: await h.seal(ticket, value),
			});
			expect(receipt.isError).toBe(false);
		}
		expect(h.infisical.stored.get("proj-1|/hobo-ci-relay|VALKEY_URL")).toBe(
			valkey,
		);
		expect(
			h.infisical.stored.get("proj-1|/hobo-ci-relay|TURSO_AUTH_TOKEN"),
		).toBe(turso);
		// One login, spent; the writer credential itself was never written anywhere.
		expect(
			h.infisical.requests.filter((r) => r.path.endsWith("/login")).length,
		).toBe(1);
		expect([...h.infisical.stored.keys()].join()).not.toContain(
			WRITER_SECRET_NAME,
		);

		const end = await h.call("end_secret_capture", {});
		expect(end.structuredContent).toEqual({
			closedCaptures: 0,
			writerSession: "ended",
		});
		expect(h.infisical.live.size).toBe(0);
		const revoke = h.infisical.requests.find(
			(r) => r.path === "/api/v1/auth/token/revoke",
		);
		expect(revoke?.authorized).toBe(false);

		const transcript = h.transcript.join("\n");
		for (const secret of [valkey, turso, WRITER_SECRET, ACCESS_TOKEN])
			expect(transcript).not.toContain(secret);
		expect(transcript).toContain(
			"infisical://proj-1/prod/hobo-ci-relay/VALKEY_URL",
		);
		await h.capture.close();
	});

	it("refuses a wrong writer credential by code, without the value", async () => {
		const h = harness(projectDir);
		await h.rpc("initialize", { capabilities: APPS_CLIENT });
		const wrong = `wrong-writer-${randomBytes(12).toString("hex")}`;
		const writer = (
			await h.call("capture_secret", {
				name: WRITER_SECRET_NAME,
				writerClientId: WRITER_CLIENT,
			})
		).structuredContent;
		const refused = await h.call("submit_secret_value", {
			ticketId: writer.ticketId,
			sealed: await h.seal(writer, wrong),
		});
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent).toMatchObject({
			code: "SECRET_STORE_WRITER_DENIED",
		});
		expect(h.transcript.join("\n")).not.toContain(wrong);
		await h.capture.close();
	});
});

describe("hobo-mcp secret capture without a store or without MCP Apps", () => {
	it("refuses when the relay project has no binding, and points at the Infisical walkthrough", async () => {
		const h = harness(emptyDir);
		await h.rpc("initialize", { capabilities: APPS_CLIENT });
		const refused = await h.call("capture_secret", {
			name: "VALKEY_URL",
		});
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent).toMatchObject({
			code: "SECRET_STORE_NOT_CONNECTED",
		});
		expect(String(refused.structuredContent.nextStep)).toContain(
			"hobo-deploy skill",
		);
		await h.capture.close();
	});

	it("answers a URL-elicitation client with -32042 naming a loopback page", async () => {
		const h = harness(projectDir);
		await h.rpc("initialize", { capabilities: { elicitation: { url: {} } } });
		// SAFETY: test-side read of the tools/list result.
		const listed = (await h.rpc("tools/list")).result as {
			tools: { name: string }[];
		};
		expect(listed.tools.map((tool) => tool.name)).not.toContain(
			"submit_secret_value",
		);
		const writer = await h.rpc("tools/call", {
			name: "capture_secret",
			arguments: { name: WRITER_SECRET_NAME, writerClientId: WRITER_CLIENT },
		});
		expect(writer.error?.code).toBe(-32042);
		expect(JSON.stringify(writer.error?.data)).toMatch(
			/"url":"http:\/\/127\.0\.0\.1:\d+\/capture\/cap_/u,
		);
		await h.capture.close();
	});

	it("leaves the capture tools out of a scope restricted to other verbs", () => {
		const auth = localOperatorAuth({ HOBO_MCP_TOOLS: "plan" });
		expect(auth.scope.map((entry) => entry.resource)).toEqual(["tool:plan"]);
		const full = localOperatorAuth({});
		expect(full.scope.map((entry) => entry.resource)).toContain(
			"tool:capture_secret",
		);
	});

	it("finds the relay project from the checkout root, or as named", () => {
		expect(secretCaptureProjectDir(emptyDir, {})).toBe(emptyDir);
		expect(
			secretCaptureProjectDir(emptyDir, { HOBO_SECRET_STORE_PROJECT: "relay" }),
		).toBe(path.join(emptyDir, "relay"));
	});
});
