// Shared fixture of the operations tests: a configuration file in a fresh
// directory, an in-memory secret store, a manual clock and a captured log.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySecretsPort } from "@hobo/identity";
import type { OpsContext } from "../../src/ops/index.js";

export const TENANT_TEXT = "acme";
export const START_MS = Date.parse("2026-11-01T10:00:00.000Z");

export type ManualClock = Readonly<{
	now: () => number;
	advance(ms: number): void;
}>;

export function manualClock(start = START_MS): ManualClock {
	let at = start;
	return { now: () => at, advance: (ms) => (at += ms) };
}

export async function opsFixture(
	settings: Readonly<Record<string, string | number | readonly string[]>> = {},
	start = START_MS,
) {
	const dir = await mkdtemp(join(tmpdir(), "hobo-fleet-ops-"));
	const configPath = join(dir, "authority.json");
	await writeFile(
		configPath,
		JSON.stringify({ tenant: TENANT_TEXT, ...settings }),
		"utf8",
	);
	const secrets = createMemorySecretsPort();
	const clock = manualClock(start);
	const logged: string[] = [];
	const context: OpsContext = {
		configPath,
		secrets,
		now: clock.now,
		log: (event, fields) => {
			logged.push(`${event} ${JSON.stringify(fields)}`);
		},
	};
	return {
		dir,
		configPath,
		secrets,
		clock,
		logged,
		context,
		prefix: `hobo-fleet/${TENANT_TEXT}`,
	};
}
