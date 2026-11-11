import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, type Json } from "../lib/pins-json.ts";

export type WorkspaceDurationTable = Readonly<{
	defaultSeconds: number;
	seconds: ReadonlyMap<string, number>;
}>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DURATION_PATH = join(HERE, "workspace-test-durations.json");

const tagOf = Object.prototype.toString;

let cached: WorkspaceDurationTable | undefined;

function isPositiveSeconds(value: Json | undefined): value is number {
	return (
		tagOf.call(value) === "[object Number]" &&
		Number.isFinite(value) &&
		value > 0
	);
}

function parseDurationTable(text: string): WorkspaceDurationTable {
	// SAFETY: `JSON.parse` returns an untyped tree; `isObject` and `isPositiveSeconds`
	// narrow it to the repo-owned duration table shape before use.
	const parsed = JSON.parse(text) as Json;
	if (!isObject(parsed)) {
		throw new Error("workspace-test-durations: root must be an object");
	}
	const defaultSeconds = isPositiveSeconds(parsed.defaultSeconds)
		? parsed.defaultSeconds
		: 30;
	const seconds = new Map<string, number>();
	for (const [key, value] of Object.entries(parsed)) {
		if (key.startsWith("_") || key === "defaultSeconds" || key === "measuredAt")
			continue;
		if (key === "sourceRun") continue;
		if (!isPositiveSeconds(value)) continue;
		seconds.set(key, value);
	}
	return { defaultSeconds, seconds };
}

export function loadWorkspaceDurations(
	path = DURATION_PATH,
): WorkspaceDurationTable {
	if (path === DURATION_PATH && cached) return cached;
	const table = parseDurationTable(readFileSync(path, "utf8"));
	if (path === DURATION_PATH) cached = table;
	return table;
}

export function workspaceTestSeconds(
	dir: string,
	table: WorkspaceDurationTable = loadWorkspaceDurations(),
): number {
	return table.seconds.get(dir) ?? table.defaultSeconds;
}
