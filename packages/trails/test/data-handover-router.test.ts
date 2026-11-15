import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createEventStoreMigrationJournal,
	fenceTokenDigest,
} from "@hobo/data-core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import {
	assertFencedHandoverFlip,
	createDurableHandoverRouter,
} from "../src/data-handover-router.js";
import type { DataMigrationJournal } from "../src/migration-executor.js";

const scope = {
	tenant: "acme",
	campId: "camp",
	dataset: "orders",
	scopeTenant: "",
};
const source = {
	yard: "y1",
	provider: "p1",
	accountId: "a1",
	resourceId: "r1",
};
const target = {
	yard: "y2",
	provider: "p2",
	accountId: "a2",
	resourceId: "r2",
};
async function verifyNativeFence({ fenceToken }: { fenceToken: string }) {
	if (fenceToken !== "t") throw new Error("native fence does not match");
}
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-trail-route-"));
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	// SAFETY: both journal ports share the same JSON facts and conditional count.
	const journal = createEventStoreMigrationJournal(store, {
		tenant: "acme",
		actor: { kind: "system", id: "test" },
	}) as DataMigrationJournal;
	return {
		journal,
		close() {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("Trails durable routing receiver", () => {
	it("permits one concurrent generation and rejects a forged receiver", async () => {
		const f = fixture();
		try {
			const router = createDurableHandoverRouter({
				journal: f.journal,
				scope,
				verifyNativeFence,
			});
			await router.initialize(source, async () => {});
			let arrivals = 0,
				unblock!: () => void;
			const barrier = new Promise<void>((resolve) => {
				unblock = resolve;
			});
			const authorize = async () => {
				if (++arrivals === 2) unblock();
				await barrier;
			};
			const results = await Promise.allSettled([
				router.begin({
					migrationId: "m1",
					source,
					target,
					expectedGeneration: 0,
					authorize,
				}),
				router.begin({
					migrationId: "m2",
					source,
					target,
					expectedGeneration: 0,
					authorize,
				}),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			expect((await router.current())?.generation).toBe(1);
			expect(() =>
				assertFencedHandoverFlip(async () => {}, {
					scope,
					migrationId: "m1",
					source,
					target,
				}),
			).toThrow(/fenced routing receiver/u);
		} finally {
			f.close();
		}
	});

	it("enforces fresh authorization and rejects a conflicting replay at one head", async () => {
		const f = fixture();
		try {
			let nativeLive = true;
			const verifier = async (input: { fenceToken: string }) => {
				if (!nativeLive) throw new Error("native fence expired");
				await verifyNativeFence(input);
			};
			const router = createDurableHandoverRouter({
				journal: f.journal,
				scope,
				verifyNativeFence: verifier,
			});
			await expect(
				router.initialize(source, async () => {
					throw new Error("genesis denied");
				}),
			).rejects.toThrow("genesis denied");
			expect(await router.current()).toBeUndefined();
			await router.initialize(source, async () => {});
			let authorized = true;
			const flip = await router.begin({
				migrationId: "m1",
				source,
				target,
				expectedGeneration: 0,
				authorize: async () => {
					if (!authorized) throw new Error("authorization expired");
				},
			});
			await f.journal.append(
				"m1",
				{
					type: "migration.CutOver",
					data: { migrationId: "m1", fenceTokenDigest: fenceTokenDigest("t") },
				},
				0,
			);
			authorized = false;
			await expect(
				flip({
					migrationId: "m1",
					head: 1,
					direction: "to-target",
					fenceToken: "t",
				}),
			).rejects.toThrow("authorization expired");
			expect((await router.current())?.current).toEqual(source);
			authorized = true;
			await expect(
				flip({
					migrationId: "m1",
					head: 2,
					direction: "to-target",
					fenceToken: "t",
				}),
			).rejects.toThrow(/decision or fence token/u);
			await expect(
				flip({
					migrationId: "m1",
					head: 1,
					direction: "to-target",
					fenceToken: "other",
				}),
			).rejects.toThrow(/decision or fence token/u);
			nativeLive = false;
			await expect(
				flip({
					migrationId: "m1",
					head: 1,
					direction: "to-target",
					fenceToken: "t",
				}),
			).rejects.toThrow(/native fence expired/u);
			expect((await router.current())?.current).toEqual(source);
			nativeLive = true;
			await flip({
				migrationId: "m1",
				head: 1,
				direction: "to-target",
				fenceToken: "t",
			});
			await expect(
				flip({
					migrationId: "m1",
					head: 1,
					direction: "to-target",
					fenceToken: "other",
				}),
			).rejects.toThrow(/decision or fence token/u);
			await flip({
				migrationId: "m1",
				head: 1,
				direction: "to-target",
				fenceToken: "t",
			});
			await expect(
				flip({
					migrationId: "m1",
					head: 1,
					direction: "to-source",
					fenceToken: "t",
				}),
			).rejects.toThrow(/stale/u);
			const restarted = createDurableHandoverRouter({
				journal: f.journal,
				scope,
				verifyNativeFence,
			});
			expect((await restarted.current())?.current).toEqual(target);
			expect(Object.isFrozen(await restarted.current())).toBe(true);
		} finally {
			f.close();
		}
	});

	it("does not create a second generation namespace for the same Camp", async () => {
		const f = fixture();
		try {
			const first = createDurableHandoverRouter({
				journal: f.journal,
				scope,
				verifyNativeFence,
			});
			await first.initialize(source, async () => {});
			const other = createDurableHandoverRouter({
				journal: f.journal,
				scope: { ...scope, dataset: "invoices" },
				verifyNativeFence,
			});
			await expect(other.initialize(source, async () => {})).rejects.toThrow(
				/genesis/u,
			);
			await expect(
				other.begin({
					migrationId: "other",
					source,
					target,
					expectedGeneration: 0,
					authorize: async () => {},
				}),
			).rejects.toThrow(/genesis/u);
		} finally {
			f.close();
		}
	});
});
