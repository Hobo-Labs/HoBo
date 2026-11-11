import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	bridgeAddress,
	DATA_LIVE_LABEL,
	LIVE_ENGINE_IMAGES_PATH,
	liveContainerNames,
	liveUrls,
	MONGO_PRIMARY_PROBE,
	mongoRunArgv,
	parseListing,
	parseLiveEngineImages,
	postgresRunArgv,
	STALE_AFTER_MS,
	staleContainers,
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
			assert.ok(argv.includes("--rm"));
			assert.ok(argv.includes("--detach"));
			// Sibling containers are outside the job's cgroup, so each is bounded.
			assert.equal(argv[argv.indexOf("--memory") + 1], "1024m");
			// A published port would bind the host's loopback, not the job's.
			assert.ok(!argv.includes("--publish") && !argv.includes("-p"));
		}
	});

	it("start PostgreSQL with logical decoding and room for capture slots", () => {
		const argv = postgresRunArgv("pg", POSTGRES);
		const settings = argv.slice(argv.indexOf(POSTGRES) + 1);
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
		assert.deepEqual(argv.slice(argv.indexOf(MONGO) + 1), [
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

	it("never removes this run's own containers, and removes one it cannot date", () => {
		assert.deepEqual(
			staleContainers(parseListing(listing), now, [
				"hobo-data-live-pg-1-1-data-live",
			]),
			["hobo-data-live-mongo-1-1-data-live"],
		);
		assert.deepEqual(
			staleContainers([{ name: "x", createdAt: "garbage" }], now, []),
			["x"],
		);
	});
});
