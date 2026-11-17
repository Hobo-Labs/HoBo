/**
 * A relay with stored routes, machines and runs for the MCP insight tools,
 * over the in-memory ports of `@hobo/ci/runner-order/testing`, and a caller
 * that sends the tools JSON-RPC the way the relay's HTTP layer hands it on:
 * a stateless transport, a JSON answer, the account and its scopes as the
 * transport's auth info.
 */
import { answerRelayJob, NO_ROUTE_FACTS } from "@hobo/ci";
import type { InsightRun } from "@hobo/ci/insights";
import {
	InMemoryInsightStore,
	InMemoryMachineRegistry,
	InMemoryMinutesReader,
	InMemoryRouteFactsSource,
	InMemoryRouteJournal,
	InMemoryRunnerOrderSource,
	testMachineAdvert,
	testRelayJobMessage,
} from "@hobo/ci/runner-order/testing";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
	type FailureLogReader,
	type RelayMcpInsightServices,
	type RepositoryVisibility,
	registerRelayMcpInsightTools,
} from "../../src/relay-mcp-insights.js";

export const WORLD_NOW = Date.parse("2026-11-17T12:00:00Z");
export const HOUR = 3_600_000;

// GitHub's Linux 2-core rate, from the actions-runner-pricing page, read 2026-11-17.
export const GITHUB_RATE = {
	usdPerMinute: 0.006,
	source: "https://docs.github.com/en/billing/reference/actions-runner-pricing",
	readOn: "2026-11-17",
} as const;

export const FAILED_LOG = [
	"Run pnpm test",
	" FAIL  test/math.test.ts > adds",
	"AssertionError: expected 3 to be 4",
	"Error: Process completed with exit code 1.",
].join("\n");

function job(
	init: Readonly<{
		id: number;
		name: string;
		labels: readonly string[];
		startMs: number;
		runMs: number;
		conclusion: "success" | "failure";
		failedStep?: string;
	}>,
): InsightRun["jobs"][number] {
	return {
		id: init.id,
		name: init.name,
		labels: init.labels,
		conclusion: init.conclusion,
		queuedAtMs: init.startMs - 30_000,
		startedAtMs: init.startMs,
		completedAtMs: init.startMs + init.runMs,
		steps: [
			{ name: "Set up job", number: 1, conclusion: "success" },
			{
				name: init.failedStep ?? "Run pnpm test",
				number: 2,
				conclusion: init.conclusion,
			},
		],
		billed: true,
	};
}

function run(
	id: number,
	repository: string,
	createdAtMs: number,
	conclusion: "success" | "failure",
	jobs: InsightRun["jobs"],
): InsightRun {
	return {
		id,
		attempt: 1,
		repository,
		workflow: "CI",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		branch: "main",
		defaultBranch: "main",
		headSha: "0123456789abcdef0123456789abcdef01234567",
		actor: "octocat",
		conclusion,
		createdAtMs,
		completedAtMs: createdAtMs + 600_000,
		jobs,
	};
}

export type InsightWorld = Readonly<{
	services: RelayMcpInsightServices;
	journal: InMemoryRouteJournal;
	registry: InMemoryMachineRegistry;
	store: InMemoryInsightStore;
	facts: InMemoryRouteFactsSource;
	logsRead: number[];
}>;

/**
 * Two accounts. `acct-1` connects `octo/app` (private, order: machine then
 * GitHub) and `octo/site` (public); `acct-2` connects `other/repo`.
 */
export async function insightWorld(
	overrides: Partial<RelayMcpInsightServices> = {},
): Promise<InsightWorld> {
	const order = new InMemoryRunnerOrderSource(
		new Map([
			["octo/app", '{"steps":[{"key":"machine"},{"key":"github"}]}'],
			["octo/broken", '{"steps":[]}'],
		]),
	);
	const facts = new InMemoryRouteFactsSource(() => NO_ROUTE_FACTS);
	const journal = new InMemoryRouteJournal();
	for (const [accountId, repository, jobId, atMs] of [
		["acct-1", "octo/app", "job-1", WORLD_NOW - 2 * HOUR],
		["acct-1", "octo/app", "job-2", WORLD_NOW - HOUR],
		["acct-2", "other/repo", "job-9", WORLD_NOW - HOUR],
	] as const)
		await answerRelayJob(testRelayJobMessage({ jobId, repository }), {
			order,
			facts,
			journal,
			nowMs: atMs,
			mode: "relay",
			node: "relay-1",
			accountId,
			checks: undefined,
		});
	const registry = new InMemoryMachineRegistry();
	await registry.put(
		testMachineAdvert({ id: "m-1", lastSeenMs: WORLD_NOW - 10_000, busy: 1 }),
	);
	await registry.put(
		testMachineAdvert({ id: "m-2", name: "attic", lastSeenMs: 1 }),
	);
	await registry.put(
		testMachineAdvert({ id: "m-9", accountId: "acct-2", name: "theirs" }),
	);
	const store = new InMemoryInsightStore();
	const day = 86_400_000;
	for (let index = 0; index < 4; index++)
		await store.ingest(
			run(100 + index, "octo/app", WORLD_NOW - (index + 1) * day, "success", [
				job({
					id: 1000 + index,
					name: "test",
					labels: ["ubuntu-latest"],
					startMs: WORLD_NOW - (index + 1) * day,
					runMs: 240_000,
					conclusion: "success",
				}),
				job({
					id: 2000 + index,
					name: "lint",
					labels: ["self-hosted", "linux"],
					startMs: WORLD_NOW - (index + 1) * day,
					runMs: 20_000,
					conclusion: "success",
					failedStep: "Run pnpm lint",
				}),
			]),
		);
	await store.ingest(
		run(200, "octo/app", WORLD_NOW - HOUR, "failure", [
			job({
				id: 3000,
				name: "test",
				labels: ["ubuntu-latest"],
				startMs: WORLD_NOW - HOUR,
				runMs: 120_000,
				conclusion: "failure",
			}),
		]),
	);
	await store.ingest(
		run(900, "other/repo", WORLD_NOW - HOUR, "failure", [
			job({
				id: 9000,
				name: "secret-job",
				labels: ["ubuntu-latest"],
				startMs: WORLD_NOW - HOUR,
				runMs: 60_000,
				conclusion: "failure",
			}),
		]),
	);
	const logsRead: number[] = [];
	const failureLogs: FailureLogReader = {
		async logTail(_repository, jobId) {
			logsRead.push(jobId);
			return FAILED_LOG;
		},
	};
	const connected = new Map<string, ReadonlyMap<string, RepositoryVisibility>>([
		[
			"acct-1",
			new Map<string, RepositoryVisibility>([
				["octo/app", "private"],
				["octo/broken", "private"],
				["octo/site", "public"],
			]),
		],
		[
			"acct-2",
			new Map<string, RepositoryVisibility>([["other/repo", "private"]]),
		],
	]);
	const services: RelayMcpInsightServices = {
		order,
		facts,
		journal,
		machines: registry,
		runs: store,
		minutes: new InMemoryMinutesReader(
			new Map([["octo", { usedMinutes: 1_200, includedMinutes: 3_000 }]]),
		),
		failureLogs,
		repositories: async (accountId) => connected.get(accountId) ?? new Map(),
		githubRate: GITHUB_RATE,
		now: () => WORLD_NOW,
		...overrides,
	};
	return { services, journal, registry, store, facts, logsRead };
}

const Json = z.json();
type Json = z.infer<typeof Json>;
const JsonObject = z.record(z.string(), Json);
export type JsonObject = z.infer<typeof JsonObject>;

const ToolResult = z.object({
	isError: z.boolean().optional(),
	content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	structuredContent: JsonObject.optional(),
});
const RpcAnswer = z.object({
	jsonrpc: z.literal("2.0"),
	result: Json.optional(),
	error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export type Caller = Readonly<{ accountId: string; scopes: readonly string[] }>;

export const READER: Caller = { accountId: "acct-1", scopes: ["policy:read"] };

/** Send one JSON-RPC message to a fresh server holding the insight tools. */
export async function rpc(
	services: RelayMcpInsightServices,
	message: Json,
	caller: Caller = READER,
): Promise<z.infer<typeof RpcAnswer>> {
	const server = new McpServer({ name: "hobo-ci-relay", version: "1.0.0" });
	registerRelayMcpInsightTools(server, services);
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
	});
	await server.connect(transport);
	try {
		const response = await transport.handleRequest(
			new Request("https://ci.example.test/mcp", {
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
				},
				body: JSON.stringify(message),
			}),
			{
				authInfo: {
					token: "",
					clientId: caller.accountId,
					scopes: [...caller.scopes],
				},
			},
		);
		return RpcAnswer.parse(await response.json());
	} finally {
		await server.close();
	}
}

export type Called = Readonly<{
	isError: boolean;
	text: string;
	data: JsonObject | undefined;
}>;

/** Call one tool and read its answer. */
export async function callTool(
	services: RelayMcpInsightServices,
	name: string,
	args: JsonObject = {},
	caller: Caller = READER,
): Promise<Called> {
	const answer = await rpc(
		services,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		},
		caller,
	);
	if (answer.error) throw new Error(answer.error.message);
	const result = ToolResult.parse(answer.result);
	return {
		isError: result.isError === true,
		text: result.content.map((part) => part.text).join("\n"),
		data: result.structuredContent,
	};
}
