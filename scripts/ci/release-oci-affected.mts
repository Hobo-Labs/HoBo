#!/usr/bin/env node
/**
 * Print the release OCI image ids whose build inputs differ between the diff
 * base and HEAD, as a JSON array. An empty array means nothing to build.
 *
 * An image's input key covers what can change the image: its Dockerfile
 * directory, the release build scripts, the worker toolchain it builds FROM
 * (mise files and the ci-runner image definition), the Turbo build inputs of
 * every workspace package in its pnpm-lock.yaml closure, the slice of the
 * lockfile that closure resolves, and the root settings pnpm and Turbo read.
 * Both sides are hashed from git trees, so a test-only, docs-only or unrelated
 * dependency change builds nothing, and nothing has to be checked out.
 *
 * HOBO_CHECK_BASE selects the base (default origin/main); its merge base with
 * HOBO_CHECK_HEAD (default HEAD) is compared. Flags: --all (every image), --only=a,b, --exclude=a,b,
 * --explain (which input group changed, on stderr).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import process from "node:process";
import type { ReleaseOciManifest } from "../lib/release-oci-contract.mts";
import { OCI_IMAGES_MANIFEST } from "../lib/release-oci-contract.mts";
import { RELEASE_OCI_STAGE_SPECS } from "./stage-release-oci-app.mts";
import { SDK_PACKAGES } from "./stage-sdk-artifacts.mts";

const RELEASE_IMAGE_ORDER = [
	"hobo-sdk",
	"hobo-codegen",
	"hobo-code",
	"hobo-cli",
	"hobo-mcp",
	"hobo-ci-serve",
	"hobo-site",
] as const;

/** Inputs of every image. A trailing slash hashes the whole directory. */
const RELEASE_BUILD_INPUTS = [
	"scripts/ci/build-release-oci-image.mts",
	"scripts/ci/stage-release-oci-app.mts",
	"scripts/ci/stage-sdk-artifacts.mts",
	"scripts/lib/release-oci-contract.mts",
	"scripts/lib/ci-runner-contract.mts",
	"tsconfig.base.json",
	"pnpm-workspace.yaml",
	".npmrc",
	"mise.toml",
	"mise.lock",
	"packages/ci-gh-actions/deploy/ci-runner/",
] as const;

/** Inputs the lockfile graph cannot see: files read by path, not by import of a workspace dependency. */
const EXTRA_INPUTS = new Map<string, readonly string[]>([
	[
		"hobo-sdk",
		["release/npm-scope-map.json", "scripts/ci/npm-publish-scope.mts"],
	],
	[
		"hobo-site",
		[
			"examples/try-site/",
			"examples/browser-runtime/",
			"packages/runtime/",
			"packages/runtimes/runtime-wasm/",
		],
	],
]);

/** Images built FROM another release image. */
const BUILT_FROM = new Map([["hobo-mcp", "hobo-cli"]]);

export type RepoTree = {
	/** Blob oid by path, for every file the commit tracks outside submodules. */
	readonly files: ReadonlyMap<string, string>;
	/** Commit oid by submodule path. */
	readonly gitlinks: ReadonlyMap<string, string>;
	read(paths: readonly string[]): ReadonlyMap<string, string>;
};

type TurboTask = { inputs?: string[] };
type TurboJson = {
	globalDependencies?: string[];
	globalEnv?: string[];
	envMode?: string;
	tasks?: Record<string, TurboTask>;
};

type Importer = {
	readonly block: string;
	readonly links: readonly string[];
	readonly deps: readonly (readonly [string, string])[];
};
type Snapshot = {
	readonly block: string;
	readonly deps: readonly (readonly [string, string])[];
};
export type Lockfile = {
	readonly settings: string;
	readonly importers: ReadonlyMap<string, Importer>;
	readonly packages: ReadonlyMap<string, string>;
	readonly snapshots: ReadonlyMap<string, Snapshot>;
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

const gitTreeCache = new Map<string, RepoTree>();

/** Drop cached git trees (tests that swap cwd/rev fixtures). */
export function clearReleaseOciGitTreeCache(): void {
	gitTreeCache.clear();
}

const lockfileParseCache = new Map<string, Lockfile>();

function parseLockfileCached(text: string): Lockfile {
	const key = sha256(text);
	const cached = lockfileParseCache.get(key);
	if (cached) return cached;
	const parsed = parseLockfile(text);
	lockfileParseCache.set(key, parsed);
	return parsed;
}

function unquote(key: string): string {
	return key.replace(/^(['"])(.*)\1$/, "$2");
}

type ImporterLines = {
	block: string[];
	links: string[];
	deps: [string, string][];
};
type SnapshotLines = { block: string[]; deps: [string, string][] };

/** The importers, packages and snapshots of a pnpm v9 lockfile, by raw block. */
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

/** `name` + `version` (or an `alias@version` value) as a snapshot key. */
function snapshotKey(name: string, version: string): string {
	const bare = version.split("(")[0] ?? version;
	return bare.includes("@") ? version : `${name}@${version}`;
}

function packageKey(snapshot: string): string {
	const peer = snapshot.indexOf("(");
	return peer === -1 ? snapshot : snapshot.slice(0, peer);
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

/** The lockfile text a set of importers resolves: their blocks and every snapshot they reach. */
export function lockfileSlice(
	lockfile: Lockfile,
	importers: Iterable<string>,
): string {
	const dirs = [...importers].sort();
	const reached = new Set<string>();
	const queue: string[] = [];
	for (const dir of dirs)
		for (const [name, version] of lockfile.importers.get(dir)?.deps ?? [])
			queue.push(snapshotKey(name, version));
	for (let key = queue.pop(); key !== undefined; key = queue.pop()) {
		if (reached.has(key)) continue;
		reached.add(key);
		for (const [name, version] of lockfile.snapshots.get(key)?.deps ?? [])
			if (!version.startsWith("link:")) queue.push(snapshotKey(name, version));
	}
	const keys = [...reached].sort();
	return [
		lockfile.settings,
		...dirs.map(
			(dir) => lockfile.importers.get(dir)?.block ?? `${dir}: absent`,
		),
		...keys.map(
			(key) => lockfile.snapshots.get(key)?.block ?? `${key}: absent`,
		),
		...[...new Set(keys.map(packageKey))].map(
			(key) => lockfile.packages.get(key) ?? `${key}: absent`,
		),
	].join("\n");
}

export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === "*" && glob[index + 1] === "*") {
			const dirs = glob[index + 2] === "/";
			source += dirs ? "(?:.*/)?" : ".*";
			index += dirs ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += (char ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Whether Turbo hashes `file` (relative to its package) for a build task with these inputs. */
export function isBuildInput(
	file: string,
	inputs: readonly string[] | undefined,
): boolean {
	if (!inputs) return true;
	const included = inputs.some(
		(input) =>
			input === "$TURBO_DEFAULT$" ||
			(!input.startsWith("!") && globToRegExp(input).test(file)),
	);
	return (
		included &&
		!inputs.some(
			(input) =>
				input.startsWith("!") && globToRegExp(input.slice(1)).test(file),
		)
	);
}

function parseJson<T>(text: string | undefined, path: string): T | undefined {
	if (text === undefined) return undefined;
	try {
		// SAFETY: repo-owned JSON; every field read below is optional and checked at use.
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(
			`${path}: ${error instanceof Error ? error.message : error}`,
		);
	}
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type RootPackageJson = { packageManager?: string; pnpm?: Json; engines?: Json };

/** Docs, tests, and detector-only scripts never change a product image. */
export function isReleaseOciLayerNoise(path: string): boolean {
	if (path.endsWith(".md")) return true;
	if (path.includes("/test/") || path.endsWith(".test.ts")) return true;
	if (path.startsWith("docs/")) return true;
	if (path.startsWith("scripts/test/")) return true;
	// SAFETY: RELEASE_BUILD_INPUTS is a const string tuple; Array.includes requires readonly string[] to accept a general path.
	const layerScripts = RELEASE_BUILD_INPUTS as readonly string[];
	if (path.startsWith("scripts/ci/") && !layerScripts.includes(path))
		return true;
	if (path.startsWith("scripts/lib/") && !layerScripts.includes(path))
		return true;
	return false;
}

function pathInputs(tree: RepoTree, inputs: readonly string[]): string[] {
	const lines: string[] = [];
	for (const input of [...inputs].sort()) {
		if (input.endsWith("/")) {
			for (const [path, oid] of tree.files)
				if (path.startsWith(input) && !isReleaseOciLayerNoise(path))
					lines.push(`${path} ${oid}`);
			for (const [path, oid] of tree.gitlinks)
				if (path.startsWith(input) && !isReleaseOciLayerNoise(path))
					lines.push(`${path} commit ${oid}`);
		} else if (!isReleaseOciLayerNoise(input)) {
			lines.push(`${input} ${tree.files.get(input) ?? "absent"}`);
		}
	}
	return lines.sort();
}

export type ImageInputs = {
	readonly layer: string;
	readonly packages: string;
	readonly lockfile: string;
	readonly from: string;
};

/** Workspace package names whose build closure an image ships. */
function imagePackages(id: string): readonly string[] {
	const spec = Object.entries(RELEASE_OCI_STAGE_SPECS).find(
		([key]) => key === id,
	)?.[1];
	if (!spec) throw new Error(`release image ${id} has no stage spec`);
	switch (spec.kind) {
		case "deploy":
			return [spec.packageName];
		case "sdk":
			return SDK_PACKAGES;
		case "site":
			return ["hobo-site"];
		case "mcp":
			return [];
	}
}

/** Input groups of every manifest image at one revision. */
export function imageInputs(
	tree: RepoTree,
	packagesOf: (id: string) => readonly string[] = imagePackages,
): Map<string, ImageInputs> {
	const roots = tree.read([
		"pnpm-lock.yaml",
		"package.json",
		"turbo.json",
		OCI_IMAGES_MANIFEST,
	]);
	const manifest = parseJson<ReleaseOciManifest>(
		roots.get(OCI_IMAGES_MANIFEST),
		OCI_IMAGES_MANIFEST,
	);
	if (!manifest) return new Map();
	const lockfile = parseLockfileCached(roots.get("pnpm-lock.yaml") ?? "");
	const turbo =
		parseJson<TurboJson>(roots.get("turbo.json"), "turbo.json") ?? {};
	const rootPackage = parseJson<RootPackageJson>(
		roots.get("package.json"),
		"package.json",
	);
	const buildTasks = Object.fromEntries(
		Object.entries(turbo.tasks ?? {}).filter(
			([name]) => name === "build" || name.endsWith("#build"),
		),
	);
	const shared = JSON.stringify({
		packageJson: {
			packageManager: rootPackage?.packageManager,
			pnpm: rootPackage?.pnpm,
			engines: rootPackage?.engines,
		},
		turbo: {
			globalDependencies: turbo.globalDependencies,
			globalEnv: turbo.globalEnv,
			envMode: turbo.envMode,
			buildTasks,
		},
		manifest: { ...manifest, images: undefined },
	});

	const dirs = [...lockfile.importers.keys()].filter((dir) => dir !== ".");
	const manifests = tree.read(dirs.map((dir) => `${dir}/package.json`));
	const dirByName = new Map<string, string>();
	const nameByDir = new Map<string, string>();
	for (const dir of dirs) {
		const name = parseJson<{ name?: string }>(
			manifests.get(`${dir}/package.json`),
			`${dir}/package.json`,
		)?.name;
		if (name) {
			dirByName.set(name, dir);
			nameByDir.set(dir, name);
		}
	}

	const neededDirs = new Set<string>();
	for (const image of manifest.images) {
		const rootDirs = packagesOf(image.id).map((name) => {
			const dir = dirByName.get(name);
			if (!dir)
				throw new Error(
					`release image ${image.id}: ${name} is not a pnpm-lock.yaml importer`,
				);
			return dir;
		});
		for (const dir of importerClosure(lockfile, [".", ...rootDirs]))
			if (dir !== ".") neededDirs.add(dir);
	}

	const filesByDir = new Map<string, [string, string][]>();
	for (const [path, oid] of tree.files) {
		for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
			if (!neededDirs.has(dir) || !lockfile.importers.has(dir)) continue;
			const list = filesByDir.get(dir) ?? [];
			list.push([path, oid]);
			filesByDir.set(dir, list);
			break;
		}
	}

	function packageFiles(dir: string): string[] {
		const name = nameByDir.get(dir);
		const task = (name && turbo.tasks?.[`${name}#build`]) || turbo.tasks?.build;
		const files = (filesByDir.get(dir) ?? [])
			.filter(([path]) =>
				isBuildInput(path.slice(dir.length + 1), task?.inputs),
			)
			.map(([path, oid]) => `${path} ${oid}`)
			.sort();
		for (const [path, oid] of tree.gitlinks)
			if (dir === path || dir.startsWith(`${path}/`))
				files.push(`${dir} in ${path} commit ${oid}`);
		return files;
	}

	const inputs = new Map<string, ImageInputs>();
	for (const image of manifest.images) {
		const rootDirs = packagesOf(image.id).map((name) => {
			const dir = dirByName.get(name);
			if (!dir)
				throw new Error(
					`release image ${image.id}: ${name} is not a pnpm-lock.yaml importer`,
				);
			return dir;
		});
		const closure = importerClosure(lockfile, [".", ...rootDirs]);
		const packageDirs = [...closure].filter((dir) => dir !== ".").sort();
		inputs.set(image.id, {
			layer: sha256(
				[
					shared,
					JSON.stringify(image),
					...pathInputs(tree, [
						`${posix.dirname(image.dockerfile)}/`,
						...RELEASE_BUILD_INPUTS,
						...(EXTRA_INPUTS.get(image.id) ?? []),
					]),
				].join("\n"),
			),
			packages: sha256(packageDirs.flatMap(packageFiles).join("\n")),
			lockfile: sha256(lockfileSlice(lockfile, closure)),
			from: BUILT_FROM.get(image.id) ?? "",
		});
	}
	return inputs;
}

export function imageKey(
	inputs: ReadonlyMap<string, ImageInputs>,
	id: string,
): string | undefined {
	const own = inputs.get(id);
	if (!own) return undefined;
	const from = own.from ? imageKey(inputs, own.from) : "";
	return sha256(JSON.stringify({ ...own, from }));
}

export function orderedImageIds(ids: Iterable<string>): string[] {
	const all = [...ids];
	return [
		...RELEASE_IMAGE_ORDER.filter((id) => all.includes(id)),
		// SAFETY: Readonly widening preserves the tuple while allowing arbitrary manifest ids.
		...all.filter(
			(id) => !(RELEASE_IMAGE_ORDER as readonly string[]).includes(id),
		),
	];
}

export type AffectedImage = { readonly id: string; readonly changed: string[] };

/** Images whose input key differs between the two revisions, in build order. */
export function affectedReleaseOciImages(
	base: ReadonlyMap<string, ImageInputs>,
	head: ReadonlyMap<string, ImageInputs>,
): AffectedImage[] {
	const affected: AffectedImage[] = [];
	for (const id of orderedImageIds(head.keys())) {
		if (imageKey(base, id) === imageKey(head, id)) continue;
		const before = base.get(id);
		const after = head.get(id);
		const changed = before
			? (["layer", "packages", "lockfile"] as const).filter(
					(group) => before[group] !== after?.[group],
				)
			: ["new image"];
		const from = after?.from;
		if (from && imageKey(base, from) !== imageKey(head, from))
			changed.push(`built FROM ${from}`);
		affected.push({ id, changed });
	}
	return affected;
}

function git(args: readonly string[], cwd: string, input?: string): Buffer {
	return execFileSync("git", args, {
		cwd,
		input,
		maxBuffer: 1 << 30,
		stdio: ["pipe", "pipe", "inherit"],
	});
}

type LsTreeMaps = {
	files: Map<string, string>;
	gitlinks: Map<string, string>;
};

function lsTreeRecords(
	rev: string,
	cwd: string,
	pathspecs: readonly string[],
): LsTreeMaps {
	const files = new Map<string, string>();
	const gitlinks = new Map<string, string>();
	if (pathspecs.length === 0) return { files, gitlinks };
	const args = ["ls-tree", "-r", "-z", "--full-tree", rev, "--", ...pathspecs];
	for (const record of git(args, cwd).toString("utf8").split("\0")) {
		const match = /^\d+ (blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(record);
		if (match?.[1] === "blob" && match[3]) files.set(match[3], match[2] ?? "");
		else if (match?.[1] === "commit" && match[3])
			gitlinks.set(match[3], match[2] ?? "");
	}
	return { files, gitlinks };
}

/** Pathspecs covering release OCI input hashing — not the whole repo (docs/tests/.github). */
const RELEASE_INPUT_PATHSPECS = [
	"packages/",
	"site/",
	"media/",
	"examples/",
	"external/",
	"src/",
	"release/",
	"deploy/",
	"scripts/",
	"mise.toml",
	"mise.lock",
	"tsconfig.base.json",
	"pnpm-workspace.yaml",
	".npmrc",
	"package.json",
	"pnpm-lock.yaml",
	"turbo.json",
	OCI_IMAGES_MANIFEST,
] as const;

/** Directory cones a sparse checkout needs for every scoped release input blob. */
export function releaseOciInputSparseCones(): readonly string[] {
	return Object.freeze(
		RELEASE_INPUT_PATHSPECS.filter((pathspec) => pathspec.endsWith("/")).map(
			(pathspec) => pathspec.slice(0, -1),
		),
	);
}

const TAR_BLOCK_SIZE = 512;

function tarString(header: Buffer, offset: number, length: number): string {
	return header
		.subarray(offset, offset + length)
		.toString("utf8")
		.replace(/\0.*$/s, "");
}

function paxValue(data: Buffer, key: string): string | undefined {
	let offset = 0;
	while (offset < data.length) {
		const space = data.indexOf(32, offset);
		const length = Number(data.toString("ascii", offset, space));
		if (
			!Number.isInteger(length) ||
			length <= 0 ||
			offset + length > data.length
		)
			throw new Error("git archive: malformed pax header");
		const record = data.subarray(space + 1, offset + length);
		const equals = record.indexOf(61);
		if (record.subarray(0, equals).toString("utf8") === key)
			return record.subarray(equals + 1, record.length - 1).toString("utf8");
		offset += length;
	}
	return undefined;
}

function parseTarFiles(archive: Buffer): Map<string, string> {
	const files = new Map<string, string>();
	let extendedPath: string | undefined;
	let longPath: string | undefined;
	for (let offset = 0; offset + TAR_BLOCK_SIZE <= archive.length; ) {
		const header = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
		if (header.every((byte) => byte === 0)) break;
		const sizeText = tarString(header, 124, 12).trim();
		const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
		if (!Number.isInteger(size) || size < 0)
			throw new Error(`git archive: invalid tar entry size ${sizeText}`);
		const dataStart = offset + TAR_BLOCK_SIZE;
		const dataEnd = dataStart + size;
		if (dataEnd > archive.length)
			throw new Error("git archive: truncated tar entry");
		const data = archive.subarray(dataStart, dataEnd);
		const type = String.fromCharCode(header[156] ?? 0);
		if (type === "x") {
			extendedPath = paxValue(data, "path");
		} else if (type === "L") {
			longPath = data.toString("utf8").replace(/\0$/, "");
		} else if (type !== "g") {
			const prefix = tarString(header, 345, 155);
			const name = tarString(header, 0, 100);
			const path =
				extendedPath ?? longPath ?? (prefix ? `${prefix}/${name}` : name);
			if (type === "0" || type === "\0" || type === "2")
				files.set(
					path,
					type === "2" ? tarString(header, 157, 200) : data.toString("utf8"),
				);
			extendedPath = undefined;
			longPath = undefined;
		}
		offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
	}
	return files;
}

function readGitArchive(
	rev: string,
	cwd: string,
	paths: readonly string[],
): Map<string, string> {
	const archived = parseTarFiles(
		git(["archive", "--format=tar", rev, "--", ...paths], cwd),
	);
	const contents = new Map<string, string>();
	for (const path of paths) {
		const text = archived.get(path);
		if (text === undefined)
			throw new Error(`git archive: missing ${path} at ${rev}`);
		contents.set(path, text);
	}
	return contents;
}

/** Git tree scoped to release OCI inputs (fast on sparse CI checkouts). */
export function releaseInputGitTree(rev: string, cwd: string): RepoTree {
	const cacheKey = `${cwd}\0${rev}\0release-inputs`;
	const cached = gitTreeCache.get(cacheKey);
	if (cached) return cached;
	const { files, gitlinks } = lsTreeRecords(rev, cwd, RELEASE_INPUT_PATHSPECS);
	const tree: RepoTree = {
		files,
		gitlinks,
		read(paths) {
			const wanted = paths.filter((path) => files.has(path));
			return wanted.length === 0
				? new Map<string, string>()
				: readGitArchive(rev, cwd, wanted);
		},
	};
	gitTreeCache.set(cacheKey, tree);
	return tree;
}

export function gitTree(rev: string, cwd: string): RepoTree {
	const cacheKey = `${cwd}\0${rev}`;
	const cached = gitTreeCache.get(cacheKey);
	if (cached) return cached;
	const files = new Map<string, string>();
	const gitlinks = new Map<string, string>();
	for (const record of git(["ls-tree", "-r", "-z", "--full-tree", rev], cwd)
		.toString("utf8")
		.split("\0")) {
		const match = /^\d+ (blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(record);
		if (match?.[1] === "blob" && match[3]) files.set(match[3], match[2] ?? "");
		else if (match?.[1] === "commit" && match[3])
			gitlinks.set(match[3], match[2] ?? "");
	}
	const tree: RepoTree = {
		files,
		gitlinks,
		read(paths) {
			const wanted = paths.filter((path) => files.has(path));
			const contents = new Map<string, string>();
			if (wanted.length === 0) return contents;
			const output = git(
				["cat-file", "--batch"],
				cwd,
				`${wanted.map((path) => files.get(path)).join("\n")}\n`,
			);
			let offset = 0;
			for (const path of wanted) {
				const newline = output.indexOf(10, offset);
				const header = output.subarray(offset, newline).toString("utf8");
				const size = Number(header.split(" ")[2]);
				if (!Number.isInteger(size))
					throw new Error(
						`git cat-file: unexpected header ${header} for ${path}`,
					);
				contents.set(
					path,
					output.subarray(newline + 1, newline + 1 + size).toString("utf8"),
				);
				offset = newline + 1 + size + 1;
			}
			return contents;
		},
	};
	gitTreeCache.set(cacheKey, tree);
	return tree;
}

function listFlag(
	argv: readonly string[],
	flag: string,
): Set<string> | undefined {
	const value = argv.find((arg) => arg.startsWith(`${flag}=`));
	return value ? new Set(value.slice(flag.length + 1).split(",")) : undefined;
}

function main(): void {
	const root = join(import.meta.dirname, "..", "..");
	const argv = process.argv.slice(2);
	const only = listFlag(argv, "--only");
	const exclude = listFlag(argv, "--exclude") ?? new Set<string>();
	const headRev = process.env.HOBO_CHECK_HEAD ?? "HEAD";
	const head = imageInputs(releaseInputGitTree(headRev, root));
	let affected: AffectedImage[];
	if (argv.includes("--all")) {
		affected = orderedImageIds(head.keys()).map((id) => ({
			id,
			changed: ["--all"],
		}));
	} else {
		const base = git(
			["merge-base", process.env.HOBO_CHECK_BASE ?? "origin/main", headRev],
			root,
		)
			.toString("utf8")
			.trim();
		affected = affectedReleaseOciImages(
			imageInputs(releaseInputGitTree(base, root)),
			head,
		);
	}
	const selected = affected.filter(
		({ id }) => (!only || only.has(id)) && !exclude.has(id),
	);
	if (argv.includes("--explain"))
		for (const { id, changed } of affected)
			process.stderr.write(
				`${id}: ${changed.join(", ")}${selected.some((image) => image.id === id) ? "" : " (filtered out)"}\n`,
			);
	process.stdout.write(`${JSON.stringify(selected.map(({ id }) => id))}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
