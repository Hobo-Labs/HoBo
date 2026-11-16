import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableHostingMutationJournal } from "../src/hosting-mutation-journal.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
const requestDigest = `sha256:${"a".repeat(64)}`;
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "hosting-mutation-journal-"));
	dispose.push(() => rmSync(dataDir, { recursive: true, force: true }));
	function connect(fenceToken = 1n) {
		const store = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock("2026-10-29T12:00:00Z"),
		});
		dispose.push(() => store.close());
		return {
			store,
			journal: createDurableHostingMutationJournal({
				store,
				tenantId: "tenant",
				actor: { kind: "service", id: "hosting-worker" },
				fenceToken,
				nowMs: () => 1000,
			}),
		};
	}
	return { connect };
}
describe("durable provider mutation claims", () => {
	it("grants a single send across two independent SQLite connections", async () => {
		const fx = fixture(),
			a = fx.connect(),
			b = fx.connect();
		const results = await Promise.all([
			a.journal.claim({ mutationId: "create:app", requestDigest }),
			b.journal.claim({ mutationId: "create:app", requestDigest }),
		]);
		expect(results.map((row) => row.status).sort()).toEqual([
			"claimed",
			"uncertain",
		]);
	});
	it("recovers a crash before network dispatch as uncertain and never grants another send", async () => {
		const fx = fixture(),
			first = fx.connect();
		expect(
			(await first.journal.claim({ mutationId: "create:app", requestDigest }))
				.status,
		).toBe("claimed");
		const reopened = fx.connect();
		expect(
			(
				await reopened.journal.claim({
					mutationId: "create:app",
					requestDigest,
				})
			).status,
		).toBe("uncertain");
	});
	it("replays acknowledgement and rejects changed-request reuse", async () => {
		const { journal } = fixture().connect();
		await journal.claim({ mutationId: "create:app", requestDigest });
		await journal.acknowledge("create:app", requestDigest);
		await journal.acknowledge("create:app", requestDigest);
		await journal.uncertain("create:app", requestDigest);
		expect(
			(await journal.claim({ mutationId: "create:app", requestDigest })).status,
		).toBe("acknowledged");
		await expect(
			journal.claim({
				mutationId: "create:app",
				requestDigest: `sha256:${"b".repeat(64)}`,
			}),
		).rejects.toThrow("different request");
	});
	it("requires a prior claim and a canonical digest for every state change", async () => {
		const { journal } = fixture().connect();
		await expect(journal.acknowledge("unknown", requestDigest)).rejects.toThrow(
			"no durable claim",
		);
		await expect(
			journal.claim({
				mutationId: "create:app",
				requestDigest: "token-shaped-value",
			}),
		).rejects.toThrow("canonical content digest");
	});
	it("retains explicit unknown outcomes across a reopen without storing provider responses", async () => {
		const fx = fixture(),
			first = fx.connect();
		await first.journal.claim({ mutationId: "create:app", requestDigest });
		await first.journal.uncertain("create:app", requestDigest);
		const reopened = fx.connect();
		expect(
			(
				await reopened.journal.claim({
					mutationId: "create:app",
					requestDigest,
				})
			).status,
		).toBe("uncertain");
		const data = [];
		for await (const item of first.store.readAll()) data.push(item.event.data);
		expect(Object.keys(data[0]).sort()).toEqual([
			"mutationId",
			"recordedAtMs",
			"requestDigest",
			"status",
		]);
	});
});
