import { basename } from "node:path";

const ISOLATED_JOB =
	/^hobo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTAINER_HOST_NAME = /^[0-9a-f]{12,64}$/u;

export type RunningContainer = Readonly<{ id: string; name: string }>;

export type SelfContainer =
	| Readonly<{ kind: "none" }>
	| Readonly<{
			kind: "known";
			name: string;
			source: "host-job-directory" | "host-name";
	  }>
	| Readonly<{ kind: "unknown" }>;

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

export function windowDecision(input: {
	busyJobContainers: number;
	self: SelfContainer;
	elapsedMs: number;
	maxWaitMs: number;
	unknownSelfMaxWaitMs: number;
}): WindowDecision {
	if (input.busyJobContainers === 0) return "open";
	const containersMayBeSelf =
		input.self.kind === "unknown" &&
		input.elapsedMs >= Math.min(input.unknownSelfMaxWaitMs, input.maxWaitMs);
	if (containersMayBeSelf) return "proceed";
	return input.elapsedMs >= input.maxWaitMs ? "fail" : "wait";
}
