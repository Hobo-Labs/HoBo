import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";

// public-contract: label every container of this lane carries; the sweep and the teardown select on it.
export const DATA_LIVE_LABEL = "hobo.data-live";

// public-contract: catalog of the digest-pinned images the lane and the compose file both run.
export const LIVE_ENGINE_IMAGES_PATH =
	"packages/data-core/deploy/live-engine-images.json";

export const STALE_AFTER_MS = 30 * 60 * 1000;

export const SERVER_LIFETIME_SECONDS = 25 * 60;

export const FIXTURE_OPEN_FILES = 65_536;

export const LIVE_PACKAGES: readonly string[] = [
	"@hobo/data-core",
	"@hobo/data-sqlite",
	"@hobo/data-postgres",
	"@hobo/data-mongodb",
	"@hobo/trails",
	"@hobo/broker",
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

export function parseLiveEngineImages(text: string): LiveEngineImages {
	const catalog = JSON.parse(text);
	return {
		postgres16: pinnedImage(String(catalog?.postgres16 ?? ""), "postgres16"),
		mongo8: pinnedImage(String(catalog?.mongo8 ?? ""), "mongo8"),
	};
}

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
		"--name",
		name,
		"--label",
		`${DATA_LIVE_LABEL}=1`,
		"--network",
		"bridge",
		"--memory",
		"1024m",
		"--memory-swap",
		"1024m",
		"--ulimit",
		`nofile=${FIXTURE_OPEN_FILES}:${FIXTURE_OPEN_FILES}`,
		"--entrypoint",
		"timeout",
	];
}

function supervised(server: string): readonly string[] {
	return [
		"--signal=INT",
		String(SERVER_LIFETIME_SECONDS),
		"docker-entrypoint.sh",
		server,
	];
}

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

// public-contract: glibc tunable the MongoDB fixture is started with; the compose file sets the same.
export const MONGO_RSEQ_TUNABLE = "GLIBC_TUNABLES=glibc.pthread.rseq=1";

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

// public-contract: where every mongosh the lane and the compose healthcheck start keeps its own files.
export const MONGOSH_HOME = "HOME=/tmp";

export function mongoshExecArgv(name: string): string[] {
	return ["exec", "--env", MONGOSH_HOME, name, "mongosh", "--quiet", "--eval"];
}

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
		mongodb: `mongodb://${addresses.mongodb}:27017/?replicaSet=rs0&directConnection=true`,
	};
}

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

export function undatedContainers(
	listed: readonly ListedContainer[],
): string[] {
	return listed
		.filter((container) => Number.isNaN(Date.parse(container.createdAt)))
		.map((container) => container.name);
}

export function parseListing(output: string): ListedContainer[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const [name = "", created = ""] = line.split("\t");
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

export type LaneIo = Readonly<{
	docker: (args: readonly string[], timeoutMs?: number) => DockerResult;
	pause: (ms: number) => Promise<void>;
	out: (line: string) => void;
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
	io.docker(["rm", "--force", "--volumes", ...names]);
}

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

export function cachedImageArchive(cacheDir: string, image: string): string {
	const digest = /@sha256:([0-9a-f]{64})$/u.exec(image)?.[1];
	if (digest === undefined) {
		throw new Error(`${image} is not digest-pinned; it cannot be cached`);
	}
	return join(cacheDir, `${digest}.tar`);
}

export function ensureCachedImage(
	io: LaneIo,
	image: string,
	cacheDir: string | undefined,
): "present" | "loaded" | "pulled" | "uncached" {
	if (
		io.docker(["image", "inspect", "--format", "{{.Id}}", image]).status === 0
	)
		return "present";
	if (cacheDir === undefined || !isAbsolute(cacheDir)) return "uncached";
	const archive = cachedImageArchive(cacheDir, image);
	if (existsSync(archive)) {
		if (io.docker(["load", "--input", archive], 600_000).status === 0)
			return "loaded";
		rmSync(archive, { force: true });
	}
	must(io, ["pull", image], 600_000);
	const partial = `${archive}.${process.pid}.partial`;
	if (io.docker(["save", "--output", partial, image], 600_000).status === 0)
		renameSync(partial, archive);
	else rmSync(partial, { force: true });
	return "pulled";
}

export async function startLiveServers(
	io: LaneIo,
	names: LiveContainerNames,
	images: LiveEngineImages,
	attempts = 90,
	imageCacheDir: string | undefined = undefined,
): Promise<LiveUrls> {
	sweep(io, [names.postgres, names.mongodb]);
	remove(io, [names.postgres, names.mongodb]);
	try {
		for (const image of [images.postgres16, images.mongo8]) {
			io.note(
				`data-live: ${image.split("@")[0]} ${ensureCachedImage(io, image, imageCacheDir)}`,
			);
		}
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
		const mongosh = mongoshExecArgv(names.mongodb);
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
			90,
			process.env.HOBO_CI_IMAGE_CACHE_DIR?.trim() || undefined,
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
