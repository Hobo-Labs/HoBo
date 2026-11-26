import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	collectStream,
	createManualClock,
	createRuntimeLocalEventStore,
	OptimisticSequenceConflictError,
} from "../src/index.js";

const pactPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"contracts",
	"pacts",
	"runtime-sdk-eventstore.pact.json",
);

describe("runtime-sdk-eventstore pact", () => {
	it("replays append, conflict, and dedup interactions against the provider store", async () => {
		const pact = JSON.parse(readFileSync(pactPath, "utf8"));
		expect(pact.consumer.name).toBe("@hobo/sdk-runtime");
		expect(pact.provider.name).toBe("@hobo/runtime-local");

		const store = createRuntimeLocalEventStore({
			dataDir: mkdtempSync(join(tmpdir(), "hobo-pact-")),
			clock: createManualClock("2026-06-26T00:00:00.000Z"),
		});

		const happy = pact.interactions[0];
		const happyBody = happy.request.body;
		const happyResult = await store.append(
			happyBody.streamId,
			happyBody.events,
			{
				expectedSeq: happyBody.expectedSeq,
				actor: happyBody.actor,
				tenant: happyBody.tenant,
			},
		);
		expect(happyResult.appended[0]?.type).toBe("run.Started");
		expect(happyResult.appended[0]?.seq).toBe(1);

		await store.append("order:1", [{ type: "order.Created", data: {} }], {
			expectedSeq: 0,
			actor: { kind: "system", id: "runtime-local" },
			tenant: "tenant-a",
		});
		await expect(
			store.append(
				"order:1",
				[{ type: "order.Discounted", data: { amount: 5 } }],
				{
					expectedSeq: 0,
					actor: { kind: "system", id: "runtime-local" },
					tenant: "tenant-a",
				},
			),
		).rejects.toBeInstanceOf(OptimisticSequenceConflictError);

		const dedupEvent = pact.interactions[2].request.body.events[0];
		await store.append("invoice:1", [dedupEvent], {
			expectedSeq: 0,
			actor: { kind: "system", id: "runtime-local" },
			tenant: "tenant-a",
		});
		const dedup = await store.append("invoice:1", [dedupEvent], {
			expectedSeq: 0,
			actor: { kind: "system", id: "runtime-local" },
			tenant: "tenant-a",
		});
		expect(dedup.appended).toHaveLength(0);
		expect(dedup.deduped[0]?.meta?.idempotencyKey).toBe("charge-123");
		expect((await collectStream(store, "invoice:1")).length).toBe(1);

		store.close();
	});
});
