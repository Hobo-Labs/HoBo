import { describe, expect, it } from "vitest";
import {
	AGENT37_QUEUE_LABELS,
	agent37BoxesToCreate,
	agent37DemandSnapshot,
	agent37RunnerSlotsPerBox,
	countAgent37QueuedJobs,
	DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX,
	jobRequiresAgent37Runner,
	MERGE_GROUP_SCRIPTS_SHARD_COUNT,
	mergeGroupAgent37BoxFloor,
} from "../ci/agent37-fleet-demand.mts";

describe("agent37-fleet-demand", () => {
	it("counts queued jobs that ask for agent37 labels only", () => {
		expect(
			countAgent37QueuedJobs([
				{ status: "queued", labels: ["agent37"] },
				{ status: "queued", labels: ["ubuntu-24.04"] },
				{ status: "in_progress", labels: ["agent37"] },
				{ status: "queued", labels: ["hobo-agent37", "self-hosted"] },
			]),
		).toBe(2);
		expect(
			jobRequiresAgent37Runner({ status: "queued", labels: ["hobo"] }),
		).toBe(false);
		expect(AGENT37_QUEUE_LABELS).toContain("agent37");
	});

	it("sets a merge-group floor of four boxes for four script shards at one slot each", () => {
		expect(mergeGroupAgent37BoxFloor(1)).toBe(MERGE_GROUP_SCRIPTS_SHARD_COUNT);
		expect(mergeGroupAgent37BoxFloor(0)).toBe(0);
	});

	it("reserves one idle runner slot per box for shared council work", () => {
		expect(
			agent37RunnerSlotsPerBox(1, DEFAULT_RESERVED_IDLE_SLOTS_PER_BOX),
		).toBe(1);
		expect(agent37RunnerSlotsPerBox(2, 1)).toBe(1);
	});

	it("models run 46085425374: three idle slots and four queued script shards need another box", () => {
		const snapshot = agent37DemandSnapshot(
			[
				{ status: "queued", labels: ["agent37"] },
				{ status: "queued", labels: ["agent37"] },
				{ status: "queued", labels: ["agent37"] },
				{ status: "queued", labels: ["agent37"] },
			],
			{
				idleRunnerSlots: 3,
				onlineBoxes: 3,
				provisioningBoxes: 0,
				mergeGroupRunsActive: 1,
			},
		);
		expect(snapshot.queuedAgent37Jobs).toBe(4);
		expect(snapshot.mergeGroupBoxFloor).toBe(4);
		expect(snapshot.boxesToCreate).toBe(1);
	});

	it("returns no create when idle supply already covers the queue", () => {
		expect(
			agent37BoxesToCreate({
				queuedAgent37Jobs: 2,
				idleRunnerSlots: 2,
				onlineBoxes: 2,
				mergeGroupRunsActive: 0,
			}),
		).toBe(0);
	});

	it("returns no create when four online boxes already satisfy a merge-group floor", () => {
		expect(
			agent37BoxesToCreate({
				queuedAgent37Jobs: 4,
				idleRunnerSlots: 4,
				onlineBoxes: 4,
				mergeGroupRunsActive: 1,
			}),
		).toBe(0);
	});
});
