import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "../../src/index.js";

const dataDir = process.argv[2];
if (!dataDir) {
	console.error("usage: append-crasher <dataDir>");
	process.exit(1);
}

const store = createRuntimeLocalEventStore({
	dataDir,
	clock: createManualClock("2026-06-26T00:00:00.000Z"),
});
const streamId = "durability:crash";

let batch = 0;
while (true) {
	const correlationId = `batch-${batch}`;
	const result = await store.append(
		streamId,
		[
			{ type: "load.StepStarted", data: { batch, step: 1 } },
			{ type: "load.StepStarted", data: { batch, step: 2 } },
			{ type: "load.StepStarted", data: { batch, step: 3 } },
		],
		{
			expectedSeq: batch * 3,
			actor: { kind: "system", id: "append-crasher" },
			tenant: "durability-tenant",
			correlationId,
		},
	);
	const last = result.appended.at(-1);
	if (last) {
		process.stdout.write(`ACKED seq=${last.seq}\n`);
	}
	batch += 1;
}
