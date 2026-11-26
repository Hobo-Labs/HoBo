import { describe, expect, it, vi } from "vitest";

import {
	applyLocalBridgeUrlOverride,
	createBridgeStationHost,
	LOCAL_BRIDGE_DEFAULT_URL,
	probeLocalBridge,
	resolveLocalBridgeBase,
} from "./local-bridge-client.js";

describe("local bridge client", () => {
	it("defaults to loopback bridge URL", () => {
		expect(resolveLocalBridgeBase(undefined)).toBe(LOCAL_BRIDGE_DEFAULT_URL);
		expect(resolveLocalBridgeBase("")).toBe(LOCAL_BRIDGE_DEFAULT_URL);
		expect(resolveLocalBridgeBase("http://127.0.0.1:8787/")).toBe(
			"http://127.0.0.1:8787",
		);
	});

	it("applies bridge URL overrides for agent regressions", () => {
		expect(applyLocalBridgeUrlOverride("http://127.0.0.1:18787/")).toBe(
			"http://127.0.0.1:18787",
		);
		expect(resolveLocalBridgeBase()).toBe("http://127.0.0.1:18787");
		applyLocalBridgeUrlOverride(LOCAL_BRIDGE_DEFAULT_URL);
	});

	it("probes health and returns remediation when unreachable", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("offline");
		});
		vi.stubGlobal("fetch", fetchMock);
		const health = await probeLocalBridge("http://127.0.0.1:9");
		expect(health.ok).toBe(false);
		expect(health.remediation).toMatch(/static site alone|Stations do not need/i);
		expect(health.remediation).not.toMatch(/Docker required/i);
		vi.unstubAllGlobals();
	});

	it("creates a host runtime that points at the Wasp client URL", () => {
		const host = createBridgeStationHost("http://127.0.0.1:3000");
		expect(host.url).toBe("http://127.0.0.1:3000");
		expect(() => host.revoke()).not.toThrow();
	});
});
