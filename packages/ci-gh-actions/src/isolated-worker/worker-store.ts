import { join } from "node:path";

export type WorkerStoreChoice = Readonly<{ kind: "sqlite"; path: string }>;

export interface WorkerStorePlan {
	readonly store: WorkerStoreChoice;
	/** `pull` polls GitHub REST for `runs-on: hobo` jobs; `push` relies on a webhook relay feeding the store. */
	readonly admission: "pull" | "push";
	readonly jobPollMs: number;
}

/** Default data file for a single-host worker; never inside a repository checkout. */
export function defaultWorkerDatabasePath(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	return join(dataHome, "hobo-ci", "worker.sqlite");
}

/**
 * A box worker owns its durable lease journal: a SQLite file
 * (`HOBO_CI_WORKER_DB`), never a shared database. `HOBO_CI_STORE` may only
 * name `sqlite`; the shared Postgres partition option was removed with the
 * hosted relay's database (ADR-0179).
 */
export function resolveWorkerStorePlan(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): WorkerStorePlan {
	if ((env.HOBO_CI_STORE || "sqlite") !== "sqlite")
		throw new Error("HOBO_CI_STORE must be sqlite");
	const store: WorkerStoreChoice = {
		kind: "sqlite",
		// Not HOBO_CI_DB: that is the relay's journal, and one SQLite file gets one writer.
		path: env.HOBO_CI_WORKER_DB || defaultWorkerDatabasePath(env, home),
	};
	const admission = env.HOBO_CI_JOB_ADMISSION || "pull";
	if (admission !== "pull" && admission !== "push")
		throw new Error("HOBO_CI_JOB_ADMISSION must be pull or push");
	const jobPollMs = Number(env.HOBO_CI_JOB_POLL_MS || "2000");
	if (!Number.isInteger(jobPollMs) || jobPollMs < 2_000 || jobPollMs > 300_000)
		throw new Error("invalid HOBO_CI_JOB_POLL_MS");
	return { store, admission, jobPollMs };
}
