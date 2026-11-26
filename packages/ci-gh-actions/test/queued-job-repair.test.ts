import { create } from "@bufbuild/protobuf";
import {
	ConfigurationSchema,
	ConfigurationStateSchema,
	ConnectionSchema,
} from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import {
	createQueuedJobRepair,
	type QueuedRepairClaims,
} from "../src/queued-job-repair.js";

const connection = create(ConnectionSchema, {
	accountId: "a",
	installationId: 9,
	repositoryId: 10,
	repository: "owner/repo",
});
const configuration = create(ConfigurationStateSchema, {
	configuration: create(ConfigurationSchema, { connections: [connection] }),
	revision: 1,
});
function fixture(options: { limit?: number; failJobs?: boolean } = {}) {
	const runIds: number[] = [];
	let saved = {
		page: 1,
		runs: runIds,
		loaded: false,
		hasNext: false,
		runIndex: 0,
		jobPage: 1,
		jobIndex: 0,
	};
	let budget = options.limit ?? 10;
	const records: string[] = [];
	const requests: string[] = [];
	const claims: QueuedRepairClaims = {
		async start(keys) {
			return {
				key: keys.find((key) => key.endsWith(":queued")) ?? "",
				cursor: structuredClone(saved),
				async take(count) {
					if (budget < count) return false;
					budget -= count;
					return true;
				},
				async checkpoint(cursor) {
					saved = structuredClone(cursor);
				},
				async more() {
					return true;
				},
				async close() {},
			};
		},
	};
	const github = {
		async request(installation: number, path: string) {
			expect(installation).toBe(9);
			requests.push(path);
			if (path.includes("/runs?"))
				return Response.json({ workflow_runs: [{ id: 22 }] });
			if (options.failJobs) return new Response(null, { status: 403 });
			return Response.json({
				jobs: [
					{
						id: 30,
						run_id: 22,
						run_attempt: 2,
						status: "queued",
						labels: ["hobo"],
					},
					{
						id: 31,
						run_id: 22,
						run_attempt: 2,
						status: "completed",
						labels: ["hobo"],
					},
					{
						id: 32,
						run_id: 22,
						run_attempt: 2,
						status: "queued",
						labels: ["ubuntu-latest"],
					},
				],
			});
		},
	};
	const relay = {
		processWebhook: vi.fn(async (body: Buffer, event: string) => {
			expect(event).toBe("workflow_job");
			records.push(body.toString());
			return "reserved";
		}),
	};
	const run = createQueuedJobRepair({
		store: {
			async configuration() {
				return configuration;
			},
		},
		github,
		claims,
		relay: async () => relay,
	});
	return {
		run,
		records,
		requests,
		relay,
		refill() {
			budget = 10;
		},
		cursor: () => saved,
	};
}

describe("queued job repair", () => {
	it("waits for this deployment's completed scan before treating idle as healthy", async () => {
		let complete = false;
		const repair = createQueuedJobRepair({
			store: { configuration: async () => configuration },
			github: { request: vi.fn(async () => new Response()) },
			claims: { start: async () => undefined },
			idleComplete: async () => complete,
			relay: async () => ({ processWebhook: vi.fn(async () => "ignored") }),
		});
		expect(await repair()).toEqual({
			more: true,
			truncated: false,
			failed: false,
			skipped: true,
		});
		complete = true;
		expect(await repair()).toEqual({
			more: false,
			truncated: false,
			failed: false,
			skipped: true,
		});
	});
	it.each([
		"busy",
		"deferred",
	] as const)("does not report a completed scan when work is %s", async (state) => {
		const repair = createQueuedJobRepair({
			store: { configuration: async () => configuration },
			github: { request: vi.fn(async () => new Response()) },
			claims: { start: async () => state },
			relay: async () => ({ processWebhook: vi.fn(async () => "ignored") }),
		});
		expect(await repair()).toEqual({
			more: true,
			truncated: false,
			failed: false,
			skipped: true,
		});
	});
	it("recovers only queued hobo jobs through the existing verified relay", async () => {
		const f = fixture();
		expect(await f.run()).toMatchObject({ failed: false });
		expect(f.relay.processWebhook).toHaveBeenCalledTimes(1);
		expect(JSON.parse(f.records[0] ?? "null")).toMatchObject({
			installation: { id: 9 },
			repository: { id: 10, full_name: "owner/repo" },
			workflow_job: { id: 30, run_id: 22, run_attempt: 2 },
		});
		expect(f.requests).toEqual([
			"/repos/owner/repo/actions/runs?status=queued&per_page=100&page=1",
			"/repos/owner/repo/actions/runs/22/jobs?filter=latest&per_page=100&page=1",
		]);
	});
	it("checkpoints without admitting a job when the global API budget is exhausted, then resumes", async () => {
		const f = fixture({ limit: 3 });
		expect(await f.run()).toMatchObject({ more: true, failed: false });
		expect(f.relay.processWebhook).not.toHaveBeenCalled();
		expect(f.cursor()).toMatchObject({ loaded: true, jobIndex: 0 });
		f.refill();
		expect(await f.run()).toMatchObject({ failed: false });
		expect(f.relay.processWebhook).toHaveBeenCalledTimes(1);
	});
	it("backs off a repository with inaccessible jobs and retains its scan cursor", async () => {
		const f = fixture({ failJobs: true });
		expect(await f.run()).toEqual({
			more: true,
			truncated: false,
			failed: true,
		});
		expect(f.cursor()).toMatchObject({ loaded: true, runs: [22], runIndex: 0 });
		expect(f.relay.processWebhook).not.toHaveBeenCalled();
	});
});
