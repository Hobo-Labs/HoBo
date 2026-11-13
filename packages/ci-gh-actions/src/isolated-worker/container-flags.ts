/**
 * Launch flags of the `S1_CONTAINER` tier (design §6.11) for every container
 * the box worker starts: all capabilities dropped, Docker's default seccomp
 * profile (never `unconfined`), `no-new-privileges`, a pids limit, a read-only
 * root, and writable scratch that the container owns (a tmpfs `/tmp` and
 * anonymous volumes seeded from the image, removed with the container).
 *
 * The flags are the Docker engine's own: nothing here needs a host `crun`,
 * `runc`, `podman` or `nsenter` (D58).
 */
import { DeviceClass, type FleetRecord } from "@hobo/fleet";

/** Default per-container process limit. */
export const DEFAULT_PIDS_LIMIT = 4096;

/** Paths the GitHub runner writes inside its image; each becomes an anonymous volume. */
const RUNNER_WRITABLE = ["/opt/actions-runner", "/home/runner"] as const;

export type ContainerHardening = Readonly<{
	pidsLimit?: number;
	/** CPU cap (`--cpus`); absent leaves CPU to the scheduler's shares. */
	cpus?: number;
}>;

export function hardenedContainerFlags(hardening: ContainerHardening): string[] {
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

/**
 * The host Docker socket is exposed only on a `DEDICATED` device of a fleet
 * whose policy sets `allow_host_docker` (§6.11, `S1_CONTAINER` "Docker inside").
 */
export function hostDockerAllowed(
	fleet: FleetRecord | undefined,
	deviceClass: DeviceClass,
): boolean {
	return (
		fleet?.policy?.allowHostDocker === true &&
		deviceClass === DeviceClass.DEDICATED
	);
}
