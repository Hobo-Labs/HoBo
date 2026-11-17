/**
 * Which machine takes a job: a connected workstation, or a self-hosted runner
 * that was registered before HoBo was.
 *
 * A machine is someone's computer, so the rules are about whose jobs it will
 * run before they are about speed. A machine shared with `only_me` takes a
 * job only when its owner both started and triggered the run, which leaves
 * out bots, schedules and somebody else's re-run. A machine shared with
 * `anyone` still refuses a repository its owner cannot read on GitHub: a
 * teammate's job must not put code on a disk whose owner was never given it.
 *
 * Among the machines that will take the job, the starter's own come first,
 * then whichever was picked longest ago, so load spreads without a counter.
 *
 * Pure functions: no clock, network or store.
 */

export const MACHINE_SHARING = ["only_me", "anyone"] as const;
export type MachineSharing = (typeof MACHINE_SHARING)[number];

export type MachineCandidate = Readonly<{
	id: string;
	name: string;
	/** The `runs-on` label that lands a job on this machine and no other. */
	runsOn: string;
	/** What the machine is: `self-hosted`, its OS, its architecture, and any label it was registered with. */
	labels: readonly string[];
	online: boolean;
	paused: boolean;
	/** Jobs it runs at once. */
	slots: number;
	/** Slots taken by a running job or held for one already routed. */
	busy: number;
	sharing: MachineSharing;
	/** The owner's GitHub user id. */
	ownerId: string;
	/** The owner can read the job's repository on GitHub. */
	ownerCanRead: boolean;
	/** When it last took a job (epoch ms); 0 when it never has. */
	lastPickedAtMs: number;
	/** Set for a runner registered on one repository: it serves that repository only. */
	repository: string | undefined;
}>;

export type MachineWant = Readonly<{
	/** Every one of these must be on the machine. Case is ignored. */
	labels: readonly string[];
	repository: string;
	/** GitHub user id of whoever started the run. */
	starterId: string | undefined;
	/** GitHub user id of whoever triggered this attempt. */
	triggeredById: string | undefined;
	/** A retry on the same runner: this machine goes first. */
	preferMachineId: string | undefined;
	/** A retry on another runner: this machine goes last. */
	avoidMachineId: string | undefined;
}>;

export type MachineRefusal =
	/** No online machine has the labels. */
	| "no_machine"
	/** Machines fit, but none is shared with this job's starter. */
	| "machine_not_shared"
	/** The machines that would take it are paused. */
	| "machine_paused"
	/** The machines that would take it are all busy. */
	| "machine_full";

export type MachineChoice =
	| Readonly<{ kind: "machine"; machine: MachineCandidate }>
	| Readonly<{
			kind: "none";
			reason: MachineRefusal;
			/** The machine the refusal is about, when one stands out. */
			machine: MachineCandidate | undefined;
	  }>;

/** The labels a connected machine has from what it is. */
export function machineLabels(
	os: "linux" | "macos" | "windows",
	arch: "x64" | "arm64" | "arm",
): readonly string[] {
	const osLabel =
		os === "linux" ? "Linux" : os === "macos" ? "macOS" : "Windows";
	return ["self-hosted", osLabel, arch.toUpperCase()];
}

function fits(machine: MachineCandidate, want: MachineWant): boolean {
	if (!machine.online) return false;
	if (
		machine.repository !== undefined &&
		machine.repository.toLowerCase() !== want.repository.toLowerCase()
	)
		return false;
	const has = new Set(machine.labels.map((label) => label.toLowerCase()));
	return want.labels.every((label) => has.has(label.toLowerCase()));
}

/** Whether the machine's owner lets it run this job. */
export function admits(machine: MachineCandidate, want: MachineWant): boolean {
	if (!machine.ownerCanRead) return false;
	const ownStart =
		want.starterId === machine.ownerId &&
		want.triggeredById === machine.ownerId;
	if (machine.sharing === "only_me") return ownStart;
	return true;
}

function rank(machine: MachineCandidate, want: MachineWant): number {
	if (machine.id === want.preferMachineId) return 0;
	if (machine.id === want.avoidMachineId) return 3;
	return machine.ownerId === want.starterId ? 1 : 2;
}

function byPreference(
	want: MachineWant,
): (left: MachineCandidate, right: MachineCandidate) => number {
	return (left, right) =>
		rank(left, want) - rank(right, want) ||
		left.lastPickedAtMs - right.lastPickedAtMs ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * The machine for the job, or the nearest reason there is none. The reason
 * names the last gate anything reached: busy machines outrank paused ones,
 * which outrank machines that are not shared, so "full" is only ever said of
 * machines that would otherwise have taken the job.
 */
export function chooseMachine(
	candidates: readonly MachineCandidate[],
	want: MachineWant,
): MachineChoice {
	const order = byPreference(want);
	const fitting = candidates.filter((machine) => fits(machine, want));
	if (fitting.length === 0)
		return { kind: "none", reason: "no_machine", machine: undefined };
	const admitted = fitting.filter((machine) => admits(machine, want));
	if (admitted.length === 0)
		return {
			kind: "none",
			reason: "machine_not_shared",
			machine: [...fitting].sort(order)[0],
		};
	const awake = admitted.filter((machine) => !machine.paused);
	if (awake.length === 0)
		return {
			kind: "none",
			reason: "machine_paused",
			machine: [...admitted].sort(order)[0],
		};
	const free = awake.filter((machine) => machine.busy < machine.slots);
	const sorted = [...(free.length > 0 ? free : awake)].sort(order);
	const machine = sorted[0];
	if (free.length === 0 || !machine)
		return { kind: "none", reason: "machine_full", machine };
	return { kind: "machine", machine };
}
