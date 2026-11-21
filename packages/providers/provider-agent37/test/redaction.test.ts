import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	Agent37Error,
	createAgent37Client,
	redactAgent37Text,
} from "../src/index.js";

function generatedKey(): string {
	return `sk_live_${randomBytes(24).toString("base64url")}`;
}

function expectNoCredential(
	outputs: readonly string[],
	credential: string,
): void {
	const forms = [
		credential,
		JSON.stringify(credential).slice(1, -1),
		Buffer.from(credential).toString("base64"),
		credential.slice(0, 16),
	];
	for (const output of outputs)
		for (const form of forms) expect(output).not.toContain(form);
}

describe("Agent37 error redaction", () => {
	it("redacts runtime-generated API and webhook keys", () => {
		const apiKey = generatedKey();
		const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
		const output = redactAgent37Text(
			`failed ${apiKey} and ${webhookSecret}\nforged`,
		);
		expect(output).toContain("[redacted]");
		expect(output).not.toContain("\n");
		expectNoCredential([output], apiKey);
		expectNoCredential([output], webhookSecret);
	});

	it("redacts provider bodies from messages, stacks, and serialized errors", async () => {
		const apiKey = generatedKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async () =>
				new Response(
					JSON.stringify({
						error: {
							code: "invalid_request",
							message: `upstream echoed ${apiKey}`,
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Agent37Error);
		if (!(failure instanceof Agent37Error)) throw new Error("missing failure");
		expect(failure.providerCode).toBe("invalid_request");
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});

	it("redacts transport failures without retaining a raw cause", async () => {
		const apiKey = generatedKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async () => {
				throw new Error(`socket failed with ${apiKey}`);
			},
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Agent37Error);
		if (!(failure instanceof Agent37Error)) throw new Error("missing failure");
		expect(failure.cause).toBeUndefined();
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});

	it("redacts secrets embedded in schema failures", async () => {
		const apiKey = generatedKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async () =>
				new Response(JSON.stringify({ data: [{ id: apiKey }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Agent37Error);
		if (!(failure instanceof Agent37Error)) throw new Error("missing failure");
		expectNoCredential([failure.message, JSON.stringify(failure)], apiKey);
	});
});
