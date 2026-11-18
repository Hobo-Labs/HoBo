import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mustGet } from "@hobo/core/total-access";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCloudNativeRuntimeHost,
	createMockCloudNativeProvider,
	defaultCloudNativeProviders,
} from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("@hobo/runtime-cloud-native", () => {
	it("registers mock and cloud providers", () => {
		const ids = defaultCloudNativeProviders().map((p) => p.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"mock",
				"aws",
				"gcp",
				"azure",
				"vercel",
				"cloudflare",
			]),
		);
	});

	it("ensure is ready for the full registry", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-cn-ensure-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const host = createCloudNativeRuntimeHost();
		const result = await host.ensure({ hoboHome });
		expect(result.kind).toBe("cloud-native");
		expect(result.ready).toBe(true);
		expect(result.details?.defaultProvider).toBe("mock");
	});

	it("mock provider serves private handlers (parity path)", async () => {
		const hoboHome = await mkdtemp(join(tmpdir(), "hobo-cn-serve-"));
		cleanups.push(() => rm(hoboHome, { recursive: true, force: true }));
		const host = createCloudNativeRuntimeHost({
			providers: [createMockCloudNativeProvider()],
			defaultProvider: "mock",
		});
		const serve = await host.servePrivate({
			hoboHome,
			projectDir: hoboHome,
			bindleEnv: { GREETING_PREFIX: "howdy" },
			privateComponents: [
				{
					resourceName: "api",
					projectDir: hoboHome,
					handler: async () => {
						const prefix = process.env.GREETING_PREFIX ?? "hello";
						return Response.json({
							message: `${prefix}, world`,
							greetingPrefix: prefix,
						});
					},
				},
			],
		});
		cleanups.push(() => serve.close());
		expect(serve.isolation.isolateBoundary).toBe("cloud_native");
		const body = await (
			await mustGet(
				serve.handlers,
				"api",
				"serve.handlers",
			)(new Request("http://x/hello"))
		).json();
		expect(body).toEqual({ message: "howdy, world", greetingPrefix: "howdy" });
	});

	it("remote providers return bound-endpoint handlers", async () => {
		const host = createCloudNativeRuntimeHost({
			providers: defaultCloudNativeProviders().filter((p) => p.id === "aws"),
			defaultProvider: "aws",
		});
		const result = await host.servePrivate({
			hoboHome: "/tmp",
			projectDir: "/tmp",
			privateComponents: [{ resourceName: "api", projectDir: "/tmp" }],
		});
		cleanups.push(() => result.close());
		expect(
			(await mustGet(result.handlers, "api")(new Request("http://internal/")))
				.status,
		).toBe(501);
	});
});
