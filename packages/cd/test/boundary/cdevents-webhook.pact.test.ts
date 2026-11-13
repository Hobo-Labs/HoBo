import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, TransportResponse } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createCloudEventsWebhookSink,
	projectCdEvents,
	verifyWebhookSignature,
} from "../../src/boundary/index.js";
import { credentials, SECRET, scriptedHttp } from "./fakes.js";
import { fixtureJournal } from "./journal.js";

// Consumer side of the CDEvents webhook boundary: the request HoBo sends and
// the three receiver behaviours it must handle, replayed from the pact.
const here = dirname(fileURLToPath(import.meta.url));
const pact = JSON.parse(
	readFileSync(join(here, "cdevents-webhook.pact.json"), "utf8"),
);
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const deployed = projectCdEvents(fixtureJournal(), {
	source: "/hobo/cd/acme",
})[3];
if (deployed === undefined) throw new Error("fixture");

type Interaction = {
	description: string;
	request: {
		method: string;
		path: string;
		headers?: Record<string, string>;
		requiredHeaders?: string[];
		body?: JsonObject;
	};
	response?: TransportResponse;
	responses?: TransportResponse[];
	expected: JsonObject;
};

describe("CDEvents webhook boundary (consumer side of the pact)", () => {
	// SAFETY: the pact file is the fixture this suite owns; its shape is Interaction[].
	const interactions: Interaction[] = pact.interactions;
	for (const interaction of interactions) {
		it(interaction.description, async () => {
			const replies =
				interaction.responses ??
				(interaction.response ? [interaction.response] : []);
			const http = scriptedHttp(replies);
			const sink = createCloudEventsWebhookSink({
				endpoint: "https://receiver.example/cd",
				http,
				credentials: credentials(),
				secretRef: "webhook/acme",
				now: () => NOW,
				sleep: async () => {},
			});
			const result = await sink.deliver(deployed);
			expect(result).toMatchObject(interaction.expected);
			for (const request of http.requests) {
				expect(request.method).toBe(interaction.request.method);
				expect(new URL(request.url).pathname).toBe(interaction.request.path);
				expect(request.headers).toMatchObject(
					interaction.request.headers ?? {},
				);
				for (const name of interaction.request.requiredHeaders ?? []) {
					expect(request.headers[name]).toBeTruthy();
				}
				if (interaction.request.body !== undefined) {
					expect(JSON.parse(request.body ?? "")).toMatchObject(
						interaction.request.body,
					);
				}
				// The provider side verifies every request it is sent.
				verifyWebhookSignature({
					headers: request.headers,
					body: request.body ?? "",
					secret: SECRET,
					now: () => NOW,
				});
			}
		});
	}
});
