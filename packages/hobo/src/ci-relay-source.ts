import { spawnSync } from "node:child_process";
import { join, posix } from "node:path";
import { isJsonString } from "./json.js";
import {
	type PinnedGitSource,
	pinnedGitEnvironment,
	readPinnedGitLinks,
	readPinnedGitSource,
} from "./pinned-git-source.js";

const RELAY_ROOT_INPUTS = [
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"turbo.json",
	"tsconfig.base.json",
	"tsconfig.json",
	"biome.json",
] as const;
const OPTIONAL_ROOT_INPUTS = [
	".npmrc",
	".pnpmfile.cjs",
	".pnpmfile.mjs",
] as const;

function unquote(value: string): string {
	if (value.startsWith("'") && value.endsWith("'"))
		return value.slice(1, -1).replaceAll("''", "'");
	if (value.startsWith('"') && value.endsWith('"')) {
		const parsed: unknown = JSON.parse(value);
		if (!isJsonString(parsed)) throw new Error("Invalid lockfile string.");
		return parsed;
	}
	return value;
}

export function pnpmWorkspaceClosure(
	text: string,
	roots: readonly string[],
): string[] {
	if (!/^lockfileVersion: ['"]?9\.0['"]?\s*$/mu.test(text))
		throw new Error("The relay source requires a pnpm v9 lockfile.");
	const links = new Map<string, string[]>();
	let section = "";
	let current: string | undefined;
	for (const line of text.split("\n")) {
		if (/^\S/u.test(line)) {
			section = line.replace(/:.*/u, "");
			current = undefined;
			continue;
		}
		if (section !== "importers") continue;
		const header = /^ {2}(\S.*?):(?: .*)?$/u.exec(line);
		if (header?.[1] !== undefined) {
			current = unquote(header[1]);
			if (links.has(current))
				throw new Error("The lockfile has duplicate importers.");
			links.set(current, []);
			continue;
		}
		const version = /^ {8}version: (.+)$/u.exec(line);
		if (current === undefined || version?.[1] === undefined) continue;
		const value = unquote(version[1].trim());
		if (!value.startsWith("link:")) continue;
		const next = posix.normalize(posix.join(current, value.slice(5)));
		if (next === ".." || next.startsWith("../") || posix.isAbsolute(next))
			throw new Error("A workspace link escapes the repository.");
		links.get(current)?.push(next);
	}
	const seen = new Set<string>();
	const queue = [...roots];
	for (let dir = queue.pop(); dir !== undefined; dir = queue.pop()) {
		if (seen.has(dir)) continue;
		const dependencies = links.get(dir);
		if (dependencies === undefined)
			throw new Error("A workspace importer is missing from the lockfile.");
		seen.add(dir);
		queue.push(...dependencies);
	}
	return [...seen].sort();
}

export function readRelaySource(cwd: string, sha: string): PinnedGitSource {
	const env = pinnedGitEnvironment();
	const rootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 16_384,
		timeout: 30_000,
	});
	if (rootResult.status !== 0 || rootResult.error !== undefined)
		throw new Error("The relay source repository is unavailable.");
	const root = rootResult.stdout.replace(/\r?\n$/u, "");
	const lock = readPinnedGitSource({
		cwd: root,
		sha,
		paths: ["pnpm-lock.yaml"],
	});
	const text = lock.files[0]?.content.toString("utf8");
	if (text === undefined)
		throw new Error("The pinned relay lockfile is missing.");
	const directories = pnpmWorkspaceClosure(text, [
		".",
		"packages/ci-vercel",
	]).filter((dir) => dir !== ".");
	const optional = spawnSync(
		"git",
		["ls-tree", "-z", "--name-only", sha, "--", ...OPTIONAL_ROOT_INPUTS],
		{
			cwd: root,
			env,
			encoding: "utf8",
			maxBuffer: 16_384,
			timeout: 30_000,
		},
	);
	if (optional.status !== 0 || optional.error !== undefined)
		throw new Error("Optional workspace inputs could not be read.");
	const optionalPaths = optional.stdout.split("\0").filter(Boolean);
	if (
		optionalPaths.some(
			(path) => !OPTIONAL_ROOT_INPUTS.some((known) => known === path),
		)
	)
		throw new Error("Invalid optional workspace input.");
	const gitlinkPins = readPinnedGitLinks({ cwd: root, sha });
	const mounts = [...gitlinkPins.keys()].sort((a, b) => b.length - a.length);
	const repoDirectories: string[] = [];
	const submoduleDirectories = new Map<string, string[]>();
	for (const dir of directories) {
		const mount = mounts.find((path) => dir.startsWith(`${path}/`));
		if (mount === undefined) repoDirectories.push(dir);
		else {
			const stripped = dir.slice(mount.length + 1);
			const group = submoduleDirectories.get(mount);
			if (group === undefined) submoduleDirectories.set(mount, [stripped]);
			else group.push(stripped);
		}
	}
	const files = [
		...readPinnedGitSource({
			cwd: root,
			sha,
			paths: [...RELAY_ROOT_INPUTS, ...optionalPaths, ...repoDirectories],
		}).files,
	];
	for (const mount of [...submoduleDirectories.keys()].sort()) {
		const pinned = readPinnedGitSource({
			cwd: join(root, mount),
			sha: gitlinkPins.get(mount) ?? "",
			paths: submoduleDirectories.get(mount) ?? [],
		});
		for (const file of pinned.files)
			files.push({ ...file, path: posix.join(mount, file.path) });
	}
	return { commit: sha, files };
}
