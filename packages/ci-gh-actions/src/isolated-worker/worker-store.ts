import { join } from "node:path";

export type WorkerStoreChoice =
	| Readonly<{ kind: "sqlite"; path: string }>
	| Readonly<{ kind: "postgres"; urlEnv: string }>;

export interface WorkerStorePlan {
	readonly store: WorkerStoreChoice;
	/** `pull` polls GitHub REST for `runs-on: hobo` jobs; `push` relies on a webhook relay feeding the store. */
	readonly admission: "pull" | "push";
	readonly jobPollMs: number;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Default data file for a single-host worker; never inside a repository checkout. */
export function defaultWorkerDatabasePath(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	return join(dataHome, "hobo-ci", "worker.sqlite");
}

/**
 * SQLite is the default: a box worker owns its own durable lease journal
 * (`HOBO_CI_WORKER_DB`) and needs no shared database. Postgres is opt-in
 * (`HOBO_CI_STORE=postgres`) for a
 * worker that shares a hosted relay's partition; the connection string is read
 * from the env var named by `HOBO_CI_STORE_URL_ENV` (default `DATABASE_URL`).
 */
export function resolveWorkerStorePlan(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): WorkerStorePlan {
	const kind = env.HOBO_CI_STORE || "sqlite";
	let store: WorkerStoreChoice;
	if (kind === "sqlite") {
		store = {
			kind,
			// Not HOBO_CI_DB: that is the relay's journal, and one SQLite file gets one writer.
			path: env.HOBO_CI_WORKER_DB || defaultWorkerDatabasePath(env, home),
		};
	} else if (kind === "postgres") {
		const urlEnv = env.HOBO_CI_STORE_URL_ENV || "DATABASE_URL";
		if (!ENV_NAME.test(urlEnv))
			throw new Error("invalid HOBO_CI_STORE_URL_ENV");
		if (!env[urlEnv]) throw new Error(`missing ${urlEnv}`);
		store = { kind, urlEnv };
	} else throw new Error("HOBO_CI_STORE must be sqlite or postgres");
	const admission =
		env.HOBO_CI_JOB_ADMISSION || (store.kind === "sqlite" ? "pull" : "push");
	if (admission !== "pull" && admission !== "push")
		throw new Error("HOBO_CI_JOB_ADMISSION must be pull or push");
	const jobPollMs = Number(env.HOBO_CI_JOB_POLL_MS || "15000");
	if (!Number.isInteger(jobPollMs) || jobPollMs < 5_000 || jobPollMs > 300_000)
		throw new Error("invalid HOBO_CI_JOB_POLL_MS");
	return { store, admission, jobPollMs };
}
