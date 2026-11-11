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
 * server that dies during start-up leaves its logs; `down` removes them, and
 * `up` first removes containers of this lane that outlived a job which never
 * reached its teardown.
 *
 * Both servers are test fixtures: PostgreSQL trusts every connection and
 * MongoDB runs without access control, reachable only on the box's bridge
 * network for the life of the job.
 *
 * CLI (Node builtins only):
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts up
 *     prints `HOBO_TEST_POSTGRES_URL=…` and `HOBO_TEST_MONGODB_URL=…`
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts logs
 *   node --experimental-strip-types scripts/ci/data-live-servers.mts down
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

// public-contract: label every container of this lane carries; the sweep and the teardown select on it.
export const DATA_LIVE_LABEL = "hobo.data-live";

// public-contract: catalog of the digest-pinned images the lane and the compose file both run.
export const LIVE_ENGINE_IMAGES_PATH =
	"packages/data-core/deploy/live-engine-images.json";

/** A container of this lane older than this outlived its job (jobs are capped at 20 minutes). */
export const STALE_AFTER_MS = 30 * 60 * 1000;

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
		// Sibling containers are outside the job's cgroup; bound them here.
		"--memory",
		"1024m",
		"--memory-swap",
		"1024m",
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
		"-c",
		"wal_level=logical",
		"-c",
		"max_replication_slots=20",
		"-c",
		"max_wal_senders=20",
	];
}

/**
 * MongoDB as a one-member replica set: transactions and change streams need
 * one. The cache is bounded because mongod otherwise sizes it from the host.
 */
export function mongoRunArgv(name: string, image: string): string[] {
	return [
		...fixtureFlags(name),
		image,
		"mongod",
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

/** Containers of this lane that outlived any job that could own them. */
export function staleContainers(
	listed: readonly ListedContainer[],
	nowMs: number,
	keep: readonly string[],
): string[] {
	return listed
		.filter((container) => !keep.includes(container.name))
		.filter((container) => {
			const created = Date.parse(container.createdAt);
			return Number.isNaN(created) || nowMs - created > STALE_AFTER_MS;
		})
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

type DockerResult = Readonly<{
	status: number;
	stdout: string;
	stderr: string;
}>;

function docker(args: readonly string[], timeoutMs = 120_000): DockerResult {
	const result = spawnSync("docker", [...args], {
		encoding: "utf8",
		timeout: timeoutMs,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function must(args: readonly string[], timeoutMs?: number): string {
	const result = docker(args, timeoutMs);
	if (result.status !== 0) {
		throw new Error(
			`docker ${args[0] ?? ""} failed (exit ${result.status}): ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`,
		);
	}
	return result.stdout;
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function running(name: string): boolean {
	return (
		docker([
			"inspect",
			"--format",
			"{{.State.Running}}",
			name,
		]).stdout.trim() === "true"
	);
}

async function until(
	what: string,
	name: string,
	probe: () => boolean,
	attempts: number,
): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (probe()) return;
		// A server that has exited will never answer; say so at once.
		if (!running(name)) throw new Error(`${what} exited during start-up`);
		await pause(1000);
	}
	throw new Error(`${what} was not ready after ${attempts} attempts`);
}

function runToken(): string {
	const run = process.env.GITHUB_RUN_ID ?? "local";
	const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
	const job = process.env.GITHUB_JOB ?? "job";
	return `${run}-${attempt}-${job}`;
}

function remove(names: readonly string[]): void {
	if (names.length === 0) return;
	// `rm --force` of a container that is already gone is not an error worth failing on.
	docker(["rm", "--force", "--volumes", ...names]);
}

function sweep(keep: readonly string[]): void {
	const listing = docker([
		"ps",
		"--all",
		"--filter",
		`label=${DATA_LIVE_LABEL}=1`,
		"--format",
		"{{.Names}}\t{{.CreatedAt}}",
	]);
	if (listing.status !== 0) return;
	const stale = staleContainers(parseListing(listing.stdout), Date.now(), keep);
	if (stale.length > 0) {
		console.error(
			`data-live: removing stale container(s): ${stale.join(", ")}`,
		);
		remove(stale);
	}
}

function printLogs(names: LiveContainerNames): void {
	for (const name of [names.postgres, names.mongodb]) {
		const logs = docker(["logs", "--tail", "40", name]);
		console.error(`--- ${name} (last 40 lines)`);
		console.error(`${logs.stdout}${logs.stderr}`.trimEnd());
	}
}

async function up(): Promise<void> {
	const images = parseLiveEngineImages(
		readFileSync(LIVE_ENGINE_IMAGES_PATH, "utf8"),
	);
	const names = liveContainerNames(runToken());
	sweep([names.postgres, names.mongodb]);
	// A re-run of the same attempt starts clean.
	remove([names.postgres, names.mongodb]);
	try {
		// The first pull on a box can take a while; later runs find the layers cached.
		must(postgresRunArgv(names.postgres, images.postgres16), 600_000);
		must(mongoRunArgv(names.mongodb, images.mongo8), 600_000);
		// The image's init phase serves a unix socket only, so answering on TCP
		// means the real server is up, not the bootstrap one.
		await until(
			"PostgreSQL",
			names.postgres,
			() =>
				docker([
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
					"show wal_level",
				]).stdout.trim() === "logical",
			90,
		);
		await until(
			"the MongoDB replica set",
			names.mongodb,
			() =>
				docker([
					"exec",
					names.mongodb,
					"mongosh",
					"--quiet",
					"--eval",
					MONGO_PRIMARY_PROBE,
				]).status === 0,
			90,
		);
		const format = "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}";
		const urls = liveUrls({
			postgres: bridgeAddress(
				must(["inspect", "--format", format, names.postgres]),
			),
			mongodb: bridgeAddress(
				must(["inspect", "--format", format, names.mongodb]),
			),
		});
		console.log(`HOBO_TEST_POSTGRES_URL=${urls.postgres}`);
		console.log(`HOBO_TEST_MONGODB_URL=${urls.mongodb}`);
	} catch (cause) {
		printLogs(names);
		remove([names.postgres, names.mongodb]);
		throw cause;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const command = process.argv[2] ?? "";
	const names = liveContainerNames(runToken());
	if (command === "up") {
		await up();
	} else if (command === "logs") {
		printLogs(names);
	} else if (command === "down") {
		remove([names.postgres, names.mongodb]);
	} else {
		console.error("usage: data-live-servers.mts up | logs | down");
		process.exit(2);
	}
}
