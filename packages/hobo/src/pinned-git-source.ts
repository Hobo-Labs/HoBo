import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { withoutSecretEnv } from "@hobo/hobo-ci";

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


export function pinnedGitEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...withoutSecretEnv(process.env) };
	for (const name of Object.keys(env)) {
		if (name.startsWith("GIT_") && name !== "GIT_CEILING_DIRECTORIES")
			delete env[name];
	}
	env.GIT_NO_REPLACE_OBJECTS = "1";
	env.GIT_NO_LAZY_FETCH = "1";
	env.GIT_ALLOW_PROTOCOL = "";
	env.GIT_TERMINAL_PROMPT = "0";
	return env;
}
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
	const env: NodeJS.ProcessEnv = {
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: devNull,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_ALLOW_PROTOCOL: "",
		GIT_TERMINAL_PROMPT: "0",
	};
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.platform === "win32" && process.env.SystemRoot !== undefined)
		env.SystemRoot = process.env.SystemRoot;
	if (process.env.GIT_CEILING_DIRECTORIES !== undefined)
		env.GIT_CEILING_DIRECTORIES = process.env.GIT_CEILING_DIRECTORIES;
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
	const unmatched = new Set(paths);
	for (const entry of entries) {
		let end = entry.path.length;
		while (end >= 0 && unmatched.size > 0) {
			unmatched.delete(entry.path.slice(0, end));
			end = entry.path.lastIndexOf("/", end - 1);
		}
		if (unmatched.size === 0) break;
	}
	if (unmatched.size > 0)
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
