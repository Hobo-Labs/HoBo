/**
 * The workspace registry as a projection of an append-only journal.
 *
 * Workspace creation touches the filesystem before it touches bookkeeping, so
 * a crash between the two used to leave a directory nothing knew about — and a
 * torn `registry.json` write lost every workspace at once. Commands append one
 * event, and the registry is a materialized view folded from those events, so
 * a damaged snapshot is rebuildable rather than fatal.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRecord } from "./workspace.js";

export type WorkspaceEvent =
	| {
			readonly type: "RootInitialized";
			readonly at: string;
			readonly root: string;
	  }
	/**
	 * Intent, written *before* any filesystem work. Cloning a large tree takes
	 * seconds, and a crash inside it used to leave a directory nothing knew
	 * about — invisible to `list`, but enough to make every later
	 * `create --name same` fail with "already exists" forever.
	 */
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

/** Append one event. Single `appendFileSync` so a concurrent reader sees whole lines. */
export function appendEvent(riftDir: string, event: WorkspaceEvent): void {
	mkdirSync(riftDir, { recursive: true });
	appendFileSync(journalPath(riftDir), `${JSON.stringify(event)}\n`, "utf8");
}

/** Every readable event; a truncated or corrupt tail line is skipped, not fatal. */
export function readEvents(riftDir: string): readonly WorkspaceEvent[] {
	const file = journalPath(riftDir);
	if (!existsSync(file)) return [];
	const events: WorkspaceEvent[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			// SAFETY: `events.push(JSON.parse(line) as WorkspaceEvent);` is required at this I/O or test boundary.
			events.push(JSON.parse(line) as WorkspaceEvent);
		} catch {
			/* a half-written tail line is the expected crash shape */
		}
	}
	return events;
}

/**
 * Fold the journal into the current set of workspaces.
 *
 * Pure, so the projection can be tested without a filesystem and rebuilt from
 * the journal whenever the snapshot is missing or unreadable.
 */
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
