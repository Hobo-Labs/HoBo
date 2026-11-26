import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createHoboCiFabricContract } from "./contract.js";
import { isJsonObject, isJsonString, parseJsonTree } from "./json.js";
import { simulateHelloBindleE2e } from "./validate.js";

export type FixturePhase = "deploy-and-assert" | "teardown" | "sweep-orphans";

export interface RunExampleFixtureOptions {
	readonly fixture: string;
	readonly phase: FixturePhase;
	readonly runId: string;
	readonly eventsPath?: string;
}

export interface FixtureLifecycleEvent {
	readonly type:
		| "e2e.FixtureDeployed"
		| "e2e.LiveUrlAsserted"
		| "e2e.FixtureTornDown"
		| "e2e.OrphanSwept";
	readonly fixture: string;
	readonly runId: string;
	readonly recordedAtMs: number;
	readonly liveUrl?: string;
	readonly ok?: boolean;
	readonly selector?: string;
	readonly maxAgeMinutes?: number;
}

export async function runExampleFixture(
	opts: RunExampleFixtureOptions,
): Promise<void> {
	const eventsPath =
		opts.eventsPath ??
		path.join(process.cwd(), "test-results", "e2e-events.jsonl");
	await mkdir(path.dirname(eventsPath), { recursive: true });

	const fixturePath = path.resolve(opts.fixture);
	const fixtureJsonPath = path.join(fixturePath, "fixture.json");
	let fixtureId = path.basename(fixturePath);

	try {
		const raw = await readFile(fixtureJsonPath, "utf8");
		const id = fixtureIdFromJson(raw);
		if (id !== undefined) {
			fixtureId = id;
		}
	} catch {
		// stub fixtures may omit fixture.json during early bootstrap
	}

	if (opts.phase === "deploy-and-assert") {
		const contract = createHoboCiFabricContract({
			e2e: { fixture: opts.fixture },
		});
		const run = simulateHelloBindleE2e(contract, { githubRunId: opts.runId });

		await appendEvent(eventsPath, {
			type: "e2e.FixtureDeployed",
			fixture: opts.fixture,
			runId: opts.runId,
			recordedAtMs: Date.now(),
		});

		const forceFail = process.env.HOBO_E2E_FORCE_FAIL === "1";
		const liveOk = !forceFail && run.status === "passed";

		await appendEvent(eventsPath, {
			type: "e2e.LiveUrlAsserted",
			fixture: opts.fixture,
			runId: opts.runId,
			liveUrl: run.deployment.liveUrl,
			ok: liveOk,
			recordedAtMs: Date.now(),
		});

		if (!liveOk) {
			throw new Error(`live URL assertion failed for ${fixtureId}`);
		}
		return;
	}

	if (opts.phase === "teardown") {
		await appendEvent(eventsPath, {
			type: "e2e.FixtureTornDown",
			fixture: opts.fixture,
			runId: opts.runId,
			recordedAtMs: Date.now(),
		});
		return;
	}

	if (opts.phase === "sweep-orphans") {
		const contract = createHoboCiFabricContract();
		await appendEvent(eventsPath, {
			type: "e2e.OrphanSwept",
			fixture: opts.fixture,
			runId: opts.runId,
			selector: contract.e2e.teardown.orphanSweeper.selector,
			maxAgeMinutes: contract.e2e.teardown.orphanSweeper.maxAgeMinutes,
			recordedAtMs: Date.now(),
		});
		return;
	}

	throw new Error(`unknown phase: ${opts.phase satisfies never}`);
}

function fixtureIdFromJson(raw: string): string | undefined {
	const parsed = parseJsonTree(raw);
	if (!isJsonObject(parsed)) {
		return undefined;
	}
	const id = parsed.id;
	return isJsonString(id) ? id : undefined;
}

async function appendEvent(
	eventsPath: string,
	event: FixtureLifecycleEvent,
): Promise<void> {
	await appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}
