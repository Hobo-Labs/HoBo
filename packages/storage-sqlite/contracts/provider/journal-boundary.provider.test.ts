import { readFileSync } from "node:fs";
import { type AppendOptions, EventStoreError } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createMemoryNodeSqliteDriver,
	SqliteJournal,
} from "../../src/index.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	parseJsonValue,
} from "../../src/json.js";

const document = parseJsonValue(
	readFileSync(
		new URL("../journal-boundary.pact.json", import.meta.url),
		"utf8",
	),
);
if (
	!isJsonObject(document) ||
	!Array.isArray(document.interactions) ||
	document.interactions.length === 0
) {
	throw new Error("journal boundary pact must contain interactions");
}
const interactions = document.interactions.map((interaction, index) => {
	if (
		!isJsonObject(interaction) ||
		!isJsonString(interaction.description) ||
		!isJsonString(interaction.providerState) ||
		!isJsonObject(interaction.request) ||
		!isJsonObject(interaction.response)
	) {
		throw new Error(`journal boundary pact interaction ${index} is malformed`);
	}
	return {
		description: interaction.description,
		providerState: interaction.providerState,
		request: interaction.request,
		response: interaction.response,
	};
});

const actor = { kind: "system" as const, id: "test" };
const setupOptions = { expectedSeq: 0, actor, tenant: "t1" };

async function arrange(journal: SqliteJournal, state: string): Promise<void> {
	switch (state) {
		case "an empty store":
			return;
		case "stream order:1 has one event":
			await journal.append(
				"order:1",
				[{ type: "order.Created", data: { n: 1 } }],
				setupOptions,
			);
			return;
		case "stream actor:a is fenced at 5":
			await journal.append("actor:a", [{ type: "actor.Opened", data: {} }], {
				...setupOptions,
				fenceToken: 5n,
			});
			return;
		default:
			throw new Error(`unknown provider state: ${state}`);
	}
}

function stringField(object: JsonObject, name: string): string {
	const value = object[name];
	if (!isJsonString(value)) throw new Error(`${name} must be a string`);
	return value;
}

function optionsOf(request: JsonObject): AppendOptions {
	const options = request.options;
	if (!isJsonObject(options) || !isJsonNumber(options.expectedSeq)) {
		throw new Error("request options are malformed");
	}
	if (!isJsonObject(options.actor)) throw new Error("request actor is missing");
	const kind = stringField(options.actor, "kind");
	if (
		kind !== "user" &&
		kind !== "agent" &&
		kind !== "service" &&
		kind !== "system"
	) {
		throw new Error(`unknown actor kind: ${kind}`);
	}
	const parsed: AppendOptions = {
		expectedSeq: options.expectedSeq,
		actor: { kind, id: stringField(options.actor, "id") },
		tenant: stringField(options, "tenant"),
	};
	if (options.fenceToken !== undefined) {
		parsed.fenceToken = BigInt(stringField(options, "fenceToken"));
	}
	return parsed;
}

async function perform(journal: SqliteJournal, request: JsonObject) {
	if (request.method !== "append" || !Array.isArray(request.events)) {
		throw new Error("unknown or malformed journal request");
	}
	const events = request.events.map((event) => {
		if (!isJsonObject(event)) throw new Error("malformed request event");
		return { type: stringField(event, "type"), data: event.data };
	});
	try {
		const result = await journal.append(
			stringField(request, "streamId"),
			events,
			optionsOf(request),
		);
		return {
			appended: result.appended.length,
			firstPosition: result.firstPosition?.toString() ?? null,
			lastPosition: result.lastPosition?.toString() ?? null,
		};
	} catch (error) {
		if (error instanceof EventStoreError)
			return { error: { code: error.code } };
		throw error;
	}
}

describe("SQLite journal provider contract", () => {
	for (const interaction of interactions) {
		it(interaction.description, async () => {
			const journal = new SqliteJournal(createMemoryNodeSqliteDriver(), {
				nativePragmas: false,
				clock: { now: () => "2026-07-27T00:00:00.000Z" },
			});
			try {
				await arrange(journal, interaction.providerState);
				expect(await perform(journal, interaction.request)).toEqual(
					interaction.response,
				);
			} finally {
				journal.close();
			}
		});
	}
});
