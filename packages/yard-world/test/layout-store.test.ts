import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	defaultWorldHome,
	LAYOUT_SAVE_DEBOUNCE_MS,
	LayoutStore,
} from "../src/layout-store.js";

const home = () => mkdtempSync(join(tmpdir(), "hobo-yard-world-"));

const layout = (overrides: Record<string, unknown> = {}) =>
	({ nodes: { "yard:a": { x: 1, y: 2 } }, ...overrides }) as never;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("defaultWorldHome", () => {
	it("prefers the configured home", () => {
		process.env.YARD_WORLD_HOME = "/custom/world";
		try {
			expect(defaultWorldHome()).toBe("/custom/world");
		} finally {
			delete process.env.YARD_WORLD_HOME;
		}
	});

	it("falls back to a dotfile under the user's home", () => {
		delete process.env.YARD_WORLD_HOME;
		expect(defaultWorldHome()).toMatch(/\.hobo-yard-world$/u);
	});
});

describe("paths", () => {
	it("keeps layouts in a layouts subdirectory of the home", () => {
		const dir = home();
		expect(new LayoutStore(dir).dir).toBe(join(dir, "layouts"));
	});

	it("names a file after the station", () => {
		const store = new LayoutStore(home());
		expect(store.pathFor("station:local")).toContain("station");
	});

	it("percent-encodes a station id, since it becomes a filename", () => {
		const store = new LayoutStore(home());
		expect(store.pathFor("a/b")).toContain("a%2Fb");
		expect(store.pathFor("a/b")).not.toContain("a/b.json");
	});

	it("gives two stations two files", () => {
		const store = new LayoutStore(home());
		expect(store.pathFor("station:a")).not.toBe(store.pathFor("station:b"));
	});
});

describe("saveNow", () => {
	it("writes a layout that loads back", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		expect(store.load("station:a")).toEqual(layout());
	});

	it("creates the layouts directory on first save", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		expect(existsSync(store.dir)).toBe(true);
	});

	it("leaves no temporary file behind", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		expect(readdirSync(store.dir).filter((f) => f.includes(".tmp-"))).toEqual(
			[],
		);
	});

	it("writes readable, newline-terminated JSON", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		const raw = readFileSync(store.pathFor("station:a"), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(raw).toContain("\n  ");
	});

	it("overwrites an existing layout in place", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		store.saveNow("station:a", layout({ nodes: { "yard:b": { x: 9, y: 9 } } }));
		expect(store.load("station:a")).toEqual({
			nodes: { "yard:b": { x: 9, y: 9 } },
		});
	});

	it("keeps each station's layout separate", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", layout());
		store.saveNow("station:b", layout({ nodes: {} }));
		expect(store.load("station:a")).toEqual(layout());
	});
});

describe("load", () => {
	it("reports nothing for a station that has never been saved", () => {
		expect(new LayoutStore(home()).load("station:new")).toBeUndefined();
	});

	it("reports nothing rather than throwing on corrupt JSON", () => {
		const store = new LayoutStore(home());
		mkdirSync(store.dir, { recursive: true });
		writeFileSync(store.pathFor("station:a"), "{ not json");
		expect(store.load("station:a")).toBeUndefined();
	});

	it("reports nothing for JSON that is not an object", () => {
		const store = new LayoutStore(home());
		mkdirSync(store.dir, { recursive: true });
		writeFileSync(store.pathFor("station:a"), "null");
		expect(store.load("station:a")).toBeUndefined();
	});

	it("reports nothing for a bare JSON scalar", () => {
		const store = new LayoutStore(home());
		mkdirSync(store.dir, { recursive: true });
		writeFileSync(store.pathFor("station:a"), "42");
		expect(store.load("station:a")).toBeUndefined();
	});

	it("returns what was stored without reshaping it", () => {
		const store = new LayoutStore(home());
		store.saveNow("station:a", { unknownFutureField: true } as never);
		expect(store.load("station:a")).toEqual({ unknownFutureField: true });
	});
});

describe("saveDebounced", () => {
	it("does not write immediately", () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout(), 50);
		expect(store.load("station:a")).toBeUndefined();
	});

	it("writes once the quiet period elapses", async () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout(), 10);
		await sleep(60);
		expect(store.load("station:a")).toEqual(layout());
	});

	it("keeps the last layout when several arrive in a burst", async () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout({ nodes: { a: 1 } }), 10);
		store.saveDebounced("station:a", layout({ nodes: { b: 2 } }), 10);
		store.saveDebounced("station:a", layout({ nodes: { c: 3 } }), 10);
		await sleep(60);
		expect(store.load("station:a")).toEqual({ nodes: { c: 3 } });
	});

	it("writes once for a burst, not once per change", async () => {
		const store = new LayoutStore(home());
		for (let i = 0; i < 5; i += 1) {
			store.saveDebounced("station:a", layout({ nodes: { i } }), 10);
		}
		await sleep(60);
		expect(readdirSync(store.dir)).toHaveLength(1);
	});

	it("debounces each station independently", async () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout({ nodes: { a: 1 } }), 10);
		store.saveDebounced("station:b", layout({ nodes: { b: 2 } }), 10);
		await sleep(60);
		expect(store.load("station:a")).toEqual({ nodes: { a: 1 } });
		expect(store.load("station:b")).toEqual({ nodes: { b: 2 } });
	});

	it("declares a default quiet period", () => {
		expect(LAYOUT_SAVE_DEBOUNCE_MS).toBeGreaterThan(0);
	});
});

describe("flush", () => {
	it("writes a pending layout at once", () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout(), 10_000);
		store.flush();
		expect(store.load("station:a")).toEqual(layout());
	});

	it("flushes every station, not just one", () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout({ nodes: { a: 1 } }), 10_000);
		store.saveDebounced("station:b", layout({ nodes: { b: 2 } }), 10_000);
		store.flush();
		expect(store.load("station:b")).toEqual({ nodes: { b: 2 } });
	});

	it("does nothing when there is nothing pending", () => {
		expect(() => new LayoutStore(home()).flush()).not.toThrow();
	});

	it("clears the pending set, so a second flush does not rewrite", () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout(), 10_000);
		store.flush();
		store.saveNow("station:a", layout({ nodes: { later: true } }));
		store.flush();
		expect(store.load("station:a")).toEqual({ nodes: { later: true } });
	});

	it("cancels the timer it flushed, so no late write follows", async () => {
		const store = new LayoutStore(home());
		store.saveDebounced("station:a", layout({ nodes: { early: true } }), 10);
		store.flush();
		store.saveNow("station:a", layout({ nodes: { later: true } }));
		await sleep(60);
		expect(store.load("station:a")).toEqual({ nodes: { later: true } });
	});
});
