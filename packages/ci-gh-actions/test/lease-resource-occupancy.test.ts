import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import {
	leaseOccupiesMergeGroupCap,
	leaseOccupiesWorkerResources,
} from "../src/lease-resource-occupancy.js";

function lease(
	overrides: Partial<ReturnType<typeof create<typeof LeaseSchema>>>,
) {
	return create(LeaseSchema, {
		id: "00000000-0000-4000-8000-000000000001",
		accountId: "a",
		offerId: "box",
		provider: "hobo-box-worker",
		state: "running",
		jobId: 1,
		actualJobId: 0,
		originalRunId: 9,
		runAttempt: 1,
		repositoryId: 1,
		repository: "Org/Repo",
		installationId: 1,
		sandboxName: "hobo-00000000-0000-4000-8000-000000000001",
		sandboxSessionId: "a".repeat(64),
		sandboxStage: "running",
		createdAt: "2026-11-10T12:00:00.000Z",
		...overrides,
	});
}

describe("lease resource occupancy", () => {
	it("releases cap and memory when stop is requested", () => {
		const stopping = lease({
			sandboxStage: "stopping",
		});
		expect(leaseOccupiesWorkerResources(stopping)).toBe(false);
		expect(leaseOccupiesMergeGroupCap(stopping)).toBe(false);
	});

	it("does not count bare reserved leases", () => {
		const reserved = lease({
			state: "reserved",
			sandboxName: "",
			sandboxSessionId: "",
		});
		expect(leaseOccupiesWorkerResources(reserved)).toBe(false);
	});
});
