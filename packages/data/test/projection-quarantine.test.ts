import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { defineProjection } from "../src/projection.js";

it("quarantines only the matching sequence in the matching stream", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-projection-stream-"));
	const store = createRuntimeLocalEventStore({
		dataDir: join(dataDir, "first"),
	});
	const other = createRuntimeLocalEventStore({
		dataDir: join(dataDir, "second"),
	});
	try {
		const append = {
			expectedSeq: 0,
			tenant: "tenant-a",
			actor: { kind: "user", id: "u1" },
		} as const;
		await store.append(
			"stream-a",
			[{ type: "probe.Accepted", data: {} }],
			append,
		);
		await store.append(
			"stream-b",
			[
				{ type: "probe.Accepted", data: {} },
				{ type: "probe.Accepted", data: {} },
				{ type: "probe.Quarantined", data: { offendingSeq: 1 } },
			],
			append,
		);
		await other.append("stream-b", [{ type: "probe.Accepted", data: {} }], {
			...append,
			tenant: "tenant-b",
		});
		const events: EventEnvelope[] = [];
		for await (const entry of store.readAll()) events.push(entry.event);
		for await (const entry of other.readAll()) events.push(entry.event);
		const projection = defineProjection<{ count: number }>({
			name: "probe",
			key: (event) => `${event.tenant}/${event.streamId}`,
			on: { "probe.Accepted": (row) => ({ count: (row?.count ?? 0) + 1 }) },
		});
		const snapshot = projection.fold(events.reverse());
		expect(projection.get(snapshot, "tenant-a/stream-a")).toEqual({ count: 1 });
		expect(projection.get(snapshot, "tenant-a/stream-b")).toEqual({ count: 1 });
		expect(projection.get(snapshot, "tenant-b/stream-b")).toEqual({ count: 1 });
	} finally {
		store.close();
		other.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});
