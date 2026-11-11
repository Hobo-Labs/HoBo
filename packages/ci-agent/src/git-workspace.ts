import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMMIT_IDENTITY } from "./config.js";
import { markerSizeFor } from "./conflict.js";
import type { ConflictFile } from "./resolver.js";
import { type CommitSigningKey, signCommitObject } from "./signing.js";

/** The result of merging two commits without touching a working tree. */
export type TrialMerge = Readonly<{
	clean: boolean;
	/** The merged tree. For a conflicted merge its conflicted paths hold marker text. */
	tree: string;
	files: readonly ConflictFile[];
}>;

/**
 * Git as the agent uses it: fetch, trial merge, write a merge commit from
 * supplied file contents, and push without force. No checkout, no working
 * tree, and no command built from model output.
 */
export interface MergeWorkspace {
	fetch(refs: readonly string[]): Promise<void>;
	trial(ours: string, theirs: string): Promise<TrialMerge>;
	commit(input: {
		tree: string;
		/** One parent for a repair on top of an earlier commit, two for a merge. */
		parents: readonly [string] | readonly [string, string];
		files: ReadonlyMap<string, string>;
		message: string;
	}): Promise<string>;
	/** A text file at a commit, or nothing when it is absent or not text. */
	read(commit: string, path: string): Promise<string | undefined>;
	/** Create or fast-forward `ref`. A push that would rewrite history fails. */
	push(commit: string, ref: string): Promise<void>;
}

const OBJECT = /^[a-f0-9]{40,64}$/;
/** Branch prefixes owned by a merge queue. Writing to one corrupts its speculation. */
export const QUEUE_OWNED_BRANCH =
	/^(?:gh-readonly-queue\/|mergify\/merge-queue\/|gtmq_)/;
export type CommitIdentity = Readonly<{ name: string; email: string }>;
/** Message types of a trial merge that leave a plain text conflict, or none. */
const TEXT_CONFLICTS = new Set([
	"Auto-merging",
	"CONFLICT (contents)",
	"CONFLICT (add/add)",
]);
const REGULAR_FILE = new Set(["100644", "100755"]);
/** Where fetched refs are kept, and where the agent's own commits stay reachable. */
const FETCHED = "refs/hobo-agent/fetched/";
const MADE = "refs/hobo-agent/commits/";

function object(value: string): string {
	if (!OBJECT.test(value)) throw new Error("invalid git object id");
	return value;
}

function branchRef(ref: string): string {
	const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : "";
	if (
		!branch ||
		QUEUE_OWNED_BRANCH.test(branch) ||
		!/^[A-Za-z0-9._/-]+$/.test(branch) ||
		branch.split("/").some((part) => part === "" || part.startsWith("."))
	)
		throw new Error("refused git ref");
	return ref;
}

/**
 * A workspace over one local repository (bare is enough) whose `remote`
 * carries the credentials the host chose. Hooks and prompts are disabled.
 */
export function createGitWorkspace(options: {
	directory: string;
	remote?: string;
	git?: string | undefined;
	/** Largest blob read from a conflicted path; larger ones are unsupported. */
	maxBlobBytes?: number;
	/**
	 * A short-lived token for the remote, asked for on every fetch and push
	 * and sent as an HTTP header to `authHost` only. It is never written to
	 * the repository's configuration or to a remote URL.
	 */
	auth?: () => Promise<string>;
	authHost?: string;
	/** Author and committer of the agent's commits. */
	identity?: CommitIdentity | undefined;
	/** When set, every commit the agent writes carries an SSH signature by this key. */
	signer?: CommitSigningKey | undefined;
}): MergeWorkspace {
	const identity = options.identity ?? DEFAULT_COMMIT_IDENTITY;
	if (
		/[<>\n\0]/.test(identity.name) ||
		!/^[^<>\s\0]+@[^<>\s\0]+$/.test(identity.email)
	)
		throw new Error("invalid commit identity");
	const remote = options.remote ?? "origin";
	const maxBlobBytes = options.maxBlobBytes ?? 4 * 1024 * 1024;
	const environment = {
		...process.env,
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_NOSYSTEM: "1",
		// A path is a path: `a[1].ts` must not match `a1.ts` as a glob.
		GIT_LITERAL_PATHSPECS: "1",
	};
	function run(
		args: readonly string[],
		extra: {
			input?: string;
			env?: Readonly<Record<string, string>>;
			maxBuffer?: number;
			/** Exit codes that are answers, not failures. */
			accept?: readonly number[];
		} = {},
	): Promise<{ stdout: Buffer; code: number }> {
		return new Promise((resolve, reject) => {
			const child = execFile(
				options.git ?? "git",
				["-c", "core.hooksPath=/dev/null", ...args],
				{
					cwd: options.directory,
					env: { ...environment, ...extra.env },
					encoding: "buffer",
					maxBuffer: extra.maxBuffer ?? 16 * 1024 * 1024,
				},
				(error, stdout) => {
					const code = child.exitCode ?? -1;
					if (error && !(extra.accept ?? []).includes(code))
						// Git output can carry repository text and remote URLs. Keep it out of errors.
						reject(new Error(`git ${args[0] ?? ""} failed`));
					else resolve({ stdout, code });
				},
			);
			if (extra.input !== undefined) child.stdin?.end(extra.input);
		});
	}
	async function remoteAuth(): Promise<Readonly<Record<string, string>>> {
		if (!options.auth) return {};
		const basic = Buffer.from(
			`x-access-token:${await options.auth()}`,
		).toString("base64");
		// Added after whatever the host already passes this way (a proxy, a CA).
		const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
		const index = Number.isInteger(count) && count > 0 ? count : 0;
		return {
			GIT_CONFIG_COUNT: String(index + 1),
			[`GIT_CONFIG_KEY_${index}`]: `http.${options.authHost ?? "https://github.com/"}.extraheader`,
			[`GIT_CONFIG_VALUE_${index}`]: `AUTHORIZATION: basic ${basic}`,
		};
	}
	async function blob(id: string): Promise<string | undefined> {
		try {
			const { stdout } = await run(["cat-file", "blob", object(id)], {
				maxBuffer: maxBlobBytes,
			});
			const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
			return text.includes("\0") ? undefined : text;
		} catch {
			// Larger than the limit, or not UTF-8 text.
			return undefined;
		}
	}
	async function conflictFile(
		path: string,
		stages: ReadonlyMap<string, { mode: string; id: string }>,
		textual: boolean,
	): Promise<ConflictFile> {
		const unsupported: ConflictFile = {
			path,
			kind: "unsupported",
			merged: "",
			markerSize: 7,
			bytes: 0,
		};
		const [base, ours, theirs] = ["1", "2", "3"].map((stage) =>
			stages.get(stage),
		);
		if (
			!textual ||
			!ours ||
			!theirs ||
			ours.mode !== theirs.mode ||
			!REGULAR_FILE.has(ours.mode)
		)
			return unsupported;
		// Two branches adding the same path have no common base: merge against nothing.
		const sides = await Promise.all([
			blob(ours.id),
			base ? blob(base.id) : "",
			blob(theirs.id),
		]);
		const [oursText, baseText, theirsText] = sides;
		if (
			oursText === undefined ||
			baseText === undefined ||
			theirsText === undefined
		)
			return unsupported;
		const markerSize = markerSizeFor([oursText, baseText, theirsText]);
		const directory = await mkdtemp(join(tmpdir(), "hobo-ci-agent-"));
		try {
			const names = ["ours", "base", "theirs"].map((name) =>
				join(directory, name),
			);
			await Promise.all(
				names.map((name, index) => writeFile(name, sides[index] ?? "")),
			);
			// The exit code counts conflicts (capped at 127); 255 is a failure.
			const { stdout, code } = await run(
				[
					"merge-file",
					"-p",
					"--zdiff3",
					`--marker-size=${markerSize}`,
					...["ours", "base", "theirs"].flatMap((label) => ["-L", label]),
					...names,
				],
				{ accept: Array.from({ length: 128 }, (_, count) => count) },
			);
			if (code < 0 || code > 127) return unsupported;
			return {
				path,
				kind: "content",
				merged: stdout.toString("utf8"),
				markerSize,
				bytes: Math.max(...sides.map((text) => Buffer.byteLength(text ?? ""))),
				ours: oursText,
				theirs: theirsText,
			};
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
	return {
		async fetch(refs) {
			if (refs.length === 0) return;
			for (const ref of refs)
				if (
					!OBJECT.test(ref) &&
					!/^refs\/(?:heads|pull)\/[A-Za-z0-9._/-]+$/.test(ref)
				)
					throw new Error("refused git ref");
			// Store what was fetched under refs of the agent's own, so the next
			// fetch can tell the remote what it already has.
			const refspecs = refs.map((ref) =>
				OBJECT.test(ref) ? ref : `+${ref}:${FETCHED}${ref.slice(5)}`,
			);
			await run(["fetch", "--quiet", "--no-tags", remote, ...refspecs], {
				env: await remoteAuth(),
			});
		},
		async trial(ours, theirs) {
			const { stdout, code } = await run(
				["merge-tree", "--write-tree", "-z", object(ours), object(theirs)],
				{ accept: [1] },
			);
			const fields = stdout.toString("utf8").split("\0");
			const tree = object(fields[0] ?? "");
			if (code === 0) return { clean: true, tree, files: [] };
			let index = 1;
			const stages = new Map<
				string,
				Map<string, { mode: string; id: string }>
			>();
			for (; fields[index]; index++) {
				const match = /^(\d{6}) ([a-f0-9]+) ([123])\t(.+)$/s.exec(
					fields[index] ?? "",
				);
				if (!match) throw new Error("unexpected trial merge output");
				const [, mode = "", id = "", stage = "", path = ""] = match;
				const entry = stages.get(path) ?? new Map();
				entry.set(stage, { mode, id });
				stages.set(path, entry);
			}
			// Message records: a path count, the paths, a stable type, then free text.
			const types = new Map<string, Set<string>>();
			for (index++; index < fields.length; ) {
				const count = Number(fields[index]);
				if (!Number.isInteger(count) || count < 1) break;
				const paths = fields.slice(index + 1, index + 1 + count);
				const type = fields[index + 1 + count] ?? "";
				for (const path of paths)
					types.set(path, (types.get(path) ?? new Set()).add(type));
				index += count + 3;
			}
			const conflicted = new Set(stages.keys());
			for (const [path, seen] of types)
				if ([...seen].some((type) => type.startsWith("CONFLICT")))
					conflicted.add(path);
			const files = await Promise.all(
				[...conflicted].sort().map((path) =>
					conflictFile(
						path,
						stages.get(path) ?? new Map(),
						[...(types.get(path) ?? [])].every((type) =>
							TEXT_CONFLICTS.has(type),
						),
					),
				),
			);
			return { clean: false, tree, files };
		},
		async commit(input) {
			const directory = await mkdtemp(join(tmpdir(), "hobo-ci-agent-"));
			const env = { GIT_INDEX_FILE: join(directory, "index") };
			try {
				await run(["read-tree", object(input.tree)], { env });
				for (const [path, text] of input.files) {
					const listed = await run(["ls-files", "-s", "-z", "--", path], {
						env,
					});
					const mode = /^(\d{6}) /.exec(listed.stdout.toString("utf8"))?.[1];
					if (!mode || !REGULAR_FILE.has(mode))
						throw new Error("resolved path is not a file in the merged tree");
					const written = await run(["hash-object", "-w", "--stdin"], {
						input: text,
					});
					await run(
						[
							"update-index",
							"--cacheinfo",
							`${mode},${written.stdout.toString("utf8").trim()},${path}`,
						],
						{ env },
					);
				}
				const tree = await run(["write-tree"], { env });
				// Dated by the newer parent, not the clock: the same merge always
				// has the same commit id, so an attempt keyed by commit ids is
				// recognised on the next pass instead of being made again.
				const dates = await run([
					"show",
					"-s",
					"--format=%ct",
					...input.parents.map(object),
				]);
				const seconds = Math.max(
					...dates.stdout
						.toString("utf8")
						.trim()
						.split("\n")
						.map((line) => Number(line)),
				);
				if (!Number.isSafeInteger(seconds))
					throw new Error("unreadable parent commit date");
				const date = `@${seconds} +0000`;
				const treeId = object(tree.stdout.toString("utf8").trim());
				let commit: { stdout: Buffer };
				if (options.signer) {
					// Written as an object so the signature covers exactly what git
					// would have written, and is stored inside it.
					const person = `${identity.name} <${identity.email}> ${seconds} +0000`;
					const unsigned = [
						`tree ${treeId}`,
						...input.parents.map((parent) => `parent ${object(parent)}`),
						`author ${person}`,
						`committer ${person}`,
						"",
						input.message,
					].join("\n");
					commit = await run(["hash-object", "-t", "commit", "-w", "--stdin"], {
						input: signCommitObject(options.signer, unsigned),
					});
				} else
					commit = await run(
						[
							"commit-tree",
							treeId,
							...input.parents.flatMap((parent) => ["-p", object(parent)]),
						],
						{
							input: input.message,
							env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
						},
					);
				const id = object(commit.stdout.toString("utf8").trim());
				// Keep it reachable until it is published, whenever that is.
				await run(["update-ref", `${MADE}${id}`, id]);
				return id;
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		async read(commit, path) {
			try {
				const { stdout } = await run(
					["cat-file", "blob", `${object(commit)}:${path}`],
					{ maxBuffer: maxBlobBytes },
				);
				return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
			} catch {
				return undefined;
			}
		},
		async push(commit, ref) {
			// No `+` and no --force: the remote refuses anything but a fast-forward.
			await run(
				["push", "--quiet", remote, `${object(commit)}:${branchRef(ref)}`],
				{ env: await remoteAuth() },
			);
		},
	};
}
