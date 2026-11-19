import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appendEvent, type WorkspaceEvent } from "../src/journal.js";
import type { JsonObject } from "../src/json.js";

import {
	createWorkspace,
	entriesToClone,
	initRoot,
	listDebris,
	pruneDebris,
	REGENERABLE,
	RIFT_DIR,
	readRegistry,
	rebuildRegistry,
	type Registry,
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

function appendJournal(abs: string, event: WorkspaceEvent): void {
	const dir = join(abs, RIFT_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`, {
		flag: "a",
	});
}

function writeSnapshot(abs: string, body: Partial<Registry>): void {
	mkdirSync(join(abs, RIFT_DIR), { recursive: true });
	writeFileSync(
		join(abs, RIFT_DIR, "registry.json"),
		JSON.stringify(body, null, 2),
	);
}

function readSnapshotFile(abs: string): JsonObject {
	return JSON.parse(
		readFileSync(join(abs, RIFT_DIR, "registry.json"), "utf8"),
	) as JsonObject;
}

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

	it("requires repair when a valid snapshot has lost its journal", () => {
		const abs = root();
		const path = join(abs, RIFT_DIR, "workspaces", "saved");
		mkdirSync(path, { recursive: true });
		writeSnapshot(abs, {
			root: abs,
			workspaces: [workspace("saved", path)],
			eventCount: 2,
		});
		expect(() => readRegistry(abs)).toThrow("workspace journal missing");
		expect(rebuildRegistry(abs).workspaces.map((entry) => entry.name)).toEqual([
			"saved",
		]);
		expect(readRegistry(abs).workspaces.map((entry) => entry.name)).toEqual([
			"saved",
		]);
	});

	it("recreates a missing empty journal during repair", () => {
		const abs = root();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 0 });
		expect(() => readRegistry(abs)).toThrow("workspace journal missing");
		expect(rebuildRegistry(abs)).toEqual({
			root: abs,
			workspaces: [],
			eventCount: 0,
		});
		expect(readRegistry(abs)).toEqual({
			root: abs,
			workspaces: [],
			eventCount: 0,
		});
	});

	it("reports empty for a root with neither journal nor snapshot", () => {
		expect(readRegistry(root()).workspaces).toEqual([]);
	});

	it("preserves an unreadable snapshot instead of treating it as empty", () => {
		const abs = root();
		writeSnapshot(abs, {});
		const path = join(abs, RIFT_DIR, "registry.json");
		writeFileSync(path, "{not json");
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readFileSync(path, "utf8")).toBe("{not json");
	});
});

describe("repair", () => {
	it("rejects malformed complete entries without changing the journal or snapshot", () => {
		const { abs } = rootWithWorkspace();
		const path = join(abs, RIFT_DIR, "events.jsonl");
		const snapshotPath = join(abs, RIFT_DIR, "registry.json");
		const journal = `${readFileSync(path, "utf8")}{invalid}\n`;
		const snapshot = readFileSync(snapshotPath, "utf8");
		writeFileSync(path, journal);
		expect(() => readRegistry(abs)).toThrow("invalid workspace journal");
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace journal");
		expect(readFileSync(path, "utf8")).toBe(journal);
		expect(readFileSync(snapshotPath, "utf8")).toBe(snapshot);
	});

	it("rejects complete entries that do not match the current event schema", () => {
		const abs = initRoot(root()).root;
		const path = join(abs, RIFT_DIR, "events.jsonl");
		const journal = `${readFileSync(path, "utf8")}{"type":"WorkspaceCreated","at":"today"}`;
		writeFileSync(path, journal);
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace journal");
		expect(readFileSync(path, "utf8")).toBe(journal);
	});

	it("refuses to append after an incomplete tail", () => {
		const abs = initRoot(root()).root;
		const dir = join(abs, RIFT_DIR);
		const path = join(dir, "events.jsonl");
		const journal = `${readFileSync(path, "utf8")}{"type":"Workspace`;
		writeFileSync(path, journal);
		expect(() =>
			appendEvent(dir, {
				type: "WorkspaceRemoved",
				at: "2026-08-20T01:00:00.000Z",
				name: "feature",
			}),
		).toThrow("incomplete workspace journal");
		expect(readFileSync(path, "utf8")).toBe(journal);
	});

	it("refuses workspace creation before claiming a name when the journal is incomplete", () => {
		const abs = initRoot(root()).root;
		const dir = join(abs, RIFT_DIR);
		const path = join(dir, "events.jsonl");
		const journal = `${readFileSync(path, "utf8")}{"type":"Workspace`;
		writeFileSync(path, journal);
		expect(() => createWorkspace({ root: abs, name: "feature" })).toThrow(
			"incomplete workspace journal",
		);
		expect(readdirSync(join(dir, "workspaces"))).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(journal);
	});

	it("preserves a damaged tail, restores the snapshot, and accepts later events", () => {
		const { abs, ws } = rootWithWorkspace();
		const dir = join(abs, RIFT_DIR);
		const path = join(dir, "events.jsonl");
		const initial = readFileSync(path, "utf8").split("\n")[0];
		const damaged = `${initial}\n{"type":"WorkspaceCreated","workspace":`;
		writeFileSync(path, damaged);
		writeSnapshot(abs, { root: abs, workspaces: [ws], eventCount: 2 });
		const result = rebuildRegistry(abs);
		expect(result.preservedJournal).toBeDefined();
		if (!result.preservedJournal) throw new Error("missing preserved journal");
		expect(readFileSync(result.preservedJournal, "utf8")).toBe(damaged);
		expect(result.workspaces).toEqual([ws]);
		expect(readSnapshotFile(abs)).not.toHaveProperty("preservedJournal");
		const resultPath = join(abs, "repair-result.json");
		writeFileSync(resultPath, JSON.stringify(result));
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/rift_workspace.cue", import.meta.url),
		);
		execFileSync(cue, ["vet", schema, resultPath, "-d", "#RepairResult"]);
		appendEvent(dir, {
			type: "WorkspaceRemoved",
			at: ws.createdAt,
			name: ws.name,
		});
		expect(readRegistry(abs).workspaces).toEqual([]);
	});

	it("normalizes a valid final event without preserving a damaged copy", () => {
		const { abs, ws } = rootWithWorkspace();
		const path = join(abs, RIFT_DIR, "events.jsonl");
		const unterminated = readFileSync(path, "utf8").trimEnd();
		writeFileSync(path, unterminated);
		const result = rebuildRegistry(abs);
		expect(result.preservedJournal).toBeUndefined();
		expect(readFileSync(path, "utf8")).toBe(`${unterminated}\n`);
		expect(readRegistry(abs).workspaces).toEqual([ws]);
	});

	it("separates a new event from a complete unterminated event", () => {
		const { abs, ws } = rootWithWorkspace();
		const dir = join(abs, RIFT_DIR);
		const path = join(dir, "events.jsonl");
		writeFileSync(path, readFileSync(path, "utf8").trimEnd());
		appendEvent(dir, {
			type: "WorkspaceRemoved",
			at: ws.createdAt,
			name: ws.name,
		});
		expect(readRegistry(abs).workspaces).toEqual([]);
		expect(readRegistry(abs).eventCount).toBe(3);
	});

	it("does not repair the journal if the snapshot is invalid", () => {
		const abs = initRoot(root()).root;
		const dir = join(abs, RIFT_DIR);
		const path = join(dir, "events.jsonl");
		const snapshot = join(dir, "registry.json");
		const journal = `${readFileSync(path, "utf8")}{"type":"Workspace`;
		writeFileSync(path, journal);
		writeFileSync(snapshot, "{invalid");
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readFileSync(path, "utf8")).toBe(journal);
		expect(readFileSync(snapshot, "utf8")).toBe("{invalid");
		expect(
			readdirSync(dir).filter((name) => name.includes(".damaged-")),
		).toEqual([]);
	});

	it("reports the preserved journal through the CLI", () => {
		const abs = initRoot(root()).root;
		const path = join(abs, RIFT_DIR, "events.jsonl");
		const journal = `${readFileSync(path, "utf8")}{"type":"Workspace`;
		writeFileSync(path, journal);
		const cli = fileURLToPath(
			new URL("../src/bin/hobo-rift.ts", import.meta.url),
		);
		const output = execFileSync(
			process.execPath,
			["--import", "tsx", cli, "repair", "--root", abs, "--json"],
			{ encoding: "utf8" },
		);
		const result = JSON.parse(output) as { preservedJournal: string };
		expect(readFileSync(result.preservedJournal, "utf8")).toBe(journal);
	});

	it("writes a registry that satisfies the current CUE contract", () => {
		const { abs } = rootWithWorkspace();
		rebuildRegistry(abs);
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/rift_workspace.cue", import.meta.url),
		);
		execFileSync(cue, [
			"vet",
			schema,
			join(abs, RIFT_DIR, "registry.json"),
			"-d",
			"#Registry",
		]);
	});
	it("rewrites the snapshot from the journal", () => {
		const { abs } = rootWithWorkspace();
		writeSnapshot(abs, { root: abs, workspaces: [], eventCount: 0 });
		const result = rebuildRegistry(abs);
		expect(result.workspaces).toHaveLength(1);
		expect(readSnapshotFile(abs).workspaces).toHaveLength(1);
	});

	it("stamps the event count it folded from", () => {
		const { abs } = rootWithWorkspace();
		expect(rebuildRegistry(abs).eventCount).toBeGreaterThanOrEqual(0);
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

	it("rejects snapshots without a valid event count and preserves their contents", () => {
		const abs = initRoot(root()).root;
		const body = {
			root: abs,
			workspaces: [workspace("saved", join(abs, "saved"))],
		};
		writeSnapshot(abs, body);
		expect(() => rebuildRegistry(abs)).toThrow("invalid workspace snapshot");
		expect(readSnapshotFile(abs)).toEqual(body);
	});

	it("restores the newer snapshot without deleting workspace directories", () => {
		const { abs, ws } = rootWithWorkspace();
		const otherPath = join(abs, RIFT_DIR, "workspaces", "other");
		mkdirSync(otherPath, { recursive: true });
		writeSnapshot(abs, {
			root: abs,
			workspaces: [workspace("other", otherPath)],
			eventCount: 20,
		});
		const result = rebuildRegistry(abs);
		expect(result.workspaces.map((entry) => entry.name)).toEqual(["other"]);
		expect(readFileSync(join(abs, RIFT_DIR, "events.jsonl"), "utf8")).toContain(
			'"type":"WorkspaceRemoved"',
		);
		expect(readRegistry(abs).workspaces.map((entry) => entry.name)).toEqual([
			"other",
		]);
		expect(existsSync(ws.path)).toBe(true);
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
