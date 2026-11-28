import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FoldEvent, JsonValue } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRivetActorHost, rivetStreamId } from "../src/actor-host.js";
import { createActorLocalJournal } from "../src/journal.js";
import { isJsonNumber } from "../src/json.js";

const directories: string[] = [];
const identity = {
	tenantId: "acme",
	projectId: "shop",
	actorTypeId: "Counter",
	keySegments: ["inbox"],
	schemaVersion: 1,
};
const streamId = rivetStreamId(identity);

function journalPath() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-inbox-"));
	directories.push(directory);
	return join(directory, "actor.sqlite");
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function add(state: JsonValue, event: FoldEvent): JsonValue {
	if (!isJsonNumber(state) || !isJsonNumber(event.payload))
		throw new TypeError("counter values must be numbers");
	return state + event.payload;
}

function command(commandId: string, payload: number, expectedRevision: number) {
	return { identity, commandId, commandType: "add", payload, expectedRevision };
}

describe("Rivet actor inbox lifecycle", () => {
	it("rejects a stale command without blocking later commands", () => {
		const journal = createActorLocalJournal();
		try {
			const actor = createRivetActorHost({ journal });
			actor.accept(command("a", 2, 0));
			actor.accept(command("b", 3, 0));
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 1,
				commandId: "a",
			});
			expect(() => actor.processNext(identity, add, 0)).toThrow(
				/expected revision 0, found 1/,
			);
			expect(journal.loadCommand(streamId, "b")).toMatchObject({
				status: "failed-terminal",
			});
			const retried = actor.accept(command("b", 3, 0));
			expect(retried).toMatchObject({
				status: "failed-terminal",
				duplicate: true,
			});
			expect(JSON.parse(retried.resultJson ?? "null")).toEqual({
				code: "STALE_REVISION",
				expectedRevision: 0,
				actualRevision: 1,
			});
			actor.accept(command("c", 5, 1));
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 2,
				commandId: "c",
			});
			expect(journal.readFacts(streamId).map((fact) => fact.eventId)).toEqual([
				"a",
				"c",
			]);
		} finally {
			journal.close();
		}
	});

	it("commits chained commands when command ids are not in submission order", () => {
		const journal = createActorLocalJournal();
		try {
			const actor = createRivetActorHost({ journal });
			actor.accept(command("z-first", 2, 0));
			actor.accept(command("a-second", 3, 1));
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 1,
				commandId: "z-first",
			});
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 2,
				commandId: "a-second",
			});
			expect(journal.readFacts(streamId).map((fact) => fact.eventId)).toEqual([
				"z-first",
				"a-second",
			]);
			expect(journal.loadCommand(streamId, "z-first")).toMatchObject({
				status: "completed",
			});
			expect(journal.loadCommand(streamId, "a-second")).toMatchObject({
				status: "completed",
			});
		} finally {
			journal.close();
		}
	});

	it("claims equal revisions in acceptance order and rejects the later one as stale", () => {
		const journal = createActorLocalJournal();
		try {
			const actor = createRivetActorHost({ journal });
			actor.accept(command("z-first", 2, 0));
			actor.accept(command("a-second", 3, 0));
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 1,
				commandId: "z-first",
			});
			expect(() => actor.processNext(identity, add, 0)).toThrow(
				/expected revision 0, found 1/,
			);
			expect(journal.loadCommand(streamId, "a-second")).toMatchObject({
				status: "failed-terminal",
			});
			expect(journal.readFacts(streamId).map((fact) => fact.eventId)).toEqual([
				"z-first",
			]);
		} finally {
			journal.close();
		}
	});

	it("does not terminally reject a command ahead of the head", () => {
		const journal = createActorLocalJournal();
		try {
			const actor = createRivetActorHost({ journal });
			actor.accept(command("a-second", 3, 1));
			expect(actor.processNext(identity, add, 0)).toBeUndefined();
			expect(actor.processNext(identity, add, 0)).toBeUndefined();
			expect(journal.loadCommand(streamId, "a-second")).toMatchObject({
				status: "persisted",
			});
			expect(journal.readFacts(streamId)).toHaveLength(0);
			actor.accept(command("z-first", 2, 0));
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 1,
				commandId: "z-first",
			});
			expect(actor.processNext(identity, add, 0)).toEqual({
				revision: 2,
				commandId: "a-second",
			});
			expect(journal.readFacts(streamId).map((fact) => fact.eventId)).toEqual([
				"z-first",
				"a-second",
			]);
			expect(journal.loadCommand(streamId, "a-second")?.status).not.toBe(
				"failed-terminal",
			);
		} finally {
			journal.close();
		}
	});

	it.each([
		false,
		true,
	])("finishes a committed command after reopen (legacy receipt: %s)", (legacyReceipt) => {
		const path = journalPath();
		const first = createActorLocalJournal(path);
		const actor = createRivetActorHost({ journal: first });
		actor.accept(command("a", 2, 0));
		first.claimNext(streamId);
		const commit = {
			streamId,
			commandId: "a",
			expectedRevision: 0,
			facts: [
				{
					type: "add",
					eventId: "a",
					payload: new TextEncoder().encode("2"),
					metadataJson: "{}",
					tenant: "acme",
				},
			],
			effects: [{ effectId: "effect-a", digest: "one", payloadJson: "{}" }],
		};
		first.commitCommand(commit);
		expect(first.loadCommand(streamId, "a")).toMatchObject({
			status: "committed",
			resultJson: '{"revision":1}',
		});
		expect(() => first.commitCommand(commit)).toThrow(/not pending/);
		first.close();
		if (legacyReceipt) {
			const raw = new DatabaseSync(path);
			raw
				.prepare(
					"UPDATE hobo_inbox SET result_json = NULL WHERE command_id = ?",
				)
				.run("a");
			raw.close();
		}

		const reopened = createActorLocalJournal(path);
		try {
			const next = createRivetActorHost({ journal: reopened });
			expect(
				next.processNext(
					identity,
					() => {
						throw new Error("must not run again");
					},
					0,
				),
			).toEqual({ revision: 1, commandId: "a" });
			expect(reopened.loadCommand(streamId, "a")).toMatchObject({
				status: "completed",
				resultJson: '{"revision":1}',
			});
			expect(reopened.readFacts(streamId)).toHaveLength(1);
			expect(reopened.pendingOutbox(streamId)).toHaveLength(1);
			expect(next.processNext(identity, add, 0)).toBeUndefined();
		} finally {
			reopened.close();
		}
	});
	it("does not invent a receipt for a committed command without a matching event", () => {
		const journal = createActorLocalJournal();
		try {
			const actor = createRivetActorHost({ journal });
			actor.accept(command("a", 2, 0));
			journal.markCommitted(streamId, "a");
			expect(() => actor.processNext(identity, add, 0)).toThrow(
				/cannot recover committed revision/,
			);
			expect(journal.loadCommand(streamId, "a")?.status).toBe("committed");
			expect(journal.readFacts(streamId)).toHaveLength(0);
		} finally {
			journal.close();
		}
	});
});
