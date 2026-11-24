import { posix } from "node:path";

export type Importer = {
	readonly block: string;
	readonly links: readonly string[];
	readonly deps: readonly (readonly [string, string])[];
};
export type Snapshot = {
	readonly block: string;
	readonly deps: readonly (readonly [string, string])[];
};
export type Lockfile = {
	readonly settings: string;
	readonly importers: ReadonlyMap<string, Importer>;
	readonly packages: ReadonlyMap<string, string>;
	readonly snapshots: ReadonlyMap<string, Snapshot>;
};

function unquote(key: string): string {
	return key.replace(/^(['"])(.*)\1$/, "$2");
}

type ImporterLines = {
	block: string[];
	links: string[];
	deps: [string, string][];
};
type SnapshotLines = { block: string[]; deps: [string, string][] };

export function parseLockfile(text: string): Lockfile {
	const settings: string[] = [];
	const importers = new Map<string, ImporterLines>();
	const packages = new Map<string, string[]>();
	const snapshots = new Map<string, SnapshotLines>();
	let section = "";
	let entry: string[] | undefined;
	let importer: ImporterLines | undefined;
	let importerDir = "";
	let snapshot: SnapshotLines | undefined;
	let depName: string | undefined;
	let inSnapshotDeps = false;
	for (const line of text.split("\n")) {
		if (/^\S/.test(line)) {
			section = line.replace(/:.*$/, "");
			entry = undefined;
			importer = undefined;
			snapshot = undefined;
			if (!["importers", "packages", "snapshots"].includes(section))
				settings.push(line);
			continue;
		}
		if (!["importers", "packages", "snapshots"].includes(section)) {
			settings.push(line);
			continue;
		}
		const head = /^ {2}(\S.*?):(?: (.*))?$/.exec(line);
		if (head?.[1]) {
			const key = unquote(head[1]);
			entry = [line];
			importer = undefined;
			snapshot = undefined;
			inSnapshotDeps = false;
			if (section === "importers") {
				importerDir = key;
				importer = { block: entry, links: [], deps: [] };
				importers.set(key, importer);
			} else if (section === "packages") packages.set(key, entry);
			else {
				snapshot = { block: entry, deps: [] };
				snapshots.set(key, snapshot);
			}
			continue;
		}
		if (!entry || line.trim() === "") continue;
		entry.push(line);
		if (importer) {
			const name = /^ {6}(\S.*):$/.exec(line);
			if (name?.[1]) depName = unquote(name[1]);
			const version = /^ {8}version: (.+)$/.exec(line);
			if (version?.[1] && depName) {
				const value = version[1].trim();
				if (value.startsWith("link:"))
					importer.links.push(
						posix.normalize(posix.join(importerDir, value.slice(5))),
					);
				else importer.deps.push([depName, value]);
			}
		} else if (snapshot) {
			const group = /^ {4}(\S+):/.exec(line);
			if (group?.[1])
				inSnapshotDeps =
					group[1] === "dependencies" || group[1] === "optionalDependencies";
			const dep = /^ {6}(\S.*?): (.+)$/.exec(line);
			if (inSnapshotDeps && dep?.[1] && dep[2])
				snapshot.deps.push([unquote(dep[1]), unquote(dep[2].trim())]);
		}
	}
	return {
		settings: settings.join("\n"),
		importers: new Map(
			[...importers].map(([dir, value]) => [
				dir,
				{ block: value.block.join("\n"), links: value.links, deps: value.deps },
			]),
		),
		packages: new Map(
			[...packages].map(([key, lines]) => [key, lines.join("\n")]),
		),
		snapshots: new Map(
			[...snapshots].map(([key, value]) => [
				key,
				{ block: value.block.join("\n"), deps: value.deps },
			]),
		),
	};
}

export function importerClosure(
	lockfile: Lockfile,
	roots: Iterable<string>,
): Set<string> {
	const seen = new Set<string>();
	const queue = [...roots];
	for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
		if (seen.has(dir)) continue;
		seen.add(dir);
		for (const next of lockfile.importers.get(dir)?.links ?? [])
			queue.push(next);
	}
	return seen;
}
