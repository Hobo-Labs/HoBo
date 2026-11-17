import { join } from "node:path";

export type WorkerStoreChoice = Readonly<{ kind: "sqlite"; path: string }>;

export interface WorkerStorePlan {
	readonly store: WorkerStoreChoice;
	readonly admission: "pull" | "push";
	readonly jobPollMs: number;
}

export function defaultWorkerDatabasePath(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
): string {
	const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
	return join(dataHome, "hobo-ci", "worker.sqlite");
}

export function resolveWorkerStorePlan(
	env: Readonly<Record<string, string | undefined>>,
	home: string,
	admission: "pull" | "push" = "pull",
): WorkerStorePlan {
	if ((env.HOBO_CI_STORE || "sqlite") !== "sqlite")
		throw new Error("HOBO_CI_STORE must be sqlite");
	const store: WorkerStoreChoice = {
		kind: "sqlite",
		path: env.HOBO_CI_WORKER_DB || defaultWorkerDatabasePath(env, home),
	};
	if (admission !== "pull" && admission !== "push")
		throw new Error("runnerRouting.box.jobAdmission must be pull or push");
	const jobPollMs = Number(env.HOBO_CI_JOB_POLL_MS || "2000");
	if (!Number.isInteger(jobPollMs) || jobPollMs < 2_000 || jobPollMs > 300_000)
		throw new Error("invalid HOBO_CI_JOB_POLL_MS");
	return { store, admission, jobPollMs };
}
