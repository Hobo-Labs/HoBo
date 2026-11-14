import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	admitAuthorityMove,
	CUSTODY_ROLES,
	createEventStoreMigrationJournal,
	encodeRecordKey,
	evaluateCustodyPath,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { createSqliteEngine } from "@hobo/data-sqlite";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import {
	executeDataHandover,
	inspectDataHandover,
} from "../src/data-handover.js";
import type { DataMigrationJournal } from "../src/migration-executor.js";

const NOW = "2026-11-10T00:00:00.000Z";
const schema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});
const path = parseCustodyPath({
	points: CUSTODY_ROLES.map((role) => ({
		id: role,
		role,
		region: "eu-west-1",
		protections: [],
		...(role === "source" ||
		role === "target" ||
		role === "event-log" ||
		role === "target-event-log"
			? undefined
			: { retainUntil: "2026-11-17T00:00:00.000Z" }),
	})),
});

describe("Trails durable data handover", () => {
	it("resumes a fenced, zero-loss copy on real stores and retires only after soak", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-trail-handover-"));
		const sourcePath = join(dir, "source.db"),
			targetPath = join(dir, "target.db");
		const store = createRuntimeLocalEventStore({
			dataDir: join(dir, "journal"),
			clock: createManualClock(),
		});
		let source = createSqliteEngine({ path: sourcePath, clock: () => NOW });
		let target = createSqliteEngine({ path: targetPath, clock: () => NOW });
		const inner = createEventStoreMigrationJournal(store, {
			tenant: "acme",
			actor: { kind: "system", id: "test" },
		});
		// SAFETY: both journals use the same JSON facts and conditional count.
		const journal = inner as DataMigrationJournal;
		const router = new Map<string, number>();
		let writable = "source",
			authorizations = 0,
			permit = true,
			soak: "hold" | "finalize" = "hold";
		function input() {
			return {
				tenant: "acme",
				campId: "orders",
				setId: "set_12345678",
				schema,
				scope: scopeOf("orders"),
				journal,
				clock: () => NOW,
				source: {
					yard: "old-yard",
					provider: "source-provider",
					accountId: "source-account",
					resourceId: "source-db",
					engine: source,
				},
				target: {
					yard: "new-yard",
					provider: "target-provider",
					accountId: "target-account",
					resourceId: "target-db",
					engine: target,
				},
				async revalidate() {
					authorizations++;
					if (!permit) throw new Error("authorization expired");
				},
				policy: () =>
					evaluateCustodyPath({
						path,
						policy: { classification: "public" },
						now: NOW,
					}),
				flipAuthority(move: {
					migrationId: string;
					head: number;
					direction: "to-source" | "to-target";
				}) {
					admitAuthorityMove(router, move);
					writable = move.direction === "to-target" ? "target" : "source";
				},
				soakDecision: () => soak,
			};
		}
		try {
			expect((await inspectDataHandover(input())).status).toBe("new");
			await source.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "a", total: "1" });
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			const first = await executeDataHandover({
				...input(),
				pauseAfter: "verify",
			});
			expect(first.status).toBe("held");
			expect((await inspectDataHandover(input())).status).toBe("running");
			expect(writable).toBe("source");
			const record2 = parseCanonicalRecord(schema, { id: "b", total: "2" });
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record2), record2),
				],
			});
			await source.close();
			await target.close();
			source = createSqliteEngine({ path: sourcePath, clock: () => NOW });
			target = createSqliteEngine({ path: targetPath, clock: () => NOW });
			permit = false;
			await expect(executeDataHandover(input())).rejects.toThrow(
				"authorization expired",
			);
			permit = true;
			const second = await executeDataHandover(input());
			expect(second.migrationId).toBe(first.migrationId);
			expect(second.status).toBe("held");
			expect((await inspectDataHandover(input())).status).toBe("cutover-held");
			expect(writable).toBe("target");
			expect(
				await source.verify?.digest({ scope: scopeOf("orders"), buckets: 4 }),
			).toMatchObject({ count: 2 });
			expect(
				await target.verify?.digest({ scope: scopeOf("orders"), buckets: 4 }),
			).toMatchObject({ count: 2 });
			soak = "finalize";
			const final = await executeDataHandover(input());
			expect(final.status).toBe("completed");
			expect((await inspectDataHandover(input())).status).toBe("completed");
			expect(
				await source.verify?.digest({ scope: scopeOf("orders"), buckets: 4 }),
			).toMatchObject({ count: 0 });
			expect(
				await target.verify?.digest({ scope: scopeOf("orders"), buckets: 4 }),
			).toMatchObject({ count: 2 });
			expect(authorizations).toBeGreaterThan(20);
		} finally {
			await source.close();
			await target.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
