import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { isJsonObject, isJsonString, parseJsonValue } from "../../src/json.js";
import { runProxied } from "../../src/launch.js";
import type { ObservedRun, ScenarioRunner } from "./proxied-run-provider.js";
import { runRawSchema, UNBOUNDED_SCHEMA } from "./raw-run.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_BIN = join(here, "../fixtures/fake-opensesame.mts");
const CHILD = join(here, "../fixtures/child.mts");

function stringsOf(text: string) {
	const parsed = parseJsonValue(text);
	const env = isJsonObject(parsed) ? parsed.env : null;
	const entries: [string, string][] = [];
	if (isJsonObject(env)) {
		for (const [key, value] of Object.entries(env)) {
			if (isJsonString(value)) entries.push([key, value]);
		}
	}
	return Object.fromEntries(entries);
}

function readIf(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Plays each scenario against the stand-in binary. */
export function createFakeRunner(): ScenarioRunner {
	return {
		async run(scenario, bindings): Promise<ObservedRun> {
			const work = mkdtempSync(join(tmpdir(), "hobo-fake-runner-"));
			try {
				mkdirSync(join(work, "tmp"));
				const dummy = `vtok_dummy_marker_${Date.now().toString(16)}${Math.floor(Math.random() * 1e9).toString(16)}`;
				const record = join(work, "record.json");
				const childOut = join(work, "child.json");
				const env = {
					PATH: process.env.PATH ?? "",
					NODE_NO_WARNINGS: "1",
					OPENSESAME_STORE_PASSWORD: "store-passphrase-for-tests",
					FAKE_OPENSESAME_RECORD: record,
					FAKE_OPENSESAME_SCENARIO: scenario,
					FAKE_OPENSESAME_STORE_TOKEN: dummy,
				};
				if (scenario === "scope-unbounded") {
					const outcome = runRawSchema(FAKE_BIN, env, UNBOUNDED_SCHEMA);
					return {
						outcome,
						childEnv: undefined,
						leaked: JSON.stringify(outcome).includes(dummy),
					};
				}
				const sink = new PassThrough();
				const seen: string[] = [];
				sink.on("data", (chunk) => seen.push(String(chunk)));
				const outcome = await runProxied({
					bin: FAKE_BIN,
					bindings,
					argv: [process.execPath, "--no-warnings", CHILD, childOut],
					env,
					passEnv: [
						"OPENSESAME_STORE_PASSWORD",
						"FAKE_OPENSESAME_RECORD",
						"FAKE_OPENSESAME_SCENARIO",
						"FAKE_OPENSESAME_STORE_TOKEN",
					],
					stderr: sink,
					tmpRoot: join(work, "tmp"),
				});
				const child = readIf(childOut);
				const everything = [
					JSON.stringify(outcome),
					seen.join(""),
					child ?? "",
					readIf(record) ?? "",
				];
				return {
					outcome,
					childEnv: child === undefined ? undefined : stringsOf(child),
					leaked: everything.some((text) => text.includes(dummy)),
				};
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		},
	};
}
