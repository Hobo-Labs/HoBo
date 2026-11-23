import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	type ElicitRequest,
	ElicitRequestSchema,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createRelaySetupMcp,
	RELAY_SETUP_PROVIDE_TOOL,
	RELAY_SETUP_STATUS_TOOL,
	RELAY_SETUP_WRITER_CLIENT_ID,
	RELAY_SETUP_WRITER_CLIENT_SECRET,
	type RelaySetupGaps,
	type RelaySetupMcpOptions,
	RelaySetupWriteError,
	type RelaySetupWriterCredential,
} from "../src/relay-setup-mcp.js";

const ORIGIN = "https://relay.example.test";
const WRITER_SECRET = "writer-one-use-secret-sentinel-7f3a";
const WRITER_ID = "writer-client-id-sentinel-91c2";
const APP_ID_VALUE = "123456";
const CONFIG_VALUE = '{"sentinel":"config-document-value-4b8e"}';
const BAD_URL_VALUE = "http://not-an-origin-sentinel-55d1/path";

const INCOMPLETE: RelaySetupGaps = {
	state: "not-configured",
	missing: [
		"HOBO_CI_GITHUB_APP_ID",
		"HOBO_CI_CONFIG_JSON",
		"HOBO_CI_PUBLIC_URL",
	],
	invalid: [],
};

const Text = z.object({
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	structuredContent: z.record(z.string(), z.json()).optional(),
	isError: z.boolean().optional(),
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (closers.length) await closers.pop()?.();
	vi.restoreAllMocks();
});

type Written = {
	credential: RelaySetupWriterCredential;
	entries: Map<string, string>;
};

function harness(overrides: Partial<RelaySetupMcpOptions> = {}) {
	const writes: Written[] = [];
	const setup = createRelaySetupMcp({
		publicOrigin: ORIGIN,
		gaps: async () => INCOMPLETE,
		entries: [
			{ name: "HOBO_CI_GITHUB_APP_ID", title: "App id", description: "digits" },
			{ name: "HOBO_CI_CONFIG_JSON", title: "Config", description: "json" },
			{ name: "HOBO_CI_PUBLIC_URL", title: "Origin", description: "https" },
		],
		accept: (name, value) =>
			name === "HOBO_CI_PUBLIC_URL" && !value.startsWith("https://")
				? undefined
				: value,
		write: async (credential, entries) => {
			writes.push({ credential, entries: new Map(entries) });
		},
		...overrides,
	});
	closers.push(() => setup.close());
	async function connect(
		answer?: (request: ElicitRequest) => ElicitResult,
		headers: Record<string, string> = {},
	) {
		const client = new Client(
			{ name: "relay-setup-test", version: "1.0.0" },
			answer === undefined
				? { capabilities: {} }
				: { capabilities: { elicitation: { form: {} } } },
		);
		const asked: ElicitRequest[] = [];
		if (answer !== undefined)
			client.setRequestHandler(ElicitRequestSchema, async (request) => {
				asked.push(request);
				return answer(request);
			});
		const transport = new StreamableHTTPClientTransport(
			new URL("/mcp", ORIGIN),
			{
				fetch: (url, init) => setup.handle(new Request(url, init)),
				requestInit: { headers },
			},
		);
		await client.connect(transport);
		closers.push(() => client.close());
		return {
			client,
			asked,
			call: async (name: string, input: Record<string, string[]> = {}) =>
				Text.parse(await client.callTool({ name, arguments: input })),
		};
	}
	return { setup, writes, connect };
}

function captureLogs() {
	const lines: string[] = [];
	const levels: Array<"error" | "warn" | "info" | "log"> = [
		"error",
		"warn",
		"info",
		"log",
	];
	for (const level of levels)
		vi.spyOn(console, level).mockImplementation((...args) => {
			lines.push(args.map(String).join(" "));
		});
	return lines;
}

function expectNoValues(texts: readonly string[]) {
	for (const text of texts)
		for (const value of [
			WRITER_SECRET,
			WRITER_ID,
			"config-document-value-4b8e",
			"not-an-origin-sentinel-55d1",
		])
			expect(text).not.toContain(value);
}

describe("relay setup mode MCP", () => {
	it("answers initialize, tools/list and the status with names only, without credentials", async () => {
		const { connect } = harness();
		const { client, call } = await connect();
		expect(client.getServerVersion()?.name).toBe("hobo-ci-relay-setup");
		expect(client.getInstructions()).toContain("setup mode");
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			RELAY_SETUP_PROVIDE_TOOL,
			RELAY_SETUP_STATUS_TOOL,
		]);
		const status = await call(RELAY_SETUP_STATUS_TOOL);
		expect(status.structuredContent).toEqual({
			state: "not-configured",
			missing: [
				"HOBO_CI_CONFIG_JSON",
				"HOBO_CI_GITHUB_APP_ID",
				"HOBO_CI_PUBLIC_URL",
			],
			invalid: [],
			providable: [
				"HOBO_CI_CONFIG_JSON",
				"HOBO_CI_GITHUB_APP_ID",
				"HOBO_CI_PUBLIC_URL",
			],
			writable: true,
		});
	});

	it("collects the entries in a form, writes the accepted ones and answers names only", async () => {
		const logs = captureLogs();
		const { connect, writes } = harness();
		const { call, asked } = await connect(() => ({
			action: "accept",
			content: {
				[RELAY_SETUP_WRITER_CLIENT_ID]: WRITER_ID,
				[RELAY_SETUP_WRITER_CLIENT_SECRET]: WRITER_SECRET,
				HOBO_CI_GITHUB_APP_ID: APP_ID_VALUE,
				HOBO_CI_CONFIG_JSON: CONFIG_VALUE,
				HOBO_CI_PUBLIC_URL: BAD_URL_VALUE,
			},
		}));
		const result = await call(RELAY_SETUP_PROVIDE_TOOL);
		expect(result.structuredContent).toEqual({
			outcome: "written",
			written: ["HOBO_CI_CONFIG_JSON", "HOBO_CI_GITHUB_APP_ID"],
			refused: ["HOBO_CI_PUBLIC_URL"],
			remaining: ["HOBO_CI_PUBLIC_URL"],
		});
		expect(asked).toHaveLength(1);
		expect(asked[0]?.params.mode).toBe("form");
		expect(writes).toEqual([
			{
				credential: { clientId: WRITER_ID, clientSecret: WRITER_SECRET },
				entries: new Map([
					["HOBO_CI_GITHUB_APP_ID", APP_ID_VALUE],
					["HOBO_CI_CONFIG_JSON", CONFIG_VALUE],
				]),
			},
		]);
		expectNoValues([JSON.stringify(result), ...logs]);
	});

	it("asks only for the named entries", async () => {
		const { connect } = harness();
		const { call, asked } = await connect(() => ({ action: "decline" }));
		const result = await call(RELAY_SETUP_PROVIDE_TOOL, {
			names: ["HOBO_CI_PUBLIC_URL"],
		});
		expect(result.structuredContent?.outcome).toBe("declined");
		const fields = Object.keys(
			asked[0]?.params.requestedSchema?.properties ?? {},
		);
		expect(fields.sort()).toEqual(
			[
				"HOBO_CI_PUBLIC_URL",
				RELAY_SETUP_WRITER_CLIENT_ID,
				RELAY_SETUP_WRITER_CLIENT_SECRET,
			].sort(),
		);
	});

	it("reports a refused writer by its code and logs no value", async () => {
		const logs = captureLogs();
		const { connect } = harness({
			write: async () => {
				throw new RelaySetupWriteError("writer-refused");
			},
		});
		const { call } = await connect(() => ({
			action: "accept",
			content: {
				[RELAY_SETUP_WRITER_CLIENT_ID]: WRITER_ID,
				[RELAY_SETUP_WRITER_CLIENT_SECRET]: WRITER_SECRET,
				HOBO_CI_CONFIG_JSON: CONFIG_VALUE,
			},
		}));
		const result = await call(RELAY_SETUP_PROVIDE_TOOL);
		expect(result.structuredContent?.outcome).toBe("writer-refused");
		expect(
			logs.some((line) => line.includes("hobo_ci_relay_setup_write_failed")),
		).toBe(true);
		expectNoValues([JSON.stringify(result), ...logs]);
	});

	it("shows no form without a writable store or a form-capable client", async () => {
		const unwritable = harness({ write: undefined });
		const first = await unwritable.connect(() => ({ action: "decline" }));
		expect(
			(await first.call(RELAY_SETUP_PROVIDE_TOOL)).structuredContent?.outcome,
		).toBe("store-not-writable");
		expect(first.asked).toHaveLength(0);
		const formless = harness();
		const second = await formless.connect();
		expect(
			(await second.call(RELAY_SETUP_PROVIDE_TOOL)).structuredContent?.outcome,
		).toBe("form-unavailable");
		expect(formless.writes).toHaveLength(0);
	});

	it("has nothing to ask once the relay is configured", async () => {
		const { connect } = harness({
			gaps: async () => ({ state: "configured", missing: [], invalid: [] }),
		});
		const { call, asked } = await connect(() => ({ action: "decline" }));
		expect(
			(await call(RELAY_SETUP_PROVIDE_TOOL)).structuredContent?.outcome,
		).toBe("nothing-to-provide");
		expect(asked).toHaveLength(0);
	});

	it("refuses a browser from another origin and an unknown session", async () => {
		const { setup } = harness();
		const foreign = await setup.handle(
			new Request(new URL("/mcp", ORIGIN), {
				method: "POST",
				headers: {
					Origin: "https://attacker.example",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
		);
		expect(foreign.status).toBe(403);
		const stale = await setup.handle(
			new Request(new URL("/mcp", ORIGIN), {
				method: "POST",
				headers: {
					"Mcp-Session-Id": "not-a-session",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
		);
		expect(stale.status).toBe(404);
	});
});
