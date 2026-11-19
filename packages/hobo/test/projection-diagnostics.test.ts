import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrossCampProjection, defineProjection } from "@hobo/data";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	buildProjectionDoctorSection,
	projectionDiagnostics,
} from "../src/projection-diagnostics.js";

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
		const progress: string[] = [];
		const section = await buildProjectionDoctorSection(
			replica,
			"workspace",
			(message) => progress.push(message),
			() => 1200,
		);
		expect(section.diagnostic).toMatchObject({
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
		expect(progress).toEqual(
			expect.arrayContaining([
				expect.stringContaining("tickets owner/session"),
				expect.stringContaining("tickets replica/bounded-staleness"),
				expect.stringContaining("tickets replica/eventual"),
				expect.stringContaining("without a lag signal"),
			]),
		);
		expect(section.remediation).toContain(
			"Inspect replica replica:tickets and its lag reporting.",
		);
		expect(await projectionDiagnostics(undefined, "workspace")).toMatchObject({
			available: false,
		});
	} finally {
		owner.close();
		replica.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
