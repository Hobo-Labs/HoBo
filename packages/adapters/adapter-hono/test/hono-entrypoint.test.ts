import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	HOBO_ADAPTER_HONO_FRAMEWORK,
	HOBO_ADAPTER_HONO_PACKAGE,
	honoEntrypoint,
	isHonoFetchApp,
	toFetchHandler,
} from "../src/index.js";

describe("@hobo/adapter-hono", () => {
	it("exposes package identity for boundary evidence", () => {
		expect(HOBO_ADAPTER_HONO_PACKAGE).toBe("@hobo/adapter-hono");
		expect(HOBO_ADAPTER_HONO_FRAMEWORK).toBe("hono");
	});

	it("toFetchHandler routes through app.fetch", async () => {
		const app = new Hono().get("/hello", (c) => {
			const name = c.req.query("name") ?? "world";
			return c.json({ ok: true, name });
		});
		const handler = toFetchHandler(app);
		const response = await handler(
			new Request("http://component.local/hello?name=Adapter"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, name: "Adapter" });
	});

	it("honoEntrypoint returns a bindle thunk", async () => {
		const app = new Hono().get("/hello", (c) =>
			c.json({ ok: true, name: c.req.query("name") ?? "world" }),
		);
		const entry = honoEntrypoint(app);
		const handler = entry();
		const response = await handler(
			new Request("http://component.local/hello?name=Thunk"),
		);
		expect(await response.json()).toEqual({ ok: true, name: "Thunk" });
	});

	it("isHonoFetchApp detects fetch surface", () => {
		const app = new Hono();
		expect(isHonoFetchApp(app)).toBe(true);
		expect(isHonoFetchApp({})).toBe(false);
		expect(isHonoFetchApp(null)).toBe(false);
	});
});
