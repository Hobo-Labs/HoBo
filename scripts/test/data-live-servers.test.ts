import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	bridgeAddress,
	DATA_LIVE_LABEL,
	type DockerResult,
	type LaneIo,
	LIVE_ENGINE_IMAGES_PATH,
	LIVE_PACKAGES,
	liveContainerNames,
	liveRunVerdict,
	liveUrls,
	MONGO_PRIMARY_PROBE,
	MONGO_RSEQ_TUNABLE,
	mongoRunArgv,
	parseListing,
	parseLiveEngineImages,
	postgresRunArgv,
	SERVER_LIFETIME_SECONDS,
	STALE_AFTER_MS,
	staleContainers,
	startLiveServers,
	stopLiveServers,
	sweep,
} from "../ci/data-live-servers.mts";

const DIGEST = "a".repeat(64);
const POSTGRES = `postgres:16@sha256:${DIGEST}`;
const MONGO = `mongo:8.0@sha256:${DIGEST}`;

describe("the image catalog", () => {
	it("is digest-pinned, and the compose file runs the same images", () => {
		const images = parseLiveEngineImages(
			readFileSync(LIVE_ENGINE_IMAGES_PATH, "utf8"),
		);
		const compose = readFileSync(
			"packages/data-core/deploy/compose.live-engines.yml",
			"utf8",
		);
		assert.ok(compose.includes(`image: ${images.postgres16}\n`));
		assert.ok(compose.includes(`image: ${images.mongo8}\n`));
		assert.match(images.postgres16, /^postgres:16@sha256:[0-9a-f]{64}$/u);
		assert.match(images.mongo8, /^mongo:8\.0@sha256:[0-9a-f]{64}$/u);
	});

	it("refuses a tag with no digest, a missing key, and a short digest", () => {
		for (const text of [
			JSON.stringify({ postgres16: "postgres:16", mongo8: MONGO }),
			JSON.stringify({ postgres16: POSTGRES }),
			JSON.stringify({
				postgres16: POSTGRES,
				mongo8: "mongo:8.0@sha256:abc",
			}),
			"null",
		]) {
			assert.throws(() => parseLiveEngineImages(text), /digest-pinned/u);
		}
	});
});

describe("the containers", () => {
	it("are named for one run attempt and one job", () => {
		const names = liveContainerNames("4242-2-data-live");
		assert.deepEqual(names, {
			postgres: "hobo-data-live-pg-4242-2-data-live",
			mongodb: "hobo-data-live-mongo-4242-2-data-live",
		});
		assert.notDeepEqual(liveContainerNames("4242-3-data-live"), names);
		// Anything that is not a name character becomes a dash.
		assert.equal(
			liveContainerNames("Run 7/job").postgres,
			"hobo-data-live-pg-run-7-job",
		);
		assert.throws(() => liveContainerNames(""), /run token/u);
	});

	it("carry the lane's own label and never the worker's", () => {
		for (const argv of [
			postgresRunArgv("pg", POSTGRES),
			mongoRunArgv("mongo", MONGO),
		]) {
			assert.ok(argv.includes(`${DATA_LIVE_LABEL}=1`));
			// The box daemon removes lease-less containers under this label.
			assert.ok(!argv.join(" ").includes("hobo.ci/isolated"));
			// A server that exits during start-up must leave its logs behind.
			assert.ok(!argv.includes("--rm"));
			assert.ok(argv.includes("--detach"));
			// Sibling containers are outside the job's cgroup, so each is bounded.
			assert.equal(argv[argv.indexOf("--memory") + 1], "1024m");
			// A published port would bind the host's loopback, not the job's.
			assert.ok(!argv.includes("--publish") && !argv.includes("-p"));
			// The network a fleet job container is on, named and not defaulted.
			assert.equal(argv[argv.indexOf("--network") + 1], "bridge");
		}
	});

	it("stop themselves, so a job that is killed does not leave servers running", () => {
		for (const [argv, image, server] of [
			[postgresRunArgv("pg", POSTGRES), POSTGRES, "postgres"],
			[mongoRunArgv("mongo", MONGO), MONGO, "mongod"],
		] as const) {
			assert.equal(argv[argv.indexOf("--entrypoint") + 1], "timeout");
			assert.ok(argv.indexOf("--entrypoint") < argv.indexOf(image));
			// `timeout`'s arguments, then the image's own entrypoint and server.
			assert.deepEqual(
				argv.slice(argv.indexOf(image) + 1, argv.indexOf(image) + 5),
				[
					"--signal=INT",
					String(SERVER_LIFETIME_SECONDS),
					"docker-entrypoint.sh",
					server,
				],
			);
		}
	});

	it("start PostgreSQL with logical decoding and room for capture slots", () => {
		const argv = postgresRunArgv("pg", POSTGRES);
		const settings = argv.slice(argv.indexOf("postgres") + 1);
		assert.deepEqual(settings, [
			"-c",
			"wal_level=logical",
			"-c",
			"max_replication_slots=20",
			"-c",
			"max_wal_senders=20",
		]);
		assert.equal(argv[argv.indexOf("--name") + 1], "pg");
	});

	it("start MongoDB as a replica set with a bounded cache", () => {
		const argv = mongoRunArgv("mongo", MONGO);
		// Without this MongoDB 8 refuses to start on Linux 6.19+ (SERVER-121912).
		assert.equal(MONGO_RSEQ_TUNABLE, "GLIBC_TUNABLES=glibc.pthread.rseq=1");
		assert.equal(argv[argv.indexOf("--env") + 1], MONGO_RSEQ_TUNABLE);
		assert.ok(argv.indexOf("--env") < argv.indexOf(MONGO));
		assert.ok(
			readFileSync(
				"packages/data-core/deploy/compose.live-engines.yml",
				"utf8",
			).includes("GLIBC_TUNABLES: glibc.pthread.rseq=1"),
		);
		assert.deepEqual(argv.slice(argv.indexOf("mongod")), [
			"mongod",
			"--replSet",
			"rs0",
			"--bind_ip_all",
			"--wiredTigerCacheSizeGB",
			"0.25",
		]);
		assert.match(MONGO_PRIMARY_PROBE, /rs\.initiate/u);
		assert.match(MONGO_PRIMARY_PROBE, /isWritablePrimary/u);
	});
});

describe("reaching the servers", () => {
	it("reads the bridge address docker inspect prints", () => {
		assert.equal(bridgeAddress("172.17.0.4 \n"), "172.17.0.4");
		assert.equal(bridgeAddress(" 172.18.0.2 172.17.0.9 "), "172.18.0.2");
		assert.throws(() => bridgeAddress(" \n"), /no bridge address/u);
		assert.throws(() => bridgeAddress("<no value>"), /no bridge address/u);
	});

	it("forms the two URLs the live tests read", () => {
		assert.deepEqual(
			liveUrls({ postgres: "172.17.0.4", mongodb: "172.17.0.5" }),
			{
				postgres: "postgres://postgres@172.17.0.4:5432/postgres",
				mongodb:
					"mongodb://172.17.0.5:27017/?replicaSet=rs0&directConnection=true",
			},
		);
	});
});

describe("the stale-container sweep", () => {
	const now = Date.parse("2026-11-11T04:00:00Z");
	const listing = [
		"hobo-data-live-pg-1-1-data-live\t2026-11-11 03:00:00 +0000 UTC",
		"hobo-data-live-mongo-1-1-data-live\t2026-11-11 03:00:00 +0000 UTC",
		"hobo-data-live-pg-2-1-data-live\t2026-11-11 03:50:00 +0000 UTC",
		"hobo-data-live-pg-3-1-data-live\t2026-11-10 20:30:00 -0700 MST",
		"",
	].join("\n");

	it("parses docker's listing, offsets included", () => {
		const parsed = parseListing(listing);
		assert.equal(parsed.length, 4);
		assert.equal(
			Date.parse(parsed[0]?.createdAt ?? ""),
			Date.parse("2026-11-11T03:00:00Z"),
		);
		assert.equal(
			Date.parse(parsed[3]?.createdAt ?? ""),
			Date.parse("2026-11-11T03:30:00Z"),
		);
	});

	it("removes only containers no running job can still own", () => {
		assert.ok(STALE_AFTER_MS > 20 * 60 * 1000, "longer than a job may run");
		assert.deepEqual(staleContainers(parseListing(listing), now, []), [
			"hobo-data-live-pg-1-1-data-live",
			"hobo-data-live-mongo-1-1-data-live",
		]);
	});

	it("never removes this run's own containers, nor one it cannot date", () => {
		assert.deepEqual(
			staleContainers(parseListing(listing), now, [
				"hobo-data-live-pg-1-1-data-live",
			]),
			["hobo-data-live-mongo-1-1-data-live"],
		);
		// On a shared box an undateable container may be a running job's server.
		assert.deepEqual(
			staleContainers([{ name: "x", createdAt: "garbage" }], now, []),
			[],
		);
	});

	it("says which containers it left for want of a date", () => {
		const lane = fakeLane((args) =>
			args[0] === "ps" ? ok(`${listing}odd-one\tsome other format\n`) : ok(""),
		);
		sweep({ ...lane.io, now: () => now }, []);
		assert.deepEqual(removed(lane.calls), [
			["hobo-data-live-pg-1-1-data-live", "hobo-data-live-mongo-1-1-data-live"],
		]);
		assert.match(lane.notes.join("\n"), /unreadable creation time: odd-one/u);
	});
});

const NAMES = liveContainerNames("7-1-data-live");
const IMAGES = { postgres16: POSTGRES, mongo8: MONGO };

function ok(stdout: string): DockerResult {
	return { status: 0, stdout, stderr: "" };
}

function failed(stderr: string): DockerResult {
	return { status: 1, stdout: "", stderr };
}

/** A lane whose docker is `answer`; everything it does is recorded in order. */
function fakeLane(answer: (args: readonly string[]) => DockerResult) {
	const calls: (readonly string[])[] = [];
	const out: string[] = [];
	const notes: string[] = [];
	const io: LaneIo = {
		docker: (args) => {
			calls.push(args);
			return answer(args);
		},
		pause: async () => {
			calls.push(["<pause>"]);
		},
		out: (line) => {
			calls.push(["<out>", line]);
			out.push(line);
		},
		note: (line) => {
			notes.push(line);
		},
		now: () => Date.parse("2026-11-11T04:00:00Z"),
	};
	return { io, calls, out, notes };
}

/** A docker in which both servers come up at once. */
function healthy(args: readonly string[]): DockerResult {
	const last = args.at(-1) ?? "";
	if (args[0] === "exec" && last === "show wal_level") return ok("logical\n");
	if (args[0] === "exec" && last === "show server_version")
		return ok("16.15\n");
	if (args[0] === "exec" && last === "db.version()") return ok("8.0.34\n");
	if (args[0] === "inspect" && args.includes("{{.State.Running}}")) {
		return ok("true\n");
	}
	if (args[0] === "inspect") {
		return ok(last === NAMES.postgres ? "172.17.0.2 \n" : "172.17.0.3 \n");
	}
	if (args[0] === "logs") return ok(`log of ${last}\n`);
	return ok("");
}

function removed(calls: readonly (readonly string[])[]): string[][] {
	return calls.filter((args) => args[0] === "rm").map((args) => args.slice(3));
}

describe("starting the servers", () => {
	it("prints the two URLs only after both servers answer, and nothing else", async () => {
		const lane = fakeLane(healthy);
		const urls = await startLiveServers(lane.io, NAMES, IMAGES);
		assert.deepEqual(lane.out, [
			`HOBO_TEST_POSTGRES_URL=${urls.postgres}`,
			`HOBO_TEST_MONGODB_URL=${urls.mongodb}`,
		]);
		assert.equal(urls.postgres, "postgres://postgres@172.17.0.2:5432/postgres");
		const firstOut = lane.calls.findIndex((args) => args[0] === "<out>");
		const lastProbe = lane.calls
			.map((args) => args.at(-1))
			.lastIndexOf(MONGO_PRIMARY_PROBE);
		assert.ok(lastProbe > 0 && lastProbe < firstOut);
		// The job log records what the run was against.
		assert.match(
			lane.notes.join("\n"),
			/PostgreSQL 16\.15 at 172\.17\.0\.2, MongoDB 8\.0\.34 at 172\.17\.0\.3/u,
		);
		// A healthy start removes only a previous attempt's containers, before it runs.
		assert.deepEqual(removed(lane.calls), [[NAMES.postgres, NAMES.mongodb]]);
		assert.ok(
			lane.calls.findIndex((args) => args[0] === "rm") <
				lane.calls.findIndex((args) => args[0] === "run"),
		);
	});

	it("waits for a server that is not serving yet", async () => {
		let asked = 0;
		const lane = fakeLane((args) => {
			if (args.at(-1) === "show wal_level") {
				asked += 1;
				// Connection refused, then the wrong answer, then the real server.
				if (asked === 1) return failed("psql: connection refused");
				if (asked === 2) return ok("replica\n");
			}
			return healthy(args);
		});
		await startLiveServers(lane.io, NAMES, IMAGES);
		assert.equal(asked, 3);
		assert.equal(lane.calls.filter((args) => args[0] === "<pause>").length, 2);
		assert.equal(lane.out.length, 2);
	});

	it("stops at once when a server has exited, prints its logs and removes both", async () => {
		const lane = fakeLane((args) => {
			if (args.at(-1) === MONGO_PRIMARY_PROBE) return failed("no such process");
			if (
				args.includes("{{.State.Running}}") &&
				args.at(-1) === NAMES.mongodb
			) {
				return ok("false\n");
			}
			return healthy(args);
		});
		await assert.rejects(
			startLiveServers(lane.io, NAMES, IMAGES),
			/the MongoDB replica set exited during start-up/u,
		);
		// Nothing reaches stdout, so nothing reaches $GITHUB_ENV.
		assert.deepEqual(lane.out, []);
		assert.equal(lane.calls.filter((args) => args[0] === "<pause>").length, 0);
		assert.match(
			lane.notes.join("\n"),
			new RegExp(`log of ${NAMES.mongodb}`, "u"),
		);
		assert.deepEqual(removed(lane.calls).at(-1), [
			NAMES.postgres,
			NAMES.mongodb,
		]);
	});

	it("gives up with the last thing the probe said", async () => {
		const lane = fakeLane((args) =>
			args.at(-1) === MONGO_PRIMARY_PROBE
				? failed("MongoServerError: already initialized")
				: healthy(args),
		);
		await assert.rejects(
			startLiveServers(lane.io, NAMES, IMAGES, 3),
			/not ready after 3 attempts; the last probe said: MongoServerError: already initialized/u,
		);
		assert.deepEqual(lane.out, []);
		assert.equal(removed(lane.calls).length, 2);
	});

	it("reports a container that would not start, with docker's own words", async () => {
		const lane = fakeLane((args) =>
			args[0] === "run" && args.includes(NAMES.mongodb)
				? failed("Unable to find image\ndocker: toomanyrequests")
				: healthy(args),
		);
		await assert.rejects(
			startLiveServers(lane.io, NAMES, IMAGES),
			/docker run failed \(exit 1\): Unable to find image \| docker: toomanyrequests/u,
		);
		assert.deepEqual(lane.out, []);
		// The PostgreSQL that did start is not left behind.
		assert.deepEqual(removed(lane.calls).at(-1), [
			NAMES.postgres,
			NAMES.mongodb,
		]);
	});

	it("does not call a failed inspect an exited server", async () => {
		const lane = fakeLane((args) => {
			if (args.at(-1) === "show wal_level") return failed("not yet");
			if (args.includes("{{.State.Running}}")) return failed("Cannot connect");
			return healthy(args);
		});
		await assert.rejects(
			startLiveServers(lane.io, NAMES, IMAGES),
			/docker inspect failed \(exit 1\): Cannot connect/u,
		);
	});
});

describe("stopping the servers", () => {
	it("removes both and says so when one is still there", () => {
		const gone = fakeLane(healthy);
		assert.equal(stopLiveServers(gone.io, NAMES), true);
		assert.deepEqual(removed(gone.calls), [[NAMES.postgres, NAMES.mongodb]]);

		const stuck = fakeLane((args) =>
			args[0] === "ps"
				? ok(`${NAMES.mongodb}\t2026-11-11 03:59:00 +0000 UTC\n`)
				: healthy(args),
		);
		assert.equal(stopLiveServers(stuck.io, NAMES), false);
		assert.match(stuck.notes.join("\n"), /could not remove/u);
	});
});

/** One package's part of the lane's output, as pnpm and vitest print it. */
function packageRun(name: string, tests: string): string {
	return [
		`> ${name}@0.0.1 pretest /work/packages/x`,
		"> node --experimental-strip-types ../../scripts/ensure-built.mts",
		"",
		`> ${name}@0.0.1 test /work/packages/x`,
		"> vitest run test/",
		"",
		" RUN  v4.1.9 /work/packages/x",
		"",
		" Test Files  16 passed (16)",
		`      Tests  ${tests}`,
		"   Start at  00:46:16",
		"",
	].join("\n");
}

describe("the proof that the live lanes ran", () => {
	const green = LIVE_PACKAGES.map((name) =>
		packageRun(name, "286 passed (286)"),
	).join("\n");

	it("accepts a run in which every package ran and every test passed", () => {
		const verdict = liveRunVerdict(green, LIVE_PACKAGES);
		assert.deepEqual(verdict.problems, []);
		assert.equal(verdict.ok, true);
		assert.deepEqual(
			verdict.totals.map((entry) => entry.name),
			LIVE_PACKAGES,
		);
		assert.equal(verdict.totals[0]?.passed, 286);
	});

	it("reads through the colour codes a terminal reporter writes", () => {
		const coloured = green.replaceAll(
			"286 passed",
			"\u001b[1m\u001b[32m286 passed\u001b[39m\u001b[22m",
		);
		assert.equal(liveRunVerdict(coloured, LIVE_PACKAGES).ok, true);
	});

	it("refuses a skipped test: that is a live lane that did not run", () => {
		const log = green.replace(
			"286 passed (286)",
			"250 passed | 36 skipped (286)",
		);
		const verdict = liveRunVerdict(log, LIVE_PACKAGES);
		assert.equal(verdict.ok, false);
		assert.match(
			verdict.problems.join("\n"),
			/@hobo\/data-core: not every test ran and passed \(250 passed \| 36 skipped\)/u,
		);
	});

	it("refuses a failure, a todo, and a package with no tests", () => {
		for (const tests of [
			"1 failed | 285 passed (286)",
			"285 passed | 1 todo (286)",
			"0 passed (0)",
		]) {
			const log = green.replace("286 passed (286)", tests);
			assert.equal(liveRunVerdict(log, LIVE_PACKAGES).ok, false, tests);
		}
	});

	it("refuses a run that is missing a package, or has one it did not expect", () => {
		const missing = LIVE_PACKAGES.slice(1)
			.map((name) => packageRun(name, "40 passed (40)"))
			.join("\n");
		assert.match(
			liveRunVerdict(missing, LIVE_PACKAGES).problems.join("\n"),
			/@hobo\/data-core: expected one test summary, found 0/u,
		);
		const extra = `${green}\n${packageRun("@hobo/pricing", "9 passed (9)")}`;
		assert.match(
			liveRunVerdict(extra, LIVE_PACKAGES).problems.join("\n"),
			/@hobo\/pricing: a summary from an unexpected package/u,
		);
		assert.equal(liveRunVerdict("", LIVE_PACKAGES).problems.length, 5);
	});
});

describe("the workflow job and the script agree", () => {
	const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
	const job = workflow.slice(
		workflow.indexOf("\n  data-live:\n"),
		workflow.indexOf("\n  ci-guard:\n"),
	);
	const minutes = [...job.matchAll(/^( +)timeout-minutes: (\d+)$/gmu)].map(
		(match) => ({ indent: (match[1] ?? "").length, value: Number(match[2]) }),
	);
	const jobMinutes = minutes.find((entry) => entry.indent === 4)?.value ?? 0;

	it("finds the job", () => {
		assert.match(job, /name: Live data engines \(PostgreSQL 16, MongoDB 8\)/u);
		assert.equal(jobMinutes, 20);
	});

	it("keeps a server alive for a whole job and the sweep away until it has stopped", () => {
		const jobMs = jobMinutes * 60 * 1000;
		assert.ok(SERVER_LIFETIME_SECONDS * 1000 > jobMs);
		assert.ok(STALE_AFTER_MS > SERVER_LIFETIME_SECONDS * 1000);
	});

	it("bounds every slow step, with room left for checkout and install", () => {
		const steps = minutes.filter((entry) => entry.indent > 4);
		assert.equal(steps.length, 3, "build, start and suites");
		const bounded = steps.reduce((sum, entry) => sum + entry.value, 0);
		assert.ok(bounded <= jobMinutes - 3, `${bounded} of ${jobMinutes} minutes`);
	});

	it("feeds the URLs to later steps, proves the run, and always tears down", () => {
		assert.match(job, /data-live-servers\.mts up >> "\$GITHUB_ENV"/u);
		assert.match(job, /data-live-servers\.mts verify /u);
		assert.match(
			job,
			/if: always\(\) && steps\.scope\.outputs\.run == 'true'\n +run: .*data-live-servers\.mts down/u,
		);
		// The nightly and a manual run never take the diff's word for it.
		assert.match(job, /"\$GITHUB_EVENT_NAME" != "pull_request"/u);
	});

	it("runs exactly the packages the proof expects", () => {
		const script = String(
			JSON.parse(readFileSync("package.json", "utf8")).scripts[
				"test:data-live"
			],
		);
		assert.deepEqual(
			[...script.matchAll(/--filter (\S+)/gu)].map((match) => match[1]),
			LIVE_PACKAGES,
		);
		assert.match(script, /--workspace-concurrency=1/u);
	});
});
