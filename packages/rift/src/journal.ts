
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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
	appendFileSync(journalPath(riftDir), `${JSON.stringify(event)}\n`, "utf8");
}

export function readEvents(riftDir: string): readonly WorkspaceEvent[] {
	const file = journalPath(riftDir);
	if (!existsSync(file)) return [];
	const events: WorkspaceEvent[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line) as WorkspaceEvent);
		} catch {
		}
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
