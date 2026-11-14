/**
 * Vitest global setup: give the PostgreSQL budget-authority tests a real server.
 *
 * When `HOBO_TEST_POSTGRES_URL` is already set it is used as is. Otherwise,
 * when PostgreSQL >= 16 server binaries (`initdb`, `pg_ctl`) are on PATH or
 * under /usr/lib/postgresql/<major>/bin, an ephemeral local cluster is started
 * on a private Unix socket for the run and removed afterwards. As root the
 * cluster runs as the `postgres` user. With neither, the variable stays unset.
 */
import { spawnSync } from "node:child_process";
import {
	chownSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const MIN_MAJOR = 16;

function majorOf(binDir: string): number | undefined {
	const result = spawnSync(join(binDir, "pg_ctl"), ["--version"], {
		encoding: "utf8",
	});
	const match = /\(PostgreSQL\)\s+(\d+)/u.exec(result.stdout ?? "");
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

function localBinDir(): string | undefined {
	const candidates: string[] = [];
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir !== "" && existsSync(join(dir, "initdb"))) candidates.push(dir);
	}
	const root = "/usr/lib/postgresql";
	if (existsSync(root)) {
		for (const major of readdirSync(root).sort(
			(a, b) => Number(b) - Number(a),
		)) {
			candidates.push(join(root, major, "bin"));
		}
	}
	return candidates.find((dir) => {
		if (!existsSync(join(dir, "initdb")) || !existsSync(join(dir, "pg_ctl"))) {
			return false;
		}
		const major = majorOf(dir);
		return major !== undefined && major >= MIN_MAJOR;
	});
}

function run(command: string, args: readonly string[], asPostgres: boolean) {
	const [cmd, argv] = asPostgres
		? ["runuser", ["-u", "postgres", "--", command, ...args]]
		: [command, [...args]];
	const result = spawnSync(cmd, argv, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
	}
}

async function waitForServer(url: string, deadlineMs: number): Promise<void> {
	const started = Date.now();
	let last: unknown;
	while (Date.now() - started < deadlineMs) {
		const client = new pg.Client({ connectionString: url });
		try {
			await client.connect();
			await client.query("SELECT 1");
			await client.end();
			return;
		} catch (error) {
			last = error;
			await client.end().catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(`postgres did not become ready: ${String(last)}`);
}

export default async function setup(): Promise<(() => void) | undefined> {
	const existing = process.env.HOBO_TEST_POSTGRES_URL;
	if (existing !== undefined && existing !== "") return undefined;
	const binDir = localBinDir();
	if (binDir === undefined) return undefined;
	const asPostgres = process.getuid?.() === 0;
	if (
		asPostgres &&
		spawnSync("id", ["-u", "postgres"], { stdio: "ignore" }).status !== 0
	) {
		return undefined;
	}
	const base = tmpdir().length > 60 ? "/tmp" : tmpdir();
	const dir = mkdtempSync(join(base, "hobo-ci-pg-"));
	const data = join(dir, "data");
	const stop = () => {
		try {
			run(
				join(binDir, "pg_ctl"),
				["-D", data, "-m", "immediate", "stop"],
				asPostgres,
			);
		} catch {
			// already stopped or never started
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	try {
		if (asPostgres) {
			const id = (flag: string) =>
				Number(
					spawnSync("id", [flag, "postgres"], {
						encoding: "utf8",
					}).stdout.trim(),
				);
			chownSync(dir, id("-u"), id("-g"));
		}
		run(
			join(binDir, "initdb"),
			["-D", data, "-A", "trust", "-U", "hobo", "-E", "UTF8", "--no-sync"],
			asPostgres,
		);
		run(
			join(binDir, "pg_ctl"),
			[
				"-D",
				data,
				"-l",
				join(dir, "server.log"),
				"-o",
				`-k ${dir} -c listen_addresses='' -c fsync=off`,
				"-w",
				"start",
			],
			asPostgres,
		);
		const url = `postgresql://hobo@/postgres?host=${encodeURIComponent(dir)}`;
		await waitForServer(url, 30_000);
		process.env.HOBO_TEST_POSTGRES_URL = url;
		return () => {
			delete process.env.HOBO_TEST_POSTGRES_URL;
			stop();
		};
	} catch (error) {
		stop();
		throw error;
	}
}
