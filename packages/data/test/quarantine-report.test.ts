import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import { parseEventPosition } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
	QuarantineReportSchema,
	readQuarantineReport,
} from "../src/index.js";

const context = {
	actor: { kind: "user", id: "operator" } as const,
	tenant: "workspace",
};

it("reports persisted aggregate, projection, and event-store quarantines across pages", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-quarantine-report-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Invalid", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const aggregate = defineAggregate<number, "noop">({
			name: "items-aggregate",
			initialState: 0,
			evolve() {
				throw new Error("aggregate failed");
			},
			decide() {},
		});
		await aggregate.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"noop",
			context,
		);
		const projection = defineProjection({
			name: "items-projection",
			key: (event) => event.streamId,
			on: {
				"item.Invalid": () => {
					throw new Error("projection failed");
				},
			},
		});
		await projection.rebuildWithQuarantine(store, "items", {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		});
		await store.append("legacy", [{ type: "item.Invalid", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		await store.fold("legacy", {
			initialState: 0,
			handlers: {
				"item.Invalid": () => {
					throw new Error("event store failed");
				},
			},
		});
		const first = await readQuarantineReport({
			store,
			tenant: "workspace",
			maxScanned: 2,
		});
		expect(first.complete).toBe(false);
		expect(first.nextPosition).not.toBe("");
		expect(first.findings.map((finding) => finding.foldKind)).toEqual([
			"aggregate",
		]);
		const second = await readQuarantineReport({
			store,
			tenant: "workspace",
			after: parseEventPosition(first.nextPosition),
		});
		expect(second.complete).toBe(true);
		expect(second.nextPosition).toBe("");
		expect(
			second.findings.map((finding) => [finding.foldKind, finding.reason]),
		).toEqual([
			["projection", "projection failed"],
			["eventstore", "event store failed"],
		]);
		expect(first.findings[0]).toMatchObject({
			code: "event-log.poison-quarantined",
			severity: "incident",
			sourceStreamId: "items",
			offendingSeq: 1n,
			fold: "items-aggregate",
			reason: "aggregate failed",
		});
		expect(second.findings[0]).toMatchObject({
			sourceStreamId: "items",
			fold: "items-projection",
			recordStreamId: "projection-quarantines",
		});
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/data.cue", import.meta.url),
		);
		for (const report of [first, second]) {
			const reportJson = toJson(QuarantineReportSchema, report, {
				alwaysEmitImplicit: true,
			});
			const jsonPath = join(directory, "report.json");
			writeFileSync(jsonPath, JSON.stringify(reportJson));
			execFileSync(cue, ["vet", schema, jsonPath, "-d", "#QuarantineReport"]);
		}
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("reports malformed quarantine facts instead of silently hiding them", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-quarantine-report-invalid-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[{ type: "aggregate.QuarantineRecorded", data: {} }],
			{ ...context, expectedSeq: 0 },
		);
		await expect(
			readQuarantineReport({ store, tenant: "workspace" }),
		).rejects.toThrow("invalid quarantine target sequence");
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
