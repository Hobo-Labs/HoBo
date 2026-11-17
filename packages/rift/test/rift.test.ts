/**
 * Virtual worktrees on a machine upstream rift cannot serve.
 *
 * Upstream needs btrfs/XFS-reflink/APFS and ships per-platform binaries; on
 * plain ext4 arm64 it does not run, and a caller falls back to giving every
 * agent the same checkout. These tests pin the ladder that replaces it,
 * and in particular the property that matters: an agent writing in place must
 * not reach the source.
 */

import { execSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { must } from "@hobo/core/total-access";
import { afterAll, describe, expect, it } from "vitest";
import { type JsonBag, type JsonValue, parseJsonObject } from "../src/json.js";

const here = dirname(fileURLToPath(import.meta.url));

import { CowTier as CowTierPb } from "../src/_generated/rift_workspace_pb.js";
import {
	detectCapability,
	probeOverlayfs,
	removeOverlayProbe,
} from "../src/capability.js";
import { projectWorkspaces, readEvents } from "../src/journal.js";
import { parseWorkspaceName } from "../src/names.js";
import {
	capabilityToWire,
	tierFromWire,
	tierToWire,
	workspaceToWire,
} from "../src/wire.js";
import {
	createWorkspace,
	deriveContract,
	entriesToClone,
	execCommand,
	initRoot,
	listDebris,
	pruneDebris,
	quoteVector,
	REGENERABLE,
	RIFT_DIR,
	readRegistry,
	rebuildRegistry,
	removeWorkspace,
} from "../src/workspace.js";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) removeOverlayProbe(d);
});

function source(): string {
	const d = mkdtempSync(join(tmpdir(), "rift-src-"));
	dirs.push(d);
	mkdirSync(join(d, "src"), { recursive: true });
	mkdirSync(join(d, "node_modules", "junk"), { recursive: true });
	writeFileSync(join(d, "src", "app.ts"), "original content\n");
	writeFileSync(join(d, "README.md"), "keep\n");
	writeFileSync(join(d, "node_modules", "junk", "big.bin"), "x".repeat(50_000));
	return d;
}

describe("capability ladder", () => {
	it("prefers reflink, then overlayfs, then hardlink, then copy", () => {
		const all = detectCapability("/x", {
			reflink: () => true,
			overlayfs: () => true,
			hardlink: () => true,
		});
		expect(all.tier).toBe("reflink");
		expect(all.available).toEqual(["reflink", "overlayfs", "hardlink", "copy"]);

		const noReflink = detectCapability("/x", {
			reflink: () => false,
			overlayfs: () => true,
			hardlink: () => true,
		});
		expect(noReflink.tier).toBe("overlayfs");
	});

	it("ranks hardlink below overlayfs because in-place writes escape it", () => {
		const hard = detectCapability("/x", {
			reflink: () => false,
			overlayfs: () => false,
			hardlink: () => true,
		});
		expect(hard.tier).toBe("hardlink");
		// The whole reason for the ordering: this tier is not safe against
		// `>>` or `sed -i`, so it must announce that rather than look equal.
		expect(hard.isolatesInPlaceWrites).toBe(false);
		expect(hard.reason).toMatch(/in-place writes reach the source/);
	});

	it("always has a working last resort", () => {
		const copy = detectCapability("/x", {
			reflink: () => false,
			overlayfs: () => false,
			hardlink: () => false,
		});
		expect(copy.tier).toBe("copy");
		expect(copy.isolatesInPlaceWrites).toBe(true);
	});

	it("removes an overlay probe with an inaccessible kernel work directory", () => {
		const probe = mkdtempSync(join(tmpdir(), "rift-ovl-cleanup-"));
		dirs.push(probe);
		const workWork = join(probe, "work", "work");
		mkdirSync(workWork, { recursive: true });
		chmodSync(workWork, 0o000);

		removeOverlayProbe(probe);

		expect(existsSync(probe)).toBe(false);
	});
});

describe("workspace creation", () => {
	it("excludes regenerable bulk by default and keeps it with copyAll", () => {
		const root = source();
		const lean = entriesToClone(root, false);
		expect(lean).toContain("src");
		expect(lean).toContain("README.md");
		expect(lean).not.toContain("node_modules");
		expect(entriesToClone(root, true)).toContain("node_modules");
		// Its own bookkeeping is never cloned into a child.
		expect(entriesToClone(root, true)).not.toContain(RIFT_DIR);
		expect(REGENERABLE).toContain("node_modules");
	});

	it("registers the root and records each workspace", () => {
		const root = source();
		expect(initRoot(root).created).toBe(true);
		expect(initRoot(root).created).toBe(false);
		const made = createWorkspace({ root, name: "claude" });
		expect(made.workspace).not.toBeNull();
		const registry = readRegistry(root);
		expect(registry.workspaces.map((w) => w.name)).toEqual(["claude"]);
		expect(removeWorkspace(root, "claude")).toBe(true);
		expect(readRegistry(root).workspaces).toEqual([]);
	});

	it("refuses to clobber an existing workspace", () => {
		const root = source();
		createWorkspace({ root, name: "dup" });
		const again = createWorkspace({ root, name: "dup" });
		expect(again.workspace).toBeNull();
		expect(again.reason).toMatch(/already exists/);
	});

	it("copy tier produces a real, independent directory", () => {
		const root = source();
		const made = createWorkspace({
			root,
			name: "copied",
			capability: {
				tier: "copy",
				available: ["copy"],
				reason: "forced",
				isolatesInPlaceWrites: true,
			},
		});
		const path = must(made.workspace, "made.workspace").path;
		expect(existsSync(join(path, "src", "app.ts"))).toBe(true);
		writeFileSync(join(path, "src", "app.ts"), "changed\n");
		expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(
			"original content\n",
		);
	});
});

describe("exec wrapper", () => {
	it("is a plain cd for directory-backed tiers", () => {
		expect(
			execCommand(
				{
					name: "a",
					path: "/ws/a",
					tier: "copy",
					source: "/src",
					createdAt: "",
				},
				"claude",
			),
		).toBe("cd '/ws/a' && claude");
	});

	it("single-quotes paths so the shell cannot expand them", () => {
		// JSON.stringify produces double quotes, inside which `$(…)`, backticks
		// and `\` are still interpreted — the path was an injection point.
		const cmd = execCommand(
			{
				name: "a",
				path: "/ws/$(touch pwned)",
				tier: "copy",
				source: "/src",
				createdAt: "",
			},
			"claude",
		);
		expect(cmd).toBe("cd '/ws/$(touch pwned)' && claude");
		expect(cmd).not.toContain('"');
	});

	it("survives a source path containing a space", () => {
		// Unquoted mount options split on the space, so `mount: bad usage` — and
		// because the chain used `;`, the agent's command then ran anyway, in
		// whatever directory the shell happened to be in.
		const cmd = execCommand(
			{
				name: "a",
				path: "/ws with space/merged",
				tier: "overlayfs",
				source: "/src dir",
				upper: "/ws with space/upper",
				work: "/ws with space/work",
				createdAt: "",
			},
			"claude",
		);
		expect(cmd).toContain("'lowerdir=/src dir,");
		expect(cmd).not.toMatch(/-o lowerdir=\/src dir/);
	});

	it("aborts instead of running the command when the mount fails", () => {
		const cmd = execCommand(
			{
				name: "a",
				path: "/ws/merged",
				tier: "overlayfs",
				source: "/src",
				upper: "/ws/upper",
				work: "/ws/work",
				createdAt: "",
			},
			"echo one; echo two",
		);
		// Every step joined with && and the command exec'd as a nested sh -c:
		// a `;` here would let a compound command partially run unmounted.
		expect(cmd).not.toMatch(/mount[^&]*;/);
		expect(cmd).toContain("exec sh -c");
		// Every step joined with &&, so a failed mount stops the chain.
		expect(cmd.split("&&").length).toBeGreaterThanOrEqual(4);
	});

	it("hides the rift directory so agents cannot read each other's trees", () => {
		const cmd = execCommand(
			{
				name: "a",
				path: "/ws/merged",
				tier: "overlayfs",
				source: "/src",
				upper: "/ws/upper",
				work: "/ws/work",
				createdAt: "",
			},
			"claude",
		);
		// The whole source is the lower layer, which includes every other
		// agent's upper layer.
		expect(cmd).toContain("mount -t tmpfs none ");
		expect(cmd).toContain("/ws/merged/.hobo-rift");
	});

	it("enters a user namespace and mounts the overlay", () => {
		const cmd = execCommand(
			{
				name: "a",
				path: "/ws/a/merged",
				tier: "overlayfs",
				source: "/src",
				upper: "/ws/a/upper",
				work: "/ws/a/work",
				createdAt: "",
			},
			"claude",
		);
		expect(cmd).toContain("unshare -Urm");
		expect(cmd).toContain("lowerdir=/src");
		expect(cmd).toContain("upperdir=/ws/a/upper");
		expect(cmd).toContain("claude");
	});
});

describe("overlay availability is reported, not silently skipped", () => {
	it("leaves no overlay probe debris under the probed directory", () => {
		const root = source();
		probeOverlayfs(root);
		expect(
			readdirSync(root).some((name) => name.startsWith(".rift-ovl-")),
		).toBe(false);
	});

	it("says so when this machine cannot grant an unprivileged overlay", () => {
		// runIf drops the property block below with no skip count in the report,
		// so a CI box without user namespaces would print "all passed" while
		// proving nothing about the tier this package exists to add.
		const root = source();
		const available = probeOverlayfs(root);
		if (!available) {
			console.warn(
				"[rift] unprivileged overlayfs unavailable here — the isolation property test did NOT run",
			);
		}
		// Not a tautology: the probe and the selector must agree. A probe that
		// says yes while detectCapability picks something else (or vice versa)
		// means the recorded tier does not describe the machine.
		const tier = detectCapability(root).tier;
		expect(available ? tier !== "hardlink" : tier !== "overlayfs").toBe(true);
		if (available) expect(["reflink", "overlayfs"]).toContain(tier);
	});
});

// The property that justifies the whole package. Skipped where the kernel
// will not give us an unprivileged overlay.
describe.runIf(probeOverlayfs())("overlayfs isolation", () => {
	it("keeps an in-place write inside the workspace", () => {
		const root = source();
		const made = createWorkspace({ root, name: "agent" });
		expect(must(made.workspace, "made.workspace").tier).toBe("overlayfs");
		execSync(
			`sh -c ${JSON.stringify(execCommand(must(made.workspace, "made.workspace"), "echo EDIT >> src/app.ts"))}`,
		);
		// An append is exactly what hardlinks leak; the source must be intact.
		expect(readFileSync(join(root, "src", "app.ts"), "utf8")).toBe(
			"original content\n",
		);
		expect(
			readFileSync(
				join(
					must(
						must(made.workspace, "made.workspace").upper,
						"made.workspace.upper",
					),
					"src",
					"app.ts",
				),
				"utf8",
			),
		).toContain("EDIT");
	});
});

describe("workspace names are parsed, not trusted", () => {
	it("refuses names that would escape the workspaces directory", () => {
		for (const bad of ["../evil", "..", ".", "a/b", "a\\b", "", "   "]) {
			expect(parseWorkspaceName(bad).ok).toBe(false);
		}
	});

	it("refuses every shell metacharacter, not just path separators", () => {
		// `create --name 'ws$(touch INJECTED)x'` executed the substitution in
		// the SOURCE tree — the exact tree a workspace exists to protect.
		for (const bad of [
			"ws$(touch INJECTED)x",
			"ws`id`",
			"ws;rm -rf /",
			"ws|cat",
			"ws&bg",
			"ws>out",
			"ws'q",
			'ws"q',
			"ws x",
			"ws\nx",
		]) {
			expect(parseWorkspaceName(bad).ok, bad).toBe(false);
		}
	});

	it("refuses a leading dash, which reads as a flag downstream", () => {
		expect(parseWorkspaceName("-rf").ok).toBe(false);
	});

	it("accepts ordinary agent ids", () => {
		for (const good of ["claude", "codex", "claude-code", "agent_1"]) {
			const parsed = parseWorkspaceName(good);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value).toBe(good);
		}
	});

	it("create refuses a traversing name instead of writing outside the root", () => {
		const root = source();
		const made = createWorkspace({ root, name: "../escaped" });
		expect(made.workspace).toBeNull();
		expect(made.reason).toMatch(/invalid workspace name/);
		// Nothing may have been produced next to the root.
		expect(existsSync(join(root, "..", "escaped"))).toBe(false);
	});
});

describe("registry is a projection of the journal", () => {
	it("records one event per lifecycle step", () => {
		const root = source();
		createWorkspace({ root, name: "one" });
		createWorkspace({ root, name: "two" });
		removeWorkspace(root, "one");
		const events = readEvents(join(root, RIFT_DIR));
		expect(events.map((e) => e.type)).toEqual([
			"RootInitialized",
			// Intent is recorded before the clone, which can take seconds and die.
			"WorkspaceCreating",
			"WorkspaceCreated",
			"WorkspaceCreating",
			"WorkspaceCreated",
			"WorkspaceRemoved",
		]);
		expect(projectWorkspaces(events).map((w) => w.name)).toEqual(["two"]);
	});

	it("survives a torn snapshot by replaying the journal", () => {
		const root = source();
		createWorkspace({ root, name: "alive" });
		// The crash shape: a half-written snapshot. It must cost time, not data.
		writeFileSync(join(root, RIFT_DIR, "registry.json"), '{"root":"/x","works');
		expect(readRegistry(root).workspaces.map((w) => w.name)).toEqual(["alive"]);
		expect(rebuildRegistry(root).workspaces.map((w) => w.name)).toEqual([
			"alive",
		]);
		// And the snapshot is valid again afterwards.
		expect(
			JSON.parse(readFileSync(join(root, RIFT_DIR, "registry.json"), "utf8"))
				.workspaces,
		).toHaveLength(1);
	});

	it("skips a truncated tail line rather than losing the whole journal", () => {
		const root = source();
		createWorkspace({ root, name: "kept" });
		const journal = join(root, RIFT_DIR, "events.jsonl");
		writeFileSync(
			journal,
			`${readFileSync(journal, "utf8")}{"type":"Workspace`,
		);
		expect(
			projectWorkspaces(readEvents(join(root, RIFT_DIR))).map((w) => w.name),
		).toEqual(["kept"]);
	});
});

describe("wire boundary", () => {
	it("maps every domain tier to a distinct generated enum value", () => {
		const tiers = ["reflink", "overlayfs", "hardlink", "copy"] as const;
		const wire = tiers.map(tierToWire);
		expect(new Set(wire).size).toBe(tiers.length);
		// Round-trip: the schema and the domain cannot drift apart silently.
		expect(wire.map(tierFromWire)).toEqual([...tiers]);
		expect(tierFromWire(CowTierPb.UNSPECIFIED)).toBeNull();
	});

	it("converts a workspace record without losing the tier or the layers", () => {
		const wire = workspaceToWire({
			name: "claude",
			path: "/ws/merged",
			tier: "overlayfs",
			source: "/src",
			upper: "/ws/upper",
			work: "/ws/work",
			createdAt: "2026-08-03T00:00:00.000Z",
		});
		expect(wire.tier).toBe(CowTierPb.OVERLAYFS);
		expect(wire.upper).toBe("/ws/upper");
		// A directory-backed tier has no layers; proto3 carries that as empty.
		expect(
			workspaceToWire({
				name: "codex",
				path: "/ws/codex",
				tier: "copy",
				source: "/src",
				createdAt: "2026-08-03T00:00:00.000Z",
			}).upper,
		).toBe("");
	});

	it("reports the hardlink hazard across the wire boundary", () => {
		const wire = capabilityToWire({
			tier: "hardlink",
			available: ["hardlink", "copy"],
			reason: "no reflinks",
			isolatesInPlaceWrites: false,
		});
		expect(wire.tier).toBe(CowTierPb.HARDLINK);
		expect(wire.isolatesInPlaceWrites).toBe(false);
	});
});

describe("crash windows", () => {
	it("prefers the journal over a stale-but-valid snapshot", () => {
		// record() appends the event then rewrites the snapshot. A crash in
		// between leaves a snapshot that parses perfectly and is wrong; trusting
		// it made a real workspace invisible to list, exec and remove.
		const root = source();
		createWorkspace({ root, name: "alpha" });
		const stale = readFileSync(join(root, RIFT_DIR, "registry.json"), "utf8");
		createWorkspace({ root, name: "beta" });
		writeFileSync(join(root, RIFT_DIR, "registry.json"), stale);
		expect(
			readRegistry(root)
				.workspaces.map((w) => w.name)
				.sort(),
		).toEqual(["alpha", "beta"]);
	});

	it("clears debris from a creation that never finished", () => {
		// The clone is the long part; a crash inside it left a directory that
		// nothing knew about but that blocked the name forever.
		const root = source();
		const made = createWorkspace({ root, name: "half" });
		const path = must(made.workspace, "made.workspace").path;
		expect(existsSync(path)).toBe(true);
		// Rewind the journal to just the intent, as a crash mid-clone would.
		const journal = join(root, RIFT_DIR, "events.jsonl");
		const kept = readFileSync(journal, "utf8")
			.split("\n")
			.filter((l) => l.length > 0 && !l.includes('"WorkspaceCreated"'));
		writeFileSync(journal, `${kept.join("\n")}\n`);
		expect(readRegistry(root).workspaces).toEqual([]);
		// The name is reusable rather than poisoned.
		const retry = createWorkspace({ root, name: "half" });
		expect(retry.workspace).not.toBeNull();
		expect(retry.reason).toBeUndefined();
	});
});

describe("a removal that dies mid-delete", () => {
	it("does not wedge the name forever", () => {
		// Removal records the event before deleting, so a crash inside rmSync of
		// a large tree leaves a directory the registry says is gone. Refusing to
		// recreate it would drop every agent to a git worktree on the next mux —
		// permanently, until a human deleted the directory by hand.
		const root = source();
		const made = createWorkspace({ root, name: "w" });
		const path = must(made.workspace, "made.workspace").path;
		const base = join(root, RIFT_DIR, "workspaces", "w");
		// Record the removal, then leave the directory behind, as a crash would.
		const journal = join(root, RIFT_DIR, "events.jsonl");
		writeFileSync(
			journal,
			`${readFileSync(journal, "utf8")}${JSON.stringify({ type: "WorkspaceRemoved", at: "2026-08-03T00:00:00.000Z", name: "w" })}\n`,
		);
		expect(readRegistry(root).workspaces).toEqual([]);
		expect(existsSync(base)).toBe(true);

		const retry = createWorkspace({ root, name: "w" });
		expect(retry.reason).toBeUndefined();
		expect(retry.workspace).not.toBeNull();
		expect(existsSync(must(retry.workspace, "retry.workspace").path)).toBe(
			true,
		);
		expect(path).toBeDefined();
	});
});

describe("an externally truncated journal", () => {
	it("is recovered by repair, not silently on every read", () => {
		// appendFileSync never truncates, so this needs external corruption —
		// the zero-length-file-after-power-loss shape. Recovering implicitly
		// would resurrect deliberately removed workspaces, so reads stay
		// journal-authoritative and `repair` is where the operator opts in.
		const root = source();
		createWorkspace({ root, name: "keep" });
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		expect(readRegistry(root).workspaces).toEqual([]);
		expect(rebuildRegistry(root).workspaces.map((w) => w.name)).toEqual([
			"keep",
		]);
		// And the repair is durable — it went back into the journal.
		expect(readRegistry(root).workspaces.map((w) => w.name)).toEqual(["keep"]);
	});

	it("repair does not resurrect a workspace whose directory is gone", () => {
		const root = source();
		const made = createWorkspace({ root, name: "gone" });
		rmSync(join(root, RIFT_DIR, "workspaces", "gone"), {
			recursive: true,
			force: true,
		});
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		expect(rebuildRegistry(root).workspaces).toEqual([]);
		expect(made.workspace).not.toBeNull();
	});

	it("still reports empty when there genuinely are no workspaces", () => {
		const root = source();
		initRoot(root);
		expect(readRegistry(root).workspaces).toEqual([]);
	});
});

describe("create never destroys what it cannot prove is dead", () => {
	it("parks an unrecognised directory instead of deleting it", () => {
		// The registry not listing a name does not prove the directory is dead:
		// a lost journal produces the same state, and the directory then holds
		// an agent's uncommitted work. A multiplexer may call create on every
		// run, so deleting here turns one lost journal into silent, permanent
		// loss of every agent's tree.
		const root = source();
		const made = createWorkspace({ root, name: "claude" });
		const upper =
			must(made.workspace, "made.workspace").upper ??
			must(made.workspace, "made.workspace").path;
		writeFileSync(join(upper, "WORK.txt"), "UNCOMMITTED AGENT WORK\n");
		// Lose the journal, exactly as external truncation would.
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");

		const again = createWorkspace({ root, name: "claude" });
		expect(again.workspace).not.toBeNull();
		expect(again.debris).toBeDefined();
		// The work still exists, at the reported location.
		// SAFETY: `const rescued = join(again.debris as string, "upper", "WORK.txt");` is required at this I/O or test boundary.
		const rescued = join(again.debris as string, "upper", "WORK.txt");
		// SAFETY: `const flat = join(again.debris as string, "WORK.txt");` is required at this I/O or test boundary.
		const flat = join(again.debris as string, "WORK.txt");
		const found = existsSync(rescued) ? rescued : flat;
		expect(existsSync(found)).toBe(true);
		expect(readFileSync(found, "utf8")).toContain("UNCOMMITTED AGENT WORK");
	});

	it("still refuses outright when the registry does list the name", () => {
		const root = source();
		createWorkspace({ root, name: "claude" });
		const again = createWorkspace({ root, name: "claude" });
		expect(again.workspace).toBeNull();
		expect(again.reason).toMatch(/already exists/);
		expect(again.debris).toBeUndefined();
	});
});

describe("repair distinguishes stale from truncated", () => {
	it("does not resurrect a workspace that was deliberately removed", () => {
		// removeWorkspace appends the event, rewrites the snapshot, then deletes.
		// A crash after the append leaves: journal correct, snapshot stale, and
		// the directory surviving — so `existsSync` is not evidence of life, it
		// is the signature of that window.
		const root = source();
		createWorkspace({ root, name: "w" });
		const snapshotPath = join(root, RIFT_DIR, "registry.json");
		const stale = readFileSync(snapshotPath, "utf8");
		const journal = join(root, RIFT_DIR, "events.jsonl");
		writeFileSync(
			journal,
			`${readFileSync(journal, "utf8")}${JSON.stringify({ type: "WorkspaceRemoved", at: "2026-08-03T00:00:00.000Z", name: "w" })}\n`,
		);
		writeFileSync(snapshotPath, stale); // snapshot predates the removal
		expect(readRegistry(root).workspaces).toEqual([]);
		expect(rebuildRegistry(root).workspaces).toEqual([]);
		expect(readRegistry(root).workspaces).toEqual([]);
	});

	it("still restores when the journal was genuinely truncated", () => {
		const root = source();
		createWorkspace({ root, name: "keep" });
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		expect(readRegistry(root).workspaces).toEqual([]);
		expect(rebuildRegistry(root).workspaces.map((w) => w.name)).toEqual([
			"keep",
		]);
	});
});

describe("debris only accumulates when there is work to keep", () => {
	it("does not park an overlayfs skeleton with no files in it", () => {
		// The overlay tier always leaves an upper/work/merged skeleton, so a
		// plain "is the directory empty" test never fires and every repeated
		// run would leave another parked copy behind.
		const capability = {
			tier: "overlayfs",
			available: ["overlayfs"],
			reason: "forced",
			isolatesInPlaceWrites: true,
		} as const;
		const root = source();
		createWorkspace({ root, name: "claude", capability });
		for (let i = 0; i < 3; i += 1) {
			writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
			createWorkspace({ root, name: "claude", capability });
		}
		expect(listDebris(root)).toEqual([]);
	});

	it("parks a copy-tier workspace holding cloned files", () => {
		const capability = {
			tier: "copy",
			available: ["copy"],
			reason: "forced",
			isolatesInPlaceWrites: true,
		} as const;
		const root = source();
		createWorkspace({ root, name: "claude", capability });
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		const again = createWorkspace({ root, name: "claude", capability });
		const parked = must(again.debris, "again.debris");
		expect(listDebris(root)).toEqual([parked]);
		expect(readFileSync(join(parked, "src", "app.ts"), "utf8")).toBe(
			"original content\n",
		);
	});

	it("parks — and can prune — a directory that holds work", () => {
		const root = source();
		const made = createWorkspace({ root, name: "claude" });
		writeFileSync(
			join(made.workspace?.upper ?? made.workspace?.path ?? root, "w.txt"),
			"work",
		);
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		const again = createWorkspace({ root, name: "claude" });
		expect(again.debris).toBeDefined();
		expect(listDebris(root)).toHaveLength(1);
		expect(pruneDebris(root)).toHaveLength(1);
		expect(listDebris(root)).toEqual([]);
	});
});

describe("a root that predates event counting", () => {
	it("declines to guess, and says why, rather than resurrecting", () => {
		const root = source();
		createWorkspace({ root, name: "old" });
		const snapshotPath = join(root, RIFT_DIR, "registry.json");
		const snapshot: JsonBag = {
			...parseJsonObject(readFileSync(snapshotPath, "utf8")),
		};
		writeFileSync(
			snapshotPath,
			JSON.stringify({
				root: snapshot.root,
				workspaces: snapshot.workspaces,
			}),
		);
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");
		const repaired = rebuildRegistry(root);
		expect(repaired.workspaces).toEqual([]);
		expect(repaired.undecidable).toMatch(/predates event counting/);
	});
});

describe("repair leaves evidence intact", () => {
	it("does not overwrite the snapshot it tells the operator to read", () => {
		// registry.json is the only surviving record of a workspace's name, tier
		// and layer paths. Emptying it in the same call that says "go read this
		// file" leaves the root worse off for having run the recovery command.
		const root = source();
		createWorkspace({ root, name: "keep" });
		const snapshotPath = join(root, RIFT_DIR, "registry.json");
		// SAFETY: `const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {` is required at this I/O or test boundary.
		const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
			root: string;
			workspaces: JsonValue[];
		};
		writeFileSync(
			snapshotPath,
			JSON.stringify({ root: snapshot.root, workspaces: snapshot.workspaces }),
		);
		writeFileSync(join(root, RIFT_DIR, "events.jsonl"), "");

		const repaired = rebuildRegistry(root);
		expect(repaired.undecidable).toBeDefined();
		// SAFETY: `const after = JSON.parse(readFileSync(snapshotPath, "utf8")) as {` is required at this I/O or test boundary.
		const after = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
			workspaces: JsonValue[];
		};
		expect(after.workspaces).toHaveLength(1);
	});

	it("labels a restored snapshot with a count that matches the journal", () => {
		// A partial truncation makes the snapshot's list and the journal's
		// length disagree. Persisting one labelled with the other poisons the
		// discriminator: a later genuine truncation would restore from a count
		// that never described those workspaces.
		const root = source();
		createWorkspace({ root, name: "alpha" });
		createWorkspace({ root, name: "beta" });
		removeWorkspace(root, "alpha");
		const journal = join(root, RIFT_DIR, "events.jsonl");
		const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
		writeFileSync(journal, `${lines.slice(0, 3).join("\n")}\n`);

		const repaired = rebuildRegistry(root);
		// SAFETY: `const persisted = JSON.parse(` is required at this I/O or test boundary.
		const persisted = JSON.parse(
			readFileSync(join(root, RIFT_DIR, "registry.json"), "utf8"),
		) as { workspaces: JsonValue[]; eventCount: number };
		// What repair reports, what list would report, and what the snapshot
		// claims to be folded from must all be the same thing.
		expect(persisted.workspaces).toHaveLength(repaired.workspaces.length);
		expect(persisted.eventCount).toBe(
			readFileSync(journal, "utf8").split("\n").filter(Boolean).length,
		);
		expect(readRegistry(root).workspaces).toHaveLength(
			repaired.workspaces.length,
		);
	});
});

describe("two creates racing on one name", () => {
	it("lets exactly one through while the other is in flight", () => {
		const root = source();
		// A live claim is what an in-flight create holds; the clone can take
		// seconds on a large tree, and both processes would otherwise see
		// "no such workspace" and copy into the same destination.
		const claim = join(root, RIFT_DIR, "workspaces", ".claude.claim");
		mkdirSync(join(root, RIFT_DIR, "workspaces"), { recursive: true });
		writeFileSync(claim, `${process.ppid}\n`);
		const blocked = createWorkspace({ root, name: "claude" });
		expect(blocked.workspace).toBeNull();
		expect(blocked.reason).toMatch(/another process is creating/);
	});

	it("takes over a claim whose holder is gone", () => {
		// Otherwise a create that died wedges the name forever — the failure
		// mode this package keeps re-learning.
		const root = source();
		const claim = join(root, RIFT_DIR, "workspaces", ".claude.claim");
		mkdirSync(join(root, RIFT_DIR, "workspaces"), { recursive: true });
		writeFileSync(claim, "2147483646\n"); // no such pid
		const made = createWorkspace({ root, name: "claude" });
		expect(made.workspace).not.toBeNull();
		expect(existsSync(claim)).toBe(false);
	});
});

describe("exec reassembles its argv without losing quoting", () => {
	// Against the BUILT BIN, not a helper. The defect was in
	// `src/bin/hobo-rift.ts` joining argv with spaces, so a test that maps
	// shellQuote itself would pass with the bug restored.
	const bin = join(here, "..", "dist", "bin", "hobo-rift.js");

	function printCmd(
		root: string,
		name: string,
		argv: readonly string[],
	): string {
		const r = spawnSync(
			process.execPath,
			[
				bin,
				"exec",
				"--root",
				root,
				"--name",
				name,
				"--print-cmd",
				"--",
				...argv,
			],
			{ encoding: "utf8" },
		);
		return `${r.stdout}${r.stderr}`;
	}

	it("keeps a path containing a space as one argument", () => {
		const root = source();
		createWorkspace({ root, name: "a" });
		const out = printCmd(root, "a", [
			"cmd",
			"--workspace",
			"/ws/my repo/merged",
		]);
		expect(out).toContain("'/ws/my repo/merged'");
	});

	it("neutralises a path that would otherwise execute", () => {
		// A directory named `pj;touch $SP` ran `touch` — a real binary, in the
		// namespace — before the workspace command ran at all.
		const root = source();
		createWorkspace({ root, name: "b" });
		const out = printCmd(root, "b", [
			"cmd",
			"--workspace",
			"/tmp/pj;touch $SP/x",
		]);
		expect(out).toContain("'/tmp/pj;touch $SP/x'");
	});

	it("runs a vector as a vector, not as a snippet", () => {
		// The filename contains a space, so a bin that joins argv splits it into
		// two nonexistent files. Without that, the assertion passes either way.
		const root = source();
		writeFileSync(join(root, "my marker.txt"), "vector-ok\n");
		createWorkspace({ root, name: "c" });
		const r = spawnSync(
			process.execPath,
			[
				bin,
				"exec",
				"--root",
				root,
				"--name",
				"c",
				"--",
				"cat",
				"my marker.txt",
			],
			{ encoding: "utf8" },
		);
		expect(r.stdout).toContain("vector-ok");
	});

	it("--shell still takes a snippet", () => {
		const root = source();
		createWorkspace({ root, name: "d" });
		const r = spawnSync(
			process.execPath,
			[
				bin,
				"exec",
				"--root",
				root,
				"--name",
				"d",
				"--shell",
				"echo one; echo two",
			],
			{ encoding: "utf8" },
		);
		expect(r.stdout).toContain("one");
		expect(r.stdout).toContain("two");
	});

	it("refuses when given neither form", () => {
		const root = source();
		createWorkspace({ root, name: "e" });
		const r = spawnSync(
			process.execPath,
			[bin, "exec", "--root", root, "--name", "e"],
			{
				encoding: "utf8",
			},
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/--shell/u);
	});
});

describe("the namespace announces itself", () => {
	it("sets a marker a process inside can read", () => {
		// Without it, a caller that also passes `--tier overlayfs --source …`
		// would mount the SHARED source from inside the namespace and hand the
		// agent every other agent's tree. The marker is what lets that be
		// refused instead of documented.
		const cmd = execCommand(
			{
				name: "claude",
				path: "/ws/merged",
				tier: "overlayfs",
				source: "/src",
				upper: "/ws/upper",
				work: "/ws/work",
				createdAt: "",
			},
			"agent",
		);
		// The outer sh -c wrapping re-escapes the quotes, so assert on the
		// variable and its value rather than on a literal quoted form.
		expect(cmd).toContain("HOBO_RIFT_WORKSPACE=");
		expect(cmd).toMatch(/HOBO_RIFT_WORKSPACE=\S*claude/u);
	});

	it("does not set it for directory-backed tiers, which have no namespace", () => {
		const cmd = execCommand(
			{ name: "c", path: "/ws/c", tier: "copy", source: "/src", createdAt: "" },
			"agent",
		);
		expect(cmd).not.toContain("HOBO_RIFT_WORKSPACE");
	});
});

describe("the advertised contract is measured, not asserted", () => {
	it("reports what the code actually does", () => {
		const contract = deriveContract();
		expect(contract.execArgvVector).toBe(true);
		expect(contract.namespaceMarker).toBe(true);
	});

	it("is derived from the same functions a caller depends on", () => {
		// The point of deriving rather than hardcoding: a refactor that stops
		// quoting the vector, or drops the marker, flips the flag by
		// construction. A constant would keep reading `true` and the guard would
		// catch only *old* sidecars, never regressed ones — the likelier failure.
		expect(quoteVector(["a b"])).toBe("'a b'");
		expect(quoteVector(["x", "y z"])).toBe("'x' 'y z'");
		const overlay = {
			name: "probe",
			path: "/p/merged",
			tier: "overlayfs" as const,
			source: "/p/src",
			upper: "/p/upper",
			work: "/p/work",
			createdAt: "",
		};
		expect(execCommand(overlay, "x")).toContain("HOBO_RIFT_WORKSPACE=");
		// Both flags trace to these two observations and nothing else.
		expect(deriveContract()).toEqual({
			execArgvVector: quoteVector(["a b"]) === "'a b'",
			namespaceMarker: execCommand(overlay, "x").includes(
				"HOBO_RIFT_WORKSPACE=",
			),
		});
	});

	it("the CLI advertises the derived values", () => {
		const bin = join(here, "..", "dist", "bin", "hobo-rift.js");
		const r = spawnSync(process.execPath, [bin, "capability", "--json"], {
			encoding: "utf8",
		});
		// SAFETY: `const advertised = JSON.parse(r.stdout) as { contract?: unknown };` is required at this I/O or test boundary.
		const advertised = JSON.parse(r.stdout) as { contract?: unknown };
		expect(advertised.contract).toEqual(deriveContract());
	});
});
