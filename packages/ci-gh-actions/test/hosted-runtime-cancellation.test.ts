import { create } from "@bufbuild/protobuf";
import { ConfigurationStateSchema, LeaseSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createHostedRelayRuntime,
	type HostedInboxStore,
} from "../src/hosted-runtime.js";
import { config, NOW, run, SECRET } from "./fixtures.js";

function fixture(options: {
	webhook?: boolean;
	actualJobId?: number;
	status?: string;
	responseRunner?: string | null;
	jobReadFails?: boolean;
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
			throw new Error("unexpected GitHub request");
		},
	);
	const reconcile = vi.fn(async (_id: string, _forceStop?: boolean) => {});
	const runtime = createHostedRelayRuntime({
		store,
		github: { request },
		identity: { verify: impossible },
		webhookSecret: SECRET,
		control: async () => undefined,
		now: () => NOW,
		isolatedHost: { launch: impossible, reconcile },
	});
	return { runtime, reconcile, request, lease };
}

describe("isolated runner cancellation", () => {
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
});
