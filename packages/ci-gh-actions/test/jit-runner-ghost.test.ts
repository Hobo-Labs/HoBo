import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { decideGhostBoxRunnerBinding } from "../src/jit-runner-ghost.js";

const LEASE_ID = "e2ac3917-9cb0-409b-abd2-8f757d2ab809";
const RUNNER = `hobo-${LEASE_ID}`;

describe("ghost box runner binding", () => {
	it("detects a ghost when GitHub bound an in-progress job to a retired lease runner", () => {
		const decision = decideGhostBoxRunnerBinding(
			{ repositoryId: 101, id: 130481461637, runAttempt: 1 },
			{
				status: "in_progress",
				runner_name: RUNNER,
				runner_id: 88,
			},
			[],
		);
		expect(decision).toEqual({
			kind: "ghost",
			runnerName: RUNNER,
			runnerId: 88,
		});
	});

	it("skips duplicate reserve when an active lease already covers the job", () => {
		const lease = create(LeaseSchema, {
			id: LEASE_ID,
			repositoryId: 101,
			jobId: 130481461637,
			actualJobId: 0,
			runAttempt: 1,
			state: "reserved",
			runnerName: "",
		});
		const decision = decideGhostBoxRunnerBinding(
			{ repositoryId: 101, id: 130481461637, runAttempt: 1 },
			{
				status: "in_progress",
				runner_name: RUNNER,
				runner_id: 88,
			},
			[lease],
		);
		expect(decision).toEqual({ kind: "covered", leaseId: LEASE_ID });
	});

	it("reproduces run 43008157463: dead e2ac3917 binding with no active box leases", () => {
		const shard2JobId = 130481461637;
		const ghost = decideGhostBoxRunnerBinding(
			{ repositoryId: 101, id: shard2JobId, runAttempt: 1 },
			{
				status: "in_progress",
				runner_name: RUNNER,
				runner_id: 88,
			},
			[],
		);
		expect(ghost.kind).toBe("ghost");

		const secondReserveLease = create(LeaseSchema, {
			id: "second-reserve-lease",
			repositoryId: 101,
			jobId: shard2JobId,
			actualJobId: 0,
			runAttempt: 1,
			state: "reserved",
			runnerName: "",
		});
		const duplicate = decideGhostBoxRunnerBinding(
			{ repositoryId: 101, id: shard2JobId, runAttempt: 1 },
			{
				status: "in_progress",
				runner_name: RUNNER,
				runner_id: 88,
			},
			[secondReserveLease],
		);
		expect(duplicate).toEqual({
			kind: "covered",
			leaseId: "second-reserve-lease",
		});
	});

	it("ignores foreign fleet runners", () => {
		expect(
			decideGhostBoxRunnerBinding(
				{ repositoryId: 101, id: 1, runAttempt: 1 },
				{
					status: "in_progress",
					runner_name: "hobo-runner-arc",
					runner_id: 1,
				},
				[],
			),
		).toEqual({ kind: "none" });
	});
});
