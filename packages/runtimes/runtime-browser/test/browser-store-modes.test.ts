import { PersistenceUnavailableError } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserEventStore } from "../src/browser-store.js";
import { detectBrowserPersistence, hasOpfs } from "../src/detect.js";

const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);

afterEach(() => {
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	} else {
		Reflect.deleteProperty(globalThis, "navigator");
	}
});

function withOpfs(present: boolean): void {
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		writable: true,
		value: present
			? { storage: { getDirectory: async () => ({}) } }
			: { storage: {} },
	});
}

describe("detecting OPFS", () => {
	it("reports absent when navigator has no storage", () => {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			writable: true,
			value: {},
		});
		expect(hasOpfs()).toBe(false);
	});

	it("reports absent when storage has no getDirectory", () => {
		withOpfs(false);
		expect(hasOpfs()).toBe(false);
	});

	it("reports absent when getDirectory is not callable", () => {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			writable: true,
			value: { storage: { getDirectory: "yes" } },
		});
		expect(hasOpfs()).toBe(false);
	});

	it("reports present when getDirectory is a function", () => {
		withOpfs(true);
		expect(hasOpfs()).toBe(true);
	});
});

describe("choosing a mode", () => {
	it("chooses opfs-sahpool when OPFS is present", () => {
		withOpfs(true);
		expect(detectBrowserPersistence({}).mode).toBe("opfs-sahpool");
	});

	it("chooses the same mode whether or not multiTab is set", () => {
		withOpfs(true);
		expect(detectBrowserPersistence({ multiTab: true }).mode).toBe(
			detectBrowserPersistence({ multiTab: false }).mode,
		);
	});

	it("chooses transient-memory only when explicitly allowed", () => {
		withOpfs(false);
		expect(detectBrowserPersistence({ allowTransient: true }).mode).toBe(
			"transient-memory",
		);
	});

	it("says why it fell back to transient", () => {
		withOpfs(false);
		expect(detectBrowserPersistence({ allowTransient: true }).reason).toMatch(
			/OPFS unavailable/,
		);
	});

	it("reports unavailable when durable is required and OPFS is missing", () => {
		withOpfs(false);
		expect(detectBrowserPersistence({}).mode).toBe("unavailable");
	});

	it("says durable persistence was required", () => {
		withOpfs(false);
		expect(detectBrowserPersistence({}).reason).toMatch(
			/durable persistence required/,
		);
	});
});

describe("opening a store", () => {
	it("refuses when persistence is unavailable and not opted out of", () => {
		withOpfs(false);
		return expect(
			createBrowserEventStore({ partitionId: "tenant-a" }),
		).rejects.toThrow(PersistenceUnavailableError);
	});

	it("opens transient memory when the caller opts in", async () => {
		withOpfs(false);
		const store = await createBrowserEventStore({
			partitionId: "tenant-a",
			allowTransient: true,
		});
		expect(store.persistenceMode).toBe("transient-memory");
		store.close();
	});

	it("refuses to claim OPFS when the VFS cannot actually be opened", async () => {
		withOpfs(true);
		await expect(
			createBrowserEventStore({ partitionId: "tenant-a" }),
		).rejects.toThrow(/durable open unavailable/);
	});

	it("names the flag that would allow a non-durable open", async () => {
		withOpfs(true);
		await expect(
			createBrowserEventStore({ partitionId: "tenant-a" }),
		).rejects.toThrow(/allowTransient/);
	});

	it("still opens transient when OPFS is detected but opted down to", async () => {
		withOpfs(true);
		const store = await createBrowserEventStore({
			partitionId: "tenant-a",
			allowTransient: true,
		});
		expect(store.persistenceMode).toBe("transient-memory");
		store.close();
	});

	it("passes multiTab through without changing the outcome", async () => {
		withOpfs(false);
		const store = await createBrowserEventStore({
			partitionId: "tenant-a",
			allowTransient: true,
			multiTab: true,
		});
		expect(store.persistenceMode).toBe("transient-memory");
		store.close();
	});
});

describe("the opened store", () => {
	async function transientStore() {
		withOpfs(false);
		return createBrowserEventStore({
			partitionId: "tenant-a",
			allowTransient: true,
		});
	}

	const APPEND = {
		expectedSeq: 0,
		actor: { kind: "system", id: "runtime-browser" },
		tenant: "tenant-a",
	} as const;

	it("is frozen", async () => {
		const store = await transientStore();
		expect(Object.isFrozen(store)).toBe(true);
		store.close();
	});

	it("appends and reads back", async () => {
		const store = await transientStore();
		await store.append("run:1", [{ type: "run.Started", data: {} }], APPEND);
		const seen = [];
		for await (const event of store.read("run:1")) seen.push(event.type);
		expect(seen).toStrictEqual(["run.Started"]);
		store.close();
	});

	it("reads across all streams", async () => {
		const store = await transientStore();
		await store.append("run:1", [{ type: "run.Started", data: {} }], APPEND);
		await store.append("run:2", [{ type: "run.Started", data: {} }], APPEND);
		const seen = [];
		for await (const positioned of store.readAll()) seen.push(positioned);
		expect(seen).toHaveLength(2);
		store.close();
	});

	it("delivers to a subscriber", async () => {
		const store = await transientStore();
		const seen: string[] = [];
		const subscription = store.subscribe({ streamId: "run:1" }, (event) => {
			seen.push(event.type);
		});
		await store.append("run:1", [{ type: "run.Started", data: {} }], APPEND);
		expect(seen).toStrictEqual(["run.Started"]);
		subscription.unsubscribe();
		store.close();
	});

	it("snapshots and loads back", async () => {
		const store = await transientStore();
		await store.append("run:1", [{ type: "run.Started", data: {} }], APPEND);
		await store.snapshot("run:1", { steps: 1 }, 1);
		expect((await store.loadSnapshot("run:1"))?.state).toStrictEqual({
			steps: 1,
		});
		store.close();
	});

	it("has no snapshot for a stream that never took one", async () => {
		const store = await transientStore();
		expect(await store.loadSnapshot("run:absent")).toBeUndefined();
		store.close();
	});

	it("commits durably through the same journal", async () => {
		const store = await transientStore();
		const result = await store.commit({
			streamId: "run:1",
			events: [{ type: "run.Started", data: {} }],
			append: APPEND,
		} as never);
		expect(result.appended).toHaveLength(1);
		store.close();
	});

	it("exposes its journal for the worker protocol to drive", async () => {
		const store = await transientStore();
		expect(store.journal()).toBeDefined();
		store.close();
	});

	it("keeps two partitions' stores independent", async () => {
		withOpfs(false);
		const first = await createBrowserEventStore({
			partitionId: "tenant-a",
			allowTransient: true,
		});
		const second = await createBrowserEventStore({
			partitionId: "tenant-b",
			allowTransient: true,
		});
		await first.append("run:1", [{ type: "run.Started", data: {} }], APPEND);
		const seen = [];
		for await (const event of second.read("run:1")) seen.push(event);
		expect(seen).toStrictEqual([]);
		first.close();
		second.close();
	});
});
