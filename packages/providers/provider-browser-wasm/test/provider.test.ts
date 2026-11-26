import { describe, expect, it } from "vitest";
import {
	browserWasmNativePorts,
	createBrowserWasmProvider,
	supportsAnonymousTemporaryDeploy,
} from "../src/index.js";
import { provisionTemporaryEnvironmentStation } from "../src/temporary-station.js";
import {
	assertSameOriginAsset,
	defaultTransportPolicy,
} from "../src/transport.js";

describe("guest bundle asset guard", () => {
	it("refuses an encoded separator that survives URL parsing", () => {
		const policy = defaultTransportPolicy("https://app.example");
		// The literal `/..` check beside this one never saw these forms. A
		// guest bundle is code that runs with every capability this host grants
		// its guests, so the route prefix is what keeps it to host-served
		// assets — and an encoded separator walks straight out of it.
		for (const url of [
			"https://app.example/_hobo/%2f%2e%2e%2fetc/passwd",
			"https://app.example/_hobo/..%5csecrets",
		]) {
			expect(() => assertSameOriginAsset(url, policy)).toThrow(
				/percent-encodes/u,
			);
		}

		expect(
			assertSameOriginAsset("https://app.example/_hobo/guest.wasm", policy)
				.pathname,
		).toBe("/_hobo/guest.wasm");
	});
});

describe("@hobo/provider-browser-wasm", () => {
	it("exposes Matching-honest native ports", () => {
		const provider = createBrowserWasmProvider();
		expect(browserWasmNativePorts().length).toBeGreaterThan(0);
		expect(provider.capabilities.length).toBe(browserWasmNativePorts().length);
		const compute = provider.capabilities.find((c) => c.port === "compute");
		expect(compute?.satisfies({ port: "compute" }).kind).toBe("full");
	});

	it("temporary deploy support flag is honest", () => {
		expect(supportsAnonymousTemporaryDeploy).toBe(true);
	});

	it("temporary provision path", async () => {
		const result = await provisionTemporaryEnvironmentStation({
			stationId: "st-1",
		});
		expect(result.anonymous).toBe(true);
		expect(result.temporary).toBe(true);
		expect(result.providerId).toBe("browser-wasm");
		expect(result.claimUrl.length).toBeGreaterThan(0);
	});
});
