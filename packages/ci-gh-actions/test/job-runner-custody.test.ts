import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { hasOutstandingBoxCustody } from "../src/job-runner-custody.js";

describe("hasOutstandingBoxCustody", () => {
	it("treats a bare reserved lease as in-flight custody", () => {
		const lease = create(LeaseSchema, {
			id: "00000000-0000-4000-8000-000000000001",
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			repositoryId: 101,
			repository: "Org/Repo",
			installationId: 10,
			jobId: 100,
			actualJobId: 0,
			originalRunId: 9,
			runAttempt: 1,
			state: "reserved",
		});
		expect(
			hasOutstandingBoxCustody(lease, 101, 100, 1),
		).toBe(true);
	});

	it("ignores completed leases", () => {
		const lease = create(LeaseSchema, {
			id: "00000000-0000-4000-8000-000000000001",
			accountId: "a",
			offerId: "box",
			provider: "hobo-box-worker",
			repositoryId: 101,
			repository: "Org/Repo",
			installationId: 10,
			jobId: 100,
			actualJobId: 0,
			originalRunId: 9,
			runAttempt: 1,
			state: "completed",
		});
		expect(
			hasOutstandingBoxCustody(lease, 101, 100, 1),
		).toBe(false);
	});
});
