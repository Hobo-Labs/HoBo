/**
 * Child process for the crash-mid-append probe: appends batches of three
 * events (one correlation id per batch) as fast as it can and prints
 * `ACKED seq=<n>` after each committed batch, until the parent SIGKILLs it.
 * A batch the kill interrupts must be wholly absent after restart.
 */
import { createPostgresEventStore } from "../../src/index.js";

const [url, schema] = process.argv.slice(2);
if (url === undefined || schema === undefined) {
	process.stderr.write("usage: append-crasher <url> <schema>\n");
	process.exit(2);
}

const store = createPostgresEventStore({
	config: { connectionString: url, schema, poolSize: 2 },
	clock: { now: () => "2026-11-12T00:00:00.000Z" },
});

let seq = 0;
for (let batch = 1; ; batch += 1) {
	const result = await store.append(
		"durability:crash",
		[1, 2, 3].map((n) => ({ type: "durability.Written", data: { batch, n } })),
		{
			expectedSeq: seq,
			actor: { kind: "system", id: "crasher" },
			tenant: "conformance",
			correlationId: `batch-${batch}`,
		},
	);
	seq += result.appended.length;
	process.stdout.write(`ACKED seq=${seq}\n`);
}
