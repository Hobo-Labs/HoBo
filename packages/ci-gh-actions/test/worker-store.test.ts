import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultWorkerDatabasePath,
	resolveWorkerStorePlan,
} from "../src/isolated-worker/worker-store.js";

describe("worker store plan", () => {
	it("defaults to a SQLite journal in the user data dir with pull admission", () => {
		const plan = resolveWorkerStorePlan(
			{ DATABASE_URL: "postgres://x.invalid/db" },
			"/home/box",
		);
		expect(plan).toEqual({
			store: {
				kind: "sqlite",
				path: join("/home/box", ".local", "share", "hobo-ci", "worker.sqlite"),
			},
			admission: "pull",
			jobPollMs: 15_000,
		});
		expect(
			defaultWorkerDatabasePath({ XDG_DATA_HOME: "/data" }, "/home/box"),
		).toBe(join("/data", "hobo-ci", "worker.sqlite"));
	});

	it("ignores the relay's HOBO_CI_DB and honours HOBO_CI_WORKER_DB", () => {
		expect(
			resolveWorkerStorePlan({ HOBO_CI_DB: "/relay.sqlite" }, "/h").store,
		).toEqual({
			kind: "sqlite",
			path: join("/h", ".local", "share", "hobo-ci", "worker.sqlite"),
		});
		expect(
			resolveWorkerStorePlan({ HOBO_CI_WORKER_DB: "/w.sqlite" }, "/h").store,
		).toEqual({ kind: "sqlite", path: "/w.sqlite" });
	});

	it("opts into Postgres by env var name and defaults it to push admission", () => {
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_STORE: "postgres" }, "/h"),
		).toThrow("missing DATABASE_URL");
		expect(
			resolveWorkerStorePlan(
				{
					HOBO_CI_STORE: "postgres",
					HOBO_CI_STORE_URL_ENV: "SHARED_DB",
					SHARED_DB: "postgres://synthetic.invalid/db",
				},
				"/h",
			),
		).toEqual({
			store: { kind: "postgres", urlEnv: "SHARED_DB" },
			admission: "push",
			jobPollMs: 15_000,
		});
		expect(() =>
			resolveWorkerStorePlan(
				{
					HOBO_CI_STORE: "postgres",
					HOBO_CI_STORE_URL_ENV: "postgres://inline",
				},
				"/h",
			),
		).toThrow("invalid HOBO_CI_STORE_URL_ENV");
	});

	it("rejects unknown stores, admissions and poll intervals", () => {
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_STORE: "neon" }, "/h"),
		).toThrow();
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_JOB_ADMISSION: "both" }, "/h"),
		).toThrow();
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_JOB_POLL_MS: "1000" }, "/h"),
		).toThrow();
	});
});
