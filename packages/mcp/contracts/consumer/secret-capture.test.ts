import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
	type CapturePublicKey,
	createSecretCaptureApp,
	type SecretCaptureApp,
	type SecretCaptureOutcome,
} from "../../src/index.js";
import type { JsonObject } from "../../src/json.js";
import {
	memoryConnector,
	SPECS,
	sealAsTheFormDoes,
	synthetic,
} from "../../test/secret-capture-support.js";

// The consumer side of the secret-capture MCP App pact: an MCP Apps host (and
// a host with URL elicitation only) against the real app. Each recorded
// interaction is realized by the app and its recorded body is a subset of
// what the app answers.

type Interaction = {
	description: string;
	providerState: string;
	response: { status: string; body: JsonObject };
};

type Pact = {
	consumer: { name: string };
	provider: { name: string };
	interactions: Interaction[];
};

// The app's answers are JSON: a round trip reads them as the recorded shape.
const roundTrip = <T>(text: string): T => JSON.parse(text);

const pact: Pact = JSON.parse(
	readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"../pacts/secret-capture-mcp-app.pact.json",
		),
		"utf8",
	),
);

function interaction(prefix: string): Interaction {
	const found = pact.interactions.find((i) => i.description.startsWith(prefix));
	if (!found) throw new Error(`no interaction "${prefix}"`);
	return found;
}

const APPS = { apps: true, urlElicitation: false };
const apps: SecretCaptureApp[] = [];
afterEach(async () => {
	while (apps.length > 0) await apps.pop()?.close();
});

function app(options: Parameters<typeof memoryConnector>[0] = {}) {
	const created = createSecretCaptureApp({
		specs: SPECS,
		connector: memoryConnector(options).connector,
	});
	apps.push(created);
	return created;
}

function body(outcome: SecretCaptureOutcome) {
	return outcome.kind === "result" ? outcome.result : outcome.error;
}

type Ticket = { ticketId: string; name: string; key: CapturePublicKey };

describe("secret-capture-mcp-app pact", () => {
	it("names the MCP Apps host as consumer and the capture app as provider", () => {
		expect(pact.consumer.name).toBe("mcp-apps-host");
		expect(pact.provider.name).toBe("hobo-secret-capture-app");
	});

	it("realizes the tool list and the resource read", () => {
		const capture = app();
		const tools = capture.tools(APPS);
		const expected = roundTrip<{ tools: { name: string }[] }>(
			JSON.stringify(interaction("an MCP Apps host lists").response.body),
		);
		for (const tool of expected.tools)
			expect(
				tools.find((candidate) => candidate.name === tool.name),
			).toMatchObject(tool);
		const read = roundTrip<{ contents: JsonObject[] }>(
			JSON.stringify(capture.readResource("ui://hobo/secret-capture")),
		);
		expect(read.contents[0]).toMatchObject(
			interaction("the host reads the form").response.body,
		);
	});

	it("realizes open, submit and refusal", async () => {
		const capture = app();
		const opened = body(
			await capture.callTool(
				"capture_secret",
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		expect(opened).toMatchObject(
			interaction("capture_secret opens").response.body,
		);
		const ticket = roundTrip<{ structuredContent: Ticket }>(
			JSON.stringify(opened),
		).structuredContent;
		const submitted = roundTrip<{ structuredContent: JsonObject }>(
			JSON.stringify(
				body(
					await capture.callTool(
						"submit_secret_value",
						{
							ticketId: ticket.ticketId,
							sealed: await sealAsTheFormDoes(
								ticket,
								synthetic("SYNTHETIC-webhook", 24),
							),
						},
						APPS,
					),
				),
			),
		);
		expect(submitted).toMatchObject(
			interaction("the form's submit_secret_value").response.body,
		);
		// "only": the receipt has exactly these keys.
		expect(Object.keys(submitted.structuredContent).sort()).toEqual([
			"name",
			"ref",
			"status",
			"stored",
			"ticketId",
		]);

		const refused = body(
			await app({ connected: false }).callTool(
				"capture_secret",
				{ name: "HOBO_CI_WEBHOOK_SECRET" },
				APPS,
			),
		);
		expect(refused).toMatchObject(
			interaction("capture_secret refuses").response.body,
		);
	});

	it("realizes URL elicitation for a host without MCP Apps", async () => {
		const outcome = await app().callTool(
			"capture_secret",
			{ name: "HOBO_CI_WEBHOOK_SECRET" },
			{ apps: false, urlElicitation: true },
		);
		expect(outcome.kind).toBe("error");
		expect(body(outcome)).toMatchObject(
			interaction("a host without MCP Apps").response.body,
		);
	});
});
