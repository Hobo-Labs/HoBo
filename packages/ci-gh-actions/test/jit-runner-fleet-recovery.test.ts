import { create } from "@bufbuild/protobuf";
import { LeaseSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { decideFleetGhostRecovery } from "../src/jit-runner-fleet-recovery.js";

const PEER_RUNNER = "hobo-37c472a9-080d-4c9f-ae64-07de19b0fff8";
const PEER_LEASE = "37c472a9-080d-4c9f-ae64-07de19b0fff8";
const JOB = { repositoryId: 101, id: 130498617302, runAttempt: 1 };

describe("fleet ghost recovery ownership", () => {
	it("defers when the peer box runner is still online", () => {
		expect(
			decideFleetGhostRecovery(
				JOB,
				{
					status: "in_progress",
					runner_name: PEER_RUNNER,
					runner_id: 77,
				},
				[],
				{ id: PEER_LEASE, state: "running", accountId: "peer-account" },
				{ status: "online", busy: true },
				"witness-account",
			),
		).toEqual({
			kind: "defer",
			leaseId: PEER_LEASE,
			reason: "minting_host_active",
		});
	});

	it("releases when GitHub reports the peer runner offline (run 43013191616)", () => {
		expect(
			decideFleetGhostRecovery(
				JOB,
				{
					status: "in_progress",
					runner_name: PEER_RUNNER,
					runner_id: 77,
				},
				[],
				{ id: PEER_LEASE, state: "running", accountId: "peer-account" },
				{ status: "offline", busy: true },
				"witness-account",
			),
		).toEqual({
			kind: "release",
			runnerName: PEER_RUNNER,
			runnerId: 77,
			leaseId: PEER_LEASE,
			role: "fleet_witness",
		});
	});

	it("skips duplicate reserve when this worker already holds custody", () => {
		const lease = create(LeaseSchema, {
			id: PEER_LEASE,
			repositoryId: 101,
			jobId: JOB.id,
			actualJobId: 0,
			runAttempt: 1,
			state: "reserved",
			runnerName: "",
		});
		expect(
			decideFleetGhostRecovery(
				JOB,
				{
					status: "in_progress",
					runner_name: PEER_RUNNER,
					runner_id: 77,
				},
				[lease],
				undefined,
				{ status: "offline", busy: true },
				"witness-account",
			),
		).toEqual({ kind: "covered", leaseId: PEER_LEASE });
	});
});
