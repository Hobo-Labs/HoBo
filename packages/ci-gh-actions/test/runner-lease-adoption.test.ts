import { create } from "@bufbuild/protobuf";
import { type Lease, LeaseSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import * as correlationModule from "../src/jit-runner-correlation.js";
import { adoptRunnerAssignment } from "../src/runner-lease-adoption.js";

function leaseFixture(partial: Partial<Lease> & Pick<Lease, "id">): Lease {
	return create(LeaseSchema, {
		accountId: "a",
		offerId: "box",
		provider: "hobo-box-worker",
		jobId: 131490897930,
		actualJobId: 131490555668,
		originalRunId: 43275965551,
		runAttempt: 1,
		repositoryId: 101,
		repository: "Hobo-Labs/HoBo",
		installationId: 10,
		runnerName: `hobo-${partial.id}`,
		runnerId: 42,
		state: "running",
		createdAt: "2026-11-12T12:00:00.000Z",
		...partial,
	});
}

describe("adoptRunnerAssignment", () => {
	it("syncs originalRunId when actualJobId already matches GitHub", async () => {
		const leaseId = "237f4d7d-0700-466a-9140-8cbc4d241cc7";
		const lease = leaseFixture({
			id: leaseId,
			actualJobId: 131490555668,
			originalRunId: 43275965551,
		});
		const transition = vi.fn(
			async (
				id: string,
				_from: string[],
				mutate: (entry: Lease) => void,
				_event: string,
				_at: string,
			) => {
				if (id !== lease.id) return undefined;
				mutate(lease);
				return lease;
			},
		);
		const store = { get: async () => lease, transition };
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: 131490555668,
			runId: 43302513633,
			status: "in_progress",
		});
		const result = await adoptRunnerAssignment(
			store,
			deniedGithub(),
			lease,
			"2026-11-12T12:01:00.000Z",
		);
		expect(transition).toHaveBeenCalledOnce();
		expect(result.lease.originalRunId).toBe(43302513633);
		expect(result.holdsActive).toBe(true);
		vi.restoreAllMocks();
	});

	it("re-associates actual job and withdraws the reserved queued job", async () => {
		const leaseId = "237f4d7d-0700-466a-9140-8cbc4d241cc7";
		const lease = leaseFixture({
			id: leaseId,
			actualJobId: 0,
			originalRunId: 43275965551,
		});
		const transition = vi.fn(
			async (
				id: string,
				_from: string[],
				mutate: (entry: Lease) => void,
				_event: string,
				_at: string,
			) => {
				if (id !== lease.id) return undefined;
				mutate(lease);
				return lease;
			},
		);
		const withdrawQueuedJob = vi.fn(async () => true);
		const store = { get: async () => lease, transition, withdrawQueuedJob };
		vi.spyOn(correlationModule, "resolveRunnerAssignedJob").mockResolvedValue({
			jobId: 131490555668,
			runId: 43302513633,
			status: "in_progress",
		});
		await adoptRunnerAssignment(
			store,
			deniedGithub(),
			lease,
			"2026-11-12T12:01:00.000Z",
		);
		expect(lease.actualJobId).toBe(131490555668);
		expect(lease.originalRunId).toBe(43302513633);
		expect(withdrawQueuedJob).toHaveBeenCalledOnce();
		expect(withdrawQueuedJob).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 131490897930,
				runId: 43275965551,
			}),
			"2026-11-12T12:01:00.000Z",
			undefined,
			leaseId,
		);
		vi.restoreAllMocks();
	});
});

function deniedGithub(): GithubTransport {
	return {
		async request() {
			throw new Error("unexpected GitHub request");
		},
	};
}
