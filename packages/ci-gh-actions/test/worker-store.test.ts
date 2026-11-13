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
			jobPollMs: 5_000,
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

	it("keeps its journal in SQLite whatever else is set, and admits by push only when asked", () => {
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_STORE: "postgres" }, "/h"),
		).toThrow("HOBO_CI_STORE must be sqlite");
		expect(
			resolveWorkerStorePlan(
				{
					HOBO_CI_STORE: "sqlite",
					HOBO_CI_WORKER_DB: "/w.sqlite",
				},
				"/h",
				"push",
			),
		).toEqual({
			store: { kind: "sqlite", path: "/w.sqlite" },
			admission: "push",
			jobPollMs: 5_000,
		});
	});

	it("takes admission from committed policy, never the environment", () => {
		expect(
			resolveWorkerStorePlan({ HOBO_CI_JOB_ADMISSION: "push" }, "/h").admission,
		).toBe("pull");
	});

	it("rejects unknown stores, admissions and poll intervals", () => {
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_STORE: "neon" }, "/h"),
		).toThrow();
		// SAFETY: deliberately not an admission, to prove the guard refuses it.
		expect(() => resolveWorkerStorePlan({}, "/h", "both" as "pull")).toThrow();
		expect(() =>
			resolveWorkerStorePlan({ HOBO_CI_JOB_POLL_MS: "1000" }, "/h"),
		).toThrow();
	});
});
