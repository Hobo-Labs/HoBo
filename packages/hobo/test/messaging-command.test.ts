import { describe, expect, it } from "vitest";

import { createMessagingCommand } from "../src/messaging-command.js";

function runInput(args: string[] = []) {
	return {
		context: {} as never,
		flags: {} as never,
		args,
		verb: "messaging",
		emitProgress: () => {},
	};
}

describe("createMessagingCommand", () => {
	it("status reports kafka + dapr readiness", async () => {
		const cmd = createMessagingCommand({
			env: {},
			tenantId: "acme",
			campId: "prod",
		});
		const result = await cmd.run(runInput(["status"]));
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			command: "messaging",
			subcommand: "status",
			wit: "hobo:durable-messaging/messaging@0.1.0",
			componentBindings: {
				kafka: "unsupported",
				dapr: "unsupported",
				rivet: "requires-host-integration",
				defaultRuntime: "unsupported",
			},
			defaultRuntime: "in-process-wasm",
			daprOptional: true,
			adr: "ADR-0138",
		});
		expect(result.data).toHaveProperty("kafka");
		expect(result.data).toHaveProperty("dapr");
	});

	it("component-yaml is secretless pubsub.kafka", async () => {
		const cmd = createMessagingCommand({
			env: {},
			tenantId: "acme",
			campId: "prod",
		});
		const result = await cmd.run(
			runInput(["component-yaml", "fromBinding:kafka-bootstrap"]),
		);
		expect(result.ok).toBe(true);
		const yaml = (result.data as { yaml: string }).yaml;
		expect(yaml).toContain("pubsub.kafka");
		expect(yaml).toContain("fromBinding:kafka-bootstrap");
		expect(yaml).not.toMatch(/password\s*:/i);
		expect(yaml).not.toMatch(/secretKey\s*:/i);
		expect((result.data as { secretless: boolean }).secretless).toBe(true);
	});

	it("realize plans kafka resources secretlessly", async () => {
		const cmd = createMessagingCommand({ env: {}, tenantId: "acme" });
		const result = await cmd.run(runInput(["realize", "orders"]));
		expect(result.ok).toBe(true);
		const realized = (
			result.data as {
				realized: { secretless: boolean; messagingBackend: string };
			}
		).realized;
		expect(realized.secretless).toBe(true);
		expect(realized.messagingBackend).toBe("native-kafka");
	});
});
