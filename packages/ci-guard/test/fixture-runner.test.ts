/**
 * Tests for the E2E fixture runner.
 *
 * The module was 0% covered. It is what CI actually invokes per phase, and its
 * only durable output is a JSONL event log that later steps and humans read to
 * decide whether a run was clean. Three properties matter and none was pinned:
 * the right event is appended for each phase, a failed live-URL assertion still
 * records the failure *before* throwing, and teardown never depends on deploy
 * having succeeded.
 *
 * Everything is driven through a temp `eventsPath`, so no test touches the real
 * `test-results/` directory.
 */
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runExampleFixture } from "../src/fixture-runner.js";
import {
	isJsonNumber,
	isJsonObject,
	type JsonObject,
	parseJsonTree,
} from "../src/json.js";

/**
 * The contract pins the E2E fixture to this exact path, and `deploy-and-assert`
 * builds a contract from it — so that phase can only be exercised with the real
 * value. `examples/hello-bindle` ships no `fixture.json`, which is why the id
 * falls back to the directory name in the assertions below. The other two
 * phases never build a contract from the fixture, so they run against a temp
 * directory.
 */
const PINNED_FIXTURE = "examples/hello-bindle";

const originalForceFail = process.env.HOBO_E2E_FORCE_FAIL;

afterEach(() => {
	if (originalForceFail === undefined) delete process.env.HOBO_E2E_FORCE_FAIL;
	else process.env.HOBO_E2E_FORCE_FAIL = originalForceFail;
});

async function workspace() {
	const root = await mkdtemp(path.join(tmpdir(), "hobo-ci-guard-"));
	const fixture = path.join(root, "hello-bindle");
	await mkdir(fixture, { recursive: true });
	return { root, fixture, eventsPath: path.join(root, "events.jsonl") };
}

async function events(eventsPath: string): Promise<JsonObject[]> {
	const text = await readFile(eventsPath, "utf8");
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const parsed = parseJsonTree(line);
			if (!isJsonObject(parsed)) {
				throw new Error("event line must be a JSON object");
			}
			return parsed;
		});
}

describe("deploy-and-assert", () => {
	it("records a deploy and a successful live-URL assertion", async () => {
		const { eventsPath } = await workspace();
		const fixture = PINNED_FIXTURE;
		await runExampleFixture({
			fixture,
			phase: "deploy-and-assert",
			runId: "run-1",
			eventsPath,
		});

		const recorded = await events(eventsPath);
		expect(recorded.map((e) => e.type)).toEqual([
			"e2e.FixtureDeployed",
			"e2e.LiveUrlAsserted",
		]);
		expect(recorded[1]?.ok).toBe(true);
		expect(recorded[1]?.liveUrl).toBeTruthy();
		for (const event of recorded) {
			expect(event.runId).toBe("run-1");
			expect(event.fixture).toBe(fixture);
			expect(isJsonNumber(event.recordedAtMs)).toBe(true);
		}
	});

	it("records the failure before throwing, so CI can see why", async () => {
		const { eventsPath } = await workspace();
		const fixture = PINNED_FIXTURE;
		process.env.HOBO_E2E_FORCE_FAIL = "1";

		await expect(
			runExampleFixture({
				fixture,
				phase: "deploy-and-assert",
				runId: "run-2",
				eventsPath,
			}),
		).rejects.toThrow(/live URL assertion failed/);

		const recorded = await events(eventsPath);
		// Both events are on disk even though the call threw — a run that fails
		// silently is worse than one that fails loudly.
		expect(recorded.map((e) => e.type)).toEqual([
			"e2e.FixtureDeployed",
			"e2e.LiveUrlAsserted",
		]);
		expect(recorded[1]?.ok).toBe(false);
	});

	it("names the fixture from the directory when fixture.json is absent", async () => {
		const { eventsPath } = await workspace();
		process.env.HOBO_E2E_FORCE_FAIL = "1";

		// examples/hello-bindle ships no fixture.json, so the id falls back to the
		// basename — and the thrown message must still identify which fixture failed.
		await expect(
			runExampleFixture({
				fixture: PINNED_FIXTURE,
				phase: "deploy-and-assert",
				runId: "run-3",
				eventsPath,
			}),
		).rejects.toThrow(/hello-bindle/);
	});
});

describe("teardown", () => {
	it("records exactly one teardown event", async () => {
		const { fixture, eventsPath } = await workspace();
		await runExampleFixture({
			fixture,
			phase: "teardown",
			runId: "run-5",
			eventsPath,
		});
		const recorded = await events(eventsPath);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.type).toBe("e2e.FixtureTornDown");
	});

	it("does not depend on a deploy having happened first", async () => {
		const { fixture, eventsPath } = await workspace();
		process.env.HOBO_E2E_FORCE_FAIL = "1";
		await expect(
			runExampleFixture({
				fixture: PINNED_FIXTURE,
				phase: "deploy-and-assert",
				runId: "run-6",
				eventsPath,
			}),
		).rejects.toThrow();

		// Teardown must still run after a failed deploy — that is the whole point
		// of `teardown.always` in the contract.
		await expect(
			runExampleFixture({
				fixture,
				phase: "teardown",
				runId: "run-6",
				eventsPath,
			}),
		).resolves.toBeUndefined();
		expect((await events(eventsPath)).at(-1)?.type).toBe("e2e.FixtureTornDown");
	});
});

describe("sweep-orphans", () => {
	it("records the sweeper's selector and age bound from the contract", async () => {
		const { fixture, eventsPath } = await workspace();
		await runExampleFixture({
			fixture,
			phase: "sweep-orphans",
			runId: "run-7",
			eventsPath,
		});
		const recorded = await events(eventsPath);
		expect(recorded[0]?.type).toBe("e2e.OrphanSwept");
		expect(recorded[0]?.selector).toBeTruthy();
		expect(isJsonNumber(recorded[0]?.maxAgeMinutes)).toBe(true);
	});
});

describe("event log handling", () => {
	it("creates the events directory when it does not exist", async () => {
		const { root, fixture } = await workspace();
		const eventsPath = path.join(root, "nested", "deeper", "events.jsonl");
		await runExampleFixture({
			fixture,
			phase: "teardown",
			runId: "run-8",
			eventsPath,
		});
		expect(await events(eventsPath)).toHaveLength(1);
	});

	it("appends across phases rather than truncating", async () => {
		const { fixture, eventsPath } = await workspace();
		await runExampleFixture({
			fixture: PINNED_FIXTURE,
			phase: "deploy-and-assert",
			runId: "run-9",
			eventsPath,
		});
		await runExampleFixture({
			fixture,
			phase: "teardown",
			runId: "run-9",
			eventsPath,
		});
		await runExampleFixture({
			fixture,
			phase: "sweep-orphans",
			runId: "run-9",
			eventsPath,
		});
		expect((await events(eventsPath)).map((e) => e.type)).toEqual([
			"e2e.FixtureDeployed",
			"e2e.LiveUrlAsserted",
			"e2e.FixtureTornDown",
			"e2e.OrphanSwept",
		]);
	});

	it("writes one JSON object per line", async () => {
		const { fixture, eventsPath } = await workspace();
		await runExampleFixture({
			fixture,
			phase: "teardown",
			runId: "run-10",
			eventsPath,
		});
		const text = await readFile(eventsPath, "utf8");
		expect(text.endsWith("\n")).toBe(true);
		expect(text.trimEnd().includes("\n")).toBe(false);
	});
});
