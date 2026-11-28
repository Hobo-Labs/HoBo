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

// domain-view: wire form is hobo.rift.v1.WorkspaceRecord; src/wire.ts converts.
export interface WorkspaceRecord {
	readonly name: string;
	readonly path: string;
	readonly tier: CowTier;
	readonly source: string;
	readonly upper?: string;
	readonly work?: string;
	readonly createdAt: string;
}

// domain-view: wire form is hobo.rift.v1.Registry; src/wire.ts converts.
export interface Registry {
	readonly root: string;
	readonly workspaces: readonly WorkspaceRecord[];
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

export function readRegistry(root: string): Registry {
	const abs = resolve(root);
	requireNoUnfinishedRepair(abs);
	const dir = riftDir(abs);
	if (existsSync(journalPath(dir))) {
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

export function pruneDebris(root: string): readonly string[] {
	const parked = listDebris(root);
	for (const path of parked) rmSync(path, { recursive: true, force: true });
	return parked;
}

export interface RepairResult extends Registry {
	readonly undecidable?: string;
}

export function rebuildRegistry(root: string): RepairResult {
	const abs = resolve(root);
	requireNoUnfinishedRepair(abs);
	const dir = riftDir(abs);
	const events = readEvents(dir);
	const projected = projectWorkspaces(events);
	const snapshot = readSnapshotRegistry(abs);
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
	if (
		snapshot !== null &&
		snapshot.workspaces.length > 0 &&
		!isJsonNumber(snapshot.eventCount) &&
		snapshot.workspaces.some(
			(workspace) =>
				!projected.some((candidate) => sameWorkspace(workspace, candidate)),
		)
	) {
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

function recordCreated(root: string, workspace: WorkspaceRecord): void {
	record(root, {
		type: "WorkspaceCreated",
		at: workspace.createdAt,
		workspace,
	});
}

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
	readonly debris?: string;
}

export function createWorkspace(options: CreateOptions): CreateResult {
	const root = resolve(options.root);
	let debris: string | null = null;
	let claim: string | null = null;
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
	record(root, {
		type: "WorkspaceCreating",
		at: new Date().toISOString(),
		name,
		path: base,
	});

	if (capability.tier === "overlayfs") {
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

function claimName(root: string, name: string): string | null {
	const path = claimPath(root, name);
	mkdirSync(join(resolve(root), RIFT_DIR, "workspaces"), { recursive: true });
	try {
		writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
		return path;
	} catch {
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
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: `return (error as NodeJS.ErrnoException).code === "EPERM";` is required at this I/O or test boundary.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function parkDebris(base: string): string | null {
	try {
		if (!containsFile(base)) {
			rmSync(base, { recursive: true, force: true });
			return null;
		}
	} catch {}
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
	record(abs, {
		type: "WorkspaceRemoved",
		at: new Date().toISOString(),
		name: parsed.value,
	});
	if (existsSync(base)) rmSync(base, { recursive: true, force: true });
	return existing !== undefined;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function escapeMountPath(path: string): string {
	return path.replace(/([\\,:])/gu, "\\$1");
}

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
	const hide = `mkdir -p ${shellQuote(join(record.path, RIFT_DIR))} && mount -t tmpfs none ${shellQuote(join(record.path, RIFT_DIR))}`;
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
