import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export interface ReplicationOptions {
	replicaUrl?: string;
	executable?: string;
	natsCredentialsFile?: string;
	stdio?: "inherit" | "ignore";
}

function databasePath(path: string): string {
	if (!path.trim() || path === ":memory:") {
		throw new Error("Replication requires a persistent SQLite database path");
	}
	return resolve(path);
}

export function replicaUrlFor(
	path: string,
	options: ReplicationOptions = {},
): string {
	const database = databasePath(path);
	const configured = options.replicaUrl ?? process.env.HOBO_LITESTREAM_REPLICA;
	if (configured !== undefined) {
		const replica = new URL(configured);
		if (replica.protocol !== "file:" && replica.protocol !== "nats:") {
			throw new Error("Replica URL must use file: or nats:");
		}
		if (replica.username || replica.password) {
			throw new Error(
				"Use a NATS credentials file instead of credentials in the replica URL",
			);
		}
		if (
			replica.protocol === "nats:" &&
			(!replica.hostname || replica.pathname === "/" || !replica.pathname)
		) {
			throw new Error(
				"NATS replica URL must include a server and object-store bucket",
			);
		}
		return replica.href;
	}
	const home = process.env.HOBO_HOME || resolve(homedir(), ".hobo");
	const id = createHash("sha256").update(database).digest("hex").slice(0, 16);
	return pathToFileURL(resolve(home, "durable", "replicas", `{{name}}-${id}`))
		.href;
}

function startLitestream(
	action: "replicate" | "sync" | "restore",
	path: string,
	options: ReplicationOptions,
): ChildProcess {
	const database = databasePath(path);
	const url = replicaUrlFor(path, options);
	if (options.natsCredentialsFile && !url.startsWith("nats:")) {
		throw new Error("NATS credentials require a NATS replica URL");
	}
	const directory = mkdtempSync(join(tmpdir(), "hobo-litestream-"));
	const config = join(directory, "config.json");
	const cleanup = () => rmSync(directory, { recursive: true, force: true });
	try {
		const replica = {
			url,
			...(options.natsCredentialsFile
				? { creds: resolve(options.natsCredentialsFile) }
				: {}),
		};
		writeFileSync(
			config,
			JSON.stringify({ dbs: [{ path: database, replica }] }),
			{ mode: 0o600 },
		);
		const args =
			action === "restore"
				? ["restore", "-config", config, "-o", database, database]
				: [
						"replicate",
						...(action === "sync" ? ["-once"] : []),
						"-config",
						config,
					];
		const child = spawn(options.executable ?? "litestream", args, {
			stdio: options.stdio ?? "inherit",
		});
		child.once("close", cleanup);
		return child;
	} catch (error) {
		cleanup();
		throw error;
	}
}

async function runLitestream(
	action: "sync" | "restore",
	path: string,
	options: ReplicationOptions,
): Promise<void> {
	const child = startLitestream(action, path, options);
	const [code, signal] = await once(child, "exit");
	if (code !== 0) {
		throw new Error(
			`Litestream failed (${signal ? `signal ${signal}` : `exit ${code}`})`,
		);
	}
}

export function openStore(path: string): DatabaseSync {
	const db = new DatabaseSync(databasePath(path));
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
	);
	return db;
}

export async function startReplication(
	path: string,
	options: ReplicationOptions = {},
): Promise<ChildProcess> {
	const child = startLitestream("replicate", path, options);
	await once(child, "spawn");
	return child;
}

export async function syncReplica(
	path: string,
	options: ReplicationOptions = {},
): Promise<void> {
	await runLitestream("sync", path, options);
}

export async function restoreStore(
	path: string,
	options: ReplicationOptions = {},
): Promise<void> {
	await runLitestream("restore", path, options);
}
