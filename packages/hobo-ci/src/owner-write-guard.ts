import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { OwnerStoreOperationUncertainError } from "./owner-store-errors.js";

const UNAVAILABLE =
	"The owner store write guard is unavailable; the operation was refused.";
const BUSY =
	"Another owner store operation is active; try again when it finishes.";
const STALE = "The owner session changed. Start this operation again.";

export class OwnerWriteGuardUnavailableError extends Error {
	constructor() {
		super(UNAVAILABLE);
	}
}

export interface OwnerWriteGuardPlatform {
	readonly noFollow: number | undefined;
	readonly sync: (fd: number) => void;
	readonly commitCleanup?: (database: DatabaseSync) => void;
	readonly commitStart?: (database: DatabaseSync) => void;
}

interface OwnerPreparationSnapshot {
	readonly settingsRevision: number;
	readonly operationRevision: number;
}

const nativePlatform: OwnerWriteGuardPlatform = {
	noFollow: constants.O_NOFOLLOW,
	sync: fsyncSync,
};
const noFollowFlag = z.number().int().positive();
const selectionRow = z.object({
	generation: z.string(),
	requires_choice: z.union([z.literal(0), z.literal(1)]),
});
const nonceRow = z.object({ nonce: z.string() });
const revisionRow = z.object({
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

function noFollow(platform: OwnerWriteGuardPlatform): number {
	const flag = noFollowFlag.safeParse(platform.noFollow);
	if (!flag.success) throw new OwnerWriteGuardUnavailableError();
	return flag.data;
}

function ownedByCurrentUser(uid: number): boolean {
	const current = process.getuid?.();
	return current === undefined || uid === current;
}

function isInside(directory: string, candidate: string): boolean {
	const relative = path.relative(directory, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
}

function hasGitHead(directory: string): boolean {
	try {
		return statSync(path.join(directory, "HEAD")).isFile();
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return false;
		throw error;
	}
}

function isBareGitDirectory(directory: string): boolean {
	if (!hasGitHead(directory)) return false;
	try {
		return (
			statSync(path.join(directory, "objects")).isDirectory() &&
			statSync(path.join(directory, "refs")).isDirectory()
		);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return false;
		throw error;
	}
}

function projectRoot(cwd: string): string | undefined {
	let current = cwd;
	for (;;) {
		const git = path.join(current, ".git");
		let entry: ReturnType<typeof lstatSync> | undefined;
		try {
			entry = lstatSync(git);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		if (entry !== undefined) {
			const info = entry.isSymbolicLink() ? statSync(git) : entry;
			if (info.isDirectory() && hasGitHead(git)) return current;
			if (info.isFile() && info.size <= 4096) {
				const match = /^gitdir: (.+)\s*$/u.exec(readFileSync(git, "utf8"));
				if (match?.[1] && hasGitHead(path.resolve(current, match[1].trim())))
					return current;
			}
		}
		if (isBareGitDirectory(current)) return current;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function assertSafeDirectoryChain(directory: string): void {
	const uid = process.getuid?.();
	let current = realpathSync(directory);
	const rootOwner = lstatSync(path.parse(current).root).uid;
	for (;;) {
		const info = lstatSync(current);
		const parent = path.dirname(current);
		if (
			!info.isDirectory() ||
			(uid !== undefined &&
				info.uid !== uid &&
				info.uid !== 0 &&
				info.uid !== rootOwner) ||
			((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
		)
			throw new Error();
		if (parent === current) return;
		current = parent;
	}
}

function guardFile(scope: string, cwd: string): string {
	const state =
		process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state");
	const directory = path.resolve(state, "hobo", "owner-write-guards");
	try {
		const project = realpathSync(cwd);
		if (
			project !== path.resolve(cwd) ||
			!statSync(project).isDirectory() ||
			(scope !== `ci\u0000${project}` && scope !== `cd\u0000${project}`)
		)
			throw new Error();
		const root = projectRoot(project);
		let ancestor = directory;
		while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
		if (
			(root !== undefined && isInside(root, directory)) ||
			projectRoot(realpathSync(ancestor)) !== undefined
		)
			throw new Error();
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const info = lstatSync(directory);
		const resolved = realpathSync(directory);
		assertSafeDirectoryChain(resolved);
		if (
			!info.isDirectory() ||
			(info.mode & 0o077) !== 0 ||
			!ownedByCurrentUser(info.uid) ||
			(root !== undefined && isInside(root, resolved)) ||
			projectRoot(resolved) !== undefined
		)
			throw new Error();
		const name = createHash("sha256").update(scope).digest("hex");
		return path.join(directory, `${name}.sqlite`);
	} catch {
		throw new OwnerWriteGuardUnavailableError();
	}
}

function syncAncestors(
	directory: string,
	platform: OwnerWriteGuardPlatform,
): void {
	let current = realpathSync(directory);
	for (;;) {
		const handle = openSync(current, constants.O_RDONLY | noFollow(platform));
		try {
			if (!fstatSync(handle).isDirectory()) throw new Error();
			platform.sync(handle);
		} finally {
			closeSync(handle);
		}
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function openGuard(
	file: string,
	platform: OwnerWriteGuardPlatform,
): DatabaseSync {
	try {
		try {
			const handle = openSync(
				file,
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_RDWR |
					noFollow(platform),
				0o600,
			);
			closeSync(handle);
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "EEXIST")
			)
				throw error;
		}
		const handle = openSync(file, constants.O_RDWR | noFollow(platform));
		try {
			const info = fstatSync(handle);
			if (
				!info.isFile() ||
				(info.mode & 0o077) !== 0 ||
				!ownedByCurrentUser(info.uid)
			)
				throw new Error();
			platform.sync(handle);
		} finally {
			closeSync(handle);
		}
		syncAncestors(path.dirname(file), platform);
		const database = new DatabaseSync(file);
		try {
			database.exec("PRAGMA busy_timeout = 0; PRAGMA synchronous = EXTRA");
		} catch (error) {
			database.close();
			throw error;
		}
		return database;
	} catch {
		throw new OwnerWriteGuardUnavailableError();
	}
}

function begin(database: DatabaseSync): void {
	try {
		database.exec("BEGIN IMMEDIATE");
	} catch (error) {
		if (
			error instanceof Error &&
			"errcode" in error &&
			(error.errcode === 5 || error.errcode === 6)
		)
			throw new Error(BUSY);
		throw new OwnerWriteGuardUnavailableError();
	}
}

async function beginCleanup(database: DatabaseSync): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			begin(database);
			return;
		} catch (error) {
			if (!(error instanceof Error && error.message === BUSY) || attempt >= 49)
				throw error;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

function initialize(database: DatabaseSync): void {
	database.exec(
		"CREATE TABLE IF NOT EXISTS owner_write_guard (id INTEGER PRIMARY KEY CHECK (id = 1), nonce TEXT NOT NULL)",
	);
	database.exec(
		"CREATE TABLE IF NOT EXISTS owner_selection (id INTEGER PRIMARY KEY CHECK (id = 1), generation TEXT NOT NULL, requires_choice INTEGER NOT NULL CHECK (requires_choice IN (0, 1)))",
	);
	database.exec(
		"CREATE TABLE IF NOT EXISTS owner_settings_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0))",
	);
	database.exec(
		"CREATE TABLE IF NOT EXISTS owner_operation_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL CHECK (revision >= 0))",
	);
	database
		.prepare(
			"INSERT OR IGNORE INTO owner_selection (id, generation, requires_choice) VALUES (1, ?, 0)",
		)
		.run(randomUUID());
	database
		.prepare(
			"INSERT OR IGNORE INTO owner_settings_revision (id, revision) VALUES (1, 0)",
		)
		.run();
	database
		.prepare(
			"INSERT OR IGNORE INTO owner_operation_revision (id, revision) VALUES (1, 0)",
		)
		.run();
}

function selection(
	database: DatabaseSync,
): { generation: string; requiresChoice: boolean } | undefined {
	const table = database
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'owner_selection'",
		)
		.get();
	if (table === undefined) return undefined;
	const row = database
		.prepare(
			"SELECT generation, requires_choice FROM owner_selection WHERE id = 1",
		)
		.get();
	if (row === undefined) return undefined;
	const parsed = selectionRow.safeParse(row);
	if (!parsed.success) throw new OwnerWriteGuardUnavailableError();
	return {
		generation: parsed.data.generation,
		requiresChoice: parsed.data.requires_choice === 1,
	};
}

function nonce(database: DatabaseSync): string | undefined {
	const row = database
		.prepare("SELECT nonce FROM owner_write_guard WHERE id = 1")
		.get();
	if (row === undefined) return undefined;
	const parsed = nonceRow.safeParse(row);
	if (!parsed.success) throw new OwnerWriteGuardUnavailableError();
	return parsed.data.nonce;
}

function settingsRevision(database: DatabaseSync): number | undefined {
	const table = database
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'owner_settings_revision'",
		)
		.get();
	if (table === undefined) return undefined;
	const row = database
		.prepare("SELECT revision FROM owner_settings_revision WHERE id = 1")
		.get();
	if (row === undefined) return undefined;
	const parsed = revisionRow.safeParse(row);
	if (!parsed.success) throw new OwnerWriteGuardUnavailableError();
	return parsed.data.revision;
}

function incrementSettingsRevision(database: DatabaseSync): number {
	const result = database
		.prepare(
			"UPDATE owner_settings_revision SET revision = revision + 1 WHERE id = 1 AND revision < ?",
		)
		.run(Number.MAX_SAFE_INTEGER);
	if (result.changes !== 1) throw new OwnerWriteGuardUnavailableError();
	const next = settingsRevision(database);
	if (next === undefined) throw new OwnerWriteGuardUnavailableError();
	return next;
}

function operationRevision(database: DatabaseSync): number {
	const row = database
		.prepare("SELECT revision FROM owner_operation_revision WHERE id = 1")
		.get();
	const parsed = revisionRow.safeParse(row);
	if (!parsed.success) throw new OwnerWriteGuardUnavailableError();
	return parsed.data.revision;
}

function incrementOperationRevision(database: DatabaseSync): void {
	const result = database
		.prepare(
			"UPDATE owner_operation_revision SET revision = revision + 1 WHERE id = 1 AND revision < ?",
		)
		.run(Number.MAX_SAFE_INTEGER);
	if (result.changes !== 1) throw new OwnerWriteGuardUnavailableError();
}

function rollback(database: DatabaseSync): void {
	try {
		database.exec("ROLLBACK");
	} catch {}
}

function hasMarker(file: string, suffix: ".uncertain" | ".cleanup"): boolean {
	try {
		lstatSync(`${file}${suffix}`);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw new OwnerWriteGuardUnavailableError();
	}
}

function hasUncertainMarker(file: string): boolean {
	return hasMarker(file, ".uncertain") || hasMarker(file, ".cleanup");
}

function persistCleanupMarker(
	file: string,
	platform: OwnerWriteGuardPlatform,
): void {
	const handle = openSync(
		`${file}.cleanup`,
		constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			noFollow(platform),
		0o600,
	);
	try {
		platform.sync(handle);
	} finally {
		closeSync(handle);
	}
	syncAncestors(path.dirname(file), platform);
}

function persistUncertainMarker(
	file: string,
	platform: OwnerWriteGuardPlatform,
): void {
	try {
		const marker = `${file}.uncertain`;
		const handle = openSync(
			marker,
			constants.O_CREAT | constants.O_WRONLY | noFollow(platform),
			0o600,
		);
		try {
			const info = lstatSync(marker);
			if (
				!info.isFile() ||
				(info.mode & 0o077) !== 0 ||
				!ownedByCurrentUser(info.uid)
			)
				throw new Error();
			platform.sync(handle);
		} finally {
			closeSync(handle);
		}
		syncAncestors(path.dirname(file), platform);
	} catch {
		throw new OwnerWriteGuardUnavailableError();
	}
}

async function clearOwnNonce(
	database: DatabaseSync,
	file: string,
	own: string,
	uncertain: () => boolean,
	platform: OwnerWriteGuardPlatform,
): Promise<boolean> {
	try {
		if (uncertain() || hasUncertainMarker(file)) return false;
		await beginCleanup(database);
		if (uncertain() || hasUncertainMarker(file)) {
			rollback(database);
			return false;
		}
		if (nonce(database) !== own) throw new OwnerStoreOperationUncertainError();
		persistCleanupMarker(file, platform);
		database
			.prepare("DELETE FROM owner_write_guard WHERE id = 1 AND nonce = ?")
			.run(own);
		if (platform.commitCleanup) platform.commitCleanup(database);
		else database.exec("COMMIT");
		if (uncertain() || hasMarker(file, ".uncertain")) return false;
		unlinkSync(`${file}.cleanup`);
		syncAncestors(path.dirname(file), platform);
		return !uncertain() && !hasMarker(file, ".uncertain");
	} catch {
		rollback(database);
		try {
			persistUncertainMarker(file, platform);
		} catch {}
		throw new OwnerStoreOperationUncertainError();
	}
}

export function ownerWriteGuard(
	scope: string,
	cwd: string,
	platform: OwnerWriteGuardPlatform = nativePlatform,
) {
	const file = () => guardFile(scope, cwd);
	return {
		currentSelection(): { generation: string; requiresChoice: boolean } {
			const database = openGuard(file(), platform);
			try {
				let selected = selection(database);
				if (selected === undefined) {
					begin(database);
					initialize(database);
					selected = selection(database);
					if (selected === undefined)
						throw new OwnerWriteGuardUnavailableError();
					database.exec("COMMIT");
				}
				return selected;
			} catch (error) {
				rollback(database);
				if (error instanceof Error && error.message === BUSY) throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		changeGeneration(expected: string): string {
			const selected = file();
			const database = openGuard(selected, platform);
			try {
				begin(database);
				initialize(database);
				if (hasUncertainMarker(selected) || nonce(database) !== undefined)
					throw new OwnerStoreOperationUncertainError();
				if (selection(database)?.generation !== expected)
					throw new Error(STALE);
				const next = randomUUID();
				database
					.prepare(
						"UPDATE owner_selection SET generation = ?, requires_choice = 1 WHERE id = 1",
					)
					.run(next);
				incrementSettingsRevision(database);
				database.exec("COMMIT");
				return next;
			} catch (error) {
				rollback(database);
				if (
					error instanceof OwnerStoreOperationUncertainError ||
					(error instanceof Error && [BUSY, STALE].includes(error.message))
				)
					throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		currentSettingsRevision(): number {
			const database = openGuard(file(), platform);
			try {
				let current = settingsRevision(database);
				if (current === undefined) {
					begin(database);
					initialize(database);
					current = settingsRevision(database);
					if (current === undefined)
						throw new OwnerWriteGuardUnavailableError();
					database.exec("COMMIT");
				}
				return current;
			} catch (error) {
				rollback(database);
				if (error instanceof Error && error.message === BUSY) throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		currentPreparationSnapshot(expected: string): OwnerPreparationSnapshot {
			const selected = file();
			const database = openGuard(selected, platform);
			try {
				begin(database);
				initialize(database);
				if (hasUncertainMarker(selected) || nonce(database) !== undefined)
					throw new OwnerStoreOperationUncertainError();
				if (selection(database)?.generation !== expected)
					throw new Error(STALE);
				const settings = settingsRevision(database);
				if (settings === undefined) throw new OwnerWriteGuardUnavailableError();
				const operation = operationRevision(database);
				database.exec("COMMIT");
				return { settingsRevision: settings, operationRevision: operation };
			} catch (error) {
				rollback(database);
				if (
					error instanceof OwnerStoreOperationUncertainError ||
					(error instanceof Error && [BUSY, STALE].includes(error.message))
				)
					throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		advanceSettingsRevision(expected: string, ownerNonce?: string): number {
			const selected = file();
			const database = openGuard(selected, platform);
			try {
				begin(database);
				initialize(database);
				if (selection(database)?.generation !== expected)
					throw new Error(STALE);
				const active = nonce(database);
				if (
					hasUncertainMarker(selected) ||
					(active !== undefined && active !== ownerNonce) ||
					(ownerNonce !== undefined && active !== ownerNonce)
				)
					throw new OwnerStoreOperationUncertainError();
				const next = incrementSettingsRevision(database);
				database.exec("COMMIT");
				return next;
			} catch (error) {
				rollback(database);
				if (
					error instanceof OwnerStoreOperationUncertainError ||
					(error instanceof Error && [BUSY, STALE].includes(error.message))
				)
					throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		assertClear() {
			const selected = file();
			if (hasUncertainMarker(selected))
				throw new OwnerStoreOperationUncertainError();
			if (!existsSync(selected)) return;
			const database = openGuard(selected, platform);
			try {
				if (nonce(database) !== undefined)
					throw new OwnerStoreOperationUncertainError();
			} catch (error) {
				if (error instanceof OwnerStoreOperationUncertainError) throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
		markUncertain() {
			persistUncertainMarker(file(), platform);
		},
		async run<T>(
			write: (ownerNonce: string) => Promise<T>,
			uncertain: () => boolean,
			expectedGeneration?: string,
			preflight?: () => true,
			uncertainBeforeDispatch: () => boolean = uncertain,
			expectedSnapshot?: OwnerPreparationSnapshot,
		): Promise<T> {
			const selected = file();
			const database = openGuard(selected, platform);
			const own = randomUUID();
			let writeFailed = false;
			try {
				begin(database);
				initialize(database);
				if (hasUncertainMarker(selected) || nonce(database) !== undefined)
					throw new OwnerStoreOperationUncertainError();
				if (
					expectedGeneration !== undefined &&
					selection(database)?.generation !== expectedGeneration
				)
					throw new Error(STALE);
				if (
					expectedSnapshot !== undefined &&
					(settingsRevision(database) !== expectedSnapshot.settingsRevision ||
						operationRevision(database) !== expectedSnapshot.operationRevision)
				)
					throw new Error(STALE);
				database
					.prepare("INSERT INTO owner_write_guard (id, nonce) VALUES (1, ?)")
					.run(own);
				incrementOperationRevision(database);
				if (platform.commitStart) platform.commitStart(database);
				else database.exec("COMMIT");
				if (hasUncertainMarker(selected) || nonce(database) !== own)
					throw new OwnerStoreOperationUncertainError();
				if (
					expectedGeneration !== undefined &&
					selection(database)?.generation !== expectedGeneration
				)
					throw new Error(STALE);
				try {
					preflight?.();
				} catch (error) {
					writeFailed = true;
					if (
						!(await clearOwnNonce(
							database,
							selected,
							own,
							uncertainBeforeDispatch,
							platform,
						))
					)
						throw new OwnerStoreOperationUncertainError();
					throw error;
				}
				let outcome: T;
				try {
					outcome = await write(own);
				} catch (error) {
					writeFailed = true;
					throw error;
				}
				if (
					!(await clearOwnNonce(database, selected, own, uncertain, platform))
				)
					throw new OwnerStoreOperationUncertainError();
				return outcome;
			} catch (error) {
				rollback(database);
				if (
					writeFailed ||
					error instanceof OwnerStoreOperationUncertainError ||
					(error instanceof Error &&
						(error.message === BUSY || error.message === STALE))
				)
					throw error;
				throw new OwnerWriteGuardUnavailableError();
			} finally {
				database.close();
			}
		},
	};
}
