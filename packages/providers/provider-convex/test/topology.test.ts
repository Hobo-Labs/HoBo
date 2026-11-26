import { describe, expect, it } from "vitest";

import {
	assertConvexBackendReachableFromFrontend,
	ConvexFrontendTopologyError,
	classifyConvexBackendUrl,
} from "../src/topology.js";

describe("convex frontend topology", () => {
	it("classifies loopback vs public", () => {
		expect(classifyConvexBackendUrl("http://127.0.0.1:3210").kind).toBe(
			"loopback",
		);
		expect(classifyConvexBackendUrl("http://localhost:3210").kind).toBe(
			"loopback",
		);
		expect(
			classifyConvexBackendUrl("https://happy-animal-123.convex.cloud").kind,
		).toBe("public");
		expect(classifyConvexBackendUrl("https://convex.example.com").kind).toBe(
			"public",
		);
	});

	it("refuses loopback Convex when frontend is remote-public (Cloudflare)", () => {
		expect(() =>
			assertConvexBackendReachableFromFrontend({
				frontendPlacement: "remote-public",
				deploymentUrl: "http://127.0.0.1:3210",
				mode: "self-hosted",
			}),
		).toThrow(ConvexFrontendTopologyError);
	});

	it("allows loopback when frontend is local", () => {
		expect(() =>
			assertConvexBackendReachableFromFrontend({
				frontendPlacement: "local",
				deploymentUrl: "http://127.0.0.1:3210",
				mode: "self-hosted",
			}),
		).not.toThrow();
	});

	it("allows Cloudflare workers.dev Convex URL for remote frontend", () => {
		expect(() =>
			assertConvexBackendReachableFromFrontend({
				frontendPlacement: "remote-public",
				deploymentUrl: "https://hobo-convex-swaghaus.acct.workers.dev",
				mode: "self-hosted",
			}),
		).not.toThrow();
	});
});
