import { describe, expect, it } from "vitest";
import { sandboxCreateParameters } from "../src/isolated-sandbox.js";

const config = {
	name: "hobo-00000000-0000-4000-8000-000000000001",
	timeoutMs: 300_000,
	vcpus: 1,
	plan: "hobby" as const,
	forwardUrl: "https://relay.example.test/sandbox/proxy",
	allowedDomains: ["github.com", "api.github.com"],
};

describe("isolated Sandbox creation", () => {
	it("uses one nonpersistent session, no ports or host secrets, and forwards every allowed domain", () => {
		const request = sandboxCreateParameters(config);
		expect(request).toMatchObject({
			name: config.name,
			persistent: false,
			ports: [],
			resources: { vcpus: 1 },
			timeout: 300_000,
		});
		expect(request).not.toHaveProperty("env");
		expect(request).not.toHaveProperty("source");
		expect(request.networkPolicy.allow).toEqual({
			"github.com": [{ forwardURL: config.forwardUrl }],
			"api.github.com": [{ forwardURL: config.forwardUrl }],
		});
	});
	it("forwards only the documented runner wildcard suffixes", () => {
		const request = sandboxCreateParameters({
			...config,
			allowedDomains: [
				"github.com",
				"*.actions.githubusercontent.com",
				"*.blob.core.windows.net",
			],
		});
		expect(request.networkPolicy.allow).toEqual({
			"github.com": [{ forwardURL: config.forwardUrl }],
			"*.actions.githubusercontent.com": [{ forwardURL: config.forwardUrl }],
			"*.blob.core.windows.net": [{ forwardURL: config.forwardUrl }],
		});
		for (const pattern of [
			"*.com",
			"*.githubusercontent.com",
			"*.windows.net",
			"*.*.actions.githubusercontent.com",
			"*.actions.githubusercontent.com.attacker.test",
			"*.ACTIONS.githubusercontent.com",
		])
			expect(() =>
				sandboxCreateParameters({ ...config, allowedDomains: [pattern] }),
			).toThrow();
	});
	it("forwards explicit GitHub Actions setup, checkout, Node and artifact hosts", () => {
		const domains = [
			"github.com",
			"api.github.com",
			"codeload.github.com",
			"raw.githubusercontent.com",
			"nodejs.org",
			"release-assets.githubusercontent.com",
			"*.actions.githubusercontent.com",
			"*.blob.core.windows.net",
		];
		const request = sandboxCreateParameters({
			...config,
			allowedDomains: domains,
		});
		expect(request.networkPolicy.allow).toEqual(
			Object.fromEntries(
				domains.map((domain) => [domain, [{ forwardURL: config.forwardUrl }]]),
			),
		);
		expect(request.networkPolicy.allow).not.toHaveProperty(
			"registry.npmjs.org",
		);
	});
	it.each([
		"*",
		"*.github.com",
		"127.0.0.1",
		"LOCALHOST",
		"github.com/path",
		"example.com:443",
		"example..com",
	])("rejects unsafe destination %s", (destination) => {
		expect(() =>
			sandboxCreateParameters({ ...config, allowedDomains: [destination] }),
		).toThrow();
	});
	it("rejects duplicate destinations and forwarded URL credentials", () => {
		expect(() =>
			sandboxCreateParameters({
				...config,
				allowedDomains: ["github.com", "github.com"],
			}),
		).toThrow();
		expect(() =>
			sandboxCreateParameters({
				...config,
				forwardUrl: "https://user:pass@relay.example.test/proxy",
			}),
		).toThrow();
	});
	it("enforces Hobby duration and resource limits", () => {
		expect(() =>
			sandboxCreateParameters({ ...config, timeoutMs: 46 * 60_000 }),
		).toThrow();
		expect(() => sandboxCreateParameters({ ...config, vcpus: 6 })).toThrow();
		expect(
			sandboxCreateParameters({ ...config, timeoutMs: 45 * 60_000, vcpus: 4 })
				.timeout,
		).toBe(45 * 60_000);
	});
});
