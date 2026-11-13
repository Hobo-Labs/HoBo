import { constants } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	lstat,
	mkdtemp,
	open,
	rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { acquirePartitionLock } from "./partition-lock.js";

async function absent(path: string): Promise<void> {
	try {
		await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return;
		throw error;
	}
	throw new Error("database operation refuses an existing target or sidecar");
}

async function freshDatabase(path: string): Promise<void> {
	for (const suffix of ["", "-wal", "-shm", "-journal"])
		await absent(`${path}${suffix}`);
}

function integrity(database: DatabaseSync): void {
	const rows = database.prepare("PRAGMA integrity_check").all();
	if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok")
		throw new Error("database integrity check failed");
}

async function publish(snapshot: string, destination: string): Promise<void> {
	const file = await open(snapshot, constants.O_RDWR | constants.O_NOFOLLOW);
	try {
		await file.chmod(0o600);
		await file.sync();
	} finally {
		await file.close();
	}
	await freshDatabase(destination);
	// A same-filesystem hard link publishes atomically and never replaces an existing path.
	await link(snapshot, destination);
	const directory = await open(dirname(destination), constants.O_RDONLY);
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

/** SQLite's online backup includes committed WAL data while the relay is running. */
export async function backupDatabase(
	databasePath: string,
	outputPath: string,
): Promise<void> {
	const destination = resolve(outputPath);
	await freshDatabase(destination);
	const directory = await mkdtemp(
		join(dirname(destination), ".hobo-ci-backup-"),
	);
	const snapshot = join(directory, "snapshot.sqlite");
	try {
		const source = new DatabaseSync(databasePath, {
			readOnly: true,
			timeout: 5000,
		});
		try {
			await backup(source, snapshot);
		} finally {
			source.close();
		}
		const checked = new DatabaseSync(snapshot);
		try {
			checked.exec("PRAGMA journal_mode=DELETE");
			integrity(checked);
		} finally {
			checked.close();
		}
		await publish(snapshot, destination);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Restore only an offline, self-contained snapshot into a new, exclusively locked partition. */
export async function restoreDatabase(
	databasePath: string,
	inputPath: string,
): Promise<void> {
	const destination = resolve(databasePath);
	const lock = await acquirePartitionLock(destination);
	try {
		await freshDatabase(destination);
		for (const suffix of ["-wal", "-shm", "-journal"])
			await absent(`${inputPath}${suffix}`);
		const source = new DatabaseSync(inputPath, {
			readOnly: true,
			timeout: 5000,
		});
		try {
			source.exec("BEGIN");
			integrity(source);
			if (
				Object.values(source.prepare("PRAGMA journal_mode").get() ?? {})[0] !==
				"delete"
			)
				throw new Error("restore requires a self-contained backup snapshot");
			const directory = await mkdtemp(
				join(dirname(destination), ".hobo-ci-restore-"),
			);
			try {
				const snapshot = join(directory, "snapshot.sqlite");
				await copyFile(inputPath, snapshot, constants.COPYFILE_EXCL);
				// copyFile preserves read-only backup modes; only the private copy becomes writable.
				await chmod(snapshot, 0o600);
				const checked = new DatabaseSync(snapshot, { readOnly: true });
				try {
					integrity(checked);
				} finally {
					checked.close();
				}
				await publish(snapshot, destination);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		} finally {
			source.close();
		}
	} finally {
		await lock.release();
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			database: { type: "string" },
			output: { type: "string" },
			input: { type: "string" },
		},
		allowPositionals: true,
	});
	if (positionals.length !== 1 || !values.database)
		throw new Error("invalid database operation arguments");
	if (positionals[0] === "backup" && values.output && !values.input)
		await backupDatabase(values.database, values.output);
	else if (positionals[0] === "restore" && values.input && !values.output)
		await restoreDatabase(values.database, values.input);
	else throw new Error("invalid database operation arguments");
	process.stdout.write("HoBo CI database operation completed.\n");
}

// Not inside a bundled controller release, whose entry is another module.
if (
	process.env.HOBO_CI_RELEASE_BUILD !== "1" &&
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch(() => {
		process.stderr.write("HoBo CI database operation failed.\n");
		process.exitCode = 1;
	});
}
