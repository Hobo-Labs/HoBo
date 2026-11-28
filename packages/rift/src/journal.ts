import {
	appendFileSync,
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
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

export function journalPath(riftDir: string): string {
	return join(riftDir, "events.jsonl");
}

export function appendEvent(riftDir: string, event: WorkspaceEvent): void {
	mkdirSync(riftDir, { recursive: true });
	const fd = openSync(journalPath(riftDir), "a+");
	try {
		const size = fstatSync(fd).size;
		const lastByte = Buffer.alloc(1);
		if (size > 0) readSync(fd, lastByte, 0, 1, size - 1);
		const separator = size > 0 && lastByte[0] !== 10 ? "\n" : "";
		appendFileSync(fd, `${separator}${JSON.stringify(event)}\n`, "utf8");
	} finally {
		closeSync(fd);
	}
}

export function readEvents(riftDir: string): readonly WorkspaceEvent[] {
	const file = journalPath(riftDir);
	if (!existsSync(file)) return [];
	const events: WorkspaceEvent[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			// SAFETY: `events.push(JSON.parse(line) as WorkspaceEvent);` is required at this I/O or test boundary.
			events.push(JSON.parse(line) as WorkspaceEvent);
		} catch {}
	}
	return events;
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
