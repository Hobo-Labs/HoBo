/**
 * Watch a relay mesh hand out jobs, on one machine.
 *
 *   pnpm --filter @hobo/ci-gh-actions run mesh:demo
 *   HOBO_CI_NATS_URL=nats://127.0.0.1:4222 pnpm --filter @hobo/ci-gh-actions run mesh:demo
 *
 * Without HOBO_CI_NATS_URL the nodes share an in-memory board and claims.
 * With it they use the real NATS adapter (start one with
 * `docker run --rm -p 4222:4222 nats:2 -js` or `nats-server -js`).
 *
 * Options: --nodes 1,2,5 (free slots per node)  --jobs 400  --step-ms 20000
 *
 * It queues a batch with every node up, then a second batch after the
 * largest node has died without saying so, and prints who took what.
 */
import process from "node:process";
import { createMemoryMesh, createMeshCoordinator } from "@hobo/ci/mesh";
import { meshSettingsFromEnv } from "@hobo/ci-gh-actions";

function option(name: string, fallback: string): string {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const slots = option("nodes", "1,2,5")
	.split(",")
	.map((value) => Number(value))
	.filter((value) => Number.isInteger(value) && value > 0);
const jobCount = Number(option("jobs", "400"));
const stepMs = Number(option("step-ms", "20000"));
const settings = meshSettingsFromEnv(process.env, "demo");
const namespace = `demo-${Date.now().toString(36)}`;

const memory = createMemoryMesh();
const closers: (() => Promise<void>)[] = [];
// The demo moves its own clock so nobody has to wait for a real step.
const clock = { now: Date.now() };

const nodes = await Promise.all(
	slots.map(async (freeSlots, index) => {
		const id = `node-${index + 1}`;
		let ports = memory;
		if (settings) {
			const { createNatsMesh } = await import("@hobo/ci-gh-actions/mesh-nats");
			const nats = createNatsMesh({
				servers: settings.servers,
				namespace,
				name: `mesh-demo ${id}`,
			});
			await nats.ready;
			closers.push(() => nats.close());
			ports = nats;
		}
		const coordinator = createMeshCoordinator({
			self: () => ({
				id,
				freeSlots,
				healthy: true,
				labels: ["hobo"],
				validUntilMs: clock.now + 3_600_000,
			}),
			board: ports.board,
			claims: ports.claims,
			stepMs,
			viewMaxAgeMs: 0,
			now: () => clock.now,
		});
		await coordinator.advertise();
		return { id, freeSlots, coordinator };
	}),
);

let nextJob = 1;
async function batch(alive: readonly string[], rounds: number) {
	const jobs = Array.from({ length: jobCount }, () => nextJob++);
	const queuedAtMs = clock.now;
	const taken = new Map<number, string[]>();
	for (let round = 0; round < rounds; round += 1) {
		await Promise.all(
			nodes
				.filter((each) => alive.includes(each.id))
				.map(async (each) => {
					for (const jobId of jobs) {
						if (taken.get(jobId)?.includes(each.id)) continue;
						const decision = await each.coordinator.shouldStart({
							jobId,
							label: "hobo",
							queuedAtMs,
						});
						if (decision.start)
							taken.set(jobId, [...(taken.get(jobId) ?? []), each.id]);
					}
				}),
		);
		clock.now += stepMs;
	}
	const once = jobs.filter((jobId) => taken.get(jobId)?.length === 1).length;
	console.log(
		`  ${jobs.length} jobs: ${once} taken once, ${jobs.filter((jobId) => (taken.get(jobId)?.length ?? 0) > 1).length} twice, ${jobs.filter((jobId) => !taken.has(jobId)).length} left`,
	);
	for (const each of nodes) {
		const count = jobs.filter(
			(jobId) => taken.get(jobId)?.[0] === each.id,
		).length;
		console.log(
			`  ${each.id}  slots ${each.freeSlots}  took ${`${count}`.padStart(4)}  ${((100 * count) / jobs.length).toFixed(1)}%${alive.includes(each.id) ? "" : "  (dead)"}`,
		);
	}
}

console.log(
	`mesh demo: ${nodes.length} nodes on ${settings ? `NATS ${settings.servers.join(", ")} (namespace ${namespace})` : "an in-memory mesh"}`,
);
console.log("all nodes up:");
await batch(
	nodes.map((each) => each.id),
	1,
);
const largest = [...nodes].sort((a, b) => b.freeSlots - a.freeSlots)[0];
console.log(
	`${largest?.id} dies without a word; the others wait out its turn:`,
);
await batch(
	nodes.filter((each) => each !== largest).map((each) => each.id),
	3,
);
await Promise.all(closers.map((close) => close()));
