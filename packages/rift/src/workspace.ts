/**
 * Virtual worktrees, built on whatever this machine can actually do.
 *
 * A workspace is a directory an agent can work in without disturbing the
 * source. How it is produced depends on the tier (see capability.ts):
 *
 * - reflink / hardlink / copy → a real directory on disk, ready to `cd` into.
 * - overlayfs → layers on disk plus a merged path that only exists inside a
 *   mount namespace, so the caller runs commands through `exec`.
 *
 * Regenerable artifacts (node_modules, target, dist, .venv, caches) are
 * excluded by default, matching rift: they are the bulk of the bytes and the
 * cheapest thing to rebuild. `--copy-all` keeps them.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	type Capability,
	type CowTier,
	detectCapability,
	type RiftContract,
} from "./capability.js";
import {
	appendEvent,
	journalPath,
	projectWorkspaces,
	readEvents,
	type WorkspaceEvent,
} from "./journal.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	parseJsonValue,
} from "./json.js";
import { parseWorkspaceName, type WorkspaceName } from "./names.js";

// public-contract: marker identifying a registered rift root.
export const RIFT_DIR = ".hobo-rift";

/** Bulk that rebuilds itself; excluded unless the caller asks for everything. */
export const REGENERABLE = [
	"node_modules",
	"target",
	"dist",
	"build",
	"coverage",
	".venv",
	".turbo",
	".next",
	".cache",
] as const;

// Carries a branded WorkspaceName (names.ts) and overlay layers present only
// for the overlay tier — neither of which proto3 can express.
// domain-view: wire form is hobo.rift.v1.WorkspaceRecord; src/wire.ts converts.
export interface WorkspaceRecord {
	readonly name: string;
	readonly path: string;
	readonly tier: CowTier;
	readonly source: string;
	/** Overlay layers, when the tier needs them. */
	readonly upper?: string;
	readonly work?: string;
	readonly createdAt: string;
}

// Holds the derived WorkspaceRecord above rather than the generated one.
// domain-view: wire form is hobo.rift.v1.Registry; src/wire.ts converts.
export interface Registry {
	readonly root: string;
	readonly workspaces: readonly WorkspaceRecord[];
	/**
	 * How many journal events this snapshot was folded from.
	 *
	 * Without it, a stale snapshot and a newer one look identical, and
	 * `repair` cannot tell "the journal was truncated, restore from the
	 * snapshot" from "the snapshot predates a removal, ignore it". `existsSync`
	 * on the workspace path cannot discriminate: a surviving directory is the
	 * *signature* of a crash between recording a removal and performing it.
	 */
	readonly eventCount?: number;
}

export class RiftRegistryError extends Error {}

function registryPath(root: string): string {
	return join(root, RIFT_DIR, "registry.json");
}

function repairBackupPath(root: string): string {
	return join(root, RIFT_DIR, "registry.repair-backup.json");
}

function requireNoUnfinishedRepair(root: string): void {
	const backup = repairBackupPath(root);
	if (existsSync(backup)) {
		throw new RiftRegistryError(
			`unfinished workspace repair left a backup at ${backup}; inspect it before continuing`,
		);
	}
}

function riftDir(root: string): string {
	return join(root, RIFT_DIR);
}

/**
 * Current workspaces, projected from the journal.
 *
 * The journal is the authority, always. An earlier version preferred
 * `registry.json` whenever it *parsed*, which is wrong in the exact window
 * `record()` creates: the event is appended and the snapshot rewritten as two
 * steps, so a crash between them leaves a snapshot that is stale but perfectly
 * valid — and preferring it made a real workspace invisible to `list`, `exec`
 * and `remove` until someone thought to run `repair`. The snapshot is a
 * convenience for other readers, not a source of truth; the journal is small
 * enough that reading it is not worth being wrong over.
 */
export function readRegistry(root: string): Registry {
	const abs = resolve(root);
	requireNoUnfinishedRepair(abs);
	const dir = riftDir(abs);
	if (existsSync(journalPath(dir))) {
		// Authoritative, including when it projects to empty: "everything was
		// removed" and "nothing was ever created" are both legitimate. Falling
		// back to the snapshot here would resurrect removed workspaces, which
		// is worse than the truncation it would guard against — recovery from a
		// lost journal is `repair`'s job, where an operator asked for it.
		const events = readEvents(dir);
		return {
			root: abs,
			workspaces: projectWorkspaces(events),
			eventCount: events.length,
		};
	}
	if (existsSync(registryPath(abs))) {
		throw new RiftRegistryError(
			`workspace journal missing at ${journalPath(dir)}; run hobo-rift repair`,
		);
	}
	return { root: abs, workspaces: [], eventCount: 0 };
}

/** Does this tree hold any file at all? Directories alone carry no work. */
function containsFile(dir: string): boolean {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (containsFile(join(dir, entry.name))) return true;
		} else {
			return true;
		}
	}
	return false;
}

/** Parked directories awaiting an operator's attention. */
export function listDebris(root: string): readonly string[] {
	const dir = join(resolve(root), RIFT_DIR, "workspaces");
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((e) => e.includes(".debris"))
			.map((e) => join(dir, e));
	} catch {
		return [];
	}
}

/** Delete every parked directory. Explicit, because they hold real work. */
export function pruneDebris(root: string): readonly string[] {
	const parked = listDebris(root);
	for (const path of parked) rmSync(path, { recursive: true, force: true });
	return parked;
}

/**
 * Reconcile journal and snapshot. Exposed as `hobo-rift repair`.
 *
 * Normally this just rewrites the snapshot from the journal. When the journal
 * is empty but the snapshot is not — external truncation, the classic
 * zero-length-file-after-power-loss shape, since `appendFileSync` never
 * truncates on its own — it replays the snapshot back into the journal instead,
 * so workspaces that still exist on disk stop being orphans. That direction is
 * deliberately only available here, where an operator asked for it: doing it
 * implicitly on every read would resurrect deliberately removed workspaces.
 */
export interface RepairResult extends Registry {
	/** Set when repair declined to act and the operator needs to decide. */
	readonly undecidable?: string;
}

export function rebuildRegistry(root: string): RepairResult {
	const abs = resolve(root);
	requireNoUnfinishedRepair(abs);
	const dir = riftDir(abs);
	const events = readEvents(dir);
	const projected = projectWorkspaces(events);
	const snapshot = readSnapshotRegistry(abs);
	// Restore only when the snapshot demonstrably saw *more* history than the
	// journal now holds — that is truncation. A snapshot written before the
	// last event is merely stale, and restoring from it would resurrect a
	// workspace someone removed on purpose, written into the append-only
	// journal where it could never be told from a real creation.
	const truncated =
		snapshot !== null &&
		isJsonNumber(snapshot.eventCount) &&
		snapshot.eventCount > events.length;
	if (truncated) {
		mkdirSync(dir, { recursive: true });
		copyFileSync(
			registryPath(abs),
			repairBackupPath(abs),
			constants.COPYFILE_EXCL,
		);
		if (!existsSync(journalPath(dir)))
			writeFileSync(journalPath(dir), "", { flag: "a" });
		const surviving = snapshot.workspaces.filter((w) => existsSync(w.path));
		const names = new Set(surviving.map((workspace) => workspace.name));
		for (const workspace of projected) {
			if (!names.has(workspace.name))
				appendEvent(dir, {
					type: "WorkspaceRemoved",
					at: new Date().toISOString(),
					name: workspace.name,
				});
		}
		for (const workspace of surviving) {
			appendEvent(dir, {
				type: "WorkspaceCreated",
				at: workspace.createdAt,
				workspace,
			});
		}
		// Persist what the journal now says, not what the snapshot said. Under a
		// *partial* truncation those differ, and labelling the snapshot's list
		// with the journal's length poisons the discriminator itself: a later
		// genuine truncation would then restore from a count that never
		// described those workspaces, silently dropping the ones it omits.
		const after = readEvents(dir);
		const restored: Registry = {
			root: abs,
			workspaces: projectWorkspaces(after),
			eventCount: after.length,
		};
		if (!sameWorkspaces(restored.workspaces, surviving))
			throw new RiftRegistryError(
				`workspace repair could not verify the restored journal; backup left at ${repairBackupPath(abs)}`,
			);
		writeRegistry(restored);
		refuseRegistryWorkspaceDrop(restored);
		rmSync(repairBackupPath(abs));
		return restored;
	}
	if (
		snapshot !== null &&
		snapshot.eventCount === events.length &&
		!sameWorkspaces(snapshot.workspaces, projected)
	) {
		return {
			root: abs,
			workspaces: projected,
			eventCount: events.length,
			undecidable: `the snapshot and journal have the same event count but different workspaces — ${registryPath(abs)} has been left untouched; inspect both before continuing`,
		};
	}
	// A root written before snapshots carried `eventCount` cannot be judged:
	// its snapshot might be a truncation survivor, or might merely predate a
	// removal. Declining is the safe half of that choice, but saying nothing
	// would leave an operator staring at workspaces that exist on disk and
	// nowhere else.
	if (
		snapshot !== null &&
		snapshot.workspaces.length > 0 &&
		!isJsonNumber(snapshot.eventCount) &&
		snapshot.workspaces.some(
			(workspace) =>
				!projected.some((candidate) => sameWorkspace(workspace, candidate)),
		)
	) {
		// Leave the snapshot alone. It is the only surviving record of those
		// workspaces' names, tiers and layer paths, and overwriting it with an
		// empty list in the same call that says "go read this file" would leave
		// the root strictly worse off for having run the recovery command.
		return {
			root: abs,
			workspaces: projected,
			...(isJsonNumber(snapshot.eventCount)
				? { eventCount: snapshot.eventCount }
				: undefined),
			undecidable: `the snapshot lists ${snapshot.workspaces.length} workspace(s) but predates event counting, so it cannot be told from one that simply predates a removal — ${registryPath(abs)} has been left untouched; inspect it and recreate what you still want`,
		};
	}
	mkdirSync(dir, { recursive: true });
	if (!existsSync(journalPath(dir)))
		writeFileSync(journalPath(dir), "", { flag: "a" });
	const registry: Registry = {
		root: abs,
		workspaces: projected,
		eventCount: events.length,
	};
	writeRegistry(registry);
	return registry;
}

function sameWorkspace(a: WorkspaceRecord, b: WorkspaceRecord): boolean {
	return (
		a.name === b.name &&
		a.path === b.path &&
		a.source === b.source &&
		a.tier === b.tier &&
		a.createdAt === b.createdAt &&
		a.upper === b.upper &&
		a.work === b.work
	);
}

function sameWorkspaces(
	a: readonly WorkspaceRecord[],
	b: readonly WorkspaceRecord[],
): boolean {
	return (
		a.length === b.length &&
		a.every((workspace) =>
			b.some((candidate) => sameWorkspace(workspace, candidate)),
		)
	);
}

function registryForWrite(root: string): Registry {
	const registry = readRegistry(root);
	const snapshot = readSnapshotRegistry(root);
	if (
		snapshot &&
		((isJsonNumber(snapshot.eventCount) &&
			snapshot.eventCount > (registry.eventCount ?? 0)) ||
			(snapshot.eventCount === registry.eventCount &&
				!sameWorkspaces(snapshot.workspaces, registry.workspaces)) ||
			(!isJsonNumber(snapshot.eventCount) &&
				snapshot.workspaces.some(
					(workspace) =>
						!registry.workspaces.some((candidate) =>
							sameWorkspace(workspace, candidate),
						),
				)))
	)
		throw new RiftRegistryError(
			`workspace snapshot may contain newer work at ${registryPath(root)}; run hobo-rift repair`,
		);
	return registry;
}

function readSnapshotRegistry(root: string): Registry | null {
	return readSnapshotFile(registryPath(root), root, false);
}

function tryReadSnapshotFile(file: string, root: string): Registry | null {
	return readSnapshotFile(file, root, true);
}

function readSnapshotFile(
	file: string,
	root: string,
	lenient: boolean,
): Registry | null {
	if (!existsSync(file)) return null;
	try {
		const snapshot = parseJsonValue(readFileSync(file, "utf8"));
		if (
			!isJsonObject(snapshot) ||
			!isJsonString(snapshot.root) ||
			snapshot.root !== root ||
			!Array.isArray(snapshot.workspaces) ||
			(snapshot.eventCount !== undefined &&
				(!isJsonNumber(snapshot.eventCount) ||
					!Number.isSafeInteger(snapshot.eventCount) ||
					snapshot.eventCount < snapshot.workspaces.length ||
					snapshot.eventCount > 4294967295)) ||
			Object.keys(snapshot).some(
				(key) => !["root", "workspaces", "eventCount"].includes(key),
			)
		)
			throw new TypeError("invalid snapshot");
		const names = new Set<string>();
		const workspaces = snapshot.workspaces.map((record): WorkspaceRecord => {
			if (!isJsonObject(record)) throw new TypeError("invalid workspace");
			const name = isJsonString(record.name)
				? parseWorkspaceName(record.name)
				: undefined;
			if (
				!isJsonString(record.name) ||
				!name?.ok ||
				name.value !== record.name ||
				names.has(record.name) ||
				!isJsonString(record.path) ||
				!record.path ||
				!isJsonString(record.source) ||
				!record.source ||
				!isJsonString(record.createdAt) ||
				!record.createdAt ||
				(record.tier !== "reflink" &&
					record.tier !== "overlayfs" &&
					record.tier !== "hardlink" &&
					record.tier !== "copy") ||
				(record.upper !== undefined && !isJsonString(record.upper)) ||
				(record.work !== undefined && !isJsonString(record.work)) ||
				(record.tier === "overlayfs" && (!record.upper || !record.work)) ||
				Object.keys(record).some(
					(key) =>
						![
							"name",
							"path",
							"source",
							"tier",
							"createdAt",
							"upper",
							"work",
						].includes(key),
				)
			)
				throw new TypeError("invalid workspace");
			names.add(record.name);
			return {
				name: record.name,
				path: record.path,
				source: record.source,
				tier: record.tier,
				createdAt: record.createdAt,
				...(isJsonString(record.upper) ? { upper: record.upper } : undefined),
				...(isJsonString(record.work) ? { work: record.work } : undefined),
			};
		});
		return {
			root: snapshot.root,
			workspaces,
			...(isJsonNumber(snapshot.eventCount)
				? { eventCount: snapshot.eventCount }
				: undefined),
		};
	} catch {
		if (lenient) return null;
		throw new RiftRegistryError(
			`invalid workspace snapshot at ${file}; file left untouched`,
		);
	}
}

/** Append a creation event and refresh the snapshot. */
function recordCreated(root: string, workspace: WorkspaceRecord): void {
	record(root, {
		type: "WorkspaceCreated",
		at: workspace.createdAt,
		workspace,
	});
}

/** Append the event, then refresh the snapshot it projects to. */
function record(root: string, event: WorkspaceEvent): void {
	const dir = riftDir(root);
	const events = readEvents(dir);
	const projected = [...events, event];
	const registry: Registry = {
		root,
		workspaces: projectWorkspaces(projected),
		eventCount: projected.length,
	};
	refuseRegistryWorkspaceDrop(registry, projected);
	appendEvent(dir, event);
	writeRegistry(registry);
}

function snapshotSources(root: string): Registry[] {
	const sources: Registry[] = [];
	const current = tryReadSnapshotFile(registryPath(root), root);
	const backup = tryReadSnapshotFile(repairBackupPath(root), root);
	if (current) sources.push(current);
	if (backup) sources.push(backup);
	return sources;
}

function droppedWorkspaceNames(registry: Registry): string[] {
	const dropped: string[] = [];
	const seen = new Set<string>();
	for (const source of snapshotSources(registry.root)) {
		for (const workspace of source.workspaces) {
			if (
				registry.workspaces.some((candidate) =>
					sameWorkspace(workspace, candidate),
				) ||
				seen.has(workspace.name)
			)
				continue;
			seen.add(workspace.name);
			dropped.push(workspace.name);
		}
	}
	return dropped;
}

function completingVerifiedTruncatedRepair(registry: Registry): boolean {
	const backup = tryReadSnapshotFile(
		repairBackupPath(registry.root),
		registry.root,
	);
	if (!backup) return false;
	const surviving = backup.workspaces.filter((workspace) =>
		existsSync(workspace.path),
	);
	return sameWorkspaces(registry.workspaces, surviving);
}

function suffixAuthorizesWorkspaceChange(
	events: readonly WorkspaceEvent[],
	eventCount: number,
	original: WorkspaceRecord,
	current: WorkspaceRecord | undefined,
): boolean {
	let removed = false;
	let created: WorkspaceRecord | undefined;
	for (const event of events.slice(eventCount)) {
		if (event.type === "WorkspaceRemoved" && event.name === original.name) {
			removed = true;
			created = undefined;
		} else if (
			event.type === "WorkspaceCreated" &&
			event.workspace.name === original.name
		) {
			if (!removed) {
				if (!sameWorkspace(event.workspace, original)) return false;
				continue;
			}
			if (created && !sameWorkspace(created, event.workspace)) return false;
			created = event.workspace;
		}
	}
	return (
		removed &&
		(current
			? created !== undefined && sameWorkspace(created, current)
			: created === undefined)
	);
}

function journalAuthorizesWorkspaceDrops(
	registry: Registry,
	dropped: readonly string[],
	events: readonly WorkspaceEvent[],
): boolean {
	if (registry.eventCount !== events.length) return false;
	if (!sameWorkspaces(registry.workspaces, projectWorkspaces(events)))
		return false;
	return dropped.every((name) => {
		const current = registry.workspaces.find(
			(workspace) => workspace.name === name,
		);
		const sources = snapshotSources(registry.root).flatMap((source) => {
			const original = source.workspaces.find(
				(workspace) =>
					workspace.name === name &&
					(!current || !sameWorkspace(workspace, current)),
			);
			return original ? [{ source, original }] : [];
		});
		return (
			sources.length > 0 &&
			sources.every(({ source, original }) =>
				suffixAuthorizesWorkspaceChange(
					events,
					isJsonNumber(source.eventCount) ? source.eventCount : 0,
					original,
					current,
				),
			)
		);
	});
}

function refuseRegistryWorkspaceDrop(
	registry: Registry,
	events: readonly WorkspaceEvent[] = readEvents(riftDir(registry.root)),
): void {
	const dropped = droppedWorkspaceNames(registry);
	if (dropped.length === 0) return;
	if (completingVerifiedTruncatedRepair(registry)) return;
	if (journalAuthorizesWorkspaceDrops(registry, dropped, events)) return;
	throw new RiftRegistryError(
		`refusing to write ${registryPath(registry.root)}; it would drop workspace(s) ${dropped.join(", ")}`,
	);
}

function writeRegistry(registry: Registry): void {
	refuseRegistryWorkspaceDrop(registry);
	mkdirSync(join(registry.root, RIFT_DIR), { recursive: true });
	writeFileSync(
		registryPath(registry.root),
		`${JSON.stringify(registry, null, 2)}\n`,
		"utf8",
	);
}

interface RootInitResult {
	root: string;
	created: boolean;
}

export function initRoot(root: string): RootInitResult {
	const abs = resolve(root);
	const created = !existsSync(join(abs, RIFT_DIR));
	mkdirSync(join(abs, RIFT_DIR, "workspaces"), { recursive: true });
	if (created) {
		writeRegistry({ root: abs, workspaces: [], eventCount: 0 });
		record(abs, {
			type: "RootInitialized",
			at: new Date().toISOString(),
			root: abs,
		});
	}
	return { root: abs, created };
}

/** Entries to clone, honouring the regenerable-artifact exclusion. */
export function entriesToClone(
	source: string,
	copyAll: boolean,
	list: (dir: string) => string[] = (d) => readdirSync(d),
): string[] {
	return list(source).filter((entry) => {
		if (entry === RIFT_DIR) return false;
		if (copyAll) return true;
		// SAFETY: `return !REGENERABLE.includes(entry as (typeof REGENERABLE)[number]);` is required at this I/O or test boundary.
		return !REGENERABLE.includes(entry as (typeof REGENERABLE)[number]);
	});
}

function cloneArgs(tier: CowTier): string[] {
	if (tier === "reflink") return ["-a", "--reflink=always"];
	if (tier === "hardlink") return ["-al"];
	return ["-a"];
}

export interface CreateOptions {
	readonly root: string;
	readonly name: string;
	readonly copyAll?: boolean;
	readonly capability?: Capability;
}

export interface CreateResult {
	readonly workspace: WorkspaceRecord | null;
	readonly reason?: string;
	/** Where an unrecognised directory was moved, when one was in the way. */
	readonly debris?: string;
}

export function createWorkspace(options: CreateOptions): CreateResult {
	const root = resolve(options.root);
	let debris: string | null = null;
	let claim: string | null = null;
	// Parse before the name is ever joined onto a path: an unchecked name is a
	// traversal primitive, not just bad input.
	const parsed = parseWorkspaceName(options.name);
	if (!parsed.ok) {
		return {
			workspace: null,
			reason: `invalid workspace name: ${parsed.reason}`,
		};
	}
	const name: WorkspaceName = parsed.value;
	if (!existsSync(join(root, RIFT_DIR))) initRoot(root);
	registryForWrite(root);
	// Claim the name before looking at the directory. Without this, two
	// concurrent creates both see "no such workspace", and the second parks or
	// recreates the tree the first is still copying into — two `cp -a` runs
	// racing on the same destination can leave a file truncated. O_EXCL makes
	// the claim atomic on every filesystem we target.
	const claimed = claimName(root, name);
	if (claimed === null) {
		return {
			workspace: null,
			reason: `another process is creating "${name}" (stale? remove ${claimPath(root, name)})`,
		};
	}
	claim = claimed;
	const release = () => {
		if (claim) rmSync(claim, { force: true });
		claim = null;
	};
	const capability = options.capability ?? detectCapability(root);
	const base = join(root, RIFT_DIR, "workspaces", name);
	if (existsSync(base)) {
		const live = readRegistry(root).workspaces.some((w) => w.name === name);
		if (live) {
			release();
			return { workspace: null, reason: `workspace "${name}" already exists` };
		}
		// The registry does not list it, so it is almost certainly debris from a
		// crash. "Almost certainly" is not good enough to delete: the same state
		// arises from a lost journal (where the directory holds an agent's
		// uncommitted work) and from a clone another process is still running.
		// A multiplexer may call create on every run, so deleting here would turn
		// one lost journal into silent, irreversible loss of every agent's tree.
		// Move it aside instead — recovery stays possible and costs a rename.
		const parked = parkDebris(base);
		if (parked === null && existsSync(base)) {
			release();
			return {
				workspace: null,
				reason: `"${name}" has a directory the registry does not list, and it could not be moved aside`,
			};
		}
		debris = parked;
	}
	// Intent first: the filesystem work below can take seconds and can die.
	record(root, {
		type: "WorkspaceCreating",
		at: new Date().toISOString(),
		name,
		path: base,
	});

	if (capability.tier === "overlayfs") {
		// The merged view only exists inside a mount namespace, so we lay down
		// the layers now and mount them per-exec.
		const upper = join(base, "upper");
		const work = join(base, "work");
		const merged = join(base, "merged");
		for (const dir of [upper, work, merged])
			mkdirSync(dir, { recursive: true });
		const made: WorkspaceRecord = {
			name,
			path: merged,
			tier: "overlayfs",
			source: root,
			upper,
			work,
			createdAt: new Date().toISOString(),
		};
		recordCreated(root, made);
		release();
		return debris ? { workspace: made, debris } : { workspace: made };
	}

	mkdirSync(base, { recursive: true });
	for (const entry of entriesToClone(root, options.copyAll === true)) {
		const copied = spawnSync(
			"cp",
			[...cloneArgs(capability.tier), join(root, entry), join(base, entry)],
			{ stdio: "ignore" },
		);
		if (copied.status !== 0) {
			rmSync(base, { recursive: true, force: true });
			release();
			return {
				workspace: null,
				reason: `clone failed for "${entry}" using ${capability.tier}`,
			};
		}
	}
	const made: WorkspaceRecord = {
		name,
		path: base,
		tier: capability.tier,
		source: root,
		createdAt: new Date().toISOString(),
	};
	recordCreated(root, made);
	release();
	return debris ? { workspace: made, debris } : { workspace: made };
}

function claimPath(root: string, name: string): string {
	return join(resolve(root), RIFT_DIR, "workspaces", `.${name}.claim`);
}

/** Atomically claim a name; null when another process holds it. */
function claimName(root: string, name: string): string | null {
	const path = claimPath(root, name);
	mkdirSync(join(resolve(root), RIFT_DIR, "workspaces"), { recursive: true });
	try {
		// wx: fail if it exists. The atomicity is the whole point.
		writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
		return path;
	} catch {
		// A create that died leaves its claim behind. Blocking the name forever
		// on a dead process would be the wedge this package keeps re-learning,
		// so take the claim over when nobody holds it.
		if (!claimHolderAlive(path)) {
			try {
				rmSync(path, { force: true });
				writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
				return path;
			} catch {
				return null;
			}
		}
		return null;
	}
}

/** Is the process that wrote this claim still running? */
function claimHolderAlive(path: string): boolean {
	let pid: number;
	try {
		pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid <= 0) return false;
	if (pid === process.pid) return false;
	try {
		// Signal 0 tests for existence without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to another user — still alive.
		// SAFETY: `return (error as NodeJS.ErrnoException).code === "EPERM";` is required at this I/O or test boundary.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Move an unrecognised workspace directory out of the way, without deleting it.
 * Returns the new path, or null if it could not be moved.
 */
function parkDebris(base: string): string | null {
	// A directory with no files in it holds nothing to preserve, and parking it
	// would only accumulate clutter — the overlay tier always leaves an
	// upper/work/merged skeleton, so a plain "is it empty" test never fires.
	// Anything containing a file is kept, whatever it is.
	try {
		if (!containsFile(base)) {
			rmSync(base, { recursive: true, force: true });
			return null;
		}
	} catch {
		/* unreadable — fall through and park it rather than guess */
	}
	for (let n = 0; n < 1000; n += 1) {
		const target = `${base}.debris${n === 0 ? "" : `-${n}`}`;
		if (existsSync(target)) continue;
		try {
			renameSync(base, target);
			return target;
		} catch {
			return null;
		}
	}
	return null;
}

export function removeWorkspace(root: string, name: string): boolean {
	const abs = resolve(root);
	const parsed = parseWorkspaceName(name);
	if (!parsed.ok) return false;
	const registry = registryForWrite(abs);
	const existing = registry.workspaces.find((w) => w.name === parsed.value);
	const base = join(abs, RIFT_DIR, "workspaces", parsed.value);
	// Record the removal before deleting: a crash mid-rm then leaves debris
	// that `create` can clear, rather than a workspace the registry still
	// advertises and `exec` cannot enter.
	record(abs, {
		type: "WorkspaceRemoved",
		at: new Date().toISOString(),
		name: parsed.value,
	});
	if (existsSync(base)) rmSync(base, { recursive: true, force: true });
	return existing !== undefined;
}

/**
 * POSIX single-quoting. `JSON.stringify` looks close enough and is not: it
 * produces double quotes, inside which `$`, backticks and backslashes are
 * still interpreted by the shell.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Escape a path for use inside a mount option list.
 *
 * `-o` options are comma-separated and `key=value` colon-separated, so a path
 * containing either has to be backslash-escaped or the kernel sees a different
 * option list than intended. A space simply split the argument and the mount
 * failed outright.
 */
export function escapeMountPath(path: string): string {
	return path.replace(/([\\,:])/gu, "\\$1");
}

/**
 * Build the command that runs `command` inside a workspace.
 *
 * For directory-backed tiers this is just a `cd`. For overlayfs it enters a
 * user namespace, mounts the overlay, and execs — which is what makes the
 * isolation real without needing root.
 */
/**
 * What this build actually guarantees, measured rather than declared.
 *
 * Each field runs the code path it describes: a refactor that stops quoting the
 * vector, or drops the namespace marker, flips the flag by construction. A
 * hardcoded `true` would keep advertising a contract the build no longer
 * honours, which is the regression a caller cannot otherwise detect.
 */
export function deriveContract(): RiftContract {
	const overlay: WorkspaceRecord = {
		name: "probe",
		path: "/probe/merged",
		tier: "overlayfs",
		source: "/probe/src",
		upper: "/probe/upper",
		work: "/probe/work",
		createdAt: "",
	};
	return {
		execArgvVector: quoteVector(["a b"]) === "'a b'",
		namespaceMarker: execCommand(overlay, "x").includes("HOBO_RIFT_WORKSPACE="),
	};
}

/** Quote an argv vector for reassembly into a shell command. */
export function quoteVector(argv: readonly string[]): string {
	return argv.map((a) => shellQuote(a)).join(" ");
}

export function execCommand(record: WorkspaceRecord, command: string): string {
	if (record.tier !== "overlayfs") {
		return `cd ${shellQuote(record.path)} && ${command}`;
	}
	const options = [
		`lowerdir=${escapeMountPath(record.source)}`,
		`upperdir=${escapeMountPath(record.upper ?? "")}`,
		`workdir=${escapeMountPath(record.work ?? "")}`,
	].join(",");
	const mount = `mount -t overlay overlay -o ${shellQuote(options)} ${shellQuote(record.path)}`;
	// Every step is joined with `&&`, and the caller's command is `exec`d as a
	// nested `sh -c` so that a compound command cannot partially run when the
	// mount fails. A `;` here is a data-loss bug, not a style choice: with an
	// unmounted workspace the agent's command would run in whatever directory
	// the shell happened to be in — outside the isolation entirely.
	// The whole source is the lower layer, so the merged view would otherwise
	// expose `.hobo-rift/workspaces/<every other agent>/upper` — one agent
	// reading (and with the upper layer, effectively watching) another's work.
	// An empty tmpfs over that path hides it inside this namespace only.
	const hide = `mkdir -p ${shellQuote(join(record.path, RIFT_DIR))} && mount -t tmpfs none ${shellQuote(join(record.path, RIFT_DIR))}`;
	// Mark the namespace. A process inside it sees the merged path as real, so
	// a caller that also passes `--tier overlayfs --source …` would mount the
	// SHARED source instead of this workspace — silent cross-agent access,
	// which is the collision rift exists to prevent. The marker lets that be
	// refused rather than left to documentation.
	const marked = `HOBO_RIFT_WORKSPACE=${shellQuote(record.name)} exec sh -c ${shellQuote(command)}`;
	const inner = `${mount} && ${hide} && cd ${shellQuote(record.path)} && ${marked}`;
	return `unshare -Urm sh -c ${shellQuote(inner)}`;
}

export function runInWorkspace(
	record: WorkspaceRecord,
	command: string,
): Promise<number | null> {
	return new Promise((resolvePromise) => {
		const child = spawn("sh", ["-c", execCommand(record, command)], {
			stdio: "inherit",
		});
		child.on("error", () => resolvePromise(null));
		child.on("exit", (code) => resolvePromise(code));
	});
}
