import { DeviceClass, type FleetRecord } from "@hobo/fleet";

export const DEFAULT_PIDS_LIMIT = 4096;

const RUNNER_WRITABLE = ["/opt/actions-runner", "/home/runner"] as const;

export type ContainerHardening = Readonly<{
	pidsLimit?: number;
	cpus?: number;
}>;

export function hardenedContainerFlags(
	hardening: ContainerHardening,
): string[] {
	const pidsLimit = hardening.pidsLimit ?? DEFAULT_PIDS_LIMIT;
	if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 1)
		throw new Error("invalid container pids limit");
	const flags = [
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		`--pids-limit=${pidsLimit}`,
		"--read-only",
		"--tmpfs=/tmp:rw,exec,nosuid,nodev,mode=1777",
		...RUNNER_WRITABLE.map((path) => `--mount=type=volume,target=${path}`),
	];
	if (hardening.cpus !== undefined) {
		if (!Number.isFinite(hardening.cpus) || hardening.cpus <= 0)
			throw new Error("invalid container CPU cap");
		flags.push(`--cpus=${hardening.cpus}`);
	}
	return flags;
}

export function hostDockerAllowed(
	fleet: FleetRecord | undefined,
	deviceClass: DeviceClass,
): boolean {
	return (
		fleet?.policy?.allowHostDocker === true &&
		deviceClass === DeviceClass.DEDICATED
	);
}
