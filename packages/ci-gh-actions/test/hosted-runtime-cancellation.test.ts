import { create } from "@bufbuild/protobuf";
import { ConfigurationStateSchema, LeaseSchema } from "@hobo/ci";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createHostedRelayRuntime,
	type HostedInboxStore,
	type HostedRelayTickTiming,
} from "../src/hosted-runtime.js";
import { config, NOW, run, SECRET } from "./fixtures.js";

function fixture(options: {
	webhook?: boolean;
	actualJobId?: number;
	status?: string;
	responseRunner?: string | null;
	jobReadFails?: boolean;
	onTickTiming?: (timing: HostedRelayTickTiming) => void;
}) {
	const name = "hobo-00000000-0000-4000-8000-000000000001";
	const lease = create(LeaseSchema, {
		id: "00000000-0000-4000-8000-000000000001",
		accountId: "account-a",
		provider: "vercel",
		repository: "org/repo",
		repositoryId: 101,
		installationId: 10,
		jobId: 1,
		originalRunId: 11,
		runAttempt: 1,
		runnerName: name,
		sandboxName: name,
		state: "running",
		actualJobId: options.actualJobId ?? 0,
	});
	const state = create(ConfigurationStateSchema, {
		revision: 1,
		configuration: config(),
	});
	let claimed = false;
	const impossible = async () => {
		throw new Error("unexpected operation");
	};
	const store: HostedInboxStore = {
		configuration: async () => state,
		policySnapshot: async () => ({ state, policies: [] }),
		get: async () => lease,
		all: async () => [lease],
		activeLeases: async () => [lease],
		accountLeases: async () => [lease],
		pendingJobs: async () => [],
		observe: async (job) => {
			if (job.runnerName === lease.runnerName) lease.actualJobId = job.id;
		},
		queue: impossible,
		reserve: impossible,
		transition: impossible,
		cancelAndRequeue: impossible,
		abortIsolatedAndRequeue: impossible,
		settleObserved: impossible,
		ready: async () => true,
		latestLeaseIntents: async () => [],
		acceptWebhook: impossible,
		acceptIgnoredWebhook: impossible,
		claimWebhook: async () => {
			if (!options.webhook || claimed) return undefined;
			claimed = true;
			return {
				deliveryId: "completed-1",
				token: "claim-1",
				event: "workflow_job",
				rawBody: Buffer.from(
					JSON.stringify({
						action: "completed",
						installation: { id: 10 },
						repository: { id: 101, full_name: "org/repo" },
						workflow_job: {
							id: 1,
							run_id: 11,
							run_attempt: 1,
							labels: ["hobo"],
							runner_name: options.responseRunner ?? name,
						},
					}),
				),
			};
		},
		ackWebhook: async () => true,
		failWebhook: async () => "retry",
	};
	const request = vi.fn<GithubTransport["request"]>(
		async (_installation, path) => {
			if (path === "/repos/org/repo/actions/runs/11")
				return Response.json(run());
			if (path === "/repos/org/repo/actions/jobs/1") {
				if (options.jobReadFails) return new Response(null, { status: 503 });
				return Response.json({
					id: 1,
					run_id: 11,
					run_attempt: 1,
					status: options.status ?? "completed",
					labels: ["hobo"],
					runner_name:
						options.responseRunner === undefined
							? name
							: options.responseRunner,
				});
			}
			if (path === "/repos/org/repo/actions/runs/11/jobs?filter=latest&per_page=100")
				return Response.json({
					jobs: [
						{
							id: 1,
							run_id: 11,
							status: options.status ?? "completed",
							runner_name:
								options.responseRunner === undefined
									? name
									: options.responseRunner,
							runner_id: 1,
						},
					],
				});
			if (path.startsWith("/repos/org/repo/actions/runs?status=in_progress"))
				return Response.json({ workflow_runs: [] });
			throw new Error(`unexpected GitHub request: ${path}`);
		},
	);
	const reconcile = vi.fn(async (_id: string, _forceStop?: boolean) => {});
	const runtimeOptions: Parameters<typeof createHostedRelayRuntime>[0] = {
		store,
		github: { request },
		identity: { verify: impossible },
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
		isolatedHost: { launch: impossible, reconcile },
	};
	if (options.onTickTiming) runtimeOptions.onTickTiming = options.onTickTiming;
	const runtime = createHostedRelayRuntime(runtimeOptions);
	return { runtime, reconcile, request, lease, store };
}

describe("isolated runner cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops the verified assigned runner in the same wakeup as its completed event", async () => {
		const h = fixture({ webhook: true });
		await h.runtime.tick();
		expect(h.lease.actualJobId).toBe(1);
		expect(h.reconcile).toHaveBeenCalledWith(h.lease.id, true);
	});
	it.each([
		{ actualJobId: 1, status: "in_progress" },
		{ actualJobId: 1, responseRunner: "another-runner" },
		{ actualJobId: 1, responseRunner: null },
		{ actualJobId: 1, jobReadFails: true },
		{ actualJobId: 0 },
	])("does not force stop without an exact completed runner assignment: %j", async (options) => {
		const h = fixture(options);
		await h.runtime.tick();
		expect(h.reconcile).toHaveBeenCalledWith(h.lease.id, false);
	});
	it("a draining tick reconciles running leases but takes no delivery and admits no job", async () => {
		const h = fixture({ webhook: true, actualJobId: 1 });
		const claimWebhook = vi.spyOn(h.store, "claimWebhook");
		const pendingJobs = vi.spyOn(h.store, "pendingJobs");
		await h.runtime.tick({ maxDeliveries: 10, admit: false });
		expect(claimWebhook).not.toHaveBeenCalled();
		expect(pendingJobs).not.toHaveBeenCalled();
		expect(h.reconcile).toHaveBeenCalledWith(h.lease.id, true);

		await h.runtime.tick();
		expect(claimWebhook).toHaveBeenCalled();
		expect(pendingJobs).toHaveBeenCalled();
	});

	it("reports phase timings for a slow tick", async () => {
		const onTickTiming = vi.fn();
		const h = fixture({ onTickTiming });
		vi.spyOn(Date, "now")
			.mockReturnValueOnce(0)
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(4_000)
			.mockReturnValueOnce(4_000)
			.mockReturnValueOnce(6_000)
			.mockReturnValueOnce(6_000);

		await h.runtime.tick();
		expect(onTickTiming).toHaveBeenCalledWith({
			totalMs: 6_000,
			deliveriesMs: 1_000,
			leaseReconcileMs: 3_000,
			dispatchMs: 2_000,
			leaseCount: 1,
			pendingCount: 0,
		});
	});
});
