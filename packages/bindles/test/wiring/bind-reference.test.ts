import { describe, expect, it } from "vitest";

import {
	addContainer,
	bindingTypesFor,
	compileBindleManifest,
	data,
	service,
} from "../../src/wiring/index.js";

describe("bind reference wiring", () => {
	it("records bind edges and capability links without ConnectionStrings env", () => {
		const db = data("db", { paradigm: "relational" });
		const api = service("api", {
			image: "oci://registry.example.com/api@sha256:abc123",
			bind: { db },
		});

		const manifest = compileBindleManifest([db, api]);

		expect(manifest.resources.api?.links).toEqual([
			{ import: "hobo:data", to: "db" },
		]);
		// ADR-0141: binding delivery is links only — no ambient ConnectionStrings__*
		expect(manifest.resources.api?.env?.ConnectionStrings__db).toBeUndefined();
		expect(JSON.stringify(manifest.resources.api?.env ?? {})).not.toMatch(
			/ConnectionStrings__/,
		);
		expect(manifest.resources.api?.bindings).toEqual({
			db: {
				port: "hobo:data",
				resource: "db",
				clientType: "DataClient",
			},
		});
	});

	it("publishes typed ctx.bindings surface and rejects unbound names", () => {
		const db = data("db");
		const orders = data("orders", { paradigm: "document" });
		const api = service("api", { bind: { db, orders } });

		expect(bindingTypesFor(api)).toEqual({
			db: "DataClient",
			orders: "DataClient",
		});
		expect(api.typescript.ctxBindings).toBe(
			["readonly db: DataClient;", "readonly orders: DataClient;"].join("\n"),
		);
		expect(api.binding("db").resource).toBe("db");
		expect(() => api.binding("missing")).toThrow(
			/ctx\.bindings\.missing is not declared on service api/,
		);
	});

	it("fails undeclared binds and unresolved lazy references closed", () => {
		const db = data("db");
		const api = service("api", { bind: { db } });

		expect(() => compileBindleManifest([api])).toThrow(
			/resources\.api\.links\[0\]\.to: unknown resource db/,
		);

		const dangling = service("worker", {
			env: { DATABASE_URL: "{missing.connectionString}" },
		});
		expect(() => compileBindleManifest([dangling])).toThrow(
			/resources\.worker\.env\.DATABASE_URL: unknown resource missing/,
		);
	});

	it("rejects cross-Camp placement and DNS at bind scope", () => {
		const db = data("db");

		expect(() => service("api", { bind: { db }, camp: "prod-aws" })).toThrow(
			/cross-Camp placement is resolved by enclosing scopes/,
		);
		const container = addContainer("api", "ghcr.io/acme/api:1");
		expect(container.withDnsRecord).toBeTypeOf("function");
		expect(() => container.withDnsRecord?.()).toThrow(/DNS is Yard-level/);
	});
});
