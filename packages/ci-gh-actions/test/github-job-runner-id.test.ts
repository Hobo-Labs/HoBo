import { describe, expect, it, vi } from "vitest";
import { getJob, listRunWorkflowJobs } from "../src/github.js";

describe("GitHub job runner_id schema", () => {
	it("accepts runner_id 0 from getJob for queued unassigned jobs", async () => {
		const api = {
			request: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							id: 42,
							run_id: 99,
							status: "queued",
							labels: ["hobo"],
							runner_id: 0,
							runner_name: null,
						}),
						{ status: 200 },
					),
			),
		};
		const job = await getJob(api, 10, "Org/Repo", 42);
		expect(job.runner_id).toBe(0);
	});

	it("accepts runner_id null from listRunWorkflowJobs", async () => {
		const api = {
			request: vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							jobs: [
								{
									id: 7,
									run_id: 3,
									status: "queued",
									labels: ["hobo"],
									runner_id: null,
									runner_name: null,
								},
							],
						}),
						{ status: 200 },
					),
			),
		};
		const jobs = await listRunWorkflowJobs(api, 10, "Org/Repo", 3);
		expect(jobs[0]?.runner_id).toBeNull();
	});
});
