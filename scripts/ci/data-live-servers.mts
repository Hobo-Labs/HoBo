/**
 * Start and stop the PostgreSQL and MongoDB servers the live data-engine lane
 * tests against (`pnpm run test:data-live`).
 *
 * A fleet job is itself a container that reaches the host's Docker engine
 * through the mounted socket, so the servers are started as *sibling*
 * containers and reached at their bridge address: a published port would bind
 * the host's loopback, which is not the job container's. A GitHub-hosted job
 * runs on the host and reaches the same bridge address.
 *
 * The containers carry their own label, never the worker's
 * `hobo.ci/isolated`: the box daemon removes containers under that label that
 * have no lease, and these have none. They are not started with `--rm`, so a
 * server that dies during start-up leaves its logs; `down` removes them.
 *
 * A job that is killed never reaches `down`, so nothing here relies on it:
 * each server stops itself after `SERVER_LIFETIME_SECONDS`, and `sweep`
 * (run by `up`, and by every job's preflight) removes containers of this lane
 * that are older than any job could be.
 *
 * Both servers are test fixtures: PostgreSQL trusts every connection and
 * MongoDB runs without access control, reachable on the box's bridge network
 * until the job's teardown, or their own lifetime if that never runs.
 *
 * CLI (Node builtins only):
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts up
 *     prints `HOBO_TEST_POSTGRES_URL=…` and `HOBO_TEST_MONGODB_URL=…`
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts verify <log>
 *     fails unless every package of the lane ran and no test was skipped
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts logs
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts down
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts sweep
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";

// public-contract: label every container of this lane carries; the sweep and the teardown select on it.
export const DATA_LIVE_LABEL = "hobo.data-live";

// public-contract: catalog of the digest-pinned images the lane and the compose file both run.
export const LIVE_ENGINE_IMAGES_PATH =
	"packages/data-core/deploy/live-engine-images.json";

/** A container of this lane older than this outlived its job (jobs are capped at 20 minutes). */
export const STALE_AFTER_MS = 30 * 60 * 1000;

/**
 * How long a server runs before it stops itself. Longer than a job may run,
 * shorter than the sweep's threshold: a job that is killed leaves its servers
 * holding memory for at most this long, and the sweep then finds them stopped.
 */
export const SERVER_LIFETIME_SECONDS = 25 * 60;

/** The packages `pnpm run test:data-live` runs; `verify` requires a result from each. */
export const LIVE_PACKAGES: readonly string[] = [
	"@hobo/data-core",
	"@hobo/data-sqlite",
	"@hobo/data-postgres",
	"@hobo/data-mongodb",
	"@hobo/trails",
];

const PINNED_IMAGE = /^[a-z0-9][a-z0-9./-]*:[\w.-]+@sha256:[0-9a-f]{64}$/u;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const RUN_TOKEN = /[^a-z0-9-]/gu;

export type LiveEngineImages = Readonly<{
	postgres16: string;
	mongo8: string;
}>;

export type LiveContainerNames = Readonly<{
	postgres: string;
	mongodb: string;
}>;

export type LiveUrls = Readonly<{
	postgres: string;
	mongodb: string;
}>;

export type ListedContainer = Readonly<{
	name: string;
	createdAt: string;
}>;

function pinnedImage(value: string, key: string): string {
	if (!PINNED_IMAGE.test(value)) {
		throw new Error(
			`${LIVE_ENGINE_IMAGES_PATH}: ${key} must be a digest-pinned image (name:tag@sha256:…)`,
		);
	}
	return value;
}

/** Parse the image catalog; a tag without a digest is refused. */
export function parseLiveEngineImages(text: string): LiveEngineImages {
	const catalog = JSON.parse(text);
	return {
		postgres16: pinnedImage(String(catalog?.postgres16 ?? ""), "postgres16"),
		mongo8: pinnedImage(String(catalog?.mongo8 ?? ""), "mongo8"),
	};
}

/** Names scoped to one run attempt, so two jobs on one box never collide. */
export function liveContainerNames(run: string): LiveContainerNames {
	const token = run.toLowerCase().replace(RUN_TOKEN, "-");
	if (token.length === 0) throw new Error("a run token is required");
	return {
		postgres: `hobo-data-live-pg-${token}`,
		mongodb: `hobo-data-live-mongo-${token}`,
	};
}

function fixtureFlags(name: string): readonly string[] {
	return [
		"run",
		"--detach",
		// Not `--rm`: a server that exits during start-up must leave its logs
		// behind. `down` and the stale sweep remove the containers instead.
		"--name",
		name,
		"--label",
		`${DATA_LIVE_LABEL}=1`,
		// The network a fleet job container is created on, named rather than
		// left to the engine's default: the job reaches the servers across it.
		"--network",
		"bridge",
		// Sibling containers are outside the job's cgroup; bound them here.
		"--memory",
		"1024m",
		"--memory-swap",
		"1024m",
		// The image's entrypoint runs under `timeout`, so the server stops
		// itself even when no teardown ever runs.
		"--entrypoint",
		"timeout",
	];
}

/** `timeout`'s own arguments, then the image's entrypoint it supervises. */
function supervised(server: string): readonly string[] {
	return [
		// Both servers shut down cleanly on SIGINT.
		"--signal=INT",
		String(SERVER_LIFETIME_SECONDS),
		"docker-entrypoint.sh",
		server,
	];
}

/**
 * PostgreSQL with logical decoding on: change capture and the logical-copy
 * fast path need `wal_level=logical`, and every capture subscription holds a
 * replication slot.
 */
export function postgresRunArgv(name: string, image: string): string[] {
	return [
		...fixtureFlags(name),
		"--shm-size",
		"256m",
		"--env",
		"POSTGRES_HOST_AUTH_METHOD=trust",
		image,
		...supervised("postgres"),
		"-c",
		"wal_level=logical",
		"-c",
		"max_replication_slots=20",
		"-c",
		"max_wal_senders=20",
	];
}

/**
 * MongoDB 8's allocator misuses restartable sequences on Linux 6.19 through
 * 7.0.13 (SERVER-121912), so recent 8.0 releases refuse to start there, and
 * until 8.0.37 also on Ubuntu kernels that already carry the fix, which is
 * what a GitHub-hosted runner has. With glibc registering rseq itself the
 * allocator cannot, falls back to per-thread caches, and neither the bug nor
 * the refusal applies, whatever kernel the host runs. A fixture does not need
 * the per-CPU caches this gives up.
 */
// public-contract: glibc tunable the MongoDB fixture is started with; the compose file sets the same.
export const MONGO_RSEQ_TUNABLE = "GLIBC_TUNABLES=glibc.pthread.rseq=1";

/**
 * MongoDB as a one-member replica set: transactions and change streams need
 * one. The cache is bounded because mongod otherwise sizes it from the host.
 */
export function mongoRunArgv(name: string, image: string): string[] {
	return [
		...fixtureFlags(name),
		"--env",
		MONGO_RSEQ_TUNABLE,
		image,
		...supervised("mongod"),
		"--replSet",
		"rs0",
		"--bind_ip_all",
		"--wiredTigerCacheSizeGB",
		"0.25",
	];
}

// public-contract: initiates the set on first call and exits 0 only once this member is the writable primary.
export const MONGO_PRIMARY_PROBE =
	'try { rs.status() } catch (e) { rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "localhost:27017" }] }) } if (!db.hello().isWritablePrimary) quit(1)';

/** The container's address on the bridge network, from `docker inspect`. */
export function bridgeAddress(inspectOutput: string): string {
	const address = inspectOutput
		.split(/\s+/u)
		.find((candidate) => IPV4.test(candidate));
	if (address === undefined) {
		throw new Error("the container has no bridge address");
	}
	return address;
}

export function liveUrls(
	addresses: Readonly<{ postgres: string; mongodb: string }>,
): LiveUrls {
	return {
		postgres: `postgres://postgres@${addresses.postgres}:5432/postgres`,
		// One member, addressed directly: the set's own member name is `localhost`.
		mongodb: `mongodb://${addresses.mongodb}:27017/?replicaSet=rs0&directConnection=true`,
	};
}

/**
 * Containers of this lane that outlived any job that could own them. One
 * whose creation time cannot be read is left alone: on a shared box it may be
 * a running job's server, and its own lifetime stops it either way.
 */
export function staleContainers(
	listed: readonly ListedContainer[],
	nowMs: number,
	keep: readonly string[],
): string[] {
	return listed
		.filter((container) => !keep.includes(container.name))
		.filter(
			(container) => nowMs - Date.parse(container.createdAt) > STALE_AFTER_MS,
		)
		.map((container) => container.name);
}

/** Containers of this lane whose creation time could not be read. */
export function undatedContainers(
	listed: readonly ListedContainer[],
): string[] {
	return listed
		.filter((container) => Number.isNaN(Date.parse(container.createdAt)))
		.map((container) => container.name);
}

/** `docker ps --format '{{.Names}}\t{{.CreatedAt}}'` lines as records. */
export function parseListing(output: string): ListedContainer[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [name = "", created = ""] = line.split("\t");
			// Docker prints `2026-11-11 03:17:00 +0000 UTC`; ISO form parses everywhere.
			const [date = "", time = "", offset = ""] = created.split(" ");
			return {
				name,
				createdAt: `${date}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`,
			};
		});
}

export type PackageTotal = Readonly<{
	name: string;
	passed: number;
	total: number;
}>;

export type LiveRunVerdict = Readonly<{
	ok: boolean;
	totals: readonly PackageTotal[];
	problems: readonly string[];
}>;

const PACKAGE_HEADER = /^> (@[\w-]+\/[\w-]+)@\S+ test(?:\s|$)/u;
const TESTS_SUMMARY = /^\s*Tests\s+(.+?)\s+\((\d+)\)\s*$/u;
const ALL_PASSED = /^(\d+) passed$/u;
const PASSED = /(\d+) passed/u;

/**
 * Read the lane's own output and say whether it proves a live run: a summary
 * from every expected package, and in each one every test passed. The live
 * tests are skipped when their variable is missing, so a skipped test means a
 * live lane that did not run; a package with no summary means a filter that
 * matched nothing. Either would otherwise still be a green job.
 */
export function liveRunVerdict(
	log: string,
	expected: readonly string[],
): LiveRunVerdict {
	const totals: PackageTotal[] = [];
	const problems: string[] = [];
	let current = "";
	for (const raw of log.split("\n")) {
		const line = stripVTControlCharacters(raw).trimEnd();
		const header = PACKAGE_HEADER.exec(line);
		if (header !== null) {
			current = header[1] ?? "";
			continue;
		}
		const summary = TESTS_SUMMARY.exec(line);
		if (summary === null) continue;
		const counts = summary[1] ?? "";
		const total = Number(summary[2]);
		const name = current === "" ? "(a run outside any package)" : current;
		// Anything beside "N passed" (skipped, failed, todo) is not a clean run.
		if (!ALL_PASSED.test(counts) || total === 0) {
			problems.push(`${name}: not every test ran and passed (${counts})`);
		}
		totals.push({
			name,
			passed: Number(PASSED.exec(counts)?.[1] ?? 0),
			total,
		});
		current = "";
	}
	for (const name of expected) {
		const seen = totals.filter((entry) => entry.name === name).length;
		if (seen !== 1) {
			problems.push(`${name}: expected one test summary, found ${seen}`);
		}
	}
	for (const entry of totals) {
		if (!expected.includes(entry.name)) {
			problems.push(`${entry.name}: a summary from an unexpected package`);
		}
	}
	return { ok: problems.length === 0, totals, problems };
}

export type DockerResult = Readonly<{
	status: number;
	stdout: string;
	stderr: string;
}>;

/** Everything `up` touches outside itself, so a test can stand in for all of it. */
export type LaneIo = Readonly<{
	docker: (args: readonly string[], timeoutMs?: number) => DockerResult;
	pause: (ms: number) => Promise<void>;
	/** A line for stdout: only the two URL lines ever go here. */
	out: (line: string) => void;
	/** A line for the job log. */
	note: (line: string) => void;
	now: () => number;
}>;

function spawnDocker(
	args: readonly string[],
	timeoutMs = 120_000,
): DockerResult {
	const result = spawnSync("docker", [...args], {
		encoding: "utf8",
		timeout: timeoutMs,
	});
	// A spawn failure (no docker, a timeout) has no exit status and no stderr.
	const failure = result.error === undefined ? "" : `${result.error.message}\n`;
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: `${failure}${result.stderr ?? ""}`,
	};
}

function lastLines(text: string, count: number): string {
	return text.trim().split("\n").slice(-count).join(" | ");
}

function must(io: LaneIo, args: readonly string[], timeoutMs?: number): string {
	const result = io.docker(args, timeoutMs);
	if (result.status !== 0) {
		throw new Error(
			`docker ${args[0] ?? ""} failed (exit ${result.status}): ${lastLines(result.stderr, 3)}`,
		);
	}
	return result.stdout;
}

function running(io: LaneIo, name: string): boolean {
	// A failed inspect is not an exited server; say which it was.
	return (
		must(io, ["inspect", "--format", "{{.State.Running}}", name]).trim() ===
		"true"
	);
}

async function until(
	io: LaneIo,
	what: string,
	name: string,
	probe: () => DockerResult,
	ready: (result: DockerResult) => boolean,
	attempts: number,
): Promise<void> {
	let last = "";
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		const result = probe();
		if (ready(result)) return;
		last = lastLines(`${result.stdout}\n${result.stderr}`, 2);
		// A server that has exited will never answer; say so at once.
		if (!running(io, name)) throw new Error(`${what} exited during start-up`);
		await io.pause(1000);
	}
	throw new Error(
		`${what} was not ready after ${attempts} attempts; the last probe said: ${last}`,
	);
}

function runToken(): string {
	const run = process.env.GITHUB_RUN_ID ?? "local";
	const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
	const job = process.env.GITHUB_JOB ?? "job";
	return `${run}-${attempt}-${job}`;
}

function listed(io: LaneIo): ListedContainer[] | undefined {
	const listing = io.docker([
		"ps",
		"--all",
		"--filter",
		`label=${DATA_LIVE_LABEL}=1`,
		"--format",
		"{{.Names}}\t{{.CreatedAt}}",
	]);
	return listing.status === 0 ? parseListing(listing.stdout) : undefined;
}

function remove(io: LaneIo, names: readonly string[]): void {
	if (names.length === 0) return;
	// A container that is already gone is not a failure; `down` checks what is left.
	io.docker(["rm", "--force", "--volumes", ...names]);
}

/** Remove containers of this lane that outlived any job that could own them. */
export function sweep(io: LaneIo, keep: readonly string[]): void {
	const containers = listed(io);
	if (containers === undefined) return;
	const undated = undatedContainers(containers);
	if (undated.length > 0) {
		io.note(
			`data-live: leaving container(s) with an unreadable creation time: ${undated.join(", ")}`,
		);
	}
	const stale = staleContainers(containers, io.now(), keep);
	if (stale.length > 0) {
		io.note(`data-live: removing stale container(s): ${stale.join(", ")}`);
		remove(io, stale);
	}
}

function printLogs(io: LaneIo, names: LiveContainerNames): void {
	for (const name of [names.postgres, names.mongodb]) {
		const logs = io.docker(["logs", "--tail", "40", name]);
		io.note(`--- ${name} (last 40 lines)`);
		io.note(`${logs.stdout}${logs.stderr}`.trimEnd());
	}
}

/** Remove this run's containers; false when one is still there afterwards. */
export function stopLiveServers(
	io: LaneIo,
	names: LiveContainerNames,
): boolean {
	const own = [names.postgres, names.mongodb];
	remove(io, own);
	const left = (listed(io) ?? []).filter((container) =>
		own.includes(container.name),
	);
	for (const container of left) {
		io.note(`data-live: could not remove ${container.name}`);
	}
	return left.length === 0;
}

function version(io: LaneIo, args: readonly string[]): string {
	const result = io.docker(args);
	return result.status === 0 ? result.stdout.trim() : "unknown";
}

/**
 * Start both servers and wait until each is really serving. Prints the two
 * URL lines only once both are; on any failure it prints the servers' logs,
 * removes them, and prints nothing to stdout.
 */
export async function startLiveServers(
	io: LaneIo,
	names: LiveContainerNames,
	images: LiveEngineImages,
	attempts = 90,
): Promise<LiveUrls> {
	sweep(io, [names.postgres, names.mongodb]);
	// A re-run of the same attempt starts clean.
	remove(io, [names.postgres, names.mongodb]);
	try {
		// The first pull on a box can take a while; later runs find the layers cached.
		must(io, postgresRunArgv(names.postgres, images.postgres16), 600_000);
		must(io, mongoRunArgv(names.mongodb, images.mongo8), 600_000);
		const psql = [
			"exec",
			names.postgres,
			"psql",
			"--host",
			"127.0.0.1",
			"--username",
			"postgres",
			"--no-align",
			"--tuples-only",
			"--command",
		];
		const mongosh = ["exec", names.mongodb, "mongosh", "--quiet", "--eval"];
		// The image's init phase serves a unix socket only, so answering on TCP
		// means the real server is up, not the bootstrap one.
		await until(
			io,
			"PostgreSQL",
			names.postgres,
			() => io.docker([...psql, "show wal_level"]),
			(result) => result.status === 0 && result.stdout.trim() === "logical",
			attempts,
		);
		await until(
			io,
			"the MongoDB replica set",
			names.mongodb,
			() => io.docker([...mongosh, MONGO_PRIMARY_PROBE]),
			(result) => result.status === 0,
			attempts,
		);
		const format = "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}";
		const addresses = {
			postgres: bridgeAddress(
				must(io, ["inspect", "--format", format, names.postgres]),
			),
			mongodb: bridgeAddress(
				must(io, ["inspect", "--format", format, names.mongodb]),
			),
		};
		const urls = liveUrls(addresses);
		// What a green run was against: the job log is the only record of it.
		io.note(
			`data-live: PostgreSQL ${version(io, [...psql, "show server_version"])} at ${addresses.postgres}, MongoDB ${version(io, [...mongosh, "db.version()"])} at ${addresses.mongodb}; each stops itself after ${SERVER_LIFETIME_SECONDS} s`,
		);
		io.out(`HOBO_TEST_POSTGRES_URL=${urls.postgres}`);
		io.out(`HOBO_TEST_MONGODB_URL=${urls.mongodb}`);
		return urls;
	} catch (cause) {
		printLogs(io, names);
		remove(io, [names.postgres, names.mongodb]);
		throw cause;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const command = process.argv[2] ?? "";
	const names = liveContainerNames(runToken());
	const io: LaneIo = {
		docker: spawnDocker,
		pause: (ms) =>
			new Promise((resolve) => {
				setTimeout(resolve, ms);
			}),
		out: (line) => console.log(line),
		note: (line) => console.error(line),
		now: () => Date.now(),
	};
	if (command === "up") {
		await startLiveServers(
			io,
			names,
			parseLiveEngineImages(readFileSync(LIVE_ENGINE_IMAGES_PATH, "utf8")),
		);
	} else if (command === "verify") {
		const verdict = liveRunVerdict(
			readFileSync(process.argv[3] ?? "", "utf8"),
			LIVE_PACKAGES,
		);
		for (const entry of verdict.totals) {
			console.error(`data-live: ${entry.name} ${entry.passed}/${entry.total}`);
		}
		for (const problem of verdict.problems) {
			console.error(`::error::data-live: ${problem}`);
		}
		if (!verdict.ok) process.exit(1);
	} else if (command === "logs") {
		printLogs(io, names);
	} else if (command === "down") {
		if (!stopLiveServers(io, names)) process.exit(1);
	} else if (command === "sweep") {
		sweep(io, []);
	} else {
		console.error(
			"usage: data-live-servers.mts up | verify <log> | logs | down | sweep",
		);
		process.exit(2);
	}
}
