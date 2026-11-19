import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FoldEvent, JsonValue } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRivetActorHost, rivetStreamId } from "../src/actor-host.js";
import { createActorLocalJournal } from "../src/journal.js";
import { isJsonNumber, isJsonObject } from "../src/json.js";

const directories: string[] = [];
const identity = {
	tenantId: "acme",
	projectId: "shop",
	actorTypeId: "Counter",
	keySegments: ["one"],
	schemaVersion: 1,
};

function journalPath() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-replay-"));
	directories.push(directory);
	return join(directory, "actor.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function add(state: JsonValue, event: FoldEvent): JsonValue {
	if (!isJsonObject(state) || !isJsonNumber(state.total))
		throw new TypeError("counter state needs a total");
	if (event.type !== "add" || !isJsonNumber(event.payload))
		throw new TypeError("add needs a numeric payload");
	return { total: state.total + event.payload };
}

describe("Rivet actor event replay", () => {
	it("replays the original event payload when a later command runs after reopen", () => {
		const path = journalPath();
		const first = createActorLocalJournal(path);
		const actor = createRivetActorHost({ journal: first });
		actor.accept({
			identity,
			commandId: "a",
			commandType: "add",
			payload: 3,
			expectedRevision: 0,
		});
		expect(actor.processNext(identity, add, { total: 0 })?.revision).toBe(1);
		first.close();

		const second = createActorLocalJournal(path);
		try {
			const reopened = createRivetActorHost({ journal: second });
			reopened.accept({
				identity,
				commandId: "b",
				commandType: "add",
				payload: 5,
				expectedRevision: 1,
			});
			const states: JsonValue[] = [];
			expect(
				reopened.processNext(
					identity,
					(state, event) => {
						states.push(state);
						return add(state, event);
					},
					{ total: 0 },
				)?.revision,
			).toBe(2);
			expect(states.at(-1)).toEqual({ total: 3 });
			expect(
				second
					.readFacts(rivetStreamId(identity))
					.map((fact) => JSON.parse(new TextDecoder().decode(fact.payload))),
			).toEqual([3, 5]);
		} finally {
			second.close();
		}
	});

	it("replays a legacy state-valued event using its committed inbox payload", () => {
		const journal = createActorLocalJournal(journalPath());
		try {
			const streamId = rivetStreamId(identity);
			journal.acceptCommand({
				streamId,
				commandId: "a",
				digest: "legacy",
				commandType: "add",
				payloadJson: "3",
				expectedRevision: 0,
			});
			journal.claimNext(streamId);
			journal.commitCommand({
				streamId,
				commandId: "a",
				expectedRevision: 0,
				facts: [
					{
						type: "add",
						eventId: "a",
						payload: new TextEncoder().encode('{"total":3}'),
						metadataJson: "{}",
						tenant: "acme",
					},
				],
			});
			journal.completeCommand(streamId, "a", '{"revision":1}');
			const actor = createRivetActorHost({ journal });
			actor.accept({
				identity,
				commandId: "b",
				commandType: "add",
				payload: 5,
				expectedRevision: 1,
			});
			const states: JsonValue[] = [];
			expect(
				actor.processNext(
					identity,
					(state, event) => {
						states.push(state);
						return add(state, event);
					},
					{ total: 0 },
				)?.revision,
			).toBe(2);
			expect(states.at(-1)).toEqual({ total: 3 });
		} finally {
			journal.close();
		}
	});
	it.each([
		["command", 7],
		["event", 11],
	] as const)("requires an explicit %s interpretation when an old payload is ambiguous", (interpretation, expectedState) => {
		const journal = createActorLocalJournal(journalPath());
		try {
			const streamId = rivetStreamId(identity);
			journal.append(streamId, 0, [
				{
					type: "add",
					eventId: "external",
					payload: new TextEncoder().encode("4"),
					metadataJson: "{}",
					tenant: "acme",
				},
			]);
			journal.acceptCommand({
				streamId,
				commandId: "a",
				digest: "legacy",
				commandType: "add",
				payloadJson: "3",
				expectedRevision: 1,
			});
			journal.claimNext(streamId);
			journal.commitCommand({
				streamId,
				commandId: "a",
				expectedRevision: 1,
				facts: [
					{
						type: "add",
						eventId: "a",
						payload: new TextEncoder().encode("7"),
						metadataJson: "{}",
						tenant: "acme",
					},
				],
			});
			journal.completeCommand(streamId, "a", '{"revision":2}');
			const ambiguous = createRivetActorHost({ journal });
			ambiguous.accept({
				identity,
				commandId: "b",
				commandType: "add",
				payload: 1,
				expectedRevision: 2,
			});
			const addNumber = (state: JsonValue, event: FoldEvent): JsonValue => {
				if (!isJsonNumber(state) || !isJsonNumber(event.payload))
					throw new TypeError("numbers required");
				return state + event.payload;
			};
			expect(() => ambiguous.processNext(identity, addNumber, 0)).toThrow(
				/ambiguous legacy event payload/,
			);
			expect(journal.head(streamId).revision).toBe(2);
			const recovered = createRivetActorHost({
				journal,
				legacyEventPayloads: interpretation,
			});
			const inputs: JsonValue[] = [];
			expect(
				recovered.processNext(
					identity,
					(state, event) => {
						inputs.push(state);
						return addNumber(state, event);
					},
					0,
				)?.revision,
			).toBe(3);
			expect(inputs.at(-1)).toBe(expectedState);
		} finally {
			journal.close();
		}
	});

	it("rejects a concurrent append after reading the event history", () => {
		const journal = createActorLocalJournal(journalPath());
		try {
			const streamId = rivetStreamId(identity);
			const actor = createRivetActorHost({ journal });
			actor.accept({
				identity,
				commandId: "a",
				commandType: "add",
				payload: 3,
				expectedRevision: 0,
			});
			expect(() =>
				actor.processNext(
					identity,
					(state, event) => {
						journal.append(streamId, 0, [
							{
								type: "add",
								eventId: "other",
								payload: new TextEncoder().encode("2"),
								metadataJson: "{}",
								tenant: "acme",
							},
						]);
						return add(state, event);
					},
					{ total: 0 },
				),
			).toThrow(/expected revision 0, found 1/);
			expect(journal.readFacts(streamId).map((event) => event.eventId)).toEqual(
				["other"],
			);
		} finally {
			journal.close();
		}
	});
});
