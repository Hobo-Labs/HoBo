import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { create } from "@bufbuild/protobuf";
import { isJsonString } from "../json.js";
import { digest, normalizePath, normalizeText } from "./text.js";
import {
	type CodegenArtifact,
	CodegenError,
	type DriftEntry,
	DriftEntrySchema,
} from "./types.js";

function safePath(path: string): string {
	const normalized = normalizePath(path);
	const first = normalized.split("/")[0]?.toLowerCase();
	if (
		!normalized ||
		first?.startsWith(".hobo-codegen.lock") ||
		first?.startsWith(".hobo-codegen-") ||
		isAbsolute(path) ||
		/^[A-Za-z]:/u.test(path) ||
		normalized
			.split("/")
			.some((part) => part === ".." || part === "." || part === "") ||
		normalized.includes("\0")
	) {
		throw new CodegenError(
			"HOBO_CODEGEN_UNSAFE_PATH",
			"Generated paths must be non-empty project-relative paths without traversal or reserved codegen control names",
			{ path },
		);
	}
	return normalized;
}

async function rejectSymlinks(base: string, path: string): Promise<void> {
	let current = base;
	for (const part of path.split("/")) {
		current = join(current, part);
		if (!(await pathExists(current))) continue;
		const info = await lstat(current);
		if (info.isSymbolicLink())
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Generated paths cannot traverse symbolic links",
				{ path },
			);
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

async function validateTree(
	projectRoot: string,
	artifacts: readonly CodegenArtifact[],
	roots: readonly string[],
	ownedFiles: readonly string[] = [],
) {
	const base = await realpath(resolve(projectRoot));
	const owned = roots.map(safePath);
	const files = ownedFiles.map(safePath);
	const all = [...owned, ...files];
	for (let index = 0; index < owned.length; index += 1) {
		const root = owned[index];
		if (root === undefined) continue;
		if (
			owned.some(
				(other, otherIndex) =>
					otherIndex !== index &&
					(root === other || root.startsWith(`${other}/`)),
			)
		) {
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Generated roots must be distinct and non-overlapping",
				{ path: root },
			);
		}
		await rejectSymlinks(base, root);
		const absolute = join(base, root);
		if (await pathExists(absolute)) await listFiles(absolute);
	}
	for (let index = 0; index < files.length; index += 1) {
		const file = files[index];
		if (file === undefined) continue;
		if (
			all.some(
				(other, otherIndex) =>
					otherIndex !== owned.length + index &&
					(file === other ||
						file.startsWith(`${other}/`) ||
						other.startsWith(`${file}/`)),
			)
		) {
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Owned files and directory roots must be distinct and non-overlapping",
				{ path: file },
			);
		}
		await rejectSymlinks(base, file);
		const absolute = join(base, file);
		if ((await pathExists(absolute)) && !(await lstat(absolute)).isFile()) {
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Owned leaf paths must be ordinary files",
				{ path: file },
			);
		}
	}
	const paths = new Set<string>();
	for (const artifact of artifacts) {
		const path = safePath(artifact.path);
		if (
			paths.has(path) ||
			!(
				files.includes(path) ||
				owned.some((root) => path.startsWith(`${root}/`))
			)
		) {
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Artifacts must be unique files inside an owned root",
				{ path },
			);
		}
		paths.add(path);
		await rejectSymlinks(base, path);
	}
	return { base, owned, files };
}

export interface GeneratedTreeOptions {
	readonly ownedFiles?: readonly string[] | undefined;
}

export interface GeneratedTreeWriteOptions extends GeneratedTreeOptions {
	readonly rename?: typeof rename;
}

interface RecoveryEntry {
	readonly path: string;
	readonly hadOriginal: boolean;
}

async function acquireTreeLock(base: string): Promise<DatabaseSync> {
	await rejectSymlinks(base, ".hobo-codegen.lock");
	const lock = new DatabaseSync(join(base, ".hobo-codegen.lock"));
	try {
		lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
		return lock;
	} catch (error) {
		lock.close();
		if (
			error instanceof Error &&
			"errcode" in error &&
			(error.errcode === 5 || error.errcode === 6)
		)
			throw new CodegenError(
				"HOBO_CODEGEN_BUSY",
				"Another codegen writer owns this project; retry after it completes",
				{ path: ".hobo-codegen.lock" },
			);
		throw error;
	}
}

function prepareRecovery(
	staging: string,
	entries: readonly RecoveryEntry[],
): void {
	const journal = new DatabaseSync(join(staging, "recovery.sqlite"));
	try {
		journal.exec(
			"PRAGMA synchronous=FULL; BEGIN; CREATE TABLE entries (position INTEGER PRIMARY KEY, path TEXT NOT NULL, had_original INTEGER NOT NULL); CREATE TABLE state (committed INTEGER NOT NULL); INSERT INTO state VALUES (0)",
		);
		const insert = journal.prepare("INSERT INTO entries VALUES (?, ?, ?)");
		entries.forEach((entry, index) => {
			insert.run(index, entry.path, Number(entry.hadOriginal));
		});
		journal.exec("COMMIT");
	} finally {
		journal.close();
	}
}

function commitRecovery(staging: string): void {
	const journal = new DatabaseSync(join(staging, "recovery.sqlite"));
	try {
		journal.exec("PRAGMA synchronous=FULL; UPDATE state SET committed=1");
	} finally {
		journal.close();
	}
}

async function recoverInterruptedTrees(
	base: string,
	roots: readonly string[],
	files: readonly string[],
): Promise<void> {
	for (const entry of await readdir(base, { withFileTypes: true })) {
		if (!entry.name.startsWith(".hobo-codegen-")) continue;
		if (!entry.isDirectory())
			throw new CodegenError(
				"HOBO_CODEGEN_UNSAFE_PATH",
				"Codegen recovery requires an ordinary staging directory",
				{ path: entry.name },
			);
		const staging = join(base, entry.name);
		await listFiles(staging);
		const journalPath = join(staging, "recovery.sqlite");
		if (await pathExists(journalPath)) {
			const journal = new DatabaseSync(journalPath);
			try {
				const prepared = journal
					.prepare(
						"SELECT name FROM sqlite_master WHERE type='table' AND name='state'",
					)
					.get();
				if (
					prepared &&
					journal.prepare("SELECT committed FROM state").get()?.committed !== 1
				) {
					const entries = journal
						.prepare(
							"SELECT path, had_original FROM entries ORDER BY position DESC",
						)
						.all();
					const validated = entries.map((record) => {
						if (
							!isJsonString(record.path) ||
							(record.had_original !== 0 && record.had_original !== 1)
						)
							throw new CodegenError(
								"HOBO_CODEGEN_UNSAFE_PATH",
								"Invalid codegen recovery journal",
							);
						const path = safePath(record.path);
						if (
							!files.includes(path) &&
							!roots.some(
								(root) => path === root || path.startsWith(`${root}/`),
							)
						)
							throw new CodegenError(
								"HOBO_CODEGEN_UNSAFE_PATH",
								"Recovery journal exceeds configured generated ownership",
								{ path },
							);
						return { path, hadOriginal: record.had_original === 1 };
					});
					for (const { path, hadOriginal } of validated) {
						await rejectSymlinks(base, path);
						const target = join(base, path);
						const backup = join(staging, "old", path);
						if (await pathExists(backup)) {
							await rm(target, { recursive: true, force: true });
							await rename(backup, target);
						} else if (!hadOriginal)
							await rm(target, { recursive: true, force: true });
					}
				}
			} finally {
				journal.close();
			}
		}
		await rm(staging, { recursive: true, force: true });
	}
}

export async function recoverGeneratedTree(
	projectRoot: string,
	ownership: {
		readonly generatedRoots: readonly string[];
		readonly ownedFiles?: readonly string[] | undefined;
	} = { generatedRoots: [".hobo/generated", "src/_generated", ".hobo/build"] },
): Promise<void> {
	const base = await realpath(resolve(projectRoot));
	const lock = await acquireTreeLock(base);
	try {
		await recoverInterruptedTrees(
			base,
			ownership.generatedRoots.map(safePath),
			(ownership.ownedFiles ?? []).map(safePath),
		);
	} finally {
		lock.close();
	}
}

export async function writeGeneratedTree(
	projectRoot: string,
	artifacts: readonly CodegenArtifact[],
	generatedRoots: readonly string[],
	options: GeneratedTreeWriteOptions = {},
): Promise<void> {
	const { base, owned, files } = await validateTree(
		projectRoot,
		artifacts,
		generatedRoots,
		options.ownedFiles,
	);
	const lock = await acquireTreeLock(base);
	try {
		await recoverInterruptedTrees(base, owned, files);
		await validateTree(
			projectRoot,
			artifacts,
			generatedRoots,
			options.ownedFiles,
		);
		const staging = await mkdtemp(join(base, ".hobo-codegen-"));
		const move = options.rename ?? rename;
		const swapped: Array<{
			target: string;
			backup: string;
			hadOriginal: boolean;
			installed: boolean;
		}> = [];
		let preserveBackup = false;
		try {
			for (const root of owned)
				await mkdir(join(staging, "new", root), { recursive: true });
			for (const artifact of artifacts) {
				const target = join(staging, "new", safePath(artifact.path));
				await mkdir(dirname(target), { recursive: true });
				await writeFile(
					target,
					artifact.binaryContent ?? normalizeText(artifact.content),
				);
			}
			const entries = await Promise.all(
				[...owned, ...files].map(async (path) => ({
					path,
					hadOriginal: await pathExists(join(base, path)),
				})),
			);
			prepareRecovery(staging, entries);
			for (const { path: root, hadOriginal } of entries) {
				await rejectSymlinks(base, root);
				const target = join(base, root);
				const backup = join(staging, "old", root);
				await mkdir(dirname(target), { recursive: true });
				await mkdir(dirname(backup), { recursive: true });
				if (hadOriginal) await move(target, backup);
				const state = { target, backup, hadOriginal, installed: false };
				swapped.push(state);
				const staged = join(staging, "new", root);
				if (await pathExists(staged)) {
					await move(staged, target);
					state.installed = true;
				}
			}
			commitRecovery(staging);
		} catch (error) {
			const failures: unknown[] = [];
			for (const state of swapped.reverse()) {
				try {
					if (state.installed)
						await rm(state.target, { recursive: true, force: true });
					if (state.hadOriginal) await rename(state.backup, state.target);
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
			if (failures.length) {
				preserveBackup = true;
				throw new AggregateError(
					[error, ...failures],
					`Codegen rollback failed; preserved recovery data at ${staging}`,
				);
			}
			throw error;
		} finally {
			if (!preserveBackup) await rm(staging, { recursive: true, force: true });
		}
	} finally {
		lock.close();
	}
}

export async function compareGeneratedTree(
	projectRoot: string,
	artifacts: readonly CodegenArtifact[],
	generatedRoots: readonly string[],
	options: GeneratedTreeOptions = {},
): Promise<readonly DriftEntry[]> {
	const { base, owned, files } = await validateTree(
		projectRoot,
		artifacts,
		generatedRoots,
		options.ownedFiles,
	);
	const lock = await acquireTreeLock(base);
	try {
		await recoverInterruptedTrees(base, owned, files);
		const expected = new Map(
			artifacts.map((artifact) => [normalizePath(artifact.path), artifact]),
		);
		const actual = await readGeneratedTree(base, owned, files);
		const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
		const drift: DriftEntry[] = [];

		for (const path of paths) {
			const artifact = expected.get(path);
			const actualBytes = actual.get(path);
			if (artifact === undefined) {
				if (actualBytes === undefined) continue;
				const decoded = Buffer.from(actualBytes).toString("utf8");
				const text =
					Buffer.from(decoded).equals(Buffer.from(actualBytes)) &&
					!decoded.includes("\0");
				drift.push(
					create(DriftEntrySchema, {
						path,
						status: "extra",
						actualDigest: text ? digest(decoded) : byteDigest(actualBytes),
					}),
				);
				continue;
			}
			const binary = artifact.binaryContent;
			const expectedText =
				binary === undefined ? normalizeText(artifact.content) : undefined;
			const expectedDigest =
				binary === undefined ? digest(expectedText ?? "") : byteDigest(binary);
			if (actualBytes === undefined) {
				drift.push(
					create(DriftEntrySchema, { path, status: "missing", expectedDigest }),
				);
				continue;
			}
			const actualText =
				binary === undefined
					? normalizeText(Buffer.from(actualBytes).toString("utf8"))
					: undefined;
			const equal =
				binary === undefined
					? actualText === expectedText
					: Buffer.from(binary).equals(Buffer.from(actualBytes));
			if (!equal) {
				drift.push(
					create(DriftEntrySchema, {
						path,
						status: "changed",
						expectedDigest,
						actualDigest:
							binary === undefined
								? digest(actualText ?? "")
								: byteDigest(actualBytes),
					}),
				);
			}
		}

		return drift;
	} finally {
		lock.close();
	}
}

function byteDigest(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readGeneratedTree(
	projectRoot: string,
	generatedRoots: readonly string[],
	ownedFiles: readonly string[],
): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	for (const root of generatedRoots) {
		const absoluteRoot = join(projectRoot, root);
		if (!existsSync(absoluteRoot)) continue;
		for (const path of await listFiles(absoluteRoot)) {
			const fullPath = join(absoluteRoot, path);
			files.set(normalizePath(join(root, path)), await readFile(fullPath));
		}
	}
	for (const file of ownedFiles) {
		const absolute = join(projectRoot, file);
		if (await pathExists(absolute)) files.set(file, await readFile(absolute));
	}
	return files;
}

async function listFiles(root: string): Promise<readonly string[]> {
	const files: string[] = [];

	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink())
				throw new CodegenError(
					"HOBO_CODEGEN_UNSAFE_PATH",
					"Generated trees cannot contain symbolic links",
					{ path },
				);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile())
				throw new CodegenError(
					"HOBO_CODEGEN_UNSAFE_PATH",
					"Generated trees may contain only ordinary files and directories",
					{ path },
				);
			files.push(relative(root, path).replace(/\\/g, "/"));
		}
	}

	await visit(root);
	return files.sort();
}
