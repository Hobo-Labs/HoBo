/**
 * Which containers hold the deps build window shut, and what to do when the
 * wait runs out. Pure: `scripts/ci/wait-deps-build-window.mts` does the I/O.
 *
 * A box job runs inside its own `hobo-<lease id>` container with the host's
 * Docker socket, so `docker ps` lists the job that is asking. The worker names
 * the container after the lease and mounts the job directory of the same name
 * (`HOBO_CI_HOST_JOB_DIRECTORY`); Docker sets the container's host name to the
 * first twelve characters of its id. Either identifies the caller.
 */
import { basename } from "node:path";

const ISOLATED_JOB =
	/^hobo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTAINER_HOST_NAME = /^[0-9a-f]{12,64}$/u;

export type RunningContainer = Readonly<{ id: string; name: string }>;

/**
 * `none`: the caller is not in a container, so every job container is another job.
 * `known`: the caller's own job container, by name.
 * `unknown`: the caller is in a container that could not be told apart.
 */
export type SelfContainer =
	| Readonly<{ kind: "none" }>
	| Readonly<{
			kind: "known";
			name: string;
			source: "host-job-directory" | "host-name";
	  }>
	| Readonly<{ kind: "unknown" }>;

/** Parses `docker ps --no-trunc --format '{{.ID}}\t{{.Names}}'`. */
export function parseRunningContainers(stdout: string): RunningContainer[] {
	const containers: RunningContainer[] = [];
	for (const line of stdout.split("\n")) {
		const [id, name] = line.trim().split("\t");
		if (id && name) containers.push({ id, name });
	}
	return containers;
}

export function identifySelfContainer(input: {
	hostJobDirectory?: string | undefined;
	hostName?: string | undefined;
	inContainer: boolean;
	containers: readonly RunningContainer[];
}): SelfContainer {
	const directory = input.hostJobDirectory?.trim();
	if (directory) {
		const name = basename(directory);
		if (ISOLATED_JOB.test(name))
			return { kind: "known", name, source: "host-job-directory" };
	}
	const hostName = input.hostName?.trim();
	if (hostName && CONTAINER_HOST_NAME.test(hostName)) {
		const own = input.containers.find((container) =>
			container.id.startsWith(hostName),
		);
		if (own) return { kind: "known", name: own.name, source: "host-name" };
	}
	return input.inContainer ? { kind: "unknown" } : { kind: "none" };
}

/** Other jobs' containers: the ones a deps build would compete with. */
export function busyJobContainers(
	containers: readonly RunningContainer[],
	self: SelfContainer,
): string[] {
	return containers
		.map((container) => container.name)
		.filter((name) => ISOLATED_JOB.test(name))
		.filter((name) => self.kind !== "known" || name !== self.name)
		.sort();
}

export type WindowDecision = "open" | "wait" | "proceed" | "fail";

/**
 * `proceed` ends the wait without the window opening: the caller could not
 * tell its own container from the others, so after `unknownSelfMaxWaitMs` the
 * containers it is waiting on are taken to be itself. Headroom is measured,
 * never guessed, so a shortage waits the full `maxWaitMs` and then fails.
 */
export function windowDecision(input: {
	busyJobContainers: number;
	headroomOk: boolean;
	self: SelfContainer;
	elapsedMs: number;
	maxWaitMs: number;
	unknownSelfMaxWaitMs: number;
}): WindowDecision {
	const timedOut = input.elapsedMs >= input.maxWaitMs;
	const containersBlock = input.busyJobContainers > 0;
	const containersMayBeSelf =
		input.self.kind === "unknown" &&
		input.elapsedMs >= Math.min(input.unknownSelfMaxWaitMs, input.maxWaitMs);
	if (containersBlock && !containersMayBeSelf)
		return timedOut ? "fail" : "wait";
	if (!input.headroomOk) return timedOut ? "fail" : "wait";
	return containersBlock ? "proceed" : "open";
}
