/**
 * Which persistence mode the browser store opens, and what it refuses to claim.
 *
 * The rule this module exists to enforce is a negative one: **never report
 * durability that is not there.** A store that said "opfs-sahpool" while
 * holding an in-memory database would let a tab close take events with it
 * while every log line said they were safe — and an event store that loses
 * events silently is worse than one that refuses to open.
 *
 * So the decision has three outcomes and each is deliberate:
 *
 * - **OPFS present and openable** → durable, reported as `opfs-sahpool`.
 * - **Durable impossible, `allowTransient: true`** → in-memory, reported
 *   honestly as `transient-memory`. The caller opted in with a flag whose name
 *   says what it costs.
 * - **Durable impossible, no opt-in** → refuse with
 *   `PersistenceUnavailableError`, naming the flag that would allow it.
 *
 * The middle case is the interesting one: transient mode is reachable *only*
 * through an explicit opt-in, never as a fallback. A silent downgrade is the
 * exact failure the mode label is meant to prevent.
 *
 * These drive `hasOpfs()` by stubbing `navigator.storage`, which is the only
 * input the detection actually reads. A real OPFS open needs a Worker and a
 * browser; what is testable here is the *decision*, and the decision is where
 * a false durability claim would come from.
 */
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

/** Present a navigator whose storage does or does not offer OPFS. */
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
		// The capability is the *method*, not the object. A storage manager
		// without it is a browser that cannot give us a durable handle.
		withOpfs(false);
		expect(hasOpfs()).toBe(false);
	});

	it("reports absent when getDirectory is not callable", () => {
		// A truthiness check here would accept a property that happens to
		// exist — and then fail at the first real open, after the store has
		// already reported itself durable.
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
		// QUIRK: the multi-tab branch selects `opfs-sahpool` either way — both
		// arms of that ternary are identical, so the option currently has no
		// effect on the chosen mode. Pinned rather than removed: SAH-pool is
		// the multi-tab-safe VFS, so the single-tab arm is the one that would
		// change if a faster single-tab VFS were ever wired in, and silently
		// dropping the option would remove the seam for it.
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
		// The reason travels with the mode so a caller logging one logs both;
		// a bare mode label leaves an operator to guess whether durability was
		// impossible or merely not requested.
		withOpfs(false);
		expect(detectBrowserPersistence({ allowTransient: true }).reason).toMatch(
			/OPFS unavailable/,
		);
	});

	it("reports unavailable when durable is required and OPFS is missing", () => {
		// The default. Falling back to memory here is the silent downgrade the
		// mode label exists to prevent.
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
		// The important case. OPFS is *detected*, so the mode says durable —
		// but the real Worker+OPFS open is not available here, and the store
		// refuses rather than quietly returning a memory database labelled
		// `opfs-sahpool`. A store that lied here would lose events on a tab
		// close while every log line said they were safe.
		withOpfs(true);
		await expect(
			createBrowserEventStore({ partitionId: "tenant-a" }),
		).rejects.toThrow(/durable open unavailable/);
	});

	it("names the flag that would allow a non-durable open", async () => {
		// A refusal that does not say how to proceed sends the caller to the
		// source; `allowTransient` is the whole remedy and it is one word.
		withOpfs(true);
		await expect(
			createBrowserEventStore({ partitionId: "tenant-a" }),
		).rejects.toThrow(/allowTransient/);
	});

	it("still opens transient when OPFS is detected but opted down to", async () => {
		// A caller that asked for transient gets transient even where durable
		// looked possible — the flag is a decision, not a hint.
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
		// It carries `persistenceMode`, which is a durability claim. A caller
		// that could rewrite it could relabel a memory store as durable.
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
		// Both streams, in one global order — the readAll contract that makes a
		// cross-stream projection possible at all.
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
		// `@internal`, but real: the Worker path operates the journal directly
		// rather than through this wrapper.
		const store = await transientStore();
		expect(store.journal()).toBeDefined();
		store.close();
	});

	it("keeps two partitions' stores independent", async () => {
		// Transient stores are per-open in-memory databases; sharing one would
		// leak a tenant's events into another's reads.
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
