import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { backupDatabase, restoreDatabase } from "../src/ops.js";
import { acquirePartitionLock } from "../src/partition-lock.js";

const execute = promisify(execFile);

it("holds the same kernel lock across aliases and releases idempotently", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-partition-"));
	const path = join(directory, "ci.sqlite");
	const alias = `${directory}-alias`;
	await symlink(directory, alias);
	try {
		const lock = await acquirePartitionLock(path);
		try {
			await expect(
				acquirePartitionLock(join(alias, "ci.sqlite")),
			).rejects.toThrow(/locked/);
			expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
		} finally {
			await Promise.all([lock.release(), lock.release()]);
		}
		const next = await acquirePartitionLock(path);
		await next.release();
	} finally {
		await rm(alias);
		await rm(directory, { recursive: true, force: true });
	}
});

it("refuses symlink lock files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-lock-symlink-"));
	try {
		const target = join(directory, "untouched");
		await writeFile(target, "preserve");
		const path = join(directory, "ci.sqlite");
		await symlink(target, `${path}.lock`);
		await expect(acquirePartitionLock(path)).rejects.toThrow();
		expect(await readFile(target, "utf8")).toBe("preserve");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("retains ownership if the lock helper crashes while its parent is alive", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-lock-helper-"));
	const children = async () => {
		const { stdout } = await execute("ps", [
			"-o",
			"pid=,comm=",
			"--ppid",
			String(process.pid),
		]);
		return stdout
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((fields) => fields[1] === "sh")
			.map((fields) => fields[0]);
	};
	try {
		const before = await children();
		const path = join(directory, "ci.sqlite");
		const lock = await acquirePartitionLock(path);
		try {
			const added = (await children()).filter((pid) => !before.includes(pid));
			expect(added).toHaveLength(1);
			process.kill(-Number(added[0]), "SIGKILL");
			await expect(acquirePartitionLock(path)).rejects.toThrow(/locked/);
		} finally {
			await lock.release();
		}
		const replacement = await acquirePartitionLock(path);
		await replacement.release();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("releases the kernel lock after the relay process crashes without deleting its lock file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-lock-crash-"));
	const path = join(directory, "ci.sqlite");
	const program =
		'import {acquirePartitionLock} from "./src/partition-lock.ts"; await acquirePartitionLock(process.argv[1]); console.log("READY"); setInterval(()=>{},1000);';
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--input-type=module", "-e", program, path],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	const stopped = once(child, "exit");
	try {
		await new Promise<void>((ready, reject) => {
			child.stdout.on("data", (chunk) => {
				if (String(chunk).includes("READY")) ready();
			});
			child.once("error", reject);
			child.once("exit", () =>
				reject(new Error("lock owner exited before ready")),
			);
		});
		await expect(acquirePartitionLock(path)).rejects.toThrow(/locked/);
		child.kill("SIGKILL");
		await stopped;
		let replacement:
			| Awaited<ReturnType<typeof acquirePartitionLock>>
			| undefined;
		for (let attempt = 0; attempt < 40 && !replacement; attempt++) {
			try {
				replacement = await acquirePartitionLock(path);
			} catch {
				await new Promise((ready) => setTimeout(ready, 25));
			}
		}
		expect(replacement).toBeDefined();
		await replacement?.release();
		expect((await lstat(`${path}.lock`)).isFile()).toBe(true);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	0o600, 0o444,
])("restores a private standalone WAL snapshot from input mode %i", async (mode) => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-wal-backup-"));
	const source = join(directory, "live.sqlite");
	const output = join(directory, "backup.sqlite");
	const destination = join(directory, "restored.sqlite");
	const database = new DatabaseSync(source);
	try {
		database.exec(
			"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('committed WAL record');",
		);
		expect((await stat(`${source}-wal`)).size).toBeGreaterThan(0);
		await backupDatabase(source, output);
		expect((await stat(output)).mode & 0o777).toBe(0o600);
		const input = await readFile(output);
		await chmod(output, mode);
		await execute(
			process.execPath,
			[
				"--import",
				"tsx",
				"src/ops.ts",
				"restore",
				"--database",
				destination,
				"--input",
				output,
			],
			{ cwd: process.cwd() },
		);
		const restored = new DatabaseSync(destination, { readOnly: true });
		try {
			expect(restored.prepare("SELECT value FROM evidence").get()?.value).toBe(
				"committed WAL record",
			);
			expect(
				restored.prepare("PRAGMA integrity_check").get()?.integrity_check,
			).toBe("ok");
		} finally {
			restored.close();
		}
		expect((await stat(destination)).mode & 0o777).toBe(0o600);
		expect((await stat(output)).mode & 0o777).toBe(mode);
		expect(await readFile(output)).toEqual(input);
	} finally {
		database.close();
		await rm(directory, { recursive: true, force: true });
	}
}, 15000);

it("refuses overwrites, stale destination sidecars, locked restores and invalid inputs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-restore-refusal-"));
	const source = join(directory, "source.sqlite");
	const backupPath = join(directory, "backup.sqlite");
	const destination = join(directory, "restored.sqlite");
	const database = new DatabaseSync(source);
	database.exec(
		"CREATE TABLE state(value TEXT); INSERT INTO state VALUES ('original');",
	);
	database.close();
	try {
		await backupDatabase(source, backupPath);
		const original = await readFile(backupPath);
		await expect(backupDatabase(source, backupPath)).rejects.toThrow(
			/existing/,
		);
		expect(await readFile(backupPath)).toEqual(original);
		const lock = await acquirePartitionLock(destination);
		try {
			await expect(restoreDatabase(destination, backupPath)).rejects.toThrow(
				/locked/,
			);
		} finally {
			await lock.release();
		}
		await writeFile(`${destination}-wal`, "stale sidecar");
		await expect(restoreDatabase(destination, backupPath)).rejects.toThrow(
			/existing/,
		);
		expect(await readFile(`${destination}-wal`, "utf8")).toBe("stale sidecar");
		await rm(`${destination}-wal`);
		await writeFile(destination, "preserve existing target");
		await expect(restoreDatabase(destination, backupPath)).rejects.toThrow(
			/existing/,
		);
		expect(await readFile(destination, "utf8")).toBe(
			"preserve existing target",
		);
		await rm(destination);
		await writeFile(join(directory, "invalid.sqlite"), "not a database");
		await expect(
			restoreDatabase(destination, join(directory, "invalid.sqlite")),
		).rejects.toThrow();
		await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
