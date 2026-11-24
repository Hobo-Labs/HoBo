import { RELAY_MCP_TOOLS } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	RELAY_MCP_INSIGHT_SCOPE,
	type RelayMcpInsightServices,
} from "../src/relay-mcp-insights.js";
import {
	callTool,
	FAILED_LOG,
	insightWorld,
	type JsonObject,
	READER,
	rpc,
} from "./support/relay-mcp-insights-world.js";

const ToolList = z.object({
	tools: z.array(
		z.object({
			name: z.string(),
			annotations: z.object({
				readOnlyHint: z.boolean(),
				destructiveHint: z.boolean().optional(),
				openWorldHint: z.boolean().optional(),
			}),
		}),
	),
});

const Decisions = z.object({
	decisions: z.array(
		z.object({
			repository: z.string(),
			outcome: z.string(),
			runner: z.string(),
			reason: z.string(),
			passedOver: z.array(z.string()),
		}),
	),
	next: z.string().optional(),
});

async function listedTools(services: RelayMcpInsightServices) {
	const answer = await rpc(services, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
	});
	return ToolList.parse(answer.result).tools;
}

const EVERY_CALL: ReadonlyArray<
	readonly [(typeof RELAY_MCP_TOOLS)[number], JsonObject]
> = [
	["get_runner_order", { repository: "octo/app" }],
	[
		"explain_route",
		{ repository: "octo/app", inputs: { github: "ubuntu-24.04" } },
	],
	["list_route_decisions", {}],
	["list_machines", {}],
	["get_signals", { repository: "octo/app" }],
	["get_job_times", { repository: "octo/app" }],
	["get_run_failures", { repository: "octo/app", runId: 200 }],
	["get_usage", { repository: "octo/app" }],
];

describe("relay MCP insight tools", () => {
	it("S04: lists the order, a route explanation, decisions, machines, signals, job times, failures and usage", async () => {
		const { services } = await insightWorld();
		const tools = await listedTools(services);
		expect(tools.map((tool) => tool.name)).toEqual([...RELAY_MCP_TOOLS]);
		expect(EVERY_CALL.map(([name]) => name)).toEqual([...RELAY_MCP_TOOLS]);
		for (const [name, args] of EVERY_CALL) {
			const called = await callTool(services, name, args);
			expect(called.isError, `${name}: ${called.text}`).toBe(false);
			expect(called.text, name).not.toContain("\n");
		}
	});

	it("X04: every insight tool answers a token with only the read scope and is marked read-only", async () => {
		const world = await insightWorld();
		const tools = await listedTools(world.services);
		for (const tool of tools) {
			expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
			expect(tool.annotations.destructiveHint, tool.name).toBe(false);
		}
		expect(READER.scopes).toEqual([RELAY_MCP_INSIGHT_SCOPE]);
		const before = {
			journal: world.journal.events.length,
			changes: world.registry.changes.length,
			runs: await world.store.runs({
				repository: "octo/app",
				sinceMs: 0,
				limit: 1_000,
			}),
		};
		for (const [name, args] of EVERY_CALL) {
			const called = await callTool(world.services, name, args);
			expect(called.isError, `${name}: ${called.text}`).toBe(false);
		}
		expect(world.journal.events.length).toBe(before.journal);
		expect(world.registry.changes.length).toBe(before.changes);
		expect(
			await world.store.runs({
				repository: "octo/app",
				sinceMs: 0,
				limit: 1_000,
			}),
		).toEqual(before.runs);
	});

	it("X04: refuses a credential without the read scope, as message (CODE)", async () => {
		const { services } = await insightWorld();
		for (const [name, args] of EVERY_CALL) {
			const called = await callTool(services, name, args, {
				accountId: "acct-1",
				scopes: ["operations:write"],
			});
			expect(called.isError, name).toBe(true);
			expect(called.text.split("\n")[0], name).toBe(
				"account scope required: policy:read (HOBO_CI_MCP_SCOPE_REQUIRED)",
			);
		}
	});

	it("reads one account's rows only: another account's repository is refused", async () => {
		const { services } = await insightWorld();
		for (const [name, args] of EVERY_CALL) {
			if (!JSON.stringify(args).includes("octo/app")) continue;
			const theirs = { ...args, repository: "other/repo" };
			const called = await callTool(services, name, theirs);
			expect(called.isError, name).toBe(true);
			expect(called.text, name).toContain(
				"other/repo is not connected to this account (HOBO_CI_MCP_REPOSITORY_NOT_CONNECTED)",
			);
		}
		const decisions = Decisions.parse(
			(await callTool(services, "list_route_decisions")).data,
		);
		expect(decisions.decisions.map((entry) => entry.repository)).toEqual([
			"octo/app",
			"octo/app",
		]);
		const machines = await callTool(services, "list_machines");
		expect(machines.text).not.toContain("theirs");
		expect(machines.text).not.toContain("m-9");
	});

	it("get_runner_order returns the committed order, and the parser's sentence for a broken one", async () => {
		const { services } = await insightWorld();
		const found = await callTool(services, "get_runner_order", {
			repository: "Octo/App",
			ref: "main",
		});
		expect(found.data).toMatchObject({
			repository: "octo/app",
			ref: "main",
			order: { steps: [{ key: "machine" }, { key: "github" }] },
		});
		expect(found.data?.problem).toBeUndefined();
		const broken = await callTool(services, "get_runner_order", {
			repository: "octo/broken",
		});
		expect(broken.isError).toBe(false);
		expect(String(broken.data?.problem)).not.toBe("");
	});

	it("explain_route walks the order with current facts and records nothing", async () => {
		const world = await insightWorld();
		const recorded = world.journal.events.length;
		const called = await callTool(world.services, "explain_route", {
			repository: "octo/app",
			inputs: { machine: "self-hosted", github: "ubuntu-24.04" },
			ref: "feature/x",
		});
		expect(called.data).toMatchObject({
			repository: "octo/app",
			outcome: "routed",
			runner: "ubuntu-24.04",
			step: "github",
			recorded: false,
		});
		expect(String(called.data?.reason)).toContain("ubuntu-24.04");
		expect(JSON.stringify(called.data?.passedOver)).toContain("machine");
		expect(world.journal.events.length).toBe(recorded);
		const asked = world.facts.asked.at(-1);
		expect(asked?.nowMs).toBe(world.services.now());
		expect(asked?.request.repository).toBe("octo/app");
		expect(asked?.request.private).toBe(true);
	});

	it("explain_route refuses a broken order with the parser's sentence and a bad size in words", async () => {
		const { services } = await insightWorld();
		const broken = await callTool(services, "explain_route", {
			repository: "octo/broken",
			inputs: { github: "ubuntu-24.04" },
		});
		expect(broken.data).toMatchObject({ outcome: "none", recorded: false });
		const sized = await callTool(services, "explain_route", {
			repository: "octo/app",
			inputs: { github: "ubuntu-24.04", size: "3" },
		});
		expect(sized.data).toMatchObject({ outcome: "none" });
		expect(String(sized.data?.reason)).toContain('not "3"');
		const site = await callTool(services, "explain_route", {
			repository: "octo/site",
			inputs: { github: "ubuntu-24.04" },
			fork: true,
			event: "pull_request",
		});
		expect(site.isError).toBe(false);
	});

	it("list_route_decisions pages newest first with a cursor and filters", async () => {
		const { services } = await insightWorld();
		const first = Decisions.parse(
			(await callTool(services, "list_route_decisions", { limit: 1 })).data,
		);
		expect(first.decisions).toHaveLength(1);
		expect(first.next).toBeDefined();
		const second = Decisions.parse(
			(
				await callTool(services, "list_route_decisions", {
					limit: 1,
					cursor: first.next ?? "",
				})
			).data,
		);
		expect(second.decisions).toHaveLength(1);
		expect(second.next).toBeUndefined();
		const recent = Decisions.parse(
			(
				await callTool(services, "list_route_decisions", {
					sinceHours: 1,
					outcome: "routed",
					repository: "octo/app",
				})
			).data,
		);
		expect(recent.decisions).toHaveLength(1);
		const bad = await callTool(services, "list_route_decisions", {
			cursor: "not-a-cursor",
		});
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain("(HOBO_CI_MCP_INVALID_CURSOR)");
	});

	it("list_machines says which machines are online", async () => {
		const { services } = await insightWorld();
		const called = await callTool(services, "list_machines");
		expect(called.data).toMatchObject({
			machines: [
				{ id: "m-1", online: true, busy: 1, isolation: "container" },
				{ id: "m-2", name: "attic", online: false },
			],
		});
	});

	it("get_signals, get_job_times and get_usage read the stored runs", async () => {
		const { services } = await insightWorld();
		const signals = await callTool(services, "get_signals", {
			repository: "octo/app",
		});
		expect(signals.data).toMatchObject({ repository: "octo/app", runs: 5 });
		expect(JSON.stringify(signals.data)).toContain("short-jobs");
		const times = await callTool(services, "get_job_times", {
			repository: "octo/app",
			job: "test",
		});
		expect(times.data).toMatchObject({
			runs: 5,
			jobs: [{ job: "test", workflow: "CI" }],
		});
		const usage = await callTool(services, "get_usage", {
			repository: "octo/app",
			days: 2,
		});
		expect(usage.data).toMatchObject({
			repository: "octo/app",
			runs: 3,
			rate: { usdPerMinute: 0.006, readOn: "2026-11-17" },
			included: { usedMinutes: 1_200, includedMinutes: 3_000 },
		});
	});

	it("get_run_failures names the failed step, quotes the log and prints its evidence", async () => {
		const world = await insightWorld();
		const called = await callTool(world.services, "get_run_failures", {
			repository: "octo/app",
			runId: 200,
		});
		expect(called.data).toMatchObject({
			runId: 200,
			attempt: 1,
			failedJobs: 1,
			jobs: [
				{
					jobId: 3000,
					name: "test",
					log: "read",
					failedStep: { name: "Run pnpm test", number: 2 },
					kind: "test",
				},
			],
		});
		expect(JSON.stringify(called.data)).toContain("expected 3 to be 4");
		expect(FAILED_LOG).toContain("expected 3 to be 4");
		expect(world.logsRead).toEqual([3000]);
		const missing = await callTool(world.services, "get_run_failures", {
			repository: "octo/app",
			runId: 999,
		});
		expect(missing.text).toContain("(HOBO_CI_MCP_RUN_NOT_FOUND)");
		const unread = await insightWorld({ failureLogs: undefined });
		const steps = await callTool(unread.services, "get_run_failures", {
			repository: "octo/app",
			runId: 200,
		});
		expect(steps.data).toMatchObject({
			jobs: [{ log: "not-read", failedStep: { name: "Run pnpm test" } }],
		});
	});

	it("on a host that stores nothing, says so and names the command that reads GitHub", async () => {
		const { services } = await insightWorld({
			journal: undefined,
			machines: undefined,
			runs: undefined,
		});
		for (const [name, args] of EVERY_CALL) {
			const called = await callTool(services, name, args);
			if (name === "get_runner_order" || name === "explain_route") {
				expect(called.isError, name).toBe(false);
				continue;
			}
			expect(called.isError, name).toBe(true);
			expect(called.text, name).toMatch(
				/^This relay keeps no [a-z ]+ \(HOBO_CI_MCP_NOT_STORED\)\nInstead, run hobo ci /u,
			);
		}
	});

	it("a failing port is a tool error, not a thrown one, and a busy account is refused", async () => {
		const broken = await insightWorld({
			repositories: async () => {
				throw new Error("store down");
			},
		});
		const failed = await callTool(broken.services, "get_signals", {
			repository: "octo/app",
		});
		expect(failed.isError).toBe(true);
		expect(failed.text).toContain("(HOBO_CI_MCP_FAILED)");
		expect(failed.text).not.toContain("store down");
		const ended: string[] = [];
		const busy = await insightWorld({
			beginCall: () => false,
			endCall: (accountId) => ended.push(accountId),
		});
		const refused = await callTool(busy.services, "list_machines");
		expect(refused.text).toContain("(HOBO_CI_MCP_BUSY)");
		expect(ended).toEqual([]);
		const held: string[] = [];
		const counted = await insightWorld({
			beginCall: (accountId) => {
				held.push(accountId);
				return true;
			},
			endCall: (accountId) => ended.push(accountId),
		});
		await callTool(counted.services, "list_machines");
		expect(held).toEqual(["acct-1"]);
		expect(ended).toEqual(["acct-1"]);
	});
});
