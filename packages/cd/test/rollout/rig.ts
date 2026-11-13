// A composed orchestrator over the real Harness engine adapter and the fakes.
import { createHarnessRolloutEngine } from "../../src/adapters/harness.js";
import type { RolloutEngine, RolloutOrchestrator } from "../../src/ports.js";
import type { CanaryCapacity } from "../../src/rollout/capacity.js";
import {
	createRolloutOrchestrator,
	type ExperimentConclusions,
} from "../../src/rollout/orchestrator.js";
import {
	clock,
	context,
	FakeApprovals,
	FakeDesired,
	FakeTraffic,
	FakeVerification,
	FakeWindows,
	MemoryEventStore,
	RecordingTelemetry,
	TENANT,
} from "./fakes.js";

export type Rig = ReturnType<typeof rig>;

export function rig(
	options: Readonly<{
		store?: MemoryEventStore;
		capacity?: CanaryCapacity;
		experiments?: ExperimentConclusions;
		start?: number;
	}> = {},
) {
	const store = options.store ?? new MemoryEventStore();
	const time = clock(options.start);
	const traffic = new FakeTraffic();
	const verification = new FakeVerification();
	const windows = new FakeWindows();
	const desired = new FakeDesired();
	const approvals = new FakeApprovals();
	const telemetry = new RecordingTelemetry();
	const base = { store, tenant: TENANT, now: time.now };
	const engine: RolloutEngine = createHarnessRolloutEngine(base);
	const build = (): RolloutOrchestrator =>
		createRolloutOrchestrator({
			...base,
			engine,
			traffic,
			verification,
			windows,
			desired,
			approvals,
			telemetry,
			...(options.capacity === undefined
				? undefined
				: { capacity: options.capacity }),
			...(options.experiments === undefined
				? undefined
				: { experiments: options.experiments }),
		});
	const orchestrator = build();
	const ctx = context(time.now);
	return {
		store,
		time,
		traffic,
		verification,
		windows,
		desired,
		approvals,
		telemetry,
		engine,
		orchestrator,
		ctx,
	};
}
