/**
 * The parse boundary: what an authored option bag has to survive before
 * anything is fetched, and what the same-origin guard refuses.
 */
import { describe, expect, it } from "vitest";

import {
	assertSameOriginAsset,
	BrowserWasmProviderError,
	browserWasm,
	defaultTransportPolicy,
	guestManifestPath,
	isComponentPreamble,
	parseGuestPlacement,
	WASM_PAGE_BYTES,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

const HOST_ORIGIN = "https://try-site.browser-wasm.hobo.localhost";

function rejects(input: JsonValue): BrowserWasmProviderError {
	try {
		parseGuestPlacement(input);
	} catch (error) {
		if (error instanceof BrowserWasmProviderError) return error;
		throw error;
	}
	throw new Error("expected the placement to be rejected");
}

describe("parseGuestPlacement", () => {
	it("fills the documented defaults and pairs the resource class with the port", () => {
		const placement = parseGuestPlacement({ guestId: "try-site" });

		expect(placement.port).toBe("compute");
		expect(placement.resourceClass).toBe("browser-wasm:guest");
		expect(placement.persistence).toBe("transient-memory");
		expect(placement.epochDeadlineMs).toBe(5_000);
	});

	it("derives the kv and queue resource classes from their ports", () => {
		expect(
			parseGuestPlacement({ guestId: "cache", port: "kv" }).resourceClass,
		).toBe("browser-wasm:kv");
		expect(
			parseGuestPlacement({ guestId: "jobs", port: "queue" }).resourceClass,
		).toBe("browser-wasm:queue");
	});

	it("rejects a guest id that would not survive as a DNS label", () => {
		const error = rejects({ guestId: "Try_Site" });

		expect(error.code).toBe("PLACEMENT_REJECTED");
	});

	it("rejects a memory limit that is not a whole number of wasm pages", () => {
		// The engine rounds up, and then the receipt disagrees with the memory
		// the guest actually got.
		expect(() =>
			parseGuestPlacement({
				guestId: "try-site",
				memoryLimitBytes: 256 * 1024 * 1024 + 1,
			}),
		).toThrow();
		expect(
			parseGuestPlacement({
				guestId: "try-site",
				memoryLimitBytes: 256 * WASM_PAGE_BYTES * 4,
			}).memoryLimitBytes,
		).toBe(67_108_864);
	});

	it("rejects an unbounded epoch deadline, which is the same as no deadline", () => {
		expect(() =>
			parseGuestPlacement({ guestId: "try-site", epochDeadlineMs: 0 }),
		).toThrow();
		expect(() =>
			parseGuestPlacement({ guestId: "try-site", epochDeadlineMs: 600_000 }),
		).toThrow();
	});

	it("refuses to let a placement ask for `unavailable`", () => {
		// Unavailable is an outcome the host reports, not something to request.
		expect(() =>
			parseGuestPlacement({ guestId: "try-site", persistence: "unavailable" }),
		).toThrow();
	});
});

describe("browserWasm.with.placement", () => {
	it("parses the option bag at authoring time", () => {
		const block = browserWasm.with.placement({
			guestId: "try-site",
			port: "kv",
		});

		expect(block.providerId).toBe("browser-wasm");
		expect(block.port).toBe("kv");
		expect(block.placement.resourceClass).toBe("browser-wasm:kv");
	});

	it("leaves the legacy guest() block alone", () => {
		// `examples/try-site` authors against this, and it is not a placement.
		const block = browserWasm.with.guest();

		expect(block.optionName).toBe("guest");
		expect(block.options.runtime).toBe("wit");
	});
});

describe("assertSameOriginAsset", () => {
	const policy = defaultTransportPolicy(HOST_ORIGIN);

	it("accepts the host's own /_hobo/ routes", () => {
		expect(
			assertSameOriginAsset(
				`${HOST_ORIGIN}${guestManifestPath("try-site")}`,
				policy,
			).pathname,
		).toBe("/_hobo/guests/try-site/manifest.json");
	});

	it("refuses a bundle from another origin", () => {
		// A cross-origin component is code from somewhere else running with
		// every capability this host grants its guests.
		const error = (() => {
			try {
				assertSameOriginAsset(
					"https://cdn.example.test/_hobo/guests/try-site/component.wasm",
					policy,
				);
			} catch (thrown) {
				return thrown;
			}
			throw new Error("expected a cross-origin bundle to be refused");
		})();

		if (!(error instanceof BrowserWasmProviderError)) throw error;
		expect(error.code).toBe("HOST_UNSUPPORTED");
	});

	it("refuses a path that walks out of the /_hobo/ route", () => {
		expect(() =>
			assertSameOriginAsset(`${HOST_ORIGIN}/_hobo/../secrets.json`, policy),
		).toThrow();
		expect(() =>
			assertSameOriginAsset(`${HOST_ORIGIN}/assets/app.wasm`, policy),
		).toThrow();
	});

	it("refuses cleartext by default", () => {
		expect(() =>
			assertSameOriginAsset(
				"http://try-site.browser-wasm.hobo.localhost/_hobo/host/capabilities",
				policy,
			),
		).toThrow();
	});
});

describe("isComponentPreamble", () => {
	it("tells a component apart from a core module with the same magic", () => {
		expect(
			isComponentPreamble(new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0])),
		).toBe(true);
		expect(
			isComponentPreamble(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
		).toBe(false);
		expect(isComponentPreamble(new Uint8Array([0, 0x61, 0x73]))).toBe(false);
	});
});
