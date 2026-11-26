import { describe, expect, it } from "vitest";

import {
	createMemoryConfigStore,
	linkConfigStoreIfImported,
} from "../src/index.js";

describe("@hobo/provider-config wasi:config/store", () => {
	it("get returns value-ref + sensitivity shape (not ambient secrets)", () => {
		const store = createMemoryConfigStore();
		store.put("LOG_LEVEL", { value: "info", sensitivity: "public" });
		const got = store.get("LOG_LEVEL");
		expect(got).toEqual({
			key: "LOG_LEVEL",
			"value-ref": "camp://LOG_LEVEL",
			sensitivity: "public",
		});
		expect(JSON.stringify(got)).not.toMatch(/password|secret/i);
		expect(store.materialize("camp://LOG_LEVEL")).toBe("info");
	});

	it("refuses sensitive plaintext puts", () => {
		const store = createMemoryConfigStore();
		expect(() =>
			store.put("DB_PASSWORD", {
				value: "super-secret",
				sensitivity: "sensitive",
			}),
		).toThrow(/sensitive plaintext/);
		store.put("DB_PASSWORD", {
			valueRef: "secref://DB_PASSWORD/v1",
			sensitivity: "sensitive",
		});
		const got = store.get("DB_PASSWORD");
		expect(got?.["value-ref"]).toBe("secref://DB_PASSWORD/v1");
		expect(store.materialize("secref://DB_PASSWORD/v1")).toBeUndefined();
	});

	it("is import-optional — no store when config not imported", () => {
		expect(
			linkConfigStoreIfImported({
				imports: ["wasi:http/incoming-handler"],
			}),
		).toBeUndefined();
		const linked = linkConfigStoreIfImported({
			imports: ["wasi:config/store@0.2.0"],
		});
		expect(linked).toBeDefined();
		expect(linked?.wit).toBe("wasi:config/store@0.2.0");
	});
});
