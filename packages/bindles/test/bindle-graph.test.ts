import { describe, expect, it } from "vitest";
import { bindle } from "../src/bindle.js";
import { defineConnector } from "../src/connector.js";

describe("Bindle graph collection", () => {
	it("rejects a resource that was declared but not returned", () => {
		expect(() =>
			bindle("shop", (builder) => {
				builder.kv();
				return { api: builder.api() };
			}),
		).toThrow(/return every declared resource/u);
	});

	it("rejects duplicate aliases for the same resource", () => {
		expect(() =>
			bindle("shop", (builder) => {
				const cache = builder.kv();
				return { cache, duplicate: cache };
			}),
		).toThrow(/exactly one returned alias/u);
	});

	it("rejects a dependency or return value from another builder", () => {
		bindle("first", (first) => {
			const cache = first.kv();
			expect(() =>
				bindle("second", (second) => ({
					api: second.api().dependsOn(cache),
				})),
			).toThrow(/dependency must belong to the same builder/u);
			expect(() => bindle("second", () => ({ cache }))).toThrow(
				/same BindleBuilder/u,
			);
			return { cache };
		});
	});

	it("rejects a connector declared by another builder", () => {
		const symbol = defineConnector({
			kind: "connector-definition",
			id: "graph-test-connector",
			origin: "https://example.test",
			auth: { protocol: "auth.md", discovery: "https://example.test/auth.md" },
			capabilities: ["read"],
		});
		bindle("first", (first) => {
			const connector = first.connector(symbol);
			expect(() =>
				bindle("second", (second) => ({
					api: second.api().dependsOn(connector),
				})),
			).toThrow(/connector dependency must belong to the same builder/u);
			return { api: first.api().dependsOn(connector) };
		});
	});

	it("rejects invalid dependency values and component bindings", () => {
		expect(() =>
			bindle("shop", (builder) => ({
				api: builder.api().dependsOn({ kind: "kv" } as never),
			})),
		).toThrow(/dependency must belong to the same builder/u);
		expect(() =>
			bindle("shop", (builder) => ({ api: builder.api("named" as never) })),
		).toThrow(/component binding must be a function or class/u);
	});

	it("rejects resource names passed to anonymous factories", () => {
		expect(() =>
			bindle("shop", (builder) => ({
				// @ts-expect-error
				cache: builder.kv("cache"),
			})),
		).toThrow(/kv factory does not accept resource names/u);
		expect(() =>
			bindle("shop", (builder) => ({
				// @ts-expect-error
				queue: builder.queue("orders"),
			})),
		).toThrow(/queue factory does not accept resource names/u);
		expect(() =>
			bindle("shop", (builder) => ({
				// @ts-expect-error
				api: builder.api(() => ({}), "api"),
			})),
		).toThrow(/api factory does not accept resource names/u);
	});
});
