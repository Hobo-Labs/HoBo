import { HTTP_INCOMING_HANDLER } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import { createHttpComponentDescriptor } from "../src/component-http.js";

it("preserves binary response bytes through a typed HTTP export", async () => {
	const component = createHttpComponentDescriptor(
		"web",
		() => new Response(Uint8Array.from([0, 128, 255]), { status: 201 }),
		"latin1",
	);
	const handle = component.exports[HTTP_INCOMING_HANDLER]?.handle;
	if (!handle) throw new Error("missing HTTP export");
	const result = await handle({
		method: "GET",
		path: "/",
		headers: [],
		body: "",
	});
	expect(result).toMatchObject({ status: 201, body: "\u0000\u0080\u00ff" });
});

it("rejects invalid request and header shapes at the component boundary", async () => {
	const component = createHttpComponentDescriptor(
		"web",
		() => new Response("ok"),
		"utf8",
	);
	const handle = component.exports[HTTP_INCOMING_HANDLER]?.handle;
	if (!handle) throw new Error("missing HTTP export");
	await expect(
		handle({ method: "GET", path: "/", headers: [], body: false }),
	).rejects.toThrow("invalid component HTTP request");
	await expect(
		handle({ method: "GET", path: "/", headers: [["name", 7]], body: "" }),
	).rejects.toThrow("invalid component HTTP headers");
});
