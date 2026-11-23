import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const [source, database, replicaUrl, executable, mode, log] =
	process.argv.slice(2);
const storage = await import(pathToFileURL(source));
const options = {
	replicaUrl:
		replicaUrl === "default" ? storage.replicaUrlFor(database) : replicaUrl,
	executable,
	stdio: "ignore",
};

if (mode === "contract") {
	const db = storage.openStore(database);
	db.exec(
		"CREATE TABLE items (value TEXT NOT NULL); INSERT INTO items VALUES ('first')",
	);
	assert.equal(db.prepare("SELECT value FROM items").get().value, "first");
	assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
	assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
	db.close();
	assert.equal(
		storage.replicaUrlFor(database),
		storage.replicaUrlFor(database),
	);
	assert.ok(
		fileURLToPath(storage.replicaUrlFor(database)).startsWith(
			`${process.env.HOBO_HOME}/durable/replicas/`,
		),
	);
	assert.notEqual(
		storage.replicaUrlFor(database),
		storage.replicaUrlFor(`${database}.other`),
	);
	assert.throws(() => storage.replicaUrlFor(":memory:"), /persistent/);
	assert.throws(
		() =>
			storage.replicaUrlFor(database, { replicaUrl: "https://example.com" }),
		/file: or nats:/,
	);
	assert.throws(
		() => storage.replicaUrlFor(database, { replicaUrl: "nats://localhost" }),
		/bucket/,
	);
	assert.throws(
		() =>
			storage.replicaUrlFor(database, {
				replicaUrl: "nats://user:secret@localhost/bucket",
			}),
		/credentials file/,
	);
	await assert.rejects(
		storage.syncReplica(database, {
			...options,
			natsCredentialsFile: "/tmp/nats.creds",
		}),
		/NATS credentials require/,
	);
	const child = await storage.startReplication(database, options);
	await once(child, "exit");
	await storage.syncReplica(database, options);
	await storage.syncReplica(database, {
		...options,
		replicaUrl: "nats://localhost:4222/bucket",
		natsCredentialsFile: "/tmp/nats.creds",
	});
	await assert.rejects(storage.restoreStore(database, options), /exit 42/);
	await assert.rejects(
		storage.startReplication(database, { executable: `${executable}.missing` }),
		/ENOENT/,
	);
	const records = readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	for (
		let attempt = 0;
		attempt < 20 && records.some(({ configPath }) => existsSync(configPath));
		attempt++
	) {
		await delay(10);
	}
	assert.ok(records.every(({ configPath }) => !existsSync(configPath)));
	process.stdout.write(JSON.stringify(records));
} else {
	const db = storage.openStore(database);
	db.exec(
		"CREATE TABLE items (value TEXT NOT NULL); INSERT INTO items VALUES ('first')",
	);
	const child = await storage.startReplication(database, options);
	let attempt = 0;
	async function restoredValues(expected) {
		const deadline = Date.now() + 30000;
		let lastError;
		while (Date.now() < deadline) {
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(
					`Litestream replication stopped: ${child.exitCode ?? child.signalCode}`,
				);
			}
			const restored = `${database}.restore-${attempt++}`;
			try {
				await storage.restoreStore(restored, options);
				const copy = storage.openStore(restored);
				const values = copy
					.prepare("SELECT value FROM items ORDER BY value")
					.all()
					.map((row) => row.value);
				copy.close();
				if (JSON.stringify(values) === JSON.stringify(expected)) return;
			} catch (error) {
				lastError = error;
			} finally {
				rmSync(restored, { force: true });
				rmSync(`${restored}-wal`, { force: true });
				rmSync(`${restored}-shm`, { force: true });
			}
			await delay(250);
		}
		throw new Error(
			`Replica did not restore ${JSON.stringify(expected)}: ${lastError}`,
		);
	}
	try {
		await restoredValues(["first"]);
		db.exec("INSERT INTO items VALUES ('second')");
		await restoredValues(["first", "second"]);
		await assert.rejects(
			storage.restoreStore(database, options),
			/Litestream failed/,
		);
		assert.equal(
			db.prepare("SELECT count(*) AS count FROM items").get().count,
			2,
		);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
		}
		db.close();
	}
	const reopened = storage.openStore(database);
	reopened.exec("INSERT INTO items VALUES ('third')");
	reopened.close();
	await storage.syncReplica(database, options);
	const restored = `${database}.final`;
	await storage.restoreStore(restored, options);
	const copy = storage.openStore(restored);
	assert.equal(
		copy.prepare("SELECT count(*) AS count FROM items").get().count,
		3,
	);
	copy.close();
	process.stdout.write("replicated and restored");
}
