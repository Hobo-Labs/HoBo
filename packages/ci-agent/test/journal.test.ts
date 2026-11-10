import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEventSchema } from "../src/_generated/agent_pb.js";
import { type AgentJournal, createMemoryJournal } from "../src/journal.js";
import { createSqliteJournal } from "../src/sqlite-journal.js";

const sha = (digit: number) => String(digit).repeat(40);
const settled = (id: string, at: string, key: string, tokens: bigint) =>
	create(AgentEventSchema, {
		id,
		type: "ci.agent.ResolutionSettled",
		at,
		repository: "hobo-labs/hobo",
		resolution: {
			key,
			repository: "hobo-labs/hobo",
			number: 7,
			oursSha: sha(1),
			theirsSha: sha(2),
			outcome: "abstained",
			reason: "low-confidence",
			usage: { inputTokens: tokens, outputTokens: 10n },
		},
	});
const planned = (id: string, at: string, digest: string) =>
	create(AgentEventSchema, {
		id,
		type: "ci.agent.PlanProposed",
		at,
		repository: "hobo-labs/hobo",
		plan: { repository: "hobo-labs/hobo", baseSha: sha(3), order: [7], digest },
	});

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
const sqlite = () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-agent-journal-"));
	directories.push(directory);
	return join(directory, "agent.sqlite");
};

const journals: [string, () => AgentJournal][] = [
	["memory", () => createMemoryJournal()],
	["sqlite", () => createSqliteJournal(sqlite())],
];

describe.each(journals)("%s journal", (_name, open) => {
	it("answers what was attempted, what was spent, and the latest plan", async () => {
		const journal = open();
		await journal.append(
			planned("e1", "2026-11-09T10:00:00.000Z", "a".repeat(64)),
		);
		await journal.append(
			settled("e2", "2026-11-09T23:59:00.000Z", "k1", 1000n),
		);
		await journal.append(settled("e3", "2026-11-10T08:00:00.000Z", "k2", 300n));
		await journal.append(
			planned("e4", "2026-11-10T09:00:00.000Z", "b".repeat(64)),
		);

		expect((await journal.settled("k1"))?.reason).toBe("low-confidence");
		expect(await journal.settled("never")).toBeUndefined();
		expect(await journal.tokensSince("2026-11-10T00:00:00.000Z")).toBe(310);
		expect(await journal.tokensSince("2026-11-09T00:00:00.000Z")).toBe(1320);
		expect(
			(await journal.latest("hobo-labs/hobo", "ci.agent.PlanProposed"))?.plan
				?.digest,
		).toBe("b".repeat(64));
		expect(
			await journal.latest("other/repo", "ci.agent.PlanProposed"),
		).toBeUndefined();
		expect((await journal.events()).map((event) => event.id)).toEqual([
			"e1",
			"e2",
			"e3",
			"e4",
		]);
	});

	it("ignores a second append of the same event id", async () => {
		const journal = open();
		const event = settled("e1", "2026-11-10T08:00:00.000Z", "k1", 5n);
		await journal.append(event);
		await journal.append(event);
		expect(await journal.events()).toHaveLength(1);
		expect(await journal.tokensSince("2026-11-10T00:00:00.000Z")).toBe(15);
	});
});

describe("sqlite journal", () => {
	it("keeps attempts and spend across a restart", async () => {
		const path = sqlite();
		const first = createSqliteJournal(path);
		await first.append(settled("e1", "2026-11-10T08:00:00.000Z", "k1", 700n));
		first.close();
		const reopened = createSqliteJournal(path);
		expect((await reopened.settled("k1"))?.usage?.inputTokens).toBe(700n);
		expect(await reopened.tokensSince("2026-11-10T00:00:00.000Z")).toBe(710);
		reopened.close();
	});
});
