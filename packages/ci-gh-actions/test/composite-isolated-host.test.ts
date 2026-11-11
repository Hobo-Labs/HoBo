import { create } from "@bufbuild/protobuf";
import { JobSchema, LeaseSchema } from "@hobo/ci";
import { describe, expect, it, vi } from "vitest";
import type { IsolatedRunnerHost } from "../src/hosted-relay.js";
import { createCompositeIsolatedHost } from "../src/isolated-worker/composite-host.js";

const lease = create(LeaseSchema, {
	id: "00000000-0000-4000-8000-000000000001",
	accountId: "a",
	offerId: "box",
	provider: "hobo-box-worker",
	jobId: 42,
	originalRunId: 9,
	runAttempt: 1,
	repositoryId: 1,
	repository: "Org/Repo",
	installationId: 1,
	state: "reserved",
});

const job = create(JobSchema, {
	id: 42,
	runId: 9,
	runAttempt: 1,
	repositoryId: 1,
	repository: "Org/Repo",
	installationId: 1,
	labels: ["hobo-trunk"],
	action: "queued",
	memoryClass: "light",
	memoryMb: 3072,
});

describe("composite isolated host", () => {
	it("forwards isLaunchParked to the worker backend", async () => {
		const worker: IsolatedRunnerHost = {
			isLaunchParked: vi.fn(async () => true),
			launch: vi.fn(async () => undefined),
			reconcile: vi.fn(async () => undefined),
		};
		const host = createCompositeIsolatedHost({
			store: {
				get: vi.fn(async () => lease),
			},
			worker,
		});
		await expect(host?.isLaunchParked?.(job)).resolves.toBe(true);
		expect(worker.isLaunchParked).toHaveBeenCalledWith(job);
		expect(worker.launch).not.toHaveBeenCalled();
	});

	it("does not launch through worker while launch is parked", async () => {
		const worker: IsolatedRunnerHost = {
			isLaunchParked: vi.fn(async () => true),
			launch: vi.fn(async () => undefined),
			reconcile: vi.fn(async () => undefined),
		};
		const host = createCompositeIsolatedHost({
			store: { get: vi.fn(async () => lease) },
			worker,
		});
		await host?.launch(lease.id, "hobo-trunk", 0);
		expect(worker.launch).not.toHaveBeenCalled();
	});
});
