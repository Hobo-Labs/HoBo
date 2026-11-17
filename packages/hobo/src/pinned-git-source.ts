import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** A tracked regular file read from the Git object database, not the checkout. */
export interface PinnedGitFile {
	readonly path: string;
	readonly mode: "100644" | "100755";
	readonly content: Buffer;
}

export interface PinnedGitSource {
	readonly commit: string;
	readonly files: readonly PinnedGitFile[];
}

const COMMIT = /^[0-9a-f]{40}$/u;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FILES = 25_000;
const decoder = new TextDecoder("utf-8", { fatal: true });

function safePath(path: string): boolean {
	return (
		path !== "" &&
		!path.includes("\\") &&
		![...path].some((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code < 32 || code === 127;
		}) &&
		path
			.split("/")
			.every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function git(
	cwd: string,
	args: readonly string[],
	maxBuffer: number,
	input?: string,
): Buffer {
	// A caller's GIT_DIR or replace refs must not silently change the repository
	// or the commit that was approved. No shell interprets the selected paths.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	const result = spawnSync("git", args, {
		cwd,
		env,
		input,
		maxBuffer,
		timeout: 30_000,
	});
	if (result.status !== 0 || result.error !== undefined)
		throw new Error("Could not read the pinned Git source within its limits.");
	return result.stdout;
}

/**
 * Materialize selected tracked files from one full commit ID. Paths are literal
 * repository-relative selections. Dirty and untracked checkout files are never
 * included. Symlinks and submodules fail closed rather than changing meaning
 * when the snapshot is unpacked by a remote builder.
 */
export function readPinnedGitSource(input: {
	readonly cwd: string;
	readonly sha: string;
	readonly paths: readonly string[];
	readonly maxBytes?: number;
	readonly maxFiles?: number;
}): PinnedGitSource {
	const { cwd, sha, paths } = input;
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
	if (
		!COMMIT.test(sha) ||
		paths.length === 0 ||
		paths.some((path) => !safePath(path)) ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0 ||
		maxBytes > DEFAULT_MAX_BYTES ||
		!Number.isSafeInteger(maxFiles) ||
		maxFiles < 1 ||
		maxFiles > DEFAULT_MAX_FILES
	)
		throw new TypeError(
			"Pinned Git source needs a full commit, safe paths, and valid limits.",
		);
	const root = git(cwd, ["rev-parse", "--show-toplevel"], 16_384)
		.toString("utf8")
		.replace(/\r?\n$/u, "");
	const resolved = git(root, ["rev-parse", "--verify", `${sha}^{commit}`], 1024)
		.toString("utf8")
		.trim();
	if (resolved !== sha)
		throw new Error("The pinned Git commit does not resolve exactly.");
	const listing = git(
		root,
		[
			"ls-tree",
			"-r",
			"-z",
			"-l",
			sha,
			"--",
			...paths.map((path) => `:(literal)${path}`),
		],
		16 * 1024 * 1024,
	);
	const entries: {
		path: string;
		mode: "100644" | "100755";
		oid: string;
		size: number;
	}[] = [];
	let total = 0;
	for (let offset = 0; offset < listing.length; ) {
		const end = listing.indexOf(0, offset);
		if (end < 0) throw new Error("Malformed Git tree listing.");
		const entry = listing.subarray(offset, end);
		const tab = entry.indexOf(9);
		if (tab < 0) throw new Error("Malformed Git tree entry.");
		const metadata = /^(\d{6}) (\w+) ([0-9a-f]{40})\s+(\d+|-)$/u.exec(
			entry.subarray(0, tab).toString("ascii"),
		);
		if (metadata === null) throw new Error("Malformed Git tree metadata.");
		const [, mode, kind, oid, sizeText] = metadata;
		if (mode === "120000")
			throw new Error("Pinned Git source contains a symlink.");
		if (
			(mode !== "100644" && mode !== "100755") ||
			kind !== "blob" ||
			oid === undefined ||
			sizeText === undefined
		)
			throw new Error(
				"Pinned Git source contains an unsupported object, such as a submodule.",
			);
		const path = decoder.decode(entry.subarray(tab + 1));
		if (!safePath(path))
			throw new Error("Pinned Git source contains an unsafe path.");
		const size = Number(sizeText);
		total += size;
		if (
			!Number.isSafeInteger(size) ||
			total > maxBytes ||
			entries.length >= maxFiles
		)
			throw new Error(
				"Pinned Git source exceeds its size or file count limit.",
			);
		entries.push({ path, mode, oid, size });
		offset = end + 1;
	}
	if (
		paths.some(
			(path) =>
				!entries.some(
					(entry) => entry.path === path || entry.path.startsWith(`${path}/`),
				),
		)
	)
		throw new Error(
			"A selected Git source path is absent from the pinned commit.",
		);
	const blobs = git(
		root,
		["cat-file", "--batch"],
		Math.max(1024, total + entries.length * 128),
		`${entries.map((entry) => entry.oid).join("\n")}\n`,
	);
	let offset = 0;
	const files = entries.map((entry) => {
		const end = blobs.indexOf(10, offset);
		if (
			end < 0 ||
			blobs.subarray(offset, end).toString("ascii") !==
				`${entry.oid} blob ${entry.size}`
		)
			throw new Error("Malformed Git blob response.");
		const content = blobs.subarray(end + 1, end + 1 + entry.size);
		if (
			content.length !== entry.size ||
			blobs[end + 1 + entry.size] !== 10 ||
			createHash("sha1")
				.update(`blob ${entry.size}\0`)
				.update(content)
				.digest("hex") !== entry.oid
		)
			throw new Error("Pinned Git blob failed its integrity check.");
		offset = end + 2 + entry.size;
		return { path: entry.path, mode: entry.mode, content };
	});
	if (offset !== blobs.length)
		throw new Error("Unexpected extra Git blob data.");
	return { commit: sha, files };
}
