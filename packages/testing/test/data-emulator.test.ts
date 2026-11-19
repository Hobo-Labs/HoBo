import {
	assertBindingMatchesDeclaration,
	encodeRecordKey,
	parseCanonicalRecord,
	parseDatasetSchema,
	runEngineConformance,
	upsertMutation,
} from "@hobo/data-core";
import { describe, expect, it } from "vitest";
import { createDataEmulator, createTestHarness } from "../src/index.js";
import { fakeBindle } from "./fixtures.js";

const orders = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string" },
		{ name: "status", type: "string" },
	],
	open: false,
});

function app() {
	return fakeBindle({
		resources: { db: { kind: "data" }, other: { kind: "data" } },
		handlers: {},
	});
}

describe("in-process data engines", () => {
	it("stores records through the data SPI, isolating tenants and resource aliases", async () => {
		const harness = createTestHarness();
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		const db = graph.data("db");
		try {
			assertBindingMatchesDeclaration(db);
			expect(db.declaration.engine).toBe("sqlite");
			expect(db.schema).toBeUndefined();
			await db.datasets.ensureDataset(orders);
			const record = parseCanonicalRecord(orders, { id: "one", status: "new" });
			const key = encodeRecordKey(orders, record);
			await db.records.write({
				dataset: "orders",
				mutations: [upsertMutation("tenant-a", key, record)],
			});
			expect(
				await db.records.read({ dataset: "orders", tenant: "tenant-a", key }),
			).toEqual(record);
			expect(
				await db.records.read({ dataset: "orders", tenant: "tenant-b", key }),
			).toBeUndefined();
			expect(
				await graph.data("other").datasets.describeDataset("orders"),
			).toBeUndefined();
			expect(graph.resource("db").fidelity).toBe("simulated");
		} finally {
			await harness.destroy(bindle)();
		}
		expect(() =>
			db.records.read({ dataset: "orders", tenant: "tenant-a", key: "closed" }),
		).toThrow();
		await db.close();
	});

	it("runs the shared data-engine conformance suite on the built-in emulator", async () => {
		const report = await runEngineConformance({
			engine: {
				create: () => createDataEmulator().port,
				positionPastHead: (head) => String(Number(head) + 1_000_000),
			},
			now: "2026-11-10T00:00:00.000Z",
		});
		const failures = report.results
			.filter((result) => result.status !== "pass")
			.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
			.join("\n");
		expect(report.outcome, failures).toBe("pass");
		expect(report.results.length).toBeGreaterThan(30);
	}, 120_000);

	it("uses replacement factories and closes their engines on teardown", async () => {
		let closed = 0;
		const harness = createTestHarness({
			emulators: {
				data: () => {
					const engine = createDataEmulator();
					return {
						...engine,
						fidelity: "mocked",
						close: () => {
							closed += 1;
							return engine.close();
						},
					};
				},
			},
		});
		const bindle = app();
		const graph = await harness.deploy(bindle)();
		graph.data("db");
		expect(graph.fidelity().prodReadinessClaimable).toBe(false);
		await harness.destroy(bindle)();
		await harness.destroy(bindle)();
		expect(closed).toBe(2);
	});

	it("closes an engine returned by an invalid factory before refusing deployment", async () => {
		const engine = createDataEmulator();
		await engine.port.datasets.ensureDataset(orders);
		const harness = createTestHarness({
			emulators: {
				// @ts-expect-error Exercise a JavaScript factory missing the required close method.
				data: () => ({ port: engine.port, fidelity: "simulated" }),
			},
		});
		await expect(harness.deploy(app())()).rejects.toMatchObject({
			code: "HARNESS_EMULATOR_INVALID",
		});
		expect(() =>
			engine.port.records.read({
				dataset: "orders",
				tenant: "a",
				key: "closed",
			}),
		).toThrow();
	});
});
