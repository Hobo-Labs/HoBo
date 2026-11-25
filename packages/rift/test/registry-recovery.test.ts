import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	entriesToClone,
	initRoot,
	listDebris,
	pruneDebris,
	REGENERABLE,
	RIFT_DIR,
	readRegistry,
	rebuildRegistry,
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
	} as WorkspaceRecord;
}

function appendJournal(abs: string, event: unknown): void {
	const dir = join(abs, RIFT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, {
		flag: "a",
	});
}

function writeSnapshot(abs: string, body: unknown): void {
	mkdirSync(join(abs, RIFT_DIR), { recursive: true });
	writeFileSync(
		join(abs, RIFT_DIR, "registry.json"),
		JSON.stringify(body, null, 2),
	);
}

function readSnapshotFile(abs: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(abs, RIFT_DIR, "registry.json"), "utf8"),
	) as Record<string, unknown>;
}

function rootWithWorkspace(): { abs: string; ws: WorkspaceRecord } {
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
		const abs = initRoot(root()).root;
		expect(initRoot(abs).created).toBe(false);
	});

	it("does not re-record initialisation on a second call", () => {
		const abs = initRoot(root()).root;
		initRoot(abs);
		const registry = readRegistry(abs);
		expect(registry.workspaces).toEqual([]);
	});

	it("resolves the root to an absolute path", () => {
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
		const { abs } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 99 });
		expect(readRegistry(abs).workspaces).toHaveLength(1);
	});

	it("projects to empty when everything was removed", () => {
		const { abs, ws } = rootWithWorkspace();
		appendJournal(abs, {
			type: "WorkspaceRemoved",
			at: "2026-08-20T01:00:00.000Z",
			name: ws.name,
		});
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 1 });
		expect(readRegistry(abs).workspaces).toEqual([]);
	});

	it("falls back to the snapshot only when there is no journal at all", () => {
		const abs = root();
		const ws = workspace("legacy", join(abs, "legacy"));
		writeSnapshot(abs, { root: abs, workspaces: [ws] });
		expect(readRegistry(abs).workspaces.map((w) => w.name)).toEqual(["legacy"]);
	});

	it("reports empty for a root with neither journal nor snapshot", () => {
		expect(readRegistry(root()).workspaces).toEqual([]);
	});

	it("reports empty rather than throwing on an unreadable snapshot", () => {
		const abs = root();
		writeSnapshot(abs, {});
		writeFileSync(join(abs, RIFT_DIR, "registry.json"), "{not json");
		expect(readRegistry(abs).workspaces).toEqual([]);
	});

	it("reports empty when the snapshot's workspaces are not an array", () => {
		const abs = root();
		writeSnapshot(abs, { root: abs, workspaces: "all of them" });
		expect(readRegistry(abs).workspaces).toEqual([]);
	});
});

describe("repair", () => {
	it("rewrites the snapshot from the journal", () => {
		const { abs } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 0 });
		const result = rebuildRegistry(abs);
		expect(result.workspaces).toHaveLength(1);
		expect(readSnapshotFile(abs).workspaces).toHaveLength(1);
	});

	it("stamps the event count it folded from", () => {
		const { abs } = rootWithWorkspace();
		expect(typeof rebuildRegistry(abs).eventCount).toBe("number");
	});

	it("restores from a snapshot that saw more history than the journal", () => {
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
		const abs = initRoot(root()).root;
		const ws = workspace("vanished", join(abs, "nowhere"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 5 });
		expect(rebuildRegistry(abs).workspaces).toEqual([]);
	});

	it("does not restore from a snapshot that is merely stale", () => {
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
		const abs = initRoot(root()).root;
		const ws = workspace("ancient", join(abs, "ancient"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws] });

		const result = rebuildRegistry(abs);
		expect(result.undecidable).toBeDefined();
	});

	it("leaves the undecidable snapshot untouched", () => {
		const abs = initRoot(root()).root;
		const ws = workspace("ancient", join(abs, "ancient"));
		writeFileSync(join(abs, RIFT_DIR, "events.jsonl"), "");
		writeSnapshot(abs, { root: abs, workspaces: [ws] });

		rebuildRegistry(abs);
		expect(readSnapshotFile(abs).workspaces).toHaveLength(1);
	});

	it("tells the operator where to look and what to do", () => {
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
		const { abs, ws } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [ws] });
		expect(rebuildRegistry(abs).undecidable).toBeUndefined();
	});

	it("does not decline for an empty snapshot with no count", () => {
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
		const listed = listDebris(withDebris());
		expect(listed).toHaveLength(1);
		expect(listed[0]).toContain(".debris");
	});

	it("lists nothing for a root with no workspaces directory", () => {
		expect(listDebris(root())).toEqual([]);
	});

	it("deletes what it listed and reports it", () => {
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
		const entries = entriesToClone("/src", false, () => [...listing]);
		expect(entries).toEqual(["src", "package.json"]);
	});

	it("includes regenerable bulk when the caller asks for everything", () => {
		const entries = entriesToClone("/src", true, () => [...listing]);
		expect(entries).toContain("node_modules");
		expect(entries).toContain("dist");
	});

	it("never clones the rift directory itself", () => {
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
		expect(
			entriesToClone("/src", false, () => ["my-dist", "dist-notes"]),
		).toEqual(["my-dist", "dist-notes"]);
	});
});
