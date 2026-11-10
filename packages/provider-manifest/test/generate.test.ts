import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JsonObject } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	generateApiClient,
	generateCodeModeServer,
	generateMcpClientConfig,
	operationSignature,
	type ParsedApiSpec,
	parseOpenApi,
} from "../src/index.js";
import { example } from "./support/example.js";

const SPEC_TEXT = readFileSync(
	fileURLToPath(new URL("../examples/petstore.openapi.yaml", import.meta.url)),
	"utf8",
);

function spec(): ParsedApiSpec {
	const parsed = parseOpenApi(SPEC_TEXT);
	if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
	return parsed.api;
}

function issues(source: string): string[] {
	const parsed = parseOpenApi(source);
	return parsed.ok ? [] : parsed.issues.map((i) => `${i.path}: ${i.message}`);
}

type Seen = {
	method: string;
	url: string;
	authorization: string;
	trace: string;
	body: string;
};

// A stand-in for the provider's API: records what it was sent.
const seen: Seen[] = [];
let api: Server;
let baseUrl = "";

beforeAll(async () => {
	api = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			seen.push({
				method: request.method ?? "",
				url: request.url ?? "",
				authorization: String(request.headers.authorization ?? ""),
				trace: String(request.headers["x-trace-id"] ?? ""),
				body,
			});
			const missing = request.url?.startsWith("/v1/pets/404");
			response.writeHead(missing ? 404 : 200, {
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify(
					missing
						? { error: "no such pet" }
						: { id: 7, name: "Rex", path: request.url },
				),
			);
		});
	});
	await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
	// SAFETY: a listening TCP server's address is an AddressInfo.
	baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/v1`;
});

afterAll(() => {
	api.close();
});

describe("parseOpenApi", () => {
	it("reads operations, merged parameters, and body requirements", () => {
		const parsed = spec();
		expect(parsed.title).toBe("Acme Pets");
		expect(parsed.baseUrl).toBe("https://api.acme-cloud.example.com/v1");
		expect(parsed.operations.map(operationSignature)).toEqual([
			"api.listPets({ limit?, tag? })",
			"api.createPet({ body })",
			"api.getPet({ petId, X-Trace-Id? })",
			// No operationId: named from the method and path.
			"api.deletePetsPetId({ petId, X-Trace-Id? })",
		]);
	});

	it("accepts JSON as well as YAML", () => {
		expect(
			issues(
				JSON.stringify({
					openapi: "3.1.0",
					info: { title: "T", version: "1" },
					paths: { "/x": { get: { responses: {} } } },
				}),
			),
		).toEqual([]);
	});

	it.each([
		[
			"Swagger 2",
			'swagger: "2.0"\npaths: { /x: { get: {} } }',
			"only OpenAPI 3.0 and 3.1",
		],
		[
			"a spec with no operations",
			"openapi: 3.0.0\npaths: {}",
			"declares no operations",
		],
		[
			"duplicate operation ids",
			"openapi: 3.0.0\npaths:\n  /a: { get: { operationId: x } }\n  /b: { get: { operationId: x } }",
			'operation id "x" is not unique',
		],
		[
			"an unresolvable parameter ref",
			'openapi: 3.0.0\npaths:\n  /a:\n    get:\n      parameters: [{ $ref: "other.yaml#/Limit" }]',
			"only local #/components/parameters refs are supported",
		],
		[
			"a path parameter missing from the path",
			"openapi: 3.0.0\npaths:\n  /a:\n    get:\n      parameters: [{ name: id, in: path }]",
			'path parameter "id" does not appear in the path',
		],
		["a non-object document", "- just\n- a list", "must be an object"],
		["malformed YAML", "paths: [unterminated", ""],
	])("refuses %s", (_name, source, fragment) => {
		expect(issues(source).join("\n")).toContain(fragment);
		expect(issues(source)).not.toEqual([]);
	});
});

describe("generateApiClient", () => {
	it("emits a client that performs the declared requests", async () => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-client-"));
		const file = join(dir, "pets.client.ts");
		writeFileSync(file, generateApiClient(spec()));
		const { createClient } = await import(pathToFileURL(file).href);
		const client = createClient({
			baseUrl,
			headers: { authorization: "Bearer t0ken" },
		});
		seen.length = 0;

		expect(await client.getPet({ petId: "a/b", "X-Trace-Id": "t-1" })).toEqual({
			id: 7,
			name: "Rex",
			path: "/v1/pets/a%2Fb",
		});
		await client.listPets({ limit: 5 });
		await client.createPet({ body: { name: "Rex" } });

		expect(seen).toEqual([
			{
				method: "GET",
				url: "/v1/pets/a%2Fb",
				authorization: "Bearer t0ken",
				trace: "t-1",
				body: "",
			},
			{
				method: "GET",
				url: "/v1/pets?limit=5",
				authorization: "Bearer t0ken",
				trace: "",
				body: "",
			},
			{
				method: "POST",
				url: "/v1/pets",
				authorization: "Bearer t0ken",
				trace: "",
				body: '{"name":"Rex"}',
			},
		]);
		await expect(client.getPet({ petId: 404 })).rejects.toMatchObject({
			status: 404,
			body: { error: "no such pet" },
		});
	});

	it("is deterministic", () => {
		expect(generateApiClient(spec())).toBe(generateApiClient(spec()));
	});
});

// Drive the generated server exactly as an MCP client would: over stdio.
describe("generateCodeModeServer", () => {
	let server: ChildProcess;
	type RpcReply = {
		readonly id: number;
		readonly result?: {
			readonly content?: readonly { readonly text: string }[];
			readonly isError?: boolean;
			readonly tools?: readonly { readonly name: string }[];
			readonly serverInfo?: { readonly name: string };
		};
		readonly error?: { readonly code: number; readonly message: string };
	};
	const replies = new Map<number, (message: RpcReply) => void>();
	let nextId = 0;

	function rpc(method: string, params: JsonObject = {}) {
		const id = ++nextId;
		return new Promise<RpcReply>((resolve) => {
			replies.set(id, resolve);
			server.stdin?.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
			);
		});
	}

	async function execute(code: string) {
		const reply = await rpc("tools/call", {
			name: "execute",
			arguments: { code },
		});
		return {
			text: reply.result?.content?.[0]?.text ?? "",
			isError: reply.result?.isError === true,
		};
	}

	beforeAll(() => {
		const dir = mkdtempSync(join(tmpdir(), "provider-manifest-mcp-"));
		const file = join(dir, "pets.mcp-server.mjs");
		writeFileSync(file, generateCodeModeServer("pets", spec()));
		server = spawn(process.execPath, [file], {
			env: {
				PATH: process.env.PATH ?? "",
				API_BASE_URL: baseUrl,
				API_TOKEN: "s3cret",
				CODE_TIMEOUT_MS: "4000",
			},
			stdio: ["pipe", "pipe", "inherit"],
		});
		if (server.stdout === null) throw new Error("server has no stdout");
		createInterface({ input: server.stdout }).on("line", (line) => {
			// SAFETY: the server under test writes one JSON-RPC reply per line.
			const message = JSON.parse(line) as RpcReply;
			replies.get(message.id)?.(message);
		});
	});

	afterAll(() => {
		server.kill();
	});

	it("completes the MCP handshake and lists two tools", async () => {
		const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
		expect(init.result?.serverInfo?.name).toBe("pets-code-mode");
		const tools = await rpc("tools/list");
		expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([
			"search",
			"execute",
		]);
		expect((await rpc("no/such")).error?.code).toBe(-32601);
	});

	it("search returns call signatures", async () => {
		const reply = await rpc("tools/call", {
			name: "search",
			arguments: { query: "fetch pet" },
		});
		expect(reply.result?.content?.[0]?.text).toBe(
			"api.getPet({ petId, X-Trace-Id? }) — GET /pets/{petId} — Fetch one pet",
		);
	});

	it("execute chains API calls in one round trip, authenticated by the parent", async () => {
		seen.length = 0;
		const { text, isError } = await execute(`
			const created = await api.createPet({ body: { name: "Rex" } });
			const pet = await api.getPet({ petId: created.body.id });
			return { status: pet.status, name: pet.body.name, path: pet.body.path };
		`);
		expect(isError).toBe(false);
		expect(JSON.parse(text)).toEqual({
			status: 200,
			name: "Rex",
			path: "/v1/pets/7",
		});
		expect(seen.map((s) => [s.method, s.url, s.authorization])).toEqual([
			["POST", "/v1/pets", "Bearer s3cret"],
			["GET", "/v1/pets/7", "Bearer s3cret"],
		]);
	});

	it("keeps the credential and the environment out of model code", async () => {
		const { text } = await execute(
			"return { env: Object.keys(process.env), token: process.env.API_TOKEN ?? null };",
		);
		expect(JSON.parse(text)).toEqual({ env: [], token: null });
	});

	it("denies model code the filesystem and child processes", async () => {
		const fs = await execute(
			"return process.getBuiltinModule('node:fs').readdirSync('.');",
		);
		expect(fs.isError).toBe(true);
		const child = await execute(
			"return process.getBuiltinModule('node:child_process').execSync('id').toString();",
		);
		expect(child.isError).toBe(true);
	});

	it("reports thrown errors, bad arguments, and runaway code as tool errors", async () => {
		expect(await execute("throw new Error('boom')")).toEqual({
			text: "boom",
			isError: true,
		});
		expect((await execute("return api.getPet({})")).text).toBe(
			"getPet requires petId",
		);
		const runaway = await execute("while (true) {}");
		expect(runaway).toEqual({ text: "timed out after 4000ms", isError: true });
	}, 15_000);
});

describe("generateMcpClientConfig", () => {
	it("points at a generated server when the provider runs none", () => {
		expect(
			generateMcpClientConfig(example().api, { pets: "pets.mcp-server.mjs" }),
		).toEqual({
			mcpServers: {
				pets: { command: "node", args: ["./pets.mcp-server.mjs"] },
			},
		});
	});
});
