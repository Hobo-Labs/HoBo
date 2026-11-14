import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CUSTODY_ROLES,
	createEventStoreMigrationJournal,
	encodeRecordKey,
	evaluateCustodyPath,
	fenceTokenDigest,
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
import {
	createDurableHandoverRouter,
	type FencedHandoverFlip,
} from "../src/data-handover-router.js";
import type { DataMigrationJournal } from "../src/migration-executor.js";

const NOW = "2026-11-10T00:00:00.000Z";
const routeScope = {
	tenant: "acme",
	campId: "orders",
	dataset: "orders",
	scopeTenant: "",
};
const sourceRoute = {
	yard: "old-yard",
	provider: "source-provider",
	accountId: "source-account",
	resourceId: "source-db",
};
const targetRoute = {
	yard: "new-yard",
	provider: "target-provider",
	accountId: "target-account",
	resourceId: "target-db",
};
function nativeFence(paths: Readonly<Record<string, string>>) {
	return async ({
		source,
		fenceToken,
	}: {
		source: { resourceId: string };
		fenceToken: string;
	}) => {
		const path = paths[source.resourceId];
		if (!path) throw new Error("unknown native source");
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const row = db
				.prepare(
					"SELECT fence_token FROM hobo_data_fences WHERE dataset = ? AND tenant_id = ?",
				)
				.get("orders", "");
			if (row?.fence_token !== fenceToken)
				throw new Error("native fence changed");
		} finally {
			db.close();
		}
	};
}
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
		const router = createDurableHandoverRouter({
			journal,
			scope: routeScope,
			verifyNativeFence: nativeFence({ "source-db": sourcePath }),
		});
		let flipAuthority: FencedHandoverFlip = async () => {
			throw new Error("route not enrolled");
		};
		let authorizations = 0,
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
				flipAuthority,
				soakDecision: () => soak,
			};
		}
		try {
			const initial = await inspectDataHandover(input());
			expect(initial.status).toBe("new");
			await expect(executeDataHandover(input())).rejects.toThrow(
				/fenced routing receiver/u,
			);
			expect(await journal.load(initial.migrationId)).toEqual([]);
			await router.initialize(sourceRoute, async () => {});
			flipAuthority = await router.begin({
				migrationId: initial.migrationId,
				source: sourceRoute,
				target: targetRoute,
				expectedGeneration: 0,
				authorize: async () => {
					if (!permit) throw new Error("authorization expired");
				},
			});
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
			expect((await router.current())?.current).toEqual(sourceRoute);
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
			expect((await router.current())?.current).toEqual(targetRoute);
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

	it("leaves the source fence for an authorized successor when authorization lapses", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-trail-handover-lapse-"));
		const store = createRuntimeLocalEventStore({
			dataDir: join(dir, "journal"),
			clock: createManualClock(),
		});
		const source = createSqliteEngine({
			path: join(dir, "source.db"),
			clock: () => NOW,
		});
		const target = createSqliteEngine({
			path: join(dir, "target.db"),
			clock: () => NOW,
		});
		// SAFETY: both journals use the same JSON facts and conditional count.
		// SAFETY: both journal ports share the same JSON facts and conditional count.
		const journal = createEventStoreMigrationJournal(store, {
			tenant: "acme",
			actor: { kind: "system", id: "test" },
		}) as DataMigrationJournal;
		const router = createDurableHandoverRouter({
			journal,
			scope: routeScope,
			verifyNativeFence: nativeFence({ "source-db": join(dir, "source.db") }),
		});
		let flipAuthority: FencedHandoverFlip = async () => {
			throw new Error("route not enrolled");
		};
		let revokeUnderFence = true;
		const fenced = async () =>
			(await source.fence?.status(scopeOf("orders")))?.fenced === true;
		const input = () => ({
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
			async revalidate(phase: string) {
				// Authorization lapses the moment the source is fenced, before
				// anything is compared under the fence or authority moves.
				if (revokeUnderFence && phase === "fence-and-flip" && (await fenced()))
					throw new Error("authorization expired");
			},
			policy: () =>
				evaluateCustodyPath({
					path,
					policy: { classification: "public" },
					now: NOW,
				}),
			flipAuthority,
			soakDecision: () => "hold" as const,
		});
		try {
			const initial = await inspectDataHandover(input());
			await router.initialize(sourceRoute, async () => {});
			flipAuthority = await router.begin({
				migrationId: initial.migrationId,
				source: sourceRoute,
				target: targetRoute,
				expectedGeneration: 0,
				authorize: async () => {},
			});
			await source.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "a", total: "1" });
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			await expect(executeDataHandover(input())).rejects.toThrow(
				"authorization expired",
			);
			expect((await router.current())?.current).toEqual(sourceRoute);
			expect(await fenced()).toBe(true);
			const { migrationId } = await inspectDataHandover(input());
			const facts = await journal.load(migrationId);
			expect(
				facts.some(
					(fact) =>
						fact.type === "migration.Held" && fact.data.compensated === true,
				),
			).toBe(false);
			// A later authorized run resumes the fenced handover.
			revokeUnderFence = false;
			expect((await executeDataHandover(input())).status).toBe("held");
			expect((await inspectDataHandover(input())).status).toBe("cutover-held");
			expect((await router.current())?.current).toEqual(targetRoute);
		} finally {
			await source.close();
			await target.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a delayed rollback after a successor takes the same Camp", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-trail-rollback-takeover-"));
		const store = createRuntimeLocalEventStore({
			dataDir: join(dir, "journal"),
			clock: createManualClock(),
		});
		const source = createSqliteEngine({
			path: join(dir, "source.db"),
			clock: () => NOW,
		});
		const target = createSqliteEngine({
			path: join(dir, "target.db"),
			clock: () => NOW,
		});
		// SAFETY: both journal ports share the same JSON facts and conditional count.
		const journal = createEventStoreMigrationJournal(store, {
			tenant: "acme",
			actor: { kind: "system", id: "test" },
		}) as DataMigrationJournal;
		let expired = false,
			rollback = false;
		let started!: () => void, continueOld!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			continueOld = resolve;
		});
		const delayedJournal: DataMigrationJournal = {
			load: (id) => journal.load(id),
			async append(id, fact, count) {
				if (
					fact.type === "trails.RouteFlipped" &&
					fact.data.direction === "to-source"
				) {
					expired = true;
					started();
					await gate;
				}
				await journal.append(id, fact, count);
			},
		};
		const oldRouter = createDurableHandoverRouter({
			journal: delayedJournal,
			scope: routeScope,
			verifyNativeFence: nativeFence({ "source-db": join(dir, "source.db") }),
		});
		const successorRouter = createDurableHandoverRouter({
			journal,
			scope: routeScope,
			verifyNativeFence: nativeFence({ "target-db": join(dir, "target.db") }),
		});
		let flipAuthority: FencedHandoverFlip = async () => {
			throw new Error("route not enrolled");
		};
		const make = () => ({
			tenant: "acme",
			campId: "orders",
			setId: "set_12345678",
			schema,
			scope: scopeOf("orders"),
			journal,
			clock: () => NOW,
			source: { ...sourceRoute, engine: source },
			target: { ...targetRoute, engine: target },
			async revalidate() {
				if (expired) throw new Error("old authorization expired");
			},
			policy: () =>
				evaluateCustodyPath({
					path,
					policy: { classification: "public" },
					now: NOW,
				}),
			flipAuthority,
			soakDecision: () =>
				rollback ? ("rollback" as const) : ("hold" as const),
		});
		try {
			const initial = await inspectDataHandover(make());
			await oldRouter.initialize(sourceRoute, async () => {});
			flipAuthority = await oldRouter.begin({
				migrationId: initial.migrationId,
				source: sourceRoute,
				target: targetRoute,
				expectedGeneration: 0,
				authorize: async () => {
					if (expired) throw new Error("old authorization expired");
				},
			});
			await source.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "a", total: "1" });
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			expect((await executeDataHandover(make())).status).toBe("held");
			expect((await successorRouter.current())?.current).toEqual(targetRoute);
			rollback = true;
			const old = executeDataHandover(make()).then(
				() => undefined,
				(error) => error,
			);
			await entered;
			const third = {
				yard: "third-yard",
				provider: "third-provider",
				accountId: "third-account",
				resourceId: "third-db",
			};
			const next = await successorRouter.begin({
				migrationId: "newer-migration",
				source: targetRoute,
				target: third,
				expectedGeneration: 1,
				authorize: async () => {},
			});
			if (!target.fence) throw new Error("target native fence unavailable");
			const nextFence = await target.fence.raise({
				scope: scopeOf("orders"),
				reason: "successor",
			});
			await journal.append(
				"newer-migration",
				{
					type: "migration.CutOver",
					data: {
						migrationId: "newer-migration",
						fenceTokenDigest: fenceTokenDigest(nextFence.fenceToken),
					},
				},
				0,
			);
			await next({
				migrationId: "newer-migration",
				head: 1,
				direction: "to-target",
				fenceToken: nextFence.fenceToken,
			});
			continueOld();
			expect(await old).toBeInstanceOf(Error);
			expect((await successorRouter.current())?.current).toEqual(third);
		} finally {
			continueOld();
			await source.close();
			await target.close();
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("recovers the exact generation after an ambiguous admission without creating another", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-trail-route-retry-"));
		const store = createRuntimeLocalEventStore({
			dataDir: join(dir, "journal"),
			clock: createManualClock(),
		});
		// SAFETY: both journal ports share the same JSON facts and conditional count.
		const journal = createEventStoreMigrationJournal(store, {
			tenant: "acme",
			actor: { kind: "system", id: "test" },
		}) as DataMigrationJournal;
		let loseAck = true;
		const unreliable: DataMigrationJournal = {
			load: (id) => journal.load(id),
			async append(id, fact, count) {
				await journal.append(id, fact, count);
				if (loseAck && fact.type === "trails.RouteGeneration") {
					loseAck = false;
					throw new Error("response lost");
				}
			},
		};
		const router = createDurableHandoverRouter({
			journal: unreliable,
			scope: routeScope,
			async verifyNativeFence({ fenceToken }) {
				if (fenceToken !== "fence") throw new Error("native fence changed");
			},
		});
		try {
			await router.initialize(sourceRoute, async () => {});
			const request = {
				migrationId: "migration",
				source: sourceRoute,
				target: targetRoute,
				expectedGeneration: 0,
				authorize: async () => {},
			};
			await expect(router.begin(request)).rejects.toThrow("response lost");
			const flip = await router.begin(request);
			expect((await router.current())?.generation).toBe(1);
			await expect(
				router.begin({
					...request,
					target: { ...targetRoute, resourceId: "other" },
				}),
			).rejects.toThrow();
			await journal.append(
				"migration",
				{
					type: "migration.CutOver",
					data: {
						migrationId: "migration",
						fenceTokenDigest: fenceTokenDigest("fence"),
					},
				},
				0,
			);
			await flip({
				migrationId: "migration",
				head: 1,
				direction: "to-target",
				fenceToken: "fence",
			});
			expect((await router.current())?.current).toEqual(targetRoute);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
