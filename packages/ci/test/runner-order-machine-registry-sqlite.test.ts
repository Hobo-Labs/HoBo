import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { generateMeshIdentity } from "../src/mesh/trust.js";
import {
	receiveMachineAdvert,
	signMachineAdvert,
} from "../src/runner-order/machine-registry.js";
import {
	MachineRegistryError,
	SqliteMachineRegistry,
} from "../src/runner-order/machine-registry-sqlite.js";
import {
	machineRegistryConformance,
	testMachineAdvert,
} from "../src/runner-order/testing.js";

const handles: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const db of handles.splice(0)) db.close();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

function memory(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	handles.push(db);
	return db;
}

describe("SqliteMachineRegistry", () => {
	it("keeps the machine registry's rules", () =>
		machineRegistryConformance(() => new SqliteMachineRegistry(memory())));

	it("reads adverts back parsed and frozen", async () => {
		const registry = new SqliteMachineRegistry(memory());
		await registry.put(testMachineAdvert({ labels: ["self-hosted", "gpu"] }));
		const [kept] = await registry.list("acct-1");
		expect(Object.isFrozen(kept)).toBe(true);
		expect(kept?.labels).toEqual(["self-hosted", "gpu"]);
	});

	it("refuses to move a machine id to another account", async () => {
		const registry = new SqliteMachineRegistry(memory());
		await registry.put(testMachineAdvert());
		await expect(
			registry.put(testMachineAdvert({ accountId: "acct-2" })),
		).rejects.toBeInstanceOf(MachineRegistryError);
		expect((await registry.list("acct-1")).length).toBe(1);
		expect(await registry.list("acct-2")).toEqual([]);
	});

	it("refuses an advert that does not parse, and keeps nothing", async () => {
		const registry = new SqliteMachineRegistry(memory());
		await expect(
			registry.put({ ...testMachineAdvert(), slots: 0 }),
		).rejects.toThrow(/slots/u);
		expect(await registry.list("acct-1")).toEqual([]);
	});

	it("keeps machines, pause and a pinned key across a restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-ci-machines-"));
		directories.push(directory);
		const path = join(directory, "relay.sqlite");
		const key = generateMeshIdentity().identity;
		const thief = generateMeshIdentity().identity;
		const now = 1_763_337_600_000;
		const first = new DatabaseSync(path);
		const before = new SqliteMachineRegistry(first);
		await receiveMachineAdvert(
			before,
			signMachineAdvert(testMachineAdvert({ lastSeenMs: now }), key),
			{ accountId: "acct-1", nowMs: now },
		);
		await before.setPaused("m-1", true, "octocat");
		first.close();

		const second = new DatabaseSync(path);
		handles.push(second);
		const after = new SqliteMachineRegistry(second);
		const [kept] = await after.list("acct-1");
		expect(kept?.paused).toBe(true);
		const takeover = await receiveMachineAdvert(
			after,
			signMachineAdvert(testMachineAdvert({ lastSeenMs: now + 1 }), thief),
			{ accountId: "acct-1", nowMs: now + 1 },
		);
		expect(takeover.kind === "refused" && takeover.reason).toBe("taken_over");
	});
});
