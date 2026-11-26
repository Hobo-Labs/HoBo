import { mustGet } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import { createLocalRuntimeHost } from "../src/host.js";

describe("createLocalRuntimeHost", () => {
	it("ensures ready and serves private handlers", async () => {
		const host = createLocalRuntimeHost();
		expect(host.kind).toBe("local");
		const ensure = await host.ensure({ hoboHome: "/tmp/hobo-local" });
		expect(ensure.ready).toBe(true);

		const serve = await host.servePrivate({
			hoboHome: "/tmp/hobo-local",
			projectDir: "/tmp",
			bindleEnv: { GREETING_PREFIX: "howdy" },
			privateComponents: [
				{
					resourceName: "api",
					projectDir: "/tmp",
					handler: async () =>
						Response.json({
							message: `${process.env.GREETING_PREFIX ?? "hello"}, world`,
						}),
				},
			],
		});
		const body = await (
			await mustGet(
				serve.handlers,
				"api",
				"serve.handlers",
			)(new Request("http://x/"))
		).json();
		expect(body).toEqual({ message: "howdy, world" });
		await serve.close();
	});
});
