import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrossCampProjection, defineProjection } from "@hobo/data";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { projectionDiagnostics } from "../src/projection-diagnostics.js";

it("reports replica consistency and missing lag signals from the local journal", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-doctor-"));
	const owner = createRuntimeLocalEventStore({
		dataDir: join(directory, "owner"),
	});
	const replica = createRuntimeLocalEventStore({
		dataDir: join(directory, "replica"),
	});
	try {
		const projection = defineProjection({
			name: "tickets",
			key: (event) => event.streamId,
			on: {},
		});
		const runtime = createCrossCampProjection({
			projection,
			owner,
			replica,
			ownerCampId: "east",
			replicaCampId: "west",
			replicaStreamId: "replica:tickets",
			tenant: "workspace",
			actor: { kind: "user", id: "operator" },
			maxStalenessMs: 100,
			nowMs: () => 1000,
		});
		await runtime.replicate();
		const diagnostic = await projectionDiagnostics(
			replica,
			"workspace",
			() => 1200,
		);
		expect(diagnostic).toMatchObject({
			available: true,
			json: {
				replicas: [
					{
						projection: "tickets",
						stalenessStatus: "exceeds-bound",
						missingLagSignal: true,
					},
				],
			},
		});
		expect(await projectionDiagnostics(undefined, "workspace")).toMatchObject({
			available: false,
		});
	} finally {
		owner.close();
		replica.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
