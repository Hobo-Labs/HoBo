import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	createActorLocalJournal,
	createRivetRuntimeHost,
	RivetJournalError,
} from "../src/index.js";

const fact = (eventId: string) => ({
	type: "added",
	eventId,
	payload: new TextEncoder().encode(JSON.stringify({ eventId })),
	metadataJson: "{}",
	tenant: "acme",
	project: "shop",
});

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("actor-local journal crash windows", () => {
	it("persists across process reopen of the same sqlite file", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-rivet-"));
		dirs.push(dir);
		const path = join(dir, "journal.sqlite");
		const first = createActorLocalJournal(path);
		first.acceptCommand({
			streamId: "s1",
			commandId: "cmd-1",
			digest: "aaa",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		first.commitCommand({
			streamId: "s1",
			commandId: "cmd-1",
			expectedRevision: 0,
			facts: [fact("e1")],
		});
		first.close();
		const second = createActorLocalJournal(path);
		expect(second.head("s1").revision).toBe(1);
		expect(second.loadCommand("s1", "cmd-1")?.status).toBe("committed");
		expect(second.readFacts("s1")).toHaveLength(1);
		second.close();
	});

	it("recovers a persisted inbox row after crash before claim", () => {
		const journal = createActorLocalJournal();
		journal.acceptCommand({
			streamId: "s1",
			commandId: "cmd-1",
			digest: "aaa",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		expect(journal.loadCommand("s1", "cmd-1")?.status).toBe("persisted");
		const claimed = journal.claimNext("s1");
		expect(claimed?.attempt).toBeGreaterThanOrEqual(1);
		journal.close();
	});

	it("keeps one revision when commit races on the same expected head", () => {
		const journal = createActorLocalJournal();
		journal.acceptCommand({
			streamId: "s1",
			commandId: "a",
			digest: "da",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		journal.acceptCommand({
			streamId: "s1",
			commandId: "b",
			digest: "db",
			commandType: "add",
			payloadJson: "{}",
			expectedRevision: 0,
		});
		journal.claimNext("s1");
		journal.commitCommand({
			streamId: "s1",
			commandId: "a",
			expectedRevision: 0,
			facts: [fact("e1")],
		});
		expect(() =>
			journal.commitCommand({
				streamId: "s1",
				commandId: "b",
				expectedRevision: 0,
				facts: [fact("e2")],
			}),
		).toThrow(RivetJournalError);
		expect(journal.head("s1").revision).toBe(1);
		journal.close();
	});

	it("runtime host accept-before-ack survives a second processNext", async () => {
		const bundle = createRivetRuntimeHost({ tenantId: "acme", campId: "shop" });
		const identity = {
			tenantId: "acme",
			projectId: "shop",
			actorTypeId: "Cart",
			keySegments: ["room-1"],
			schemaVersion: 1,
		};
		const first = bundle.actors.accept({
			identity,
			commandId: "cmd-1",
			commandType: "addItem",
			payload: { sku: "hat" },
			expectedRevision: 0,
		});
		expect(first.status).toBe("persisted");
		const processed = bundle.actors.processNext(
			identity,
			(state, event) => {
				const items = (state as { items: string[] }).items;
				if (event.type === "addItem") {
					return { items: [...items, (event.payload as { sku: string }).sku] };
				}
				return state;
			},
			{ items: [] },
		);
		expect(processed?.revision).toBe(1);
		expect(
			bundle.actors.processNext(identity, (state) => state, { items: [] }),
		).toBe(undefined);
		const ensured = await bundle.host.ensure({ hoboHome: "/tmp", env: {} });
		expect(ensured.details.fidelity).toBe("local-sqlite");
		bundle.journal.close();
	});
});
