/**
 * The live PostgreSQL lane. Tests that need a real server run against one of:
 *
 * 1. `HOBO_TEST_POSTGRES_URL` — any reachable server (CI service, dev box);
 * 2. a container from the digest-pinned image below, when a Docker engine
 *    answers (`/var/run/docker.sock` + `docker info`);
 * 3. an ephemeral local cluster from PostgreSQL >= 16 binaries (`initdb`,
 *    `pg_ctl`) on PATH or under /usr/lib/postgresql/<major>/bin.
 *
 * When none is available the live suites are skipped with the reason in
 * their name; `HOBO_STORAGE_POSTGRES_LANE=off` skips on purpose.
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

/**
 * Same digest-pinned image as packages/ci-gh-actions/contracts/pinned-container-images.json
 * (postgres17Alpine); 17 satisfies the >= 16 minimum (plan 0024 R6).
 */
export const PINNED_POSTGRES_IMAGE =
	"postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b";

export const MIN_MAJOR = 16;

export interface LaneProbe {
	env(name: string): string | undefined;
	dockerReady(): boolean;
	/** Directory holding initdb/pg_ctl of the newest local major >= MIN_MAJOR. */
	localBinDir(): string | undefined;
	isRoot(): boolean;
	hasPostgresUser(): boolean;
}

export type LanePlan =
	| Readonly<{ kind: "url"; url: string }>
	| Readonly<{ kind: "container"; image: string }>
	| Readonly<{ kind: "local"; binDir: string; runAsPostgres: boolean }>
	| Readonly<{ kind: "unavailable"; reason: string }>;

/** Decide which lane to run, without side effects. */
export function planLane(probe: LaneProbe): LanePlan {
	const url = probe.env("HOBO_TEST_POSTGRES_URL");
	if (url !== undefined && url !== "") return { kind: "url", url };
	if (probe.env("HOBO_STORAGE_POSTGRES_LANE") === "off") {
		return {
			kind: "unavailable",
			reason: "disabled by HOBO_STORAGE_POSTGRES_LANE=off",
		};
	}
	if (probe.dockerReady()) {
		return { kind: "container", image: PINNED_POSTGRES_IMAGE };
	}
	const binDir = probe.localBinDir();
	if (binDir !== undefined) {
		if (!probe.isRoot()) return { kind: "local", binDir, runAsPostgres: false };
		if (probe.hasPostgresUser()) {
			return { kind: "local", binDir, runAsPostgres: true };
		}
	}
	return {
		kind: "unavailable",
		reason: `no PostgreSQL >= ${MIN_MAJOR}: set HOBO_TEST_POSTGRES_URL, start a Docker engine, or install postgresql-${MIN_MAJOR}+ server binaries`,
	};
}

function majorOf(binDir: string): number | undefined {
	const result = spawnSync(join(binDir, "pg_ctl"), ["--version"], {
		encoding: "utf8",
	});
	const match = /\(PostgreSQL\)\s+(\d+)/u.exec(result.stdout ?? "");
	return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function systemProbe(): LaneProbe {
	return {
		env: (name) => process.env[name],
		dockerReady() {
			if (!existsSync("/var/run/docker.sock")) return false;
			return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
		},
		localBinDir() {
			const candidates: string[] = [];
			for (const dir of (process.env.PATH ?? "").split(":")) {
				if (
					dir !== "" &&
					existsSync(join(dir, "initdb")) &&
					existsSync(join(dir, "pg_ctl"))
				) {
					candidates.push(dir);
				}
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
				if (!existsSync(join(dir, "initdb"))) return false;
				const major = majorOf(dir);
				return major !== undefined && major >= MIN_MAJOR;
			});
		},
		isRoot: () => process.getuid?.() === 0,
		hasPostgresUser: () =>
			spawnSync("id", ["-u", "postgres"], { stdio: "ignore" }).status === 0,
	};
}

export type RunningLane = Readonly<{
	url: string;
	description: string;
	stop(): Promise<void>;
}>;

async function waitForServer(url: string, deadlineMs: number): Promise<void> {
	const started = Date.now();
	let last: Error | undefined;
	while (Date.now() - started < deadlineMs) {
		const client = new pg.Client({ connectionString: url });
		try {
			await client.connect();
			await client.query("SELECT 1");
			await client.end();
			return;
		} catch (error) {
			last = error instanceof Error ? error : new Error(String(error));
			await client.end().catch(() => undefined);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}
	throw new Error(
		`postgres did not become ready: ${last?.message ?? "timeout"}`,
	);
}

function run(command: string, args: readonly string[], runAsPostgres: boolean) {
	const [cmd, argv] = runAsPostgres
		? ["runuser", ["-u", "postgres", "--", command, ...args]]
		: [command, [...args]];
	const result = spawnSync(cmd, argv, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
	}
	return result.stdout;
}

async function startLocal(
	binDir: string,
	runAsPostgres: boolean,
): Promise<RunningLane> {
	const base = tmpdir().length > 60 ? "/tmp" : tmpdir();
	const dir = mkdtempSync(join(base, "hobo-pg-"));
	if (runAsPostgres) {
		const uid = Number(
			spawnSync("id", ["-u", "postgres"], { encoding: "utf8" }).stdout.trim(),
		);
		const gid = Number(
			spawnSync("id", ["-g", "postgres"], { encoding: "utf8" }).stdout.trim(),
		);
		chownSync(dir, uid, gid);
	}
	const data = join(dir, "data");
	run(
		join(binDir, "initdb"),
		["-D", data, "-A", "trust", "-U", "hobo", "-E", "UTF8", "--no-sync"],
		runAsPostgres,
	);
	run(
		join(binDir, "pg_ctl"),
		[
			"-D",
			data,
			"-l",
			join(dir, "server.log"),
			"-o",
			`-k ${dir} -c listen_addresses='' -c fsync=off -c max_connections=300`,
			"-w",
			"start",
		],
		runAsPostgres,
	);
	const url = `postgresql://hobo@/postgres?host=${encodeURIComponent(dir)}`;
	await waitForServer(url, 30_000);
	return {
		url,
		description: `ephemeral local cluster (${binDir})`,
		async stop() {
			try {
				run(
					join(binDir, "pg_ctl"),
					["-D", data, "-m", "immediate", "stop"],
					runAsPostgres,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

async function startContainer(image: string): Promise<RunningLane> {
	const started = spawnSync(
		"docker",
		[
			"run",
			"-d",
			"--rm",
			"-e",
			"POSTGRES_USER=hobo",
			"-e",
			"POSTGRES_PASSWORD=hobo-local-tests-only",
			"-e",
			"POSTGRES_DB=hobo",
			"-p",
			"127.0.0.1::5432",
			image,
			"-c",
			"max_connections=300",
		],
		{ encoding: "utf8" },
	);
	if (started.status !== 0)
		throw new Error(`docker run failed: ${started.stderr}`);
	const id = started.stdout.trim();
	const stop = async () => {
		spawnSync("docker", ["rm", "-f", id], { stdio: "ignore" });
	};
	try {
		const port = spawnSync("docker", ["port", id, "5432/tcp"], {
			encoding: "utf8",
		})
			.stdout.trim()
			.split("\n")[0];
		const hostPort = /:(\d+)$/u.exec(port ?? "")?.[1];
		if (hostPort === undefined) throw new Error(`no mapped port for ${id}`);
		const url = `postgresql://hobo:hobo-local-tests-only@127.0.0.1:${hostPort}/hobo`;
		await waitForServer(url, 90_000);
		return { url, description: `container ${image}`, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

/** Start the planned lane; a failure to start becomes an unavailable lane with its reason. */
export async function startLane(
	plan: LanePlan,
): Promise<RunningLane | Readonly<{ url: undefined; reason: string }>> {
	try {
		switch (plan.kind) {
			case "url":
				await waitForServer(plan.url, 10_000);
				return {
					url: plan.url,
					description: "HOBO_TEST_POSTGRES_URL",
					stop: async () => {},
				};
			case "container":
				return await startContainer(plan.image);
			case "local":
				return await startLocal(plan.binDir, plan.runAsPostgres);
			case "unavailable":
				return { url: undefined, reason: plan.reason };
		}
	} catch (error) {
		return {
			url: undefined,
			reason: `${plan.kind} lane failed to start: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
