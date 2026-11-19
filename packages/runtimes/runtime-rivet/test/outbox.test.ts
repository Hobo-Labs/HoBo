import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRivetActorHost, rivetStreamId } from "../src/actor-host.js";
import { createActorLocalJournal } from "../src/journal.js";
import { dispatchRivetOutbox } from "../src/outbox.js";

const directories: string[] = [];
function journalPath() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-outbox-"));
	directories.push(directory);
	return join(directory, "actor.sqlite");
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("Rivet outbox delivery", () => {
	it("commits command effects with actor facts and dispatches them", async () => {
		const journal = createActorLocalJournal();
		try {
			const identity = {
				tenantId: "acme",
				projectId: "shop",
				actorTypeId: "Counter",
				keySegments: ["one"],
				schemaVersion: 1,
			};
			const actor = createRivetActorHost({ journal });
			actor.accept({
				identity,
				commandId: "cmd",
				commandType: "add",
				payload: 5,
				expectedRevision: 0,
			});
			expect(
				actor.processNext(
					identity,
					(_state, event) => event.payload ?? null,
					0,
					{
						effects: (state) => [
							{
								effectId: "notify",
								digest: "effect-digest",
								payloadJson: JSON.stringify({ total: state }),
							},
						],
					},
				),
			).toEqual({ revision: 1, commandId: "cmd" });
			const streamId = rivetStreamId(identity);
			const delivered: string[] = [];
			expect(
				await dispatchRivetOutbox(journal, streamId, (effect) => {
					delivered.push(effect.payloadJson);
				}),
			).toBe(1);
			expect(delivered).toEqual(['{"total":5}']);
			expect(journal.readFacts(streamId)).toHaveLength(1);
			expect(journal.pendingOutbox(streamId)).toEqual([]);
		} finally {
			journal.close();
		}
	});

	it("acknowledges successful deliveries and retries failures after reopen", async () => {
		const path = journalPath();
		const journal = createActorLocalJournal(path);
		journal.stageOutbox("actor", "a", "digest-a", '{"value":1}');
		journal.stageOutbox("actor", "b", "digest-b", '{"value":2}');
		const attempts: string[] = [];
		await expect(
			dispatchRivetOutbox(journal, "actor", async (effect) => {
				attempts.push(effect.effectId);
				if (effect.effectId === "b") throw new Error("destination offline");
			}),
		).rejects.toThrow("destination offline");
		expect(
			journal.pendingOutbox("actor").map((effect) => effect.effectId),
		).toEqual(["b"]);
		journal.close();

		const reopened = createActorLocalJournal(path);
		try {
			expect(
				await dispatchRivetOutbox(reopened, "actor", async (effect) => {
					attempts.push(effect.effectId);
					expect(effect).toEqual({
						streamId: "actor",
						effectId: "b",
						digest: "digest-b",
						payloadJson: '{"value":2}',
					});
				}),
			).toBe(1);
			expect(attempts).toEqual(["a", "b", "b"]);
			expect(reopened.pendingOutbox("actor")).toEqual([]);
			reopened.stageOutbox("actor", "a", "digest-a", '{"value":1}');
			expect(reopened.pendingOutbox("actor")).toEqual([]);
		} finally {
			reopened.close();
		}
	});

	it("rejects conflicting reuse without replacing the original effect", () => {
		const journal = createActorLocalJournal();
		try {
			journal.stageOutbox("actor", "a", "digest-a", '{"value":1}');
			journal.stageOutbox("actor", "a", "digest-a", '{"value":1}');
			expect(() =>
				journal.stageOutbox("actor", "a", "digest-b", '{"value":1}'),
			).toThrow(/digest mismatch/);
			expect(() =>
				journal.stageOutbox("actor", "a", "digest-a", '{"value":2}'),
			).toThrow(/digest mismatch/);
			expect(journal.pendingOutbox("actor")).toEqual([
				{ effectId: "a", digest: "digest-a", payloadJson: '{"value":1}' },
			]);
		} finally {
			journal.close();
		}
	});

	it.each([
		["", "effect", "digest", "{}"],
		["actor", "", "digest", "{}"],
		["actor", "effect", "", "{}"],
		["actor", "effect", "digest", "not-json"],
	] as const)("refuses incomplete outbox entries", (stream, effect, digest, payload) => {
		const journal = createActorLocalJournal();
		try {
			expect(() =>
				journal.stageOutbox(stream, effect, digest, payload),
			).toThrow();
			expect(journal.pendingOutbox("actor")).toEqual([]);
		} finally {
			journal.close();
		}
	});

	it("dispatches only the selected stream", async () => {
		const journal = createActorLocalJournal();
		try {
			journal.stageOutbox("first", "a", "digest", "{}");
			journal.stageOutbox("second", "a", "digest", "{}");
			const streams: string[] = [];
			await dispatchRivetOutbox(journal, "first", (effect) => {
				streams.push(effect.streamId);
			});
			expect(streams).toEqual(["first"]);
			expect(journal.pendingOutbox("first")).toEqual([]);
			expect(journal.pendingOutbox("second")).toHaveLength(1);
		} finally {
			journal.close();
		}
	});

	it("rolls back facts, inbox receipt, and effects when an effect conflicts", () => {
		const journal = createActorLocalJournal();
		try {
			journal.stageOutbox("actor", "a", "old", "{}");
			journal.acceptCommand({
				streamId: "actor",
				commandId: "cmd",
				digest: "cmd-digest",
				commandType: "add",
				payloadJson: "{}",
				expectedRevision: 0,
			});
			expect(() =>
				journal.commitCommand({
					streamId: "actor",
					commandId: "cmd",
					expectedRevision: 0,
					facts: [
						{
							type: "added",
							eventId: "event",
							payload: new TextEncoder().encode("{}"),
							metadataJson: "{}",
							tenant: "acme",
						},
					],
					effects: [{ effectId: "a", digest: "new", payloadJson: "{}" }],
				}),
			).toThrow(/digest mismatch/);
			expect(journal.readFacts("actor")).toEqual([]);
			expect(journal.head("actor").revision).toBe(0);
			expect(journal.loadCommand("actor", "cmd")?.status).toBe("persisted");
			expect(journal.pendingOutbox("actor")).toEqual([
				{ effectId: "a", digest: "old", payloadJson: "{}" },
			]);
		} finally {
			journal.close();
		}
	});

	it("permits duplicate delivery by overlapping dispatchers without restoring an acknowledged effect", async () => {
		const path = journalPath();
		const first = createActorLocalJournal(path);
		const second = createActorLocalJournal(path);
		try {
			first.stageOutbox("actor", "a", "digest", "{}");
			let release = () => {};
			const wait = new Promise<void>((resolve) => {
				release = resolve;
			});
			const sent: string[] = [];
			const delayed = dispatchRivetOutbox(first, "actor", async (effect) => {
				sent.push(`first:${effect.effectId}`);
				await wait;
			});
			await dispatchRivetOutbox(second, "actor", async (effect) => {
				sent.push(`second:${effect.effectId}`);
			});
			release();
			expect(await delayed).toBe(1);
			expect(sent).toEqual(["first:a", "second:a"]);
			expect(first.pendingOutbox("actor")).toEqual([]);
		} finally {
			first.close();
			second.close();
		}
	});
});
