import { clone, create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { LeaseSchema } from "../src/_generated/ci_pb.js";
import { isIsolatedRetirementTransition } from "../src/isolated-retirement.js";

const createdAt = "2026-10-30T12:00:00Z";
const at = "2026-10-30T12:01:00Z";

function lease() {
	return create(LeaseSchema, {
		id: "lease-1",
		provider: "hobo-box-worker",
		state: "running",
		createdAt,
		sandboxName: "hobo-lease-1",
		sandboxSessionId: "session-1",
		sandboxStage: "running",
	});
}

describe("isolated session retirement", () => {
	it("accepts only the ordered stop and removal bookkeeping", () => {
		const running = lease();
		const stopping = clone(LeaseSchema, running);
		stopping.sandboxStage = "stopping";
		const stopped = clone(LeaseSchema, stopping);
		stopped.sandboxStage = "stopped";
		const removed = clone(LeaseSchema, stopped);
		removed.usageCompletedAt = at;
		expect(
			isIsolatedRetirementTransition(
				running,
				stopping,
				"ci.SandboxStopRequested",
				at,
			),
		).toBe(true);
		expect(
			isIsolatedRetirementTransition(
				stopping,
				stopped,
				"ci.SandboxStopped",
				at,
			),
		).toBe(true);
		expect(
			isIsolatedRetirementTransition(stopped, removed, "ci.SandboxRemoved", at),
		).toBe(true);
		expect(
			isIsolatedRetirementTransition(running, stopped, "ci.SandboxStopped", at),
		).toBe(false);
		expect(
			isIsolatedRetirementTransition(
				stopped,
				stopping,
				"ci.SandboxStopRequested",
				at,
			),
		).toBe(false);
	});

	it("does not let an event name authorize changes to execution, identity or liability", () => {
		const before = lease();
		const stopping = clone(LeaseSchema, before);
		stopping.sandboxStage = "stopping";
		for (const mutate of [
			(value: typeof stopping) => {
				value.runnerId = 99;
			},
			(value: typeof stopping) => {
				value.sandboxSessionId = "other-session";
			},
			(value: typeof stopping) => {
				value.reservedPaidMicros = 1;
			},
			(value: typeof stopping) => {
				value.state = "claiming";
			},
			(value: typeof stopping) => {
				value.usageCompletedAt = at;
			},
		]) {
			const forged = clone(LeaseSchema, stopping);
			mutate(forged);
			expect(
				isIsolatedRetirementTransition(
					before,
					forged,
					"ci.SandboxStopRequested",
					at,
				),
			).toBe(false);
		}
		expect(
			isIsolatedRetirementTransition(before, stopping, "ci.RunnerStarted", at),
		).toBe(false);
		expect(
			isIsolatedRetirementTransition(
				before,
				stopping,
				"ci.SandboxStopRequested",
				"invalid",
			),
		).toBe(false);
		expect(
			isIsolatedRetirementTransition(
				before,
				stopping,
				"ci.SandboxStopRequested",
				"2026-10-30T11:59:59Z",
			),
		).toBe(false);
		for (const mutate of [
			(value: typeof before) => {
				value.provider = "github";
			},
			(value: typeof before) => {
				value.pipelineId = "pipeline";
			},
			(value: typeof before) => {
				value.sandboxName = "unrelated";
			},
			(value: typeof before) => {
				value.sandboxSessionId = "";
			},
			(value: typeof before) => {
				value.state = "completed";
			},
		]) {
			const alteredBefore = clone(LeaseSchema, before);
			mutate(alteredBefore);
			const alteredAfter = clone(LeaseSchema, alteredBefore);
			alteredAfter.sandboxStage = "stopping";
			expect(
				isIsolatedRetirementTransition(
					alteredBefore,
					alteredAfter,
					"ci.SandboxStopRequested",
					at,
				),
			).toBe(false);
		}
	});
});
