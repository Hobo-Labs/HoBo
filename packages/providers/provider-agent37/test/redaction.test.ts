import { randomBytes } from "node:crypto";
import { generateAgent37TestApiKey } from "@hobo/provider-agent37/fake";
import { describe, expect, it } from "vitest";
import {
	Agent37Error,
	createAgent37Client,
	redactAgent37Text,
} from "../src/index.js";

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
	for (const output of outputs) {
		for (const form of forms) expect(output).not.toContain(form);
	}
}

describe("Agent37 redaction", () => {
	it("redacts API and webhook credential shapes", () => {
		const apiKey = generateAgent37TestApiKey();
		const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
		const output = redactAgent37Text(
			`rejected ${apiKey} and ${webhookSecret}\nforged`,
		);
		expect(output).toContain("[redacted]");
		expect(output).not.toContain("\n");
		expectNoCredential([output], apiKey);
		expectNoCredential([output], webhookSecret);
	});

	it("redacts provider error bodies in messages, stacks, and JSON", async () => {
		const apiKey = generateAgent37TestApiKey();
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
					{ status: 400 },
				),
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Agent37Error);
		expect(failure).toMatchObject({ providerCode: "invalid_request" });
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});

	it("redacts transport failures without retaining a raw cause", async () => {
		const apiKey = generateAgent37TestApiKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async () => {
				throw new Error(`socket failed with ${apiKey}`);
			},
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Agent37Error);
		expect(failure.cause).toBeUndefined();
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});

	it("redacts an echoed exec credential", async () => {
		const apiKey = generateAgent37TestApiKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async (input, init) => {
				const echoed = new Request(input, init).headers.get("x-agent37-key");
				throw new Error(`sandbox echoed ${echoed}`);
			},
		});
		const failure = await client
			.exec("box-1", { command: "true" })
			.catch((error: Error) => error);
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});

	it("does not echo credentials in schema failures", async () => {
		const apiKey = generateAgent37TestApiKey();
		const client = createAgent37Client({
			apiKey,
			fetchImpl: async () =>
				new Response(JSON.stringify({ data: [{ id: apiKey }] })),
		});
		const failure = await client.listInstances().catch((error: Error) => error);
		expectNoCredential(
			[failure.message, failure.stack ?? "", JSON.stringify(failure)],
			apiKey,
		);
	});
});
