import { describe, expect, it } from "vitest";
import { createAgent37SandboxDriver, resolveAgent37Network } from "../src/agent37-sandbox.js";

describe("resolveAgent37Network", () => {
	it.each([
		{ label: "missing network", pool: { template: "t", type: "vm" as const } },
		{ label: "allow-all", pool: { template: "t", type: "vm" as const, network: "allow-all" as const } },
		{ label: "deny-all", pool: { template: "t", type: "vm" as const, network: "deny-all" as const } },
		{
			label: "empty allow",
			pool: { template: "t", type: "vm" as const, network: { allow: [] } },
		},
	])("rejects $label", ({ pool }) => {
		expect(() => resolveAgent37Network(pool)).toThrow();
	});

	it("returns a copy of the allow list", () => {
		expect(
			resolveAgent37Network({
				template: "t",
				type: "vm",
				network: { allow: ["github.com"] },
			}),
		).toEqual({ allow: ["github.com"] });
	});
});

describe("createAgent37SandboxDriver start", () => {
	it("rejects JIT payloads outside the base64 charset", async () => {
		const exec = async () => ({ exit_code: 0, stdout: "", stderr: "" });
		const driver = createAgent37SandboxDriver({
			client: {
				createInstance: async () => {
					throw new Error("unexpected create");
				},
				getInstance: async () => {
					throw new Error("unexpected get");
				},
				listInstances: async () => [],
				deleteInstance: async () => undefined,
				exec,
				registerWebhook: async () => ({ id: "wh" }),
				listWebhooks: async () => [],
				deleteWebhook: async () => undefined,
				usage: async () => ({
					compute: { cost_micros: 0, awake_minutes: 0 },
					disk: { cost_micros: 0, gigabyte_minutes: 0 },
					memory: { cost_micros: 0, gigabyte_minutes: 0 },
					network: { cost_micros: 0, egress_bytes: 0, ingress_bytes: 0 },
				}),
			},
			pool: {
				template: "t",
				type: "vm",
				network: { allow: ["github.com"] },
			},
		});
		await expect(
			driver.start("hobo-00000000-0000-4000-8000-000000000001", "inst", "not-base64!"),
		).rejects.toThrow(/invalid runner JIT/);
	});
});