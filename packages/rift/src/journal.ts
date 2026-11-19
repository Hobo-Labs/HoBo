import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RiftRegistryError } from "./errors.js";
import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import { parseWorkspaceRecord } from "./records.js";
import type { WorkspaceRecord } from "./workspace.js";

export type WorkspaceEvent =
	| {
			readonly type: "RootInitialized";
			readonly at: string;
			readonly root: string;
	  }
	| {
			readonly type: "WorkspaceCreating";
			readonly at: string;
			readonly name: string;
			readonly path: string;
	  }
	| {
			readonly type: "WorkspaceCreated";
			readonly at: string;
			readonly workspace: WorkspaceRecord;
	  }
	| {
			readonly type: "WorkspaceRemoved";
			readonly at: string;
			readonly name: string;
	  };

interface JournalContents {
	readonly text: string;
	readonly events: readonly WorkspaceEvent[];
	readonly unterminated: boolean;
	readonly incompleteTail: boolean;
}

export function journalPath(riftDir: string): string {
	return join(riftDir, "events.jsonl");
}

function parseEvent(value: JsonValue): WorkspaceEvent {
	if (!isJsonObject(value) || !isJsonString(value.at) || !value.at)
		throw new TypeError("invalid event");
	const at = value.at;
	if (
		value.type === "RootInitialized" &&
		isJsonString(value.root) &&
		value.root &&
		Object.keys(value).every((key) => ["type", "at", "root"].includes(key))
	)
		return { type: value.type, at, root: value.root };
	if (
		value.type === "WorkspaceCreating" &&
		isJsonString(value.name) &&
		value.name &&
		isJsonString(value.path) &&
		value.path &&
		Object.keys(value).every((key) =>
			["type", "at", "name", "path"].includes(key),
		)
	)
		return { type: value.type, at, name: value.name, path: value.path };
	if (
		value.type === "WorkspaceCreated" &&
		value.workspace !== undefined &&
		Object.keys(value).every((key) => ["type", "at", "workspace"].includes(key))
	)
		return {
			type: value.type,
			at,
			workspace: parseWorkspaceRecord(value.workspace),
		};
	if (
		value.type === "WorkspaceRemoved" &&
		isJsonString(value.name) &&
		value.name &&
		Object.keys(value).every((key) => ["type", "at", "name"].includes(key))
	)
		return { type: value.type, at, name: value.name };
	throw new TypeError("invalid event");
}

function readJournal(riftDir: string): JournalContents {
	const file = journalPath(riftDir);
	const text = existsSync(file) ? readFileSync(file, "utf8") : "";
	const unterminated = text.length > 0 && !text.endsWith("\n");
	const lines = text.split("\n");
	const events: WorkspaceEvent[] = [];
	let incompleteTail = false;
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		let value: JsonValue;
		try {
			value = JSON.parse(line) as JsonValue;
		} catch {
			if (unterminated && index === lines.length - 1) {
				incompleteTail = true;
				continue;
			}
			throw new RiftRegistryError(
				`invalid workspace journal at ${file}, line ${index + 1}; file left untouched`,
			);
		}
		try {
			events.push(parseEvent(value));
		} catch {
			throw new RiftRegistryError(
				`invalid workspace journal at ${file}, line ${index + 1}; file left untouched`,
			);
		}
	}
	return { text, events, unterminated, incompleteTail };
}

function requireCompleteJournal(
	riftDir: string,
	journal: JournalContents,
): void {
	if (journal.incompleteTail)
		throw new RiftRegistryError(
			`incomplete workspace journal at ${journalPath(riftDir)}; run hobo-rift repair`,
		);
}

export function appendEvent(riftDir: string, event: WorkspaceEvent): void {
	const journal = readJournal(riftDir);
	requireCompleteJournal(riftDir, journal);
	mkdirSync(riftDir, { recursive: true });
	appendFileSync(
		journalPath(riftDir),
		`${journal.unterminated ? "\n" : ""}${JSON.stringify(event)}\n`,
		"utf8",
	);
}

export function readEvents(riftDir: string): readonly WorkspaceEvent[] {
	const journal = readJournal(riftDir);
	requireCompleteJournal(riftDir, journal);
	return journal.events;
}

export function readEventsForRepair(
	riftDir: string,
): readonly WorkspaceEvent[] {
	return readJournal(riftDir).events;
}

export function repairJournalTail(riftDir: string): string | undefined {
	const journal = readJournal(riftDir);
	if (!journal.unterminated) return undefined;
	const file = journalPath(riftDir);
	if (!journal.incompleteTail) {
		appendFileSync(file, "\n", "utf8");
		return undefined;
	}
	const preserved = `${file}.damaged-${randomUUID()}`;
	const temporary = `${file}.repair-${randomUUID()}`;
	copyFileSync(file, preserved, constants.COPYFILE_EXCL);
	try {
		writeFileSync(
			temporary,
			journal.text.slice(0, journal.text.lastIndexOf("\n") + 1),
			{
				flag: "wx",
			},
		);
		if (readFileSync(file, "utf8") !== journal.text)
			throw new RiftRegistryError(
				`workspace journal changed during repair; copy preserved at ${preserved}`,
			);
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
	return preserved;
}

export function projectWorkspaces(
	events: readonly WorkspaceEvent[],
): readonly WorkspaceRecord[] {
	const byName = new Map<string, WorkspaceRecord>();
	for (const event of events) {
		if (event.type === "WorkspaceCreated") {
			byName.set(event.workspace.name, event.workspace);
		} else if (event.type === "WorkspaceRemoved") {
			byName.delete(event.name);
		}
	}
	return [...byName.values()];
}
