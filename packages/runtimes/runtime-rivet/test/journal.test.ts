import { describe, expect, it } from "vitest";

import { createActorLocalJournal, RivetJournalError } from "../src/index.js";

const fact = (eventId: string, type = "added") => ({
	type,
	eventId,
	payload: new TextEncoder().encode(JSON.stringify({ eventId })),
	metadataJson: "{}",
	tenant: "acme",
	project: "shop",
});

describe("actor-local journal", () => {
	it("appends under expected-revision CAS", () => {
		const journal = createActorLocalJournal();
		const first = journal.append("s1", 0, [fact("e1")]);
		expect(first.revision).toBe(1);
		expect(() => journal.append("s1", 0, [fact("e2")])).toThrow(
			RivetJournalError,
		);
		expect(journal.append("s1", 1, [fact("e2")]).revision).toBe(2);
		expect(journal.readFacts("s1")).toHaveLength(2);
		journal.close();
	});

	it("rejects duplicate command id with a different digest", () => {
		const journal = createActorLocalJournal();
		const accepted = journal.acceptCommand({
			streamId: "s1",
			commandId: "cmd-1",
			digest: "aaa",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		expect(accepted.status).toBe("persisted");
		expect(() =>
			journal.acceptCommand({
				streamId: "s1",
				commandId: "cmd-1",
				digest: "bbb",
				commandType: "add",
				payloadJson: "{}",
				expectedRevision: 0,
			}),
		).toThrow(/digest mismatch/);
		const again = journal.acceptCommand({
			streamId: "s1",
			commandId: "cmd-1",
			digest: "aaa",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		expect(again.duplicate).toBe(true);
		journal.close();
	});

	it("recovers a persisted command after a simulated wake", () => {
		const journal = createActorLocalJournal();
		journal.acceptCommand({
			streamId: "s1",
			commandId: "cmd-1",
			digest: "aaa",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		const claimed = journal.claimNext("s1");
		expect(claimed?.commandId).toBe("cmd-1");
		const committed = journal.commitCommand({
			streamId: "s1",
			commandId: "cmd-1",
			expectedRevision: 0,
			facts: [fact("e1")],
			effects: [
				{
					effectId: "fx-1",
					digest: "fx",
					payloadJson: '{"kind":"queue"}',
				},
			],
		});
		expect(committed.revision).toBe(1);
		expect(journal.loadCommand("s1", "cmd-1")?.status).toBe("committed");
		expect(journal.pendingOutbox("s1")).toHaveLength(1);
		journal.completeCommand("s1", "cmd-1", '{"ok":true}');
		expect(journal.loadCommand("s1", "cmd-1")?.status).toBe("completed");
		journal.close();
	});
});
