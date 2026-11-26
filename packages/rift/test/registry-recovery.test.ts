/**
 * Reading and repairing a rift registry after a crash.
 *
 * A rift root keeps two records of its workspaces: an append-only journal,
 * which is the authority, and `registry.json`, a snapshot kept for other
 * readers. `record()` writes them in two steps, so a crash between them is an
 * ordinary state rather than an exotic one — and the source comments here are
 * unusually explicit about the reasoning, because getting it wrong destroys
 * somebody's work in ways that look like ordinary behaviour.
 *
 * Three decisions carry all the weight, and each is a test group below:
 *
 * 1. **The journal wins, including when it projects to empty.** "Everything was
 *    removed" and "nothing was ever created" are both legitimate. A read that
 *    fell back to the snapshot would resurrect deliberately removed workspaces,
 *    and the append-only journal cannot tell a resurrection from a real
 *    creation afterwards.
 * 2. **Repair restores only on demonstrated truncation.** `eventCount` is the
 *    discriminator: a snapshot that saw *more* history than the journal now
 *    holds was truncated; one merely written before the last event is stale.
 *    Confusing them resurrects a removal.
 * 3. **A snapshot with no `eventCount` cannot be judged, so repair declines and
 *    says so.** Overwriting it would destroy the only surviving record of those
 *    workspaces, in the very command an operator ran to recover them.
 *
 * The tests build real roots in temp directories and corrupt them the way a
 * crash would, because the states that matter here are states of files on disk.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "../src/journal.js";
import { type JsonObject, parseJsonObject } from "../src/json.js";

import {
	createWorkspace,
	entriesToClone,
	initRoot,
	listDebris,
	pruneDebris,
	REGENERABLE,
	type Registry,
	RIFT_DIR,
	readRegistry,
	rebuildRegistry,
	removeWorkspace,
	type WorkspaceRecord,
} from "../src/workspace.js";

function root(): string {
	return mkdtempSync(join(tmpdir(), "hobo-rift-recovery-"));
}

function workspace(name: string, path: string): WorkspaceRecord {
	return {
		name,
		path,
		tier: "copy",
		source: "/src",
		createdAt: "2026-08-20T00:00:00.000Z",
	};
}

/** Append a raw journal line, the way the runtime does. */
function appendJournal(abs: string, event: WorkspaceEvent): void {
	const dir = join(abs, RIFT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, {
		flag: "a",
	});
}

function writeSnapshot(
	abs: string,
	body: Partial<Registry> | { root: string; workspaces: string },
): void {
	mkdirSync(join(abs, RIFT_DIR), { recursive: true });
	writeFileSync(
		join(abs, RIFT_DIR, "registry.json"),
		JSON.stringify(body, null, 2),
	);
}

function readSnapshotFile(abs: string): JsonObject {
	return parseJsonObject(
		readFileSync(join(abs, RIFT_DIR, "registry.json"), "utf8"),
	);
}

/** A root with one workspace whose directory really exists on disk. */
function rootWithWorkspace() {
	const abs = initRoot(root()).root;
	const path = join(abs, RIFT_DIR, "workspaces", "feature");
	mkdirSync(path, { recursive: true });
	const ws = workspace("feature", path);
	appendJournal(abs, {
		type: "WorkspaceCreated",
		at: ws.createdAt,
		workspace: ws,
	});
	return { abs, ws };
}

describe("initialising a root", () => {
	it("reports creating one that did not exist", () => {
		const result = initRoot(root());
		expect(result.created).toBe(true);
	});

	it("reports not creating one that already existed", () => {
		// The flag drives whether a caller prints "initialised" or "already a
		// rift root". Reporting creation twice would suggest the second run
		// reset something.
		const abs = initRoot(root()).root;
		expect(initRoot(abs).created).toBe(false);
	});

	it("does not re-record initialisation on a second call", () => {
		// A second RootInitialized event is harmless to the projection but makes
		// the journal lie about the root's history.
		const abs = initRoot(root()).root;
		initRoot(abs);
		const registry = readRegistry(abs);
		expect(registry.workspaces).toEqual([]);
	});

	it("resolves the root to an absolute path", () => {
		// Records store paths. A relative one would resolve against whatever
		// directory a later process happened to run from.
		const abs = initRoot(root()).root;
		expect(abs.startsWith("/")).toBe(true);
	});
});

describe("the journal is the authority", () => {
	it("projects workspaces from the journal", () => {
		const { abs } = rootWithWorkspace();
		expect(readRegistry(abs).workspaces.map((w) => w.name)).toEqual([
			"feature",
		]);
	});

	it("ignores a snapshot that disagrees with the journal", () => {
		// This is the exact window `record()` opens: the event is appended and the
		// snapshot rewritten as two steps. An earlier version preferred the
		// snapshot whenever it parsed, which made a real workspace invisible to
		// list, exec and remove until somebody thought to run repair.
		const { abs } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 99 });
		expect(readRegistry(abs).workspaces).toHaveLength(1);
	});

	it("projects to empty when everything was removed", () => {
		// "Everything was removed" and "nothing was ever created" are both
		// legitimate. Falling back to the snapshot here would resurrect removed
		// workspaces, which the append-only journal could never distinguish from
		// real creations afterwards.
		const { abs, ws } = rootWithWorkspace();
		appendJournal(abs, {
			type: "WorkspaceRemoved",
			at: "2026-08-20T01:00:00.000Z",
			name: ws.name,
		});
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 1 });
		expect(readRegistry(abs).workspaces).toEqual([]);
	});

	it("requires explicit repair when a snapshot has no journal", () => {
		const abs = root();
		const ws = workspace("legacy", join(abs, "legacy"));
		writeSnapshot(abs, { root: abs, workspaces: [ws] });
		expect(() => readRegistry(abs)).toThrow("workspace journal missing");
		expect(rebuildRegistry(abs).undecidable).toContain("left untouched");
		expect(readSnapshotFile(abs).workspaces).toEqual([ws]);
	});

	it("reports empty for a root with neither journal nor snapshot", () => {
		expect(readRegistry(root()).workspaces).toEqual([]);
	});

	it("reports and preserves an unreadable snapshot during repair", () => {
		const abs = root();
		writeSnapshot(abs, {});
		writeFileSync(join(abs, RIFT_DIR, "registry.json"), "{not json");
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readFileSync(join(abs, RIFT_DIR, "registry.json"), "utf8")).toBe(
			"{not json",
		);
	});

	it("preserves a snapshot whose workspaces are not an array", () => {
		const abs = root();
		writeSnapshot(abs, { root: abs, workspaces: "all of them" });
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readSnapshotFile(abs).workspaces).toBe("all of them");
	});
});

describe("repair", () => {
	it("preserves a snapshot belonging to a different root", () => {
		const abs = root();
		const foreignRoot = join(abs, "other-root");
		const path = join(abs, RIFT_DIR, "workspaces", "feature");
		mkdirSync(path, { recursive: true });
		const body = {
			root: foreignRoot,
			workspaces: [workspace("feature", path)],
			eventCount: 2,
		};
		writeSnapshot(abs, body);

		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readSnapshotFile(abs)).toEqual(body);
		expect(existsSync(join(abs, RIFT_DIR, "events.jsonl"))).toBe(false);
	});

	it("restores a newer snapshot after an unterminated journal tail", () => {
		const { abs, ws } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 2 });
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), '{"type":"WorkspaceCre');

		expect(rebuildRegistry(abs).workspaces).toEqual([ws]);
		expect(readRegistry(abs).workspaces).toEqual([ws]);
		expect(readSnapshotFile(abs).workspaces).toEqual([ws]);
		expect(existsSync(join(abs, RIFT_DIR, "registry.repair-backup.json"))).toBe(
			false,
		);
	});

	it("records a removal after an unterminated journal tail", () => {
		const { abs, ws } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 2 });
		writeFileSync(
			join(abs, RIFT_DIR, "events.jsonl"),
			'{"type":"WorkspaceCre',
			{
				flag: "a",
			},
		);

		expect(removeWorkspace(abs, ws.name)).toBe(true);
		expect(readRegistry(abs).workspaces).toEqual([]);
		expect(readSnapshotFile(abs).workspaces).toEqual([]);
	});

	it("preserves the backup and refuses further changes after an interrupted repair", () => {
		const { abs, ws } = rootWithWorkspace();
		const backup = join(abs, RIFT_DIR, "registry.repair-backup.json");
		const body = JSON.stringify({ root: abs, workspaces: [ws], eventCount: 9 });
		writeFileSync(backup, body);
		writeFileSync(join(abs, RIFT_DIR, "registry.json"), "{torn");
		expect(() => readRegistry(abs)).toThrow("unfinished workspace repair");
		expect(() => createWorkspace({ root: abs, name: "new" })).toThrow(
			"unfinished workspace repair",
		);
		expect(() => rebuildRegistry(abs)).toThrow("unfinished workspace repair");
		expect(readFileSync(backup, "utf8")).toBe(body);
	});

	it("refuses creation when the journal is missing and leaves the snapshot intact", () => {
		const { abs, ws } = rootWithWorkspace();
		const body = { root: abs, workspaces: [ws], eventCount: 2 };
		writeSnapshot(abs, body);
		rmSync(join(abs, RIFT_DIR, "events.jsonl"));
		expect(() => createWorkspace({ root: abs, name: "new" })).toThrow(
			"workspace journal missing",
		);
		expect(readSnapshotFile(abs)).toEqual(body);
		expect(existsSync(join(abs, RIFT_DIR, "events.jsonl"))).toBe(false);
	});

	it("refuses mutations when a snapshot may contain newer work", () => {
		const { abs, ws } = rootWithWorkspace();
		const body = { root: abs, workspaces: [ws], eventCount: 9 };
		writeSnapshot(abs, body);
		expect(() => createWorkspace({ root: abs, name: "new" })).toThrow(
			"snapshot may contain newer work",
		);
		expect(() => removeWorkspace(abs, ws.name)).toThrow(
			"snapshot may contain newer work",
		);
		expect(readSnapshotFile(abs)).toEqual(body);
		expect(existsSync(ws.path)).toBe(true);
	});

	it("refuses mutations when the snapshot cannot be parsed", () => {
		const { abs, ws } = rootWithWorkspace();
		const path = join(abs, RIFT_DIR, "registry.json");
		writeFileSync(path, "{broken");
		expect(() => createWorkspace({ root: abs, name: "new" })).toThrow(
			"invalid workspace snapshot",
		);
		expect(() => removeWorkspace(abs, ws.name)).toThrow(
			"invalid workspace snapshot",
		);
		expect(readFileSync(path, "utf8")).toBe("{broken");
		expect(existsSync(ws.path)).toBe(true);
	});

	it("recreates a missing journal for a counted empty snapshot", () => {
		const abs = root();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 0 });
		expect(() => readRegistry(abs)).toThrow("workspace journal missing");
		expect(rebuildRegistry(abs).workspaces).toEqual([]);
		expect(readRegistry(abs).workspaces).toEqual([]);
	});

	it("preserves invalid counts and duplicate workspace records", () => {
		const abs = initRoot(root()).root;
		const ws = workspace("feature", join(abs, "feature"));
		for (const body of [
			{ root: abs, workspaces: [ws], eventCount: -1 },
			{ root: abs, workspaces: [ws], eventCount: 0 },
			{ root: abs, workspaces: [ws], eventCount: 1.5 },
			{ root: abs, workspaces: [ws, ws], eventCount: 2 },
		]) {
			writeSnapshot(abs, body);
			expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
			expect(readSnapshotFile(abs)).toEqual(body);
		}
	});

	it("declines to overwrite an uncounted snapshot with unprojected work", () => {
		const { abs, ws } = rootWithWorkspace();
		const body = {
			root: abs,
			workspaces: [ws, workspace("other", join(abs, "other"))],
		};
		writeSnapshot(abs, body);
		expect(rebuildRegistry(abs).undecidable).toContain("left untouched");
		expect(readSnapshotFile(abs)).toEqual(body);
	});

	it("preserves conflicting snapshots at the same event count", () => {
		const { abs, ws } = rootWithWorkspace();
		const body = { root: abs, workspaces: [], eventCount: 2 };
		writeSnapshot(abs, body);
		expect(rebuildRegistry(abs).undecidable).toContain("left untouched");
		expect(() => removeWorkspace(abs, ws.name)).toThrow(
			"snapshot may contain newer work",
		);
		expect(readSnapshotFile(abs)).toEqual(body);
	});

	it("removes stale journal projections when restoring a newer snapshot", () => {
		const { abs } = rootWithWorkspace();
		const survivorPath = join(abs, RIFT_DIR, "workspaces", "survivor");
		mkdirSync(survivorPath, { recursive: true });
		writeSnapshot(abs, {
			root: abs,
			workspaces: [workspace("survivor", survivorPath)],
			eventCount: 9,
		});
		expect(rebuildRegistry(abs).workspaces.map((entry) => entry.name)).toEqual([
			"survivor",
		]);
		expect(readRegistry(abs).workspaces.map((entry) => entry.name)).toEqual([
			"survivor",
		]);
		expect(existsSync(join(abs, RIFT_DIR, "registry.repair-backup.json"))).toBe(
			false,
		);
	});

	it("does not resurrect a removed workspace from a partially truncated journal", () => {
		const { abs, ws } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 3 });
		expect(rebuildRegistry(abs).workspaces).toEqual([]);
		expect(readRegistry(abs).workspaces).toEqual([]);
		expect(existsSync(ws.path)).toBe(true);
	});

	it("rewrites the snapshot from the journal", () => {
		const { abs } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 0 });
		const result = rebuildRegistry(abs);
		expect(result.workspaces).toHaveLength(1);
		expect(readSnapshotFile(abs).workspaces).toHaveLength(1);
	});

	it("stamps the event count it folded from", () => {
		// The count is the discriminator every later repair depends on. Omitting
		// it makes the root permanently unjudgeable.
		const { abs } = rootWithWorkspace();
		expect(rebuildRegistry(abs).eventCount).toEqual(expect.any(Number));
	});

	it("restores from a snapshot that saw more history than the journal", () => {
		// External truncation — the zero-length-file-after-power-loss shape, since
		// appendFileSync never truncates on its own. The workspace still exists on
		// disk, so leaving it out of the journal would orphan real work.
		const abs = initRoot(root()).root;
		const path = join(abs, RIFT_DIR, "workspaces", "survivor");
		mkdirSync(path, { recursive: true });
		const ws = workspace("survivor", path);
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 5 });

		const result = rebuildRegistry(abs);
		expect(result.workspaces.map((w) => w.name)).toEqual(["survivor"]);
	});

	it("does not restore a workspace whose directory is gone", () => {
		// The directory is the evidence. Replaying a record for one that no longer
		// exists would list a workspace nothing can open.
		const abs = initRoot(root()).root;
		const ws = workspace("vanished", join(abs, "nowhere"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 5 });
		expect(rebuildRegistry(abs).workspaces).toEqual([]);
	});

	it("does not restore from a snapshot that is merely stale", () => {
		// The critical distinction. A snapshot written before the last event has
		// an eventCount at or below the journal's length. Restoring from it would
		// resurrect a workspace someone removed on purpose — written into an
		// append-only journal where it could never be told from a real creation.
		const { abs, ws } = rootWithWorkspace();
		appendJournal(abs, {
			type: "WorkspaceRemoved",
			at: "2026-08-20T01:00:00.000Z",
			name: ws.name,
		});
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 1 });
		expect(rebuildRegistry(abs).workspaces).toEqual([]);
	});

	it("labels the restored snapshot with the journal's own count", () => {
		// Under a partial truncation the snapshot's list and the journal's differ.
		// Labelling the snapshot's list with the journal's length would poison the
		// discriminator: a later genuine truncation would restore from a count
		// that never described those workspaces, silently dropping the ones it
		// omits.
		const abs = initRoot(root()).root;
		const kept = join(abs, RIFT_DIR, "workspaces", "kept");
		mkdirSync(kept, { recursive: true });
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, {
			root: abs,
			workspaces: [workspace("kept", kept), workspace("gone", "/nowhere")],
			eventCount: 9,
		});

		const result = rebuildRegistry(abs);
		expect(result.workspaces).toHaveLength(1);
		expect(result.eventCount).toBe(1);
		expect(readSnapshotFile(abs).eventCount).toBe(1);
	});

	it("declines to judge a snapshot that predates event counting", () => {
		// It might be a truncation survivor, or might merely predate a removal.
		// There is no way to tell, and guessing either way destroys something.
		const abs = initRoot(root()).root;
		const ws = workspace("ancient", join(abs, "ancient"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws] });

		const result = rebuildRegistry(abs);
		expect(result.undecidable).toBeDefined();
	});

	it("leaves the undecidable snapshot untouched", () => {
		// It is the only surviving record of those workspaces' names, tiers and
		// layer paths. Overwriting it with an empty list in the same call that
		// says "go read this file" would leave the root strictly worse off for
		// having run the recovery command.
		const abs = initRoot(root()).root;
		const ws = workspace("ancient", join(abs, "ancient"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws] });

		rebuildRegistry(abs);
		expect(readSnapshotFile(abs).workspaces).toHaveLength(1);
	});

	it("tells the operator where to look and what to do", () => {
		// Declining silently would leave somebody staring at workspaces that
		// exist on disk and nowhere else.
		const abs = initRoot(root()).root;
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, {
			root: abs,
			workspaces: [workspace("ancient", join(abs, "ancient"))],
		});

		const message = rebuildRegistry(abs).undecidable ?? "";
		expect(message).toContain("registry.json");
		expect(message).toContain("left untouched");
		expect(message).toContain("1 workspace(s)");
	});

	it("does not decline when the journal still projects something", () => {
		// Nothing is at risk: the journal has the workspaces, so the snapshot's
		// age does not matter.
		const { abs, ws } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [ws] });
		expect(rebuildRegistry(abs).undecidable).toBeUndefined();
	});

	it("does not decline for an empty snapshot with no count", () => {
		// There is nothing to lose, so writing a fresh one is safe.
		const abs = initRoot(root()).root;
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [] });
		expect(rebuildRegistry(abs).undecidable).toBeUndefined();
	});

	it("handles a root with no snapshot at all", () => {
		const { abs } = rootWithWorkspace();
		rmSync(join(abs, RIFT_DIR, "registry.json"), { force: true });
		expect(rebuildRegistry(abs).workspaces).toHaveLength(1);
	});
});

describe("debris", () => {
	function withDebris(): string {
		const abs = initRoot(root()).root;
		mkdirSync(join(abs, RIFT_DIR, "workspaces", "old.debris.123"), {
			recursive: true,
		});
		mkdirSync(join(abs, RIFT_DIR, "workspaces", "live"), { recursive: true });
		return abs;
	}

	it("lists only parked directories", () => {
		// A live workspace listed as debris would be offered up for deletion.
		const listed = listDebris(withDebris());
		expect(listed).toHaveLength(1);
		expect(listed[0]).toContain(".debris");
	});

	it("lists nothing for a root with no workspaces directory", () => {
		expect(listDebris(root())).toEqual([]);
	});

	it("deletes what it listed and reports it", () => {
		// Debris holds real work, so the operator needs to know what went.
		const abs = withDebris();
		const pruned = pruneDebris(abs);
		expect(pruned).toHaveLength(1);
		expect(listDebris(abs)).toEqual([]);
	});

	it("leaves live workspaces alone", () => {
		const abs = withDebris();
		pruneDebris(abs);
		expect(
			listDebris(abs).concat(readRegistry(abs).workspaces.map((w) => w.path)),
		).toEqual([]);
	});

	it("prunes nothing when there is nothing parked", () => {
		expect(pruneDebris(initRoot(root()).root)).toEqual([]);
	});
});

describe("choosing what to clone", () => {
	const listing = [
		"src",
		"package.json",
		"node_modules",
		"dist",
		".turbo",
		RIFT_DIR,
	];

	it("skips regenerable bulk by default", () => {
		// Cloning node_modules is the difference between an instant workspace and
		// a coffee break, and it rebuilds itself anyway.
		const entries = entriesToClone("/src", false, () => [...listing]);
		expect(entries).toEqual(["src", "package.json"]);
	});

	it("includes regenerable bulk when the caller asks for everything", () => {
		const entries = entriesToClone("/src", true, () => [...listing]);
		expect(entries).toContain("node_modules");
		expect(entries).toContain("dist");
	});

	it("never clones the rift directory itself", () => {
		// Copying it would give the workspace its own registry claiming to own the
		// workspaces of the root it was cloned from.
		expect(entriesToClone("/src", true, () => [...listing])).not.toContain(
			RIFT_DIR,
		);
	});

	for (const entry of REGENERABLE) {
		it(`treats ${entry} as regenerable`, () => {
			expect(entriesToClone("/src", false, () => [entry, "keep"])).toEqual([
				"keep",
			]);
		});
	}

	it("does not skip a name that merely contains a regenerable one", () => {
		// `my-dist` is somebody's source directory. Matching on substring rather
		// than equality would silently drop it from every workspace.
		expect(
			entriesToClone("/src", false, () => ["my-dist", "dist-notes"]),
		).toEqual(["my-dist", "dist-notes"]);
	});
});
