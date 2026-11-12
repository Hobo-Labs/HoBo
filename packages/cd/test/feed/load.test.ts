// Feed load baseline (WP11 Accept): 1,000 Camps served by 50 agents (20 each)
// over the delivery feed. Every Camp is claimed, fed, reported and
// checkpointed through the real agent transport and feed handler, with SVID
// and DPoP verification and the journal-backed replay store on every request.
// p99 frame latency (feed request → frame received) and p99 checkpoint
// latency are recorded in the test output and bounded generously so the lane
// catches order-of-magnitude regressions, not machine noise.
import { describe, expect, it } from "vitest";
import { ReconcileStatus } from "../../src/_generated/cd_pb.js";
import { resolvedFor } from "./fakes.js";
import {
	camp,
	collect,
	createStation,
	observation,
	provisionAgent,
} from "./harness.js";

const CAMPS = 1_000;
const AGENTS = 50;

function p99(samples: readonly number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)] ??
		0
	);
}

describe("delivery feed load baseline", () => {
	it(`serves ${CAMPS} Camps with ${AGENTS} agents and records p99 frame and checkpoint latency`, async () => {
		const camps = Array.from(
			{ length: CAMPS },
			(_, i) => `camp-${String(i).padStart(4, "0")}`,
		);
		const station = createStation({ camps, longPollMs: 1_000 });
		for (const id of camps) await station.desired.publish(id, resolvedFor(id));
		const perAgent = CAMPS / AGENTS;
		const agents = [];
		for (let a = 0; a < AGENTS; a += 1)
			agents.push(
				await provisionAgent(station, {
					campIds: camps.slice(a * perAgent, (a + 1) * perAgent),
				}),
			);

		const frameMs: number[] = [];
		const checkpointMs: number[] = [];
		const signal = new AbortController().signal;
		const started = performance.now();
		await Promise.all(
			agents.map(async (agent, a) => {
				for (const id of camps.slice(a * perAgent, (a + 1) * perAgent)) {
					const lease = await agent.transport.claim({
						reconcilerId: agent.reconcilerId,
						campId: camp(id),
						holderId: `host-${a}`,
						ttlMs: 30_000,
					});
					if (!lease.ok) throw new Error(`${id}: ${lease.reasons[0]?.code}`);
					const t0 = performance.now();
					const [change] = await collect(
						agent.transport.feed({ lease: lease.value, signal }),
					);
					frameMs.push(performance.now() - t0);
					if (!change) throw new Error(`${id}: no frame`);
					const reported = await agent.transport.report(
						lease.value,
						observation(lease.value, change.set, ReconcileStatus.CONVERGED),
					);
					if (!reported.ok)
						throw new Error(`${id}: ${reported.reasons[0]?.code}`);
					const t1 = performance.now();
					const committed = await agent.transport.checkpoint(
						lease.value,
						change.position,
					);
					checkpointMs.push(performance.now() - t1);
					if (!committed.ok)
						throw new Error(`${id}: ${committed.reasons[0]?.code}`);
				}
			}),
		);
		const totalMs = performance.now() - started;
		const baseline = {
			camps: CAMPS,
			agents: AGENTS,
			frames: frameMs.length,
			checkpoints: checkpointMs.length,
			p99FrameMs: Number(p99(frameMs).toFixed(2)),
			p99CheckpointMs: Number(p99(checkpointMs).toFixed(2)),
			totalMs: Math.round(totalMs),
		};
		console.info(`hobo.cd.feed load baseline ${JSON.stringify(baseline)}`);
		expect(frameMs).toHaveLength(CAMPS);
		expect(checkpointMs).toHaveLength(CAMPS);
		expect(baseline.p99FrameMs).toBeLessThan(2_000);
		expect(baseline.p99CheckpointMs).toBeLessThan(1_000);
		// Every Camp converged exactly once on its status stream.
		const converged = station.store.log.filter(
			(e) => e.event.type === "deployment.Converged",
		);
		expect(converged).toHaveLength(CAMPS);
	}, 300_000);
});
